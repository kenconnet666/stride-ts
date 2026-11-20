/**
 * 屏幕空间的环境光遮蔽：GTAO（Jimenez 2016 "Practical Real-Time Strategies for Accurate Indirect Occlusion"，参照 Intel
 * XeGTAO 的做法）。深度预通道之后、着色之前算，着色器只拿它乘环境光（天空盒、环境光的漫反射和镜面），直射光不乘。
 *
 * - 半分辨率算：先把深度缓冲缩成半分辨率的视图空间位置（2x2 里取最近的，细的前景不丢），GTAO 和模糊都在半分辨率上做，
 *   着色时按像素取对应的那一格。遮蔽是低频的，半分辨率看不出差别，开销是全分辨率的四分之一左右（全分辨率时 TPP 上
 *   3.4 ms：近处 1 米的半径在画面上有好几百个像素，采样散得开、缓存命中低）。
 * - 每个像素在屏幕上取 2 个方向的切片，每个方向两边各走 6 步找地平线，按投影到切片上的法线积分出可见的比例。法线从位置
 *   重建（左右、上下取离得近的那边），所以不要法线缓冲。
 * - 切片的角度和步长按像素加噪声，开着 TAA 时噪声每帧换，TAA 把它平均掉；再加两遍按深度加权的模糊（横、竖各 5 个）。
 *
 * 和 Stride 不同：Stride 的 AmbientOcclusion（SAO 那一类）在后处理里把整个画面乘上遮蔽，太阳照着的地方也变暗；我们只乘
 * 环境光。效果开不开、半径照合成器里的 AmbientOcclusion（Enabled、ParamRadius）。
 */
import { GRADIENT_NOISE } from '../shaders/noise';
import { Matrix } from '../../mathematics/Matrix';
import { FullscreenShader, UniformArena, type EffectFrame } from '../postfx/ImageEffect';
import type { RenderView } from '../RenderSystem';

/** 半分辨率的视图空间位置（POSITIONS_SHADER 的输出，屏幕空间全局光照也用）。 */
export const POSITION_FORMAT: GPUTextureFormat = 'rgba32float';
const AO_FORMAT: GPUTextureFormat = 'r8unorm';

/** 深度缓冲 → 半分辨率的视图空间位置（x 向右、y 向下、z 向前为正，天空的 w 是 0）。uniform 是这一帧主画面投影的逆。 */
export const POSITIONS_SHADER = /* wgsl */ `
// 裁剪坐标 → 视图空间（这一帧主画面的投影的逆）
struct Prefilter { inverseProjection: mat4x4f };
@group(0) @binding(0) var<uniform> prefilter: Prefilter;
@group(0) @binding(1) var depth: texture_depth_2d;

// 半分辨率的一格：2x2 里最近的深度还原成视图空间的位置，换成 x 向右、y 向下、z 向前为正（同 XeGTAO，切片的方向和屏幕上的
// 方向一致）；天空（深度 1）的 w 是 0
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let full = vec2i(textureDimensions(depth));
  let base = vec2i(in.position.xy) * 2;
  var d = 1.0;
  var at = base;
  for (var i = 0; i < 4; i++) {
    let p = min(base + vec2i(i & 1, i >> 1), full - 1);
    let sample = textureLoad(depth, p, 0);
    if (sample < d) {
      d = sample;
      at = p;
    }
  }
  if (d >= 1.0) { return vec4f(0.0, 0.0, 1e6, 0.0); }
  let uv = (vec2f(at) + 0.5) / vec2f(full);
  let v = prefilter.inverseProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let q = v.xyz / v.w;
  return vec4f(q.x, -q.y, -q.z, 1.0);
}`;

