/**
 * 光追的阴影（Stride 没有；照 UE 的 Ray Traced Shadows、DXR 的软阴影做法）：投阴影的那盏方向光，主画面每个像素从深度还原的表面朝
 * 光源打一条阴影射线（rtOccluded：打到任何东西就停），方向在光源的张角里每帧随机抖一下——半影的宽度自己随遮挡物离得远近变（脚边
 * 锐利、远处的楼影发虚），没有阴影图的分辨率、级联、深度偏移的问题。一个像素一条射线是噪声，交出去之前降噪：
 * 1. 时间上累积：按表面的世界位置和上一帧的视图投影找上一帧的位置，历史夹在这一帧 3×3 邻域的最小、最大之间，九成留历史；
 * 2. 空间上两遍 à-trous（步长 1、2 的 3×3），按视深挡边。
 *
 * 结果 r16float（1 是亮，0 是被挡住）当 RenderView.screenShadow，着色时乘那盏光的直射项（同接触阴影，开着它时不另算接触阴影）。
 * 光追场景里没有的投影者（蒙皮的角色、透明的、关了 visibleInRayTracing 的小东西）照旧靠阴影图：开着时那盏光的级联只画这些
 * （RenderView.skipsRayTraced），两边相乘。
 */
import { createCheckedShaderModule } from '../../graphics/shaderModule';
import { GpuProfiler } from '../../graphics/GpuProfiler';
import { Matrix } from '../../data/Matrix';
import type { RenderView } from '../RenderSystem';
import { FullscreenShader, type EffectFrame } from '../postfx/ImageEffect';
import { GRADIENT_NOISE } from '../wgsl';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

const FORMAT: GPUTextureFormat = 'r16float';
/** 阴影射线最远多长（方向光）。 */
const SHADOW_DISTANCE = 1e5;

/** 几个通道共用：参数和按深度还原世界位置。 */
const COMMON = /* wgsl */ `
struct Shadow {
  inverseViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  // xyz：从表面指向光源（世界空间，单位向量）；w：光源张角一半的正切
  toLight: vec4f,
  // 宽、高、第几帧、0
  params: vec4f,
  // 相机的位置（渲染坐标）
  eye: vec4f,
};

/** 这一帧 2×2 块里打哪个像素。 */
fn blockOffset() -> vec2i {
  let frame = u32(shadow.params.z);
  return vec2i(i32(frame & 1u), i32((frame >> 1u) & 1u));
}

fn worldAt(inverseViewProjection: mat4x4f, uv: vec2f, z: f32) -> vec3f {
  let clip = inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return clip.xyz / clip.w;
}
`;

