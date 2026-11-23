/**
 * 光追的反射（路线图 R2）：屏幕空间反射（ScreenSpaceReflections）找不到的部分——反射的东西在屏幕外、被挡着、在背面——用光追补上。
 * 半分辨率，每个像素（每帧在 2×2 里换一个）按和屏幕空间的追踪同一个随机数取同一条反射光线（reflectionWgsl 的
 * reflectionDirection），屏幕上命中的把握不足 1 的才追：
 * - 打到的表面：烘好的材质平均色 ×（直射光（带阴影射线）+ 辐照度体的间接光，体外是天空盒光）+ 自发光，同探针的射线；
 * - 没打到：天空盒的镜面贴图（按粗糙度取 mip，乘天空盒光的强度）。
 * 输出 rgb 是反射、a 是它占的比例（1 - 屏幕上的把握），屏幕空间反射的空间解析按比例混进去，再一起做时间上的累积、合成。
 *
 * 一个像素一条光线噪声很大（阴影里和太阳下的地面亮度差得多，粗糙的金属上斑驳），交出去之前先降噪（半分辨率，同 SVGF 的简化版）：
 * 1. 时间上累积：按表面的世界位置和上一帧的视图投影找上一帧的位置，历史夹在这一帧 3×3 邻域的均值 ± 1.5 倍标准差里（方差夹，
 *    静止时能收敛得比 min/max 夹更干净），九成留历史；
 * 2. 空间上两遍 à-trous（步长 1、2 的 3×3），按法线、到平面的距离挡边，半径乘粗糙度（镜面不糊）。
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import type { GraphTexture } from '../RenderGraph';
import { FullscreenShader, type EffectFrame } from '../postfx/ImageEffect';
import { FULLSCREEN_VERTEX } from '../wgsl';
import { SSR_COMMON_WGSL, SSR_SAMPLING_WGSL } from '../screenspace/reflectionWgsl';
import { IRRADIANCE_VOLUME_WGSL } from './IrradianceVolume';
import { rayTracedLightingWgsl } from './RayTracedLighting';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

const FORMAT: GPUTextureFormat = 'rgba16float';

/** 降噪两步共用：半分辨率的像素对应的整分辨率像素、它的表面（法线、粗糙度）和世界位置。 */
const DENOISE_COMMON = /* wgsl */ `
${SSR_COMMON_WGSL}
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var surface: texture_2d<f32>;
@group(0) @binding(2) var depth: texture_depth_2d;

struct Here { valid: bool, n: vec3f, roughness: f32, world: vec3f, distance: f32 };

fn here(half: vec2i) -> Here {
  let pixel = min(half * 2, vec2i(ssr.size.xy) - 1);
  let s = textureLoad(surface, pixel, 0);
  let uv = (vec2f(pixel) + 0.5) / ssr.size.xy;
  let world = worldPosition(ssr, uv, textureLoad(depth, pixel, 0));
  return Here(s.w > 0.5 && s.z <= ssr.params.x, octahedralDecode(s.xy), s.z, world, length(ssr.eye.xyz - world));
}
`;

const TEMPORAL_SHADER = /* wgsl */ `
${DENOISE_COMMON}
@group(0) @binding(3) var current: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let q = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(current));
  let now = textureLoad(current, q, 0);
  let h = here(q);
  if (!h.valid) { return vec4f(0.0); }
  // 3×3 邻域的均值和标准差（方差夹）
  var mean = vec4f(0.0);
  var square = vec4f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = textureLoad(current, clamp(q + vec2i(x, y), vec2i(0), size - 1), 0);
      mean += c;
      square += c * c;
    }
  }
  mean /= 9.0;
  let sigma = sqrt(max(square / 9.0 - mean * mean, vec4f(0.0)));
  let previousUv = project(ssr.previousViewProjection, h.world).xy;
  if (ssr.eye.w <= 0.0 || any(previousUv < vec2f(0.0)) || any(previousUv > vec2f(1.0))) {
    return now;
  }
  let previous = clamp(textureSampleLevel(history, linearClamp, previousUv, 0.0), mean - 1.5 * sigma, mean + 1.5 * sigma);
  return mix(now, previous, 0.9);
}
`;

