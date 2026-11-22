/**
 * 路径追踪的间接光（路线图 R2，原来的 G7；成片导出用）：第一次打到的表面照旧光栅化（贴图、法线贴图、材质全有），从它出发的漫反射的
 * 间接光逐像素路径追踪，代替辐照度体、天空盒光和环境光的漫反射（镜面反射照旧）：
 *
 * 1. 追踪（半分辨率，取 2×2 的左上角）：深度还原世界位置、按深度的邻居求法线，按余弦分布发 paths 条路径，每条最多
 *    bounces 次反弹：打到的表面加（反照率 × 直射光（带阴影射线）+ 自发光）× 一路的反照率，反照率乘上去、再按余弦往下弹，第三次
 *    起按俄罗斯轮盘赌提前停；没打到的加天空盒（镜面贴图的第一级，乘天空盒光的强度）。按余弦采样时平均值就是辐照度 / π，和网格
 *    着色器的漫反射环境光同一个约定。
 * 2. 累积：相机不动时逐帧求平均（第 n 帧的权重 1 / n，最多 MAX_SAMPLES 帧），动了（没抖动的视图投影变了）或者 reset() 了从头来；
 *    离线渲染每个输出帧的第一个子帧 reset，一帧的子帧一起平均。
 * 3. 降噪：两遍 à-trous（步长 1、2），按深度、法线挡边，样本越多糊得越少（1 / √n）。
 *
 * 结果是 rgb = 间接光、a = 1 的半分辨率图，交给网格着色器当屏幕空间的间接光（同屏幕空间全局光照的那条路），视图的辐照度体那一位
 * 设 2：漫反射的环境光整个由它代替。
 */
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { FullscreenShader, type EffectFrame } from '../postfx/ImageEffect';
import type { RenderView } from '../RenderSystem';
import { FULLSCREEN_VERTEX } from '../wgsl';
import { rayTracedLightingWgsl } from './RayTracedLighting';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

const FORMAT: GPUTextureFormat = 'rgba16float';
/** 累积到这么多帧就不再加（权重太小，半精度加不进去）。 */
const MAX_SAMPLES = 4096;
const MISS_DISTANCE = 1e5;

/** 路径追踪要的东西（前向渲染器给）。 */
export interface PathTracingInputs {
  readonly scene: RayTracingScene;
  readonly localLights: GPUBuffer;
  readonly skySpecular: GPUTexture;
}

/** 追踪、累积、降噪共用的参数和取像素。 */
const COMMON = /* wgsl */ `
struct Params {
  inverseViewProjection: mat4x4f,
  // 相机位置、第几帧
  eye: vec4f,
  // 整分辨率的宽、高，每像素几条路径，最多几次反弹
  size: vec4f,
  // 累积了几帧（这一帧算进去以后）、降噪的强度
  accumulate: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depth: texture_depth_2d;

/** 整分辨率像素的世界位置；天空（深度 0）的 w 是 0。 */
fn worldAt(pixel: vec2i) -> vec4f {
  let size = vec2i(params.size.xy);
  let p = clamp(pixel, vec2i(0), size - 1);
  let z = textureLoad(depth, p, 0);
  let uv = (vec2f(p) + 0.5) / params.size.xy;
  let clip = params.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return vec4f(clip.xyz / clip.w, select(0.0, 1.0, z > 0.0));
}

/** 按深度的邻居求法线：左右、上下各取离得近的那边（同 GTAO），朝着相机。 */
fn normalAt(pixel: vec2i, center: vec3f) -> vec3f {
  let size = vec2i(params.size.xy);
  let l = worldAt(pixel - vec2i(1, 0)).xyz;
  let r = worldAt(pixel + vec2i(1, 0)).xyz;
  let u = worldAt(pixel - vec2i(0, 1)).xyz;
  let d = worldAt(pixel + vec2i(0, 1)).xyz;
  // 画面边上那一边出界了（夹回来就是自己，差是零向量）：用另一边
  let useR = pixel.x + 1 < size.x && (pixel.x < 1 || distance(r, center) < distance(l, center));
  let useD = pixel.y + 1 < size.y && (pixel.y < 1 || distance(d, center) < distance(u, center));
  let dx = select(center - l, r - center, useR);
  let dy = select(center - u, d - center, useD);
  let n = normalize(cross(dy, dx));
  return select(n, -n, dot(n, params.eye.xyz - center) < 0.0);
}
`;