const GTAO_SHADER = /* wgsl */ `
struct Gtao {
  // x：半径（视图空间的单位），y：深度 1 处一个单位是几个（半分辨率的）像素，z：结果的幂（越大越暗），w：这一帧的噪声偏移
  params: vec4f,
};
@group(0) @binding(0) var<uniform> gtao: Gtao;
@group(0) @binding(1) var positions: texture_2d<f32>;

const PI = 3.14159265;
const HALF_PI = 1.57079633;
const SLICES = 2u;
const STEPS = 6u;
/** 半径在画面上最多这么多（半分辨率的）像素：近处再大采样太散，遮蔽也看不出差别。 */
const MAX_RADIUS_PIXELS = 96.0;

fn positionAt(pixel: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(positions));
  return textureLoad(positions, clamp(pixel, vec2i(0), size - 1), 0).xyz;
}

${GRADIENT_NOISE}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let here = textureLoad(positions, pixel, 0);
  if (here.w == 0.0) { return vec4f(1.0); }
  let center = here.xyz;
  // 法线：左右、上下各取离得近（深度差小）的那边，不跨过边缘
  let left = positionAt(pixel - vec2i(1, 0)) - center;
  let right = positionAt(pixel + vec2i(1, 0)) - center;
  let up = positionAt(pixel - vec2i(0, 1)) - center;
  let down = positionAt(pixel + vec2i(0, 1)) - center;
  let dx = select(-left, right, abs(right.z) < abs(left.z));
  let dy = select(-up, down, abs(down.z) < abs(up.z));
  let viewVec = normalize(-center);
  var normal = normalize(cross(dx, dy));
  normal = select(normal, -normal, dot(normal, viewVec) < 0.0);

  let radiusPixels = min(gtao.params.x * gtao.params.y / center.z, MAX_RADIUS_PIXELS);
  if (radiusPixels < 1.0) { return vec4f(1.0); }
  // 离中心太近（不到 1.3 个像素）的采样只是自己，不算
  let minS = 1.3 / radiusPixels;
  let falloffRange = 0.615 * gtao.params.x;
  let falloffMul = -1.0 / falloffRange;
  let falloffAdd = (gtao.params.x - falloffRange) / falloffRange + 1.0;
  let jitter = gradientNoise(in.position.xy + gtao.params.w);
  let stepJitter = fract(jitter + 0.5 * f32((pixel.x + pixel.y) & 1));

  var visibility = 0.0;
  for (var slice = 0u; slice < SLICES; slice++) {
    let phi = (f32(slice) + jitter) * PI / f32(SLICES);
    let omega = vec2f(cos(phi), sin(phi));
    let direction = vec3f(omega, 0.0);
    let orthoDirection = direction - dot(direction, viewVec) * viewVec;
    let axis = normalize(cross(direction, viewVec));
    let projectedNormal = normal - axis * dot(normal, axis);
    let projectedLength = length(projectedNormal);
    let cosNormal = clamp(dot(projectedNormal, viewVec) / max(projectedLength, 1e-5), -1.0, 1.0);
    let n = sign(dot(orthoDirection, projectedNormal)) * acos(cosNormal);
    let lowHorizon0 = cos(n + HALF_PI);
    let lowHorizon1 = cos(n - HALF_PI);
    var horizon0 = lowHorizon0;
    var horizon1 = lowHorizon1;
    for (var step = 0u; step < STEPS; step++) {
      var s = (f32(step) + stepJitter) / f32(STEPS);
      s = s * s + minS;
      let offset = vec2i(round(omega * s * radiusPixels));
      let delta0 = positionAt(pixel + offset) - center;
      let delta1 = positionAt(pixel - offset) - center;
      let distance0 = length(delta0);
      let distance1 = length(delta1);
      // 远的采样按距离衰减成"没有遮挡"（地平线不往上抬）；天空的位置很远，自然算没有遮挡
      let weight0 = clamp(distance0 * falloffMul + falloffAdd, 0.0, 1.0);
      let weight1 = clamp(distance1 * falloffMul + falloffAdd, 0.0, 1.0);
      horizon0 = max(horizon0, mix(lowHorizon0, dot(delta0 / max(distance0, 1e-5), viewVec), weight0));
      horizon1 = max(horizon1, mix(lowHorizon1, dot(delta1 / max(distance1, 1e-5), viewVec), weight1));
    }
    let h0 = n + clamp(-acos(clamp(horizon1, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
    let h1 = n + clamp(acos(clamp(horizon0, -1.0, 1.0)) - n, -HALF_PI, HALF_PI);
    let arc0 = (cosNormal + 2.0 * h0 * sin(n) - cos(2.0 * h0 - n)) / 4.0;
    let arc1 = (cosNormal + 2.0 * h1 * sin(n) - cos(2.0 * h1 - n)) / 4.0;
    visibility += projectedLength * (arc0 + arc1);
  }
  visibility = clamp(visibility / f32(SLICES), 0.03, 1.0);
  return vec4f(pow(visibility, gtao.params.z));
}`;