const BLUR_SHADER = /* wgsl */ `
${DENOISE_COMMON}
@group(0) @binding(3) var source: texture_2d<f32>;
// x：步长（半分辨率的像素）
@group(0) @binding(4) var<uniform> blur: vec4f;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let q = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(source));
  let center = textureLoad(source, q, 0);
  let h = here(q);
  if (!h.valid || h.roughness < 0.05) { return center; }
  // 半径随粗糙度：越粗糙越糊（反射的波瓣越宽）
  let step = max(1, i32(round(blur.x * saturate(h.roughness / max(ssr.params.x, 0.01)) * 2.0)));
  var sum = center;
  var weight = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) { continue; }
      let p = q + vec2i(x, y) * step;
      if (any(p < vec2i(0)) || any(p >= size)) { continue; }
      let other = here(p);
      if (!other.valid) { continue; }
      // 挡边：法线差得多、不在同一个平面上的不算
      let nw = pow(saturate(dot(other.n, h.n)), 16.0);
      let plane = abs(dot(other.world - h.world, h.n)) / max(h.distance * 0.02, 1e-3);
      let w = nw * exp(-plane * plane) * select(0.5, 1.0, abs(x) + abs(y) == 1);
      sum += textureLoad(source, p, 0) * w;
      weight += w;
    }
  }
  return sum / weight;
}
`;
/** 没打到的射线算多远。 */
const MISS_DISTANCE = 1e5;

/** 光追的反射要的东西（前向渲染器在有光追场景时给屏幕空间反射）。 */
export interface RayTracedInputs {
  readonly scene: RayTracingScene;
  /** 点光、聚光（LocalLightBuffer）。 */
  readonly localLights: GPUBuffer;
  /** 天空盒的镜面贴图（立方体，按粗糙度的 mip）和它的级数。 */
  readonly skySpecular: GPUTexture;
  readonly specularLevels: number;
  /** 辐照度体的图集和网格着色器的那四个 vec4（IrradianceVolumes.shading；没有体时用不用的那一位是 0）。 */
  readonly giAtlas: GPUTexture;
  readonly giVolume: readonly number[];
}

/** 追踪的着色器（和 RenderSystem 互相引用，用到时才拼）。 */
const shader = () => /* wgsl */ `
${FULLSCREEN_VERTEX}
${SSR_COMMON_WGSL}
${SSR_SAMPLING_WGSL}
${IRRADIANCE_VOLUME_WGSL}
struct Params {
  gi: GiVolume,
  // 天空盒镜面贴图的级数
  sky: vec4f,
};
@group(0) @binding(0) var<uniform> ssr: Ssr;
@group(0) @binding(1) var trace: texture_2d<f32>;
@group(0) @binding(2) var surface: texture_2d<f32>;
@group(0) @binding(3) var depth: texture_depth_2d;
@group(0) @binding(4) var skySpecular: texture_cube<f32>;
@group(0) @binding(5) var linearClamp: sampler;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var giAtlas: texture_2d<f32>;
${rayTracingWgsl(1)}
${rayTracedLightingWgsl(0, 9, 8)}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let frame = u32(ssr.eye.w);
  // 半分辨率的这个像素代表 2×2 里的哪一个：每帧换一个，时间上的累积把四个都用上
  let size = vec2i(ssr.size.xy);
  let pixel = min(vec2i(in.position.xy) * 2 + vec2i(i32(frame & 1u), i32((frame >> 1u) & 1u)), size - 1);
  let surfaceData = textureLoad(surface, pixel, 0);
  let roughness = surfaceData.z;
  if (surfaceData.w < 0.5 || roughness > ssr.params.x) {
    return vec4f(0.0);
  }
  let share = 1.0 - textureLoad(trace, pixel, 0).z;
  if (share <= 0.01) {
    return vec4f(0.0);
  }
  let uv = (vec2f(pixel) + 0.5) / ssr.size.xy;
  let world = worldPosition(ssr, uv, textureLoad(depth, pixel, 0));
  let n = octahedralDecode(surfaceData.xy);
  let toEye = ssr.eye.xyz - world;
  let v = normalize(toEye);
  let r = reflectionDirection(vec2u(pixel), frame, n, v, roughness);
  // 起点沿法线挪开一点（深度还原的位置有误差，按到相机的距离）
  let origin = world + n * (1e-3 + 2e-4 * length(toEye));
  let hit = rtTrace(origin, r, ${MISS_DISTANCE});
  var radiance: vec3f;
  if (hit.instance == 0xffffffffu) {
    radiance = textureSampleLevel(skySpecular, linearClamp, rtSkyDirection(r), roughness * params.sky.x).rgb * rtLighting.sky.x;
  } else {
    let p = origin + r * hit.t;
    let hn = rtNormal(hit, r);
    var light = rtDirectLight(p, hn);
    let sky = rtSkyLight(hn);
    if (params.gi.min.w > 0.0) {
      let indirect = giSample(giAtlas, linearClamp, params.gi, p, hn, -r);
      light += mix(sky, indirect.rgb * params.gi.spacing.w, indirect.a);
    } else {
      light += sky;
    }
    radiance = rtAlbedo(hit) * light + rtEmissive(hit);
  }
  return vec4f(radiance, share);
}
`;