/** 追踪的着色器（和 RenderSystem 互相引用，用到时才拼：模块加载时 MAX_DIRECTIONAL_LIGHTS 还没定义）。 */
const traceShader = () => /* wgsl */ `
${FULLSCREEN_VERTEX}
${COMMON}
@group(0) @binding(2) var skySpecular: texture_cube<f32>;
@group(0) @binding(3) var linearClamp: sampler;
${rayTracingWgsl(1)}
${rayTracedLightingWgsl(0, 5, 4)}

fn hash(v: vec3u) -> vec3u {
  var x = v * 1664525u + 1013904223u;
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  x ^= x >> vec3u(16u);
  x.x += x.y * x.z; x.y += x.z * x.x; x.z += x.x * x.y;
  return x;
}

/** 绕 n 按余弦分布的方向。 */
fn cosineDirection(n: vec3f, u: vec2f) -> vec3f {
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(n.z) > 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  let r = sqrt(u.x);
  let phi = 6.28318530718 * u.y;
  return normalize(tx * (r * cos(phi)) + ty * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u.x)));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let frame = u32(params.eye.w);
  let size = vec2i(params.size.xy);
  // 固定取 2×2 的左上角（同降噪、同网格着色器取这张图）：不抖动，轮廓上不把别的表面混进来
  let pixel = min(vec2i(in.position.xy) * 2, size - 1);
  let here = worldAt(pixel);
  if (here.w == 0.0) { return vec4f(0.0); }
  let n0 = normalAt(pixel, here.xyz);
  let paths = u32(params.size.z);
  let bounces = u32(params.size.w);
  var sum = vec3f(0.0);
  for (var k = 0u; k < paths; k++) {
    var seed = hash(vec3u(vec2u(pixel), frame * 16u + k));
    var p = here.xyz + n0 * (1e-3 + 2e-4 * distance(here.xyz, params.eye.xyz));
    var n = n0;
    var throughput = vec3f(1.0);
    var dir = cosineDirection(n, vec2f(seed.xy & vec2u(0xffffffu)) / 16777216.0);
    for (var b = 0u; b < bounces; b++) {
      let hit = rtTrace(p, dir, ${MISS_DISTANCE});
      if (hit.instance == 0xffffffffu) {
        sum += throughput * textureSampleLevel(skySpecular, linearClamp, rtSkyDirection(dir), 0.0).rgb * rtLighting.sky.x;
        break;
      }
      if (rtBackFace(hit, dir)) { break; }
      let hp = p + dir * hit.t;
      let hn = rtNormal(hit, dir);
      let albedo = rtAlbedo(hit);
      sum += throughput * (albedo * rtDirectLight(hp, hn) + rtEmissive(hit));
      throughput *= albedo;
      seed = hash(seed + vec3u(b + 1u));
      // 第三次反弹起按俄罗斯轮盘赌停（留下的按留下的概率放大）
      if (b >= 1u) {
        let keep = clamp(max(throughput.r, max(throughput.g, throughput.b)), 0.05, 0.95);
        if (f32(seed.z & 0xffffu) / 65536.0 > keep) { break; }
        throughput /= keep;
      }
      p = hp + hn * 1e-3;
      n = hn;
      dir = cosineDirection(n, vec2f(seed.xy & vec2u(0xffffffu)) / 16777216.0);
    }
  }
  return vec4f(sum / f32(max(paths, 1u)), 1.0);
}
`;