/** 追踪：每个像素一条阴影射线，计算着色器 8×8 一组（和 RenderSystem 互相引用，用到时才拼）。 */
const traceShader = () => /* wgsl */ `
${COMMON}
${GRADIENT_NOISE}
@group(0) @binding(0) var<uniform> shadow: Shadow;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var traced: texture_storage_2d<r32float, write>;
${rayTracingWgsl(1)}

fn worldAtPixel(pixel: vec2i) -> vec3f {
  let size = vec2i(shadow.params.xy);
  let p = clamp(pixel, vec2i(0), size - 1);
  return worldAt(shadow.inverseViewProjection, (vec2f(p) + 0.5) / shadow.params.xy, textureLoad(depth, p, 0));
}

/**
 * 按深度还原的法线：左右、上下各取离这个点近的那一边（物体的边缘上不跨到背景去），画面边上只取在画面里的那一边，朝着相机。
 * 还原不出来（两边都是零向量）时返回零向量。
 */
fn depthNormal(pixel: vec2i, center: vec3f) -> vec3f {
  let last = vec2i(shadow.params.xy) - 1;
  let right = worldAtPixel(pixel + vec2i(1, 0)) - center;
  let left = center - worldAtPixel(pixel - vec2i(1, 0));
  let down = worldAtPixel(pixel + vec2i(0, 1)) - center;
  let up = center - worldAtPixel(pixel - vec2i(0, 1));
  let dx = select(select(left, right, dot(right, right) < dot(left, left)), select(right, left, pixel.x == last.x), pixel.x == 0 || pixel.x == last.x);
  let dy = select(select(up, down, dot(down, down) < dot(up, up)), select(down, up, pixel.y == last.y), pixel.y == 0 || pixel.y == last.y);
  let c = cross(dy, dx);
  if (!(dot(c, c) > 1e-20)) { return vec3f(0.0); }
  var n = normalize(c);
  if (dot(n, shadow.eye.xyz - center) < 0.0) { n = -n; }
  return n;
}

/** 半分辨率：每个线程是一个 2×2 块，按帧号轮着挑块里的一个像素打（四帧把四个都打到，时间累积合起来）。 */
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(traced))) { return; }
  let size = vec2i(shadow.params.xy);
  let pixel = min(vec2i(id.xy) * 2 + blockOffset(), size - 1);
  textureStore(traced, id.xy, vec4f(visibility(pixel), 0.0, 0.0, 1.0));
}

fn visibility(pixel: vec2i) -> f32 {
  let z = textureLoad(depth, pixel, 0);
  // 反向 Z：0 是天空
  if (z <= 0.0) { return 1.0; }
  let world = worldAtPixel(pixel);
  let n = depthNormal(pixel, world);
  let l = shadow.toLight.xyz;
  // 背光的面直射项本来就是 0；法线还原不出来的（零向量、NaN）也不打：NaN 的起点在 GPU 上让 min、max 返回另一边，每个盒子都"测中"，
  // 一条射线走遍整个场景的 BVH（左上角的一个像素曾经让这一遍从 0.3 毫秒变成 10 毫秒）
  if (!(dot(n, l) > 0.0)) { return 1.0; }
  // 在光源的张角里均匀取一个方向（圆盘上的点，每帧换：交错梯度噪声加帧号的黄金分割）
  let frame = shadow.params.z;
  let r1 = fract(gradientNoise(vec2f(pixel)) + frame * 0.6180340);
  let r2 = fract(gradientNoise(vec2f(pixel) + vec2f(47.0, 17.0)) + frame * 0.7548777);
  let tangent = normalize(select(cross(l, vec3f(0.0, 1.0, 0.0)), cross(l, vec3f(1.0, 0.0, 0.0)), abs(l.y) > 0.9));
  let bitangent = cross(l, tangent);
  let radius = sqrt(r1) * shadow.toLight.w;
  let phi = r2 * 6.2831853;
  let dir = normalize(l + (tangent * cos(phi) + bitangent * sin(phi)) * radius);
  // 起点沿法线挪开一点（深度还原的位置有误差，按到相机的距离）
  let distance = length(shadow.eye.xyz - world);
  let origin = world + n * (2e-3 + 4e-4 * distance);
  return select(1.0, 0.0, rtOccludedStatic(origin, dir, ${SHADOW_DISTANCE}));
}
`;

/**
 * 时间上累积（全分辨率）：按世界位置找上一帧的位置，历史夹在所在块周围 3×3 块的范围里；这一帧打到的像素新样本占三成，块里别的
 * 像素拿块的样本、占得少。
 */
const TEMPORAL_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> shadow: Shadow;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var current: texture_2d<f32>;
@group(0) @binding(3) var history: texture_2d<f32>;
@group(0) @binding(4) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let blocks = vec2i(textureDimensions(current));
  let block = min(pixel / 2, blocks - 1);
  let now = textureLoad(current, block, 0).r;
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return vec4f(1.0); }
  var low = now;
  var high = now;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let v = textureLoad(current, clamp(block + vec2i(x, y), vec2i(0), blocks - 1), 0).r;
      low = min(low, v);
      high = max(high, v);
    }
  }
  let mine = all(pixel - block * 2 == blockOffset());
  let world = worldAt(shadow.inverseViewProjection, (vec2f(pixel) + 0.5) / shadow.params.xy, z);
  let previous = shadow.previousViewProjection * vec4f(world, 1.0);
  let uv = vec2f(previous.x / previous.w * 0.5 + 0.5, 0.5 - previous.y / previous.w * 0.5);
  if (previous.w <= 0.0 || any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || shadow.params.w < 0.5) {
    return vec4f(now, 0.0, 0.0, 1.0);
  }
  let past = clamp(textureSampleLevel(history, linearClamp, uv, 0.0).r, low, high);
  return vec4f(mix(past, now, select(0.08, 0.3, mine)), 0.0, 0.0, 1.0);
}
`;

/** 空间上一遍 à-trous（步长在 step.x）：3×3，按视深挡边。 */
const BLUR_SHADER = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> shadow: Shadow;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var<uniform> step: vec4f;

fn viewDistance(pixel: vec2i) -> f32 {
  let z = textureLoad(depth, pixel, 0);
  if (z <= 0.0) { return 1e9; }
  return length(shadow.eye.xyz - worldAt(shadow.inverseViewProjection, (vec2f(pixel) + 0.5) / shadow.params.xy, z));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(shadow.params.xy);
  let d = viewDistance(pixel);
  if (d >= 1e9) { return vec4f(1.0); }
  var sum = 0.0;
  var weight = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let p = clamp(pixel + vec2i(x, y) * i32(step.x), vec2i(0), size - 1);
      let dq = viewDistance(p);
      // 视深差过 2% 的（另一个物体、远处的背景）不算
      let gap = abs(dq - d) / (d * 0.02);
      let w = exp(-gap * gap) * select(select(0.25, 0.5, abs(x) + abs(y) == 1), 1.0, x == 0 && y == 0);
      sum += textureLoad(source, p, 0).r * w;
      weight += w;
    }
  }
  return vec4f(sum / weight, 0.0, 0.0, 1.0);
}
`;