/** 光追的反射的通道（ScreenSpaceReflections 持有）。 */
export class RayTracedReflections {
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  #params: GPUBuffer | undefined;
  readonly #data = new Float32Array(20);
  readonly #temporal: FullscreenShader;
  readonly #blur: FullscreenShader;
  #blurSteps: [GPUBuffer, GPUBuffer] | undefined;
  /** 时间累积的结果两张轮着用：这一帧写一张、读上一帧的另一张。 */
  #history: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  /** 追踪的管线：后台编，编好以前不画（不在帧里同步编）。 */
  #pipeline: { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.#sampler = linearClamp;
    this.#temporal = new FullscreenShader(device, 'Ray traced reflections temporal', TEMPORAL_SHADER);
    this.#blur = new FullscreenShader(device, 'Ray traced reflections blur', BLUR_SHADER);
  }

  /** 管线都编好了（追踪的、降噪的两条全屏的）；没有时在后台开始编，这一帧不画。 */
  #ready(sceneLayout: GPUBindGroupLayout): { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout } | undefined {
    if (!this.#pipeline) {
      const creating = this.#createPipeline(sceneLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Ray traced reflections: creating the pipeline failed', error));
    }
    const fullscreen = [this.#temporal.warm([FORMAT]), this.#blur.warm([FORMAT])].filter((warming) => warming !== undefined);
    return this.#pipeline instanceof Promise || fullscreen.length > 0 ? undefined : this.#pipeline;
  }

  /**
   * 往渲染图里加这一遍：ssr 是屏幕空间反射这一帧的参数（Ssr 结构），trace 是它的追踪结果（命中的把握在 z），surface、depth 同它。
   * 光追场景还没有能遍历的东西时不画，返回 undefined。
   */
  record(frame: EffectFrame, ssr: GPUBufferBinding, trace: GraphTexture, surface: GraphTexture, depth: GPUTexture, inputs: RayTracedInputs): GraphTexture | undefined {
    const scene = inputs.scene.bindGroup;
    if (!scene) return undefined;
    const ready = this.#ready(inputs.scene.bindGroupLayout);
    if (!ready) return undefined;
    const device = this.#device;
    const params = (this.#params ??= device.createBuffer({ label: 'RayTracedReflections params', size: this.#data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const width = Math.max(1, Math.ceil(trace.width / 2)), height = Math.max(1, Math.ceil(trace.height / 2));
    const output = frame.acquire(width, height, FORMAT, 'Ray traced reflections');
    this.#data.set(inputs.giVolume, 0);
    this.#data.set([inputs.specularLevels, 0, 0, 0], 16);
    device.queue.writeBuffer(params, 0, this.#data);
    const { pipeline, layout } = ready;
    frame.pass('Ray traced reflections', (pass) => {
      pass.read(trace);
      pass.read(surface);
      pass.write(output);
    }, (real) => {
      const encoder = frame.encoder;
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('Ray traced reflections');
      const pass = encoder.beginRenderPass({
        label: 'Ray traced reflections',
        colorAttachments: [{ view: real.view(output), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
        ...(timestampWrites ? { timestampWrites } : {}),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: 'Ray traced reflections',
        layout,
        entries: [
          { binding: 0, resource: ssr },
          { binding: 1, resource: real.view(trace) },
          { binding: 2, resource: real.view(surface) },
          { binding: 3, resource: depth.createView() },
          { binding: 4, resource: inputs.skySpecular.createView({ dimension: 'cube' }) },
          { binding: 5, resource: this.#sampler },
          { binding: 6, resource: { buffer: params } },
          { binding: 7, resource: inputs.giAtlas.createView() },
          { binding: 8, resource: { buffer: inputs.localLights } },
          { binding: 9, resource: { buffer: inputs.scene.lighting.buffer } },
        ],
      }));
      pass.setBindGroup(1, scene);
      pass.draw(3);
      pass.end();
    });
    return this.#denoise(frame, ssr, output, surface, depth);
  }

  /** 时间上累积（写进自己留到下一帧的贴图，算副作用）、空间上两遍 à-trous；返回降过噪的。 */
  #denoise(frame: EffectFrame, ssr: GPUBufferBinding, traced: GraphTexture, surface: GraphTexture, depth: GPUTexture): GraphTexture {
    const { width, height } = traced;
    if (this.#history?.[0].width !== width || this.#history[0].height !== height) {
      for (const texture of this.#history ?? []) texture.destroy();
      const create = () => this.#device.createTexture({ label: `Ray traced reflections history ${width}x${height}`, size: [width, height], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.#history = [create(), create()];
    }
    const previous = this.#history[1 - this.#current]!, next = this.#history[this.#current]!;
    this.#current = 1 - this.#current;
    const accumulated = frame.graph.import({ label: 'Ray traced reflections history', width, height, format: FORMAT }, next.createView(), { texture: next });
    this.#temporal.draw(frame, accumulated, [ssr, surface, depth, traced, previous, this.#sampler]);
    const steps = (this.#blurSteps ??= [1, 2].map((step) => {
      const buffer = this.#device.createBuffer({ label: `Ray traced reflections blur ${step}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(buffer, 0, new Float32Array([step, 0, 0, 0]));
      return buffer;
    }) as [GPUBuffer, GPUBuffer]);
    const first = frame.acquire(width, height, FORMAT, 'Ray traced reflections blur 1');
    this.#blur.draw(frame, first, [ssr, surface, depth, accumulated, { buffer: steps[0] }]);
    const second = frame.acquire(width, height, FORMAT, 'Ray traced reflections blur 2');
    this.#blur.draw(frame, second, [ssr, surface, depth, first, { buffer: steps[1] }]);
    return second;
  }

  async #createPipeline(sceneLayout: GPUBindGroupLayout): Promise<{ pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }> {
    const device = this.#device;
    const fragment = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'Ray traced reflections',
      entries: [
        { binding: 0, visibility: fragment, buffer: {} },
        { binding: 1, visibility: fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: fragment, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: fragment, texture: { viewDimension: 'cube' } },
        { binding: 5, visibility: fragment, sampler: {} },
        { binding: 6, visibility: fragment, buffer: {} },
        { binding: 7, visibility: fragment, texture: {} },
        { binding: 8, visibility: fragment, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: fragment, buffer: {} },
      ],
    });
    const module = createCheckedShaderModule(device, 'Ray traced reflections', shader());
    const pipeline = await device.createRenderPipelineAsync({
      label: 'Ray traced reflections',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sceneLayout] }),
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    return { pipeline, layout };
  }

  destroy(): void {
    this.#params?.destroy();
    for (const buffer of this.#blurSteps ?? []) buffer.destroy();
    for (const texture of this.#history ?? []) texture.destroy();
  }
}