const ACCUMULATE_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(2) var current: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let q = vec2i(in.position.xy);
  // 天空不算
  if (worldAt(q * 2).w == 0.0) { return vec4f(0.0); }
  let now = textureLoad(current, q, 0);
  let n = params.accumulate.x;
  if (n <= 1.0) { return now; }
  let before = textureLoad(history, q, 0);
  return before + (now - before) / n;
}
`;

const BLUR_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(2) var source: texture_2d<f32>;
// x：步长
@group(0) @binding(3) var<uniform> blur: vec4f;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let q = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(source));
  let center = textureLoad(source, q, 0);
  let strength = params.accumulate.y;
  if (strength <= 0.01) { return center; }
  let here = worldAt(q * 2);
  if (here.w == 0.0) { return center; }
  let n = normalAt(q * 2, here.xyz);
  let distanceToEye = distance(here.xyz, params.eye.xyz);
  let step = i32(blur.x);
  var sum = center;
  var weight = 1.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      if (x == 0 && y == 0) { continue; }
      let p = q + vec2i(x, y) * step;
      if (any(p < vec2i(0)) || any(p >= size)) { continue; }
      let other = worldAt(p * 2);
      if (other.w == 0.0) { continue; }
      let plane = abs(dot(other.xyz - here.xyz, n)) / max(distanceToEye * 0.01, 1e-3);
      let on = normalAt(p * 2, other.xyz);
      let w = strength * pow(saturate(dot(on, n)), 8.0) * exp(-plane * plane) * exp(-f32(x * x + y * y) / 4.0);
      sum += textureLoad(source, p, 0) * w;
      weight += w;
    }
  }
  return sum / weight;
}
`;

/** 追踪的、累积的两张（轮换）、降噪的两张。 */
interface Textures {
  readonly raw: GPUTexture;
  readonly history: [GPUTexture, GPUTexture];
  readonly blurred: GPUTexture;
  readonly result: GPUTexture;
}

/** 路径追踪的间接光（RenderSystem.pathTracing）。 */
export class PathTracedLighting {
  /** 开着时（离线渲染的 pathTracing、调试命令 pathtrace）由它算漫反射的间接光。 */
  enabled = false;
  /** 每像素每帧几条路径、最多几次反弹。 */
  paths = 1;
  bounces = 3;
  /** 这一帧在用（前向渲染器在写视图常量之前定：开着、设备允许、管线和光追场景都好了）；网格着色器按它不再加别的漫反射环境光。 */
  active = false;
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #accumulate: FullscreenShader;
  readonly #blur: FullscreenShader;
  #params: GPUBuffer | undefined;
  #blurSteps: [GPUBuffer, GPUBuffer] | undefined;
  readonly #data = new Float32Array(28);
  #pipeline: { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;
  #textures: Textures | undefined;
  #current = 0;
  #frame = 0;
  /** 累积了几帧（这一帧以后）；相机动了、reset 了从 0 开始。 */
  samples = 0;
  readonly #lastViewProjection = new Float32Array(16);

  constructor(device: GPUDevice, linearClamp: GPUSampler) {
    this.#device = device;
    this.#sampler = linearClamp;
    this.#accumulate = new FullscreenShader(device, 'Path traced lighting accumulate', ACCUMULATE_SHADER);
    this.#blur = new FullscreenShader(device, 'Path traced lighting blur', BLUR_SHADER);
  }