const BLUR_SHADER = /* wgsl */ `
// xy：模糊的方向（一个像素），z：视图深度的相对差超过它的不混（边缘）
struct Blur { direction: vec4f };
@group(0) @binding(0) var<uniform> blur: Blur;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var positions: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(source));
  let centerDepth = textureLoad(positions, pixel, 0).z;
  var sum = 0.0;
  var weights = 0.0;
  for (var i = -2; i <= 2; i++) {
    let p = clamp(pixel + vec2i(blur.direction.xy) * i, vec2i(0), size - 1);
    // 深度差得多的是别的表面：不混进来
    let d = textureLoad(positions, p, 0).z;
    let w = select(0.0, 1.0, abs(d - centerDepth) <= blur.direction.z * centerDepth) * (1.0 - abs(f32(i)) * 0.2);
    sum += textureLoad(source, p, 0).r * w;
    weights += w;
  }
  return vec4f(sum / max(weights, 1e-5));
}`;

export class AmbientOcclusion {
  /** 合成器给的：开不开（Stride 的 PostProcessingEffects.AmbientOcclusion.Enabled）。 */
  enabled = false;
  /** 半径（世界单位，Stride 的 ParamRadius）。 */
  radius = 1;
  /** 结果的幂：越大越暗（XeGTAO 的 FinalValuePower）。 */
  power = 2.2;
  readonly #device: GPUDevice;
  readonly #prefilter: FullscreenShader;
  readonly #gtao: FullscreenShader;
  readonly #blur: FullscreenShader;
  readonly #arena: UniformArena;
  /** 半分辨率的：视图空间的位置、算出来的、横着模糊过的、结果（着色器读的那张）。 */
  #textures: { positions: GPUTexture; raw: GPUTexture; horizontal: GPUTexture; result: GPUTexture } | undefined;
  #frame = 0;
  readonly #inverseProjection = Matrix.identity();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#prefilter = new FullscreenShader(device, 'GTAO positions', POSITIONS_SHADER);
    this.#gtao = new FullscreenShader(device, 'GTAO', GTAO_SHADER);
    this.#blur = new FullscreenShader(device, 'GTAO blur', BLUR_SHADER);
    this.#arena = new UniformArena(device, 2048);
  }

  /**
   * 往这一帧的渲染图里加 GTAO 的通道（深度预通道之后、着色之前），返回半分辨率的遮蔽贴图（着色器按像素的一半取，乘环境光，
   * 见 RenderView.screenOcclusion）。temporal 为真时噪声每帧换（TAA 会把它平均掉）。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, temporal: boolean): GPUTexture {
    this.#arena.reset();
    const width = Math.ceil(depth.width / 2), height = Math.ceil(depth.height / 2);
    if (this.#textures?.result.width !== width || this.#textures.result.height !== height) {
      if (this.#textures) for (const texture of Object.values(this.#textures)) texture.destroy();
      const create = (label: string, format: GPUTextureFormat) => this.#device.createTexture({ label: `GTAO ${label}`, size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.#textures = { positions: create('positions', POSITION_FORMAT), raw: create('raw', AO_FORMAT), horizontal: create('blurred', AO_FORMAT), result: create('result', AO_FORMAT) };
    }
    const { positions, raw, horizontal, result } = this.#textures;
    if (!Matrix.invert(this.#inverseProjection, view.projection)) Matrix.setIdentity(this.#inverseProjection);
    this.#prefilter.draw(frame, positions, [this.#arena.push(this.#inverseProjection), depth]);
    // 深度 1 处一个单位在（半分辨率的）画面上有几个像素：投影的 [1][1] 是 1 / tan(视角 / 2)
    this.#gtao.draw(frame, raw, [this.#arena.push([this.radius, (view.projection[5]! * height) / 2, this.power, temporal ? (this.#frame++ % 64) * 5.588238 : 0]), positions]);
    this.#blur.draw(frame, horizontal, [this.#arena.push([1, 0, 0.05, 0]), raw, positions]);
    this.#blur.draw(frame, result, [this.#arena.push([0, 1, 0.05, 0]), horizontal, positions]);
    return result;
  }

  /** 在后台编三步的管线（加载开着 GTAO 的场景时，见 ForwardRenderer.warmPostEffects）；目标格式是固定的。 */
  warm(): Promise<void> {
    return Promise.all([this.#prefilter.warm([POSITION_FORMAT]), this.#gtao.warm([AO_FORMAT]), this.#blur.warm([AO_FORMAT])]).then(() => undefined);
  }

  /** 这一帧录的通道执行完以后调。 */
  flush(): void {
    this.#arena.flush();
  }

  destroy(): void {
    if (this.#textures) for (const texture of Object.values(this.#textures)) texture.destroy();
    this.#textures = undefined;
    this.#arena.destroy();
  }
}