/** 光追的阴影的通道（前向渲染器持有）。 */
export class RayTracedShadows {
  /** 开着、画质开着全局光照、有光追场景时主画面投阴影的那盏方向光用光追的阴影（合成器的 rayTracedShadows，调试命令 rtshadow）。 */
  enabled = false;
  readonly #device: GPUDevice;
  readonly #sampler: GPUSampler;
  readonly #temporal: FullscreenShader;
  readonly #blur: FullscreenShader;
  #uniforms: GPUBuffer | undefined;
  readonly #data = new Float32Array(48);
  #blurSteps: [GPUBuffer, GPUBuffer] | undefined;
  /** 时间累积的结果两张轮着用；最后一遍模糊写进 #result（着色时经视图的绑定组读，所以在渲染图外面）。 */
  #history: [GPUTexture, GPUTexture] | undefined;
  #current = 0;
  #result: GPUTexture | undefined;
  /** 上一帧的视图投影（时间累积找上一帧的位置）；historyValid 是假时这一帧不用历史（刚开、尺寸变了）。 */
  readonly #previous = Matrix.identity();
  #historyValid = false;
  #frame = 0;
  /** 追踪的结果（计算着色器写的存储贴图，r32float）。 */
  #traced: GPUTexture | undefined;
  /** 追踪的管线：后台编，编好以前不用（不在帧里同步编）。 */
  #pipeline: { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout } | Promise<unknown> | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#sampler = device.createSampler({ label: 'RayTracedShadows', magFilter: 'linear', minFilter: 'linear' });
    this.#temporal = new FullscreenShader(device, 'Ray traced shadows temporal', TEMPORAL_SHADER);
    this.#blur = new FullscreenShader(device, 'Ray traced shadows blur', BLUR_SHADER);
  }

  /** 这一帧能用：光追场景有东西、管线都编好了；没编时在后台开始编。前向渲染器在收集阴影图之前问（用的话阴影图只画光追里没有的投影者）。 */
  ready(scene: RayTracingScene): boolean {
    if (!scene.bindGroup) return false;
    if (!this.#pipeline) {
      const creating = this.#createPipeline(scene.bindGroupLayout);
      this.#pipeline = creating;
      creating.then((ready) => (this.#pipeline = ready), (error: unknown) => console.error('Ray traced shadows: creating the pipeline failed', error));
    }
    const fullscreen = [this.#temporal.warm([FORMAT]), this.#blur.warm([FORMAT])].filter((warming) => warming !== undefined);
    return !(this.#pipeline instanceof Promise) && fullscreen.length === 0;
  }

  /**
   * 往渲染图里加这几遍（深度预通道之后、不透明阶段之前），返回结果贴图（全分辨率，见 RenderView.screenShadow）。toLight 是从表面
   * 指向光源的单位向量，lightAngle 是光源的张角（度）。ready 之后调。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, scene: RayTracingScene, toLight: readonly [number, number, number], lightAngle: number): GPUTexture {
    const device = this.#device;
    const { pipeline, layout } = this.#pipeline as { readonly pipeline: GPUComputePipeline; readonly layout: GPUBindGroupLayout };
    const { width, height } = depth;
    this.#resize(width, height);
    const d = this.#data;
    d.set(view.inverseViewProjection, 0);
    d.set(this.#previous, 16);
    d.set([toLight[0], toLight[1], toLight[2], Math.tan((lightAngle / 2) * (Math.PI / 180))], 32);
    d.set([width, height, this.#frame++ % 1024, this.#historyValid ? 1 : 0], 36);
    d.set([view.eye.x, view.eye.y, view.eye.z, 0], 40);
    const uniforms = (this.#uniforms ??= device.createBuffer({ label: 'RayTracedShadows', size: d.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(uniforms, 0, d);
    this.#previous.set(view.viewProjection);
    this.#historyValid = true;

    const traced = this.#traced!;
    frame.pass('Ray traced shadows', (pass) => pass.sideEffect(), () => {
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('Ray traced shadows');
      const pass = frame.encoder.beginComputePass({ label: 'Ray traced shadows', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        label: 'Ray traced shadows',
        layout,
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: depth.createView() },
          { binding: 2, resource: traced.createView() },
        ],
      }));
      pass.setBindGroup(1, scene.bindGroup!);
      pass.dispatchWorkgroups(Math.ceil(traced.width / 8), Math.ceil(traced.height / 8));
      pass.end();
    });

    // 时间上累积进这一帧的历史，再两遍 à-trous，最后一遍写进结果
    const previous = this.#history![1 - this.#current]!, next = this.#history![this.#current]!;
    this.#current = 1 - this.#current;
    const accumulated = frame.graph.import({ label: 'Ray traced shadows history', width, height, format: FORMAT }, next.createView(), { texture: next });
    this.#temporal.draw(frame, accumulated, [{ buffer: uniforms }, depth, traced, previous, this.#sampler]);
    const steps = (this.#blurSteps ??= [1, 2].map((step) => {
      const buffer = device.createBuffer({ label: `Ray traced shadows blur ${step}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Float32Array([step, 0, 0, 0]));
      return buffer;
    }) as [GPUBuffer, GPUBuffer]);
    const first = frame.acquire(width, height, FORMAT, 'Ray traced shadows blur 1');
    this.#blur.draw(frame, first, [{ buffer: uniforms }, depth, accumulated, { buffer: steps[0] }]);
    const result = this.#result!;
    const target = frame.graph.import({ label: 'Ray traced shadows', width, height, format: FORMAT }, result.createView(), { texture: result });
    this.#blur.draw(frame, target, [{ buffer: uniforms }, depth, first, { buffer: steps[1] }]);
    return result;
  }

  /** 关掉、换场景时：下次开时不接着用旧的历史。 */
  reset(): void {
    this.#historyValid = false;
  }

  #resize(width: number, height: number): void {
    if (this.#result?.width === width && this.#result.height === height) return;
    for (const texture of [...(this.#history ?? []), this.#result, this.#traced]) texture?.destroy();
    const half = [Math.ceil(width / 2), Math.ceil(height / 2)];
    this.#traced = this.#device.createTexture({ label: `Ray traced shadows traced ${half[0]}x${half[1]}`, size: half, format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const create = (label: string) => this.#device.createTexture({ label: `${label} ${width}x${height}`, size: [width, height], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#history = [create('Ray traced shadows history'), create('Ray traced shadows history')];
    this.#result = create('Ray traced shadows');
    this.#historyValid = false;
  }

  async #createPipeline(sceneLayout: GPUBindGroupLayout): Promise<{ pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }> {
    const device = this.#device;
    const compute = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'Ray traced shadows',
      entries: [
        { binding: 0, visibility: compute, buffer: {} },
        { binding: 1, visibility: compute, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: compute, storageTexture: { access: 'write-only', format: 'r32float' } },
      ],
    });
    const module = createCheckedShaderModule(device, 'Ray traced shadows', traceShader());
    const pipeline = await device.createComputePipelineAsync({
      label: 'Ray traced shadows',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sceneLayout] }),
      compute: { module, entryPoint: 'main' },
    });
    return { pipeline, layout };
  }

  destroy(): void {
    this.#uniforms?.destroy();
    for (const buffer of this.#blurSteps ?? []) buffer.destroy();
    for (const texture of [...(this.#history ?? []), this.#result, this.#traced]) texture?.destroy();
  }
}