  /** 管线编好了、光追场景有能遍历的东西（没有时开始在后台编，这一帧还不能用）。 */
  ready(scene: RayTracingScene): boolean {
    if (!scene.bindGroup) return false;
    if (!this.#pipeline) {
      const creating = this.#createPipeline(scene.bindGroupLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Path traced lighting: creating the pipeline failed', error));
    }
    const fullscreen = [this.#accumulate.warm([FORMAT]), this.#blur.warm([FORMAT])].filter((warming) => warming !== undefined);
    return !(this.#pipeline instanceof Promise) && fullscreen.length === 0;
  }

  /** 下一帧从头累积（离线渲染每个输出帧的第一个子帧调）。 */
  reset(): void {
    this.samples = 0;
  }

  /**
   * 深度有了以后：追踪、累积、降噪，返回给网格着色的半分辨率间接光（rgb，a = 1）。管线还没编好或者光追场景还没有能遍历的东西时
   * undefined（这一帧照旧用别的环境光）。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, inputs: PathTracingInputs): GPUTexture | undefined {
    const scene = inputs.scene.bindGroup;
    if (!scene || !this.ready(inputs.scene) || !this.#pipeline || this.#pipeline instanceof Promise) return undefined;
    const { pipeline, layout } = this.#pipeline as { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout };
    const device = this.#device;
    const width = Math.ceil(depth.width / 2), height = Math.ceil(depth.height / 2);
    const textures = this.#texturesFor(width, height);
    // 相机动了（不看子像素抖动）：从头累积
    const moved = view.unjitteredViewProjection.some((value, i) => value !== this.#lastViewProjection[i]);
    this.#lastViewProjection.set(view.unjitteredViewProjection);
    if (moved) this.samples = 0;
    this.samples = Math.min(this.samples + 1, MAX_SAMPLES);
    const params = (this.#params ??= device.createBuffer({ label: 'Path traced lighting params', size: this.#data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.#data.set(view.inverseViewProjection, 0);
    this.#data.set([view.eye.x, view.eye.y, view.eye.z, this.#frame++ % 65536], 16);
    this.#data.set([depth.width, depth.height, Math.max(1, Math.round(this.paths)), Math.max(1, Math.round(this.bounces))], 20);
    this.#data.set([this.samples, 1 / Math.sqrt(this.samples), 0, 0], 24);
    device.queue.writeBuffer(params, 0, this.#data);
    const steps = (this.#blurSteps ??= [1, 2].map((step) => {
      const buffer = device.createBuffer({ label: `Path traced lighting blur ${step}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array([step, 0, 0, 0]));
      return buffer;
    }) as [GPUBuffer, GPUBuffer]);

    // 1. 追踪：写进自己的贴图（图外面的）：算副作用
    frame.pass('Path traced lighting', (pass) => pass.sideEffect(), () => {
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('Path traced lighting');
      const pass = frame.encoder.beginRenderPass({
        label: 'Path traced lighting',
        colorAttachments: [{ view: textures.raw.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
        ...(timestampWrites ? { timestampWrites } : {}),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: 'Path traced lighting',
        layout,
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: inputs.skySpecular.createView({ dimension: 'cube' }) },
          { binding: 3, resource: this.#sampler },
          { binding: 4, resource: { buffer: inputs.localLights } },
          { binding: 5, resource: { buffer: inputs.scene.lighting.buffer } },
        ],
      }));
      pass.setBindGroup(1, scene);
      pass.draw(3);
      pass.end();
    });
    // 2. 累积、3. 降噪（都写自己的贴图）
    const previous = textures.history[1 - this.#current]!, next = textures.history[this.#current]!;
    this.#current = 1 - this.#current;
    this.#accumulate.draw(frame, next, [{ buffer: params }, depth, textures.raw, previous]);
    this.#blur.draw(frame, textures.blurred, [{ buffer: params }, depth, next, { buffer: steps[0] }]);
    this.#blur.draw(frame, textures.result, [{ buffer: params }, depth, textures.blurred, { buffer: steps[1] }]);
    return textures.result;
  }

  #texturesFor(width: number, height: number): Textures {
    if (this.#textures?.raw.width === width && this.#textures.raw.height === height) return this.#textures;
    this.#destroyTextures();
    const create = (label: string) => this.#device.createTexture({ label: `Path traced lighting ${label} ${width}x${height}`, size: [width, height], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.samples = 0;
    return (this.#textures = { raw: create('raw'), history: [create('history'), create('history')], blurred: create('blurred'), result: create('result') });
  }

  async #createPipeline(sceneLayout: GPUBindGroupLayout): Promise<{ pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }> {
    const device = this.#device;
    const fragment = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'Path traced lighting',
      entries: [
        { binding: 0, visibility: fragment, buffer: {} },
        { binding: 1, visibility: fragment, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: fragment, texture: { viewDimension: 'cube' } },
        { binding: 3, visibility: fragment, sampler: {} },
        { binding: 4, visibility: fragment, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: fragment, buffer: {} },
      ],
    });
    const module = createCheckedShaderModule(device, 'Path traced lighting', traceShader());
    const pipeline = await device.createRenderPipelineAsync({
      label: 'Path traced lighting',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sceneLayout] }),
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    return { pipeline, layout };
  }

  #destroyTextures(): void {
    if (!this.#textures) return;
    for (const texture of [this.#textures.raw, ...this.#textures.history, this.#textures.blurred, this.#textures.result]) texture.destroy();
    this.#textures = undefined;
  }

  destroy(): void {
    this.#destroyTextures();
    this.#params?.destroy();
    for (const buffer of this.#blurSteps ?? []) buffer.destroy();
  }
}
