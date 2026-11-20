/**
 * 屏幕空间的全局光照（SSGI，Stride 没有）：近处表面互相反射的漫反射光，和遮蔽一起算。做法是 SSILVB（Therrien、Levesque、
 * Gilet 2023 "Screen Space Indirect Lighting with Visibility Bitmask"，three.js 的 SSGINode 照的是同一篇）：
 *
 * - 同 GTAO（AmbientOcclusion.ts）在半分辨率上，每个像素在屏幕上取几个方向的切片，两边各走几步。不只记最高的地平线：
 *   每个采样当作一段有厚度的东西，挡住切片上从它正面到背面（往远处推 thickness）的那段角度，用 32 位的位掩码记哪些角度
 *   被挡住了。位按 sin(和法线的夹角) 均分，所以每一位是同样多的余弦加权立体角（Lambert 的权重已经在里面）：没被挡的位数
 *   / 32 就是可见的比例（遮蔽），新挡住的位数 / 32 乘那个采样的亮度就是从那里来的间接光（被遮住的方向上来的光）。
 *   不用 three.js 的经验强度（giIntensity 10），能量上是自洽的；切片按投影法线的长度加权再归一化，完全没遮挡时正好是 1。
 * - 采样的亮度取上一帧的 HDR 画面（着色之前算，这一帧还没画）：按矩阵把采样的位置投影到上一帧的画面上，取那里的颜色。
 *   上一帧里已经有这一帧的间接光，所以几帧以后就是多次反弹。只算面朝着这个像素的采样（发光的那面要朝着它）。
 * - 降噪：每帧换噪声，按位置把上一帧的结果重投影过来累积（深度对不上的不要），再横竖各一遍按深度加权的模糊。
 * - 着色（MeshRenderFeature）：环境光乘它的可见比例（代替 GTAO），再加上漫反射颜色乘它的间接光。
 *
 * 开着它时不再算 GTAO（遮蔽它自己就有）。默认关，画质档位高、极高才允许。
 */
import { Matrix } from '../../mathematics/Matrix';
import { POSITION_FORMAT, POSITIONS_SHADER } from './AmbientOcclusion';
import { FullscreenShader, UniformArena, type EffectFrame, type Image } from '../postfx/ImageEffect';
import type { RenderView } from '../RenderSystem';

const NORMAL_FORMAT: GPUTextureFormat = 'rgba16float';
/** rgb：间接光（乘漫反射颜色就是出射的光），a：环境光可见的比例。 */
const RESULT_FORMAT: GPUTextureFormat = 'rgba16float';

/** 半分辨率的视图空间法线：左右、上下各取离得近（深度差小）的那边（同 GTAO），天空是 0。 */
const NORMALS_SHADER = /* wgsl */ `
@group(0) @binding(0) var positions: texture_2d<f32>;

fn positionAt(pixel: vec2i) -> vec3f {
  let size = vec2i(textureDimensions(positions));
  return textureLoad(positions, clamp(pixel, vec2i(0), size - 1), 0).xyz;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let here = textureLoad(positions, pixel, 0);
  if (here.w == 0.0) { return vec4f(0.0); }
  let center = here.xyz;
  let left = positionAt(pixel - vec2i(1, 0)) - center;
  let right = positionAt(pixel + vec2i(1, 0)) - center;
  let up = positionAt(pixel - vec2i(0, 1)) - center;
  let down = positionAt(pixel + vec2i(0, 1)) - center;
  let dx = select(-left, right, abs(right.z) < abs(left.z));
  let dy = select(-up, down, abs(down.z) < abs(up.z));
  // 画面边上的一侧邻居被夹回自己（差是 0）时叉积是 0：退回朝着相机的方向。一个 NaN 会经过累积和模糊几秒内铺满整个画面
  let c = cross(dx, dy);
  let lengthSquared = dot(c, c);
  var normal = select(normalize(-center), c * inverseSqrt(max(lengthSquared, 1e-30)), lengthSquared > 1e-20);
  normal = select(normal, -normal, dot(normal, -center) < 0.0);
  return vec4f(normal, 1.0);
}`;

const TRACE_SHADER = /* wgsl */ `
struct Trace {
  // 视图空间（x 右、y 下、z 前）→ 上一帧的裁剪坐标
  toPrevious: mat4x4f,
  // x：半径（视图空间的单位），y：深度 1 处一个单位是几个（半分辨率的）像素，z：厚度（视图空间的单位），w：这一帧的噪声偏移
  params: vec4f,
  // x：间接光的强度，y：有没有上一帧的画面
  params2: vec4f,
};
@group(0) @binding(0) var<uniform> trace: Trace;
@group(0) @binding(1) var positions: texture_2d<f32>;
@group(0) @binding(2) var normals: texture_2d<f32>;
@group(0) @binding(3) var previousColor: texture_2d<f32>;

const PI = 3.14159265;
const HALF_PI = 1.57079633;
const SLICES = 2u;
const STEPS = 8u;
/** 半径在画面上最多这么多（半分辨率的）像素：近处再大采样太散。 */
const MAX_RADIUS_PIXELS = 128.0;

fn noise(pixel: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

/** 这个位置在上一帧的画面上的颜色；投影到画面外或没有上一帧时是黑的。 */
fn previousRadiance(position: vec3f) -> vec3f {
  let clip = trace.toPrevious * vec4f(position, 1.0);
  if (clip.w <= 0.0 || trace.params2.y == 0.0) { return vec3f(0.0); }
  let ndc = clip.xy / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec3f(0.0); }
  return textureLoad(previousColor, vec2i(uv * vec2f(textureDimensions(previousColor))), 0).rgb;
}

/** [low, high]（0 到 1，按 sin 均分的角度）占的位。 */
fn sectorBits(low: f32, high: f32) -> u32 {
  let start = u32(clamp(floor(low * 32.0), 0.0, 32.0));
  let end = u32(clamp(ceil(high * 32.0), 0.0, 32.0));
  if (end <= start) { return 0u; }
  let count = end - start;
  let mask = select((1u << count) - 1u, 0xffffffffu, count >= 32u);
  return mask << start;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let size = vec2i(textureDimensions(positions));
  let here = textureLoad(positions, pixel, 0);
  if (here.w == 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let center = here.xyz;
  let normal = textureLoad(normals, pixel, 0).xyz;
  let viewVec = normalize(-center);
  let radius = trace.params.x;
  let radiusPixels = min(radius * trace.params.y / center.z, MAX_RADIUS_PIXELS);
  if (radiusPixels < 1.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // 离中心太近（不到 1.3 个像素）的采样只是自己
  let minS = 1.3 / radiusPixels;
  let jitter = noise(in.position.xy + trace.params.w);
  let stepJitter = fract(jitter + 0.5 * f32((pixel.x + pixel.y) & 1));

  var visible = 0.0;
  var light = vec3f(0.0);
  var weights = 0.0;
  for (var slice = 0u; slice < SLICES; slice++) {
    let phi = (f32(slice) + jitter) * PI / f32(SLICES);
    let omega = vec2f(cos(phi), sin(phi));
    let direction = vec3f(omega, 0.0);
    let orthoDirection = direction - dot(direction, viewVec) * viewVec;
    let axis = normalize(cross(direction, viewVec));
    let projectedNormal = normal - axis * dot(normal, axis);
    let projectedLength = length(projectedNormal);
    let cosNormal = clamp(dot(projectedNormal, viewVec) / max(projectedLength, 1e-5), -1.0, 1.0);
    // 法线在切片里的角度（从朝着相机的方向量，往 omega 那边为正）
    let n = sign(dot(orthoDirection, projectedNormal)) * acos(cosNormal);
    var occluded = 0u;
    var sliceLight = vec3f(0.0);
    for (var side = 0; side < 2; side++) {
      let sideSign = select(-1.0, 1.0, side == 0);
      for (var step = 0u; step < STEPS; step++) {
        var s = (f32(step) + stepJitter) / f32(STEPS);
        s = s * s + minS;
        let samplePixel = pixel + vec2i(round(omega * s * radiusPixels * sideSign));
        if (any(samplePixel < vec2i(0)) || any(samplePixel >= size)) { break; }
        let sample = textureLoad(positions, samplePixel, 0);
        if (sample.w == 0.0) { continue; }
        let delta = sample.xyz - center;
        let distance = length(delta);
        if (distance > radius || distance < 1e-4) { continue; }
        // 采样挡住的角度：正面到背面（往远处推 thickness）
        let front = sideSign * acos(clamp(dot(delta / distance, viewVec), -1.0, 1.0));
        let backDelta = delta - viewVec * trace.params.z;
        let back = sideSign * acos(clamp(dot(backDelta, viewVec) * inverseSqrt(max(dot(backDelta, backDelta), 1e-12)), -1.0, 1.0));
        let low = clamp(min(front, back) - n, -HALF_PI, HALF_PI);
        let high = clamp(max(front, back) - n, -HALF_PI, HALF_PI);
        let bits = sectorBits(sin(low) * 0.5 + 0.5, sin(high) * 0.5 + 0.5) & ~occluded;
        if (bits == 0u) { continue; }
        occluded |= bits;
        // 光从采样的表面来：它的正面要朝着这个像素
        let senderNormal = textureLoad(normals, samplePixel, 0).xyz;
        if (dot(senderNormal, -delta) > 0.0) {
          sliceLight += previousRadiance(sample.xyz) * (f32(countOneBits(bits)) / 32.0);
        }
      }
    }
    visible += (1.0 - f32(countOneBits(occluded)) / 32.0) * projectedLength;
    light += sliceLight * projectedLength;
    weights += projectedLength;
  }
  let w = max(weights, 1e-5);
  return vec4f(light / w * trace.params2.x, visible / w);
}`;

const TEMPORAL_SHADER = /* wgsl */ `
struct Temporal {
  toPrevious: mat4x4f,
  // x：新的一帧占多少，y：有没有上一帧的结果
  params: vec4f,
};
@group(0) @binding(0) var<uniform> temporal: Temporal;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var positions: texture_2d<f32>;
@group(0) @binding(3) var previousPositions: texture_2d<f32>;
@group(0) @binding(4) var history: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let now = textureLoad(current, pixel, 0);
  let here = textureLoad(positions, pixel, 0);
  if (here.w == 0.0 || temporal.params.y == 0.0) { return now; }
  // 这个位置上一帧在哪：那里上一帧的深度（视图空间往前的距离，正好是裁剪坐标的 w）对得上才用它的结果
  let clip = temporal.toPrevious * vec4f(here.xyz, 1.0);
  if (clip.w <= 0.0) { return now; }
  let ndc = clip.xy / clip.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return now; }
  let previousPixel = vec2i(uv * vec2f(textureDimensions(history)));
  let previous = textureLoad(previousPositions, previousPixel, 0);
  if (previous.w == 0.0 || abs(previous.z - clip.w) > 0.05 * clip.w) { return now; }
  return mix(textureLoad(history, previousPixel, 0), now, temporal.params.x);
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
  var sum = vec4f(0.0);
  var weights = 0.0;
  for (var i = -2; i <= 2; i++) {
    let p = clamp(pixel + vec2i(blur.direction.xy) * i, vec2i(0), size - 1);
    let d = textureLoad(positions, p, 0).z;
    let w = select(0.0, 1.0, abs(d - centerDepth) <= blur.direction.z * centerDepth) * (1.0 - abs(f32(i)) * 0.2);
    sum += textureLoad(source, p, 0) * w;
    weights += w;
  }
  return sum / max(weights, 1e-5);
}`;

/** 这一帧画好的 HDR 画面缩成半分辨率留给下一帧（2x2 平均）；太亮的压一压，免得一个亮点在间接光里变成一片噪点。 */
const CAPTURE_SHADER = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
const MAX_LUMINANCE = 16.0;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  let base = vec2i(in.position.xy) * 2;
  var sum = vec3f(0.0);
  for (var i = 0; i < 4; i++) {
    // 溢出成无穷大的像素（rgba16float 过了 65504）乘上压暗的系数 0 会是 NaN：先夹到有限的范围
    sum += clamp(textureLoad(source, min(base + vec2i(i & 1, i >> 1), size - 1), 0).rgb, vec3f(0.0), vec3f(65000.0));
  }
  let color = sum * 0.25;
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(color * min(1.0, MAX_LUMINANCE / max(luminance, 1e-5)), 1.0);
}`;

interface Textures {
  /** 这一帧和上一帧的半分辨率位置（轮着用）。 */
  readonly positions: [GPUTexture, GPUTexture];
  readonly normals: GPUTexture;
  readonly raw: GPUTexture;
  /** 累积的结果，这一帧和上一帧的（轮着用）。 */
  readonly accumulated: [GPUTexture, GPUTexture];
  readonly horizontal: GPUTexture;
  readonly result: GPUTexture;
  /** 上一帧的 HDR 画面（半分辨率）。 */
  readonly previousColor: GPUTexture;
}

export class ScreenSpaceGlobalIllumination {
  /** 默认关：Stride 没有它，开了以后和桌面 Stride 的画面不再逐像素一致。 */
  enabled = false;
  /** 半径（世界单位）：多远以内的表面互相照亮、互相遮挡。 */
  radius = 2;
  /** 采样被当作多厚（世界单位）：挡住的角度从它的正面算到背面。 */
  thickness = 0.5;
  /** 间接光乘多少（1 是物理上的量）。 */
  intensity = 1;
  /** 新的一帧在累积里占多少。 */
  feedback = 0.1;

  readonly #device: GPUDevice;
  readonly #positions: FullscreenShader;
  readonly #normals: FullscreenShader;
  readonly #trace: FullscreenShader;
  readonly #temporal: FullscreenShader;
  readonly #blur: FullscreenShader;
  readonly #capture: FullscreenShader;
  readonly #arena: UniformArena;
  #textures: Textures | undefined;
  /** 这一帧用哪一份（positions、accumulated 轮着用）。 */
  #current: 0 | 1 = 0;
  #frame = 0;
  /** 上一帧留下了画面和结果（大小变了、刚打开时没有）。 */
  #hasPrevious = false;
  readonly #inverseProjection = Matrix.identity();
  readonly #inverseView = Matrix.identity();
  readonly #previousViewProjection = Matrix.identity();
  readonly #toPrevious = Matrix.identity();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#positions = new FullscreenShader(device, 'SSGI positions', POSITIONS_SHADER);
    this.#normals = new FullscreenShader(device, 'SSGI normals', NORMALS_SHADER);
    this.#trace = new FullscreenShader(device, 'SSGI trace', TRACE_SHADER);
    this.#temporal = new FullscreenShader(device, 'SSGI temporal', TEMPORAL_SHADER);
    this.#blur = new FullscreenShader(device, 'SSGI blur', BLUR_SHADER);
    this.#capture = new FullscreenShader(device, 'SSGI capture', CAPTURE_SHADER);
    this.#arena = new UniformArena(device, 4096);
  }

  /**
   * 往这一帧的渲染图里加 SSGI 的通道（深度预通道之后、着色之前），返回半分辨率的结果（rgb 间接光、a 可见的比例；着色器按
   * 像素的一半取，见 RenderView.screenOcclusion 和 screenIndirect）。画完这一帧的 HDR 画面以后要调 capture。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView): GPUTexture {
    this.#arena.reset();
    const textures = this.#texturesFor(Math.ceil(depth.width / 2), Math.ceil(depth.height / 2));
    const current = this.#current, previous = current === 0 ? 1 : 0;
    const positions = textures.positions[current];
    if (!Matrix.invert(this.#inverseProjection, view.projection)) Matrix.setIdentity(this.#inverseProjection);
    if (!Matrix.invert(this.#inverseView, view.view)) Matrix.setIdentity(this.#inverseView);
    // 位置是 x 右、y 下、z 前的视图空间：先翻回 y 上、z 后，再回到世界，再到上一帧的裁剪坐标
    Matrix.multiply(this.#toPrevious, this.#previousViewProjection, this.#inverseView);
    Matrix.multiply(this.#toPrevious, this.#toPrevious, FLIP_YZ);
    this.#positions.draw(frame, positions, [this.#arena.push(this.#inverseProjection), depth]);
    this.#normals.draw(frame, textures.normals, [positions]);
    const height = textures.result.height;
    const hasPrevious = this.#hasPrevious ? 1 : 0;
    this.#trace.draw(frame, textures.raw, [
      this.#arena.push([...this.#toPrevious, this.radius, (view.projection[5]! * height) / 2, this.thickness, (this.#frame++ % 64) * 5.588238, this.intensity, hasPrevious, 0, 0]),
      positions, textures.normals, textures.previousColor,
    ]);
    const accumulated = textures.accumulated[current];
    this.#temporal.draw(frame, accumulated, [
      this.#arena.push([...this.#toPrevious, this.feedback, hasPrevious, 0, 0]),
      textures.raw, positions, textures.positions[previous], textures.accumulated[previous],
    ]);
    this.#blur.draw(frame, textures.horizontal, [this.#arena.push([1, 0, 0.05, 0]), accumulated, positions]);
    this.#blur.draw(frame, textures.result, [this.#arena.push([0, 1, 0.05, 0]), textures.horizontal, positions]);
    this.#previousViewProjection.set(view.viewProjection);
    this.#current = previous;
    return textures.result;
  }

  /** 这一帧画好的 HDR 画面（后处理之前）缩成半分辨率留给下一帧当光源。 */
  capture(frame: EffectFrame, color: Image): void {
    if (!this.#textures) return;
    this.#capture.draw(frame, this.#textures.previousColor, [color]);
    this.#hasPrevious = true;
  }

  /** 关掉以后再打开时不用上一次留下的画面和结果。 */
  reset(): void {
    this.#hasPrevious = false;
  }

  warm(): Promise<void> {
    return Promise.all([
      this.#positions.warm([POSITION_FORMAT]), this.#normals.warm([NORMAL_FORMAT]), this.#trace.warm([RESULT_FORMAT]),
      this.#temporal.warm([RESULT_FORMAT]), this.#blur.warm([RESULT_FORMAT]), this.#capture.warm([RESULT_FORMAT]),
    ]).then(() => undefined);
  }

  /** 这一帧录的通道执行完以后调。 */
  flush(): void {
    this.#arena.flush();
  }

  destroy(): void {
    this.#destroyTextures();
    this.#arena.destroy();
  }

  #texturesFor(width: number, height: number): Textures {
    if (this.#textures?.result.width === width && this.#textures.result.height === height) return this.#textures;
    this.#destroyTextures();
    const create = (label: string, format: GPUTextureFormat) => this.#device.createTexture({
      label: `SSGI ${label}`, size: [width, height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.#textures = {
      positions: [create('positions 0', POSITION_FORMAT), create('positions 1', POSITION_FORMAT)],
      normals: create('normals', NORMAL_FORMAT),
      raw: create('raw', RESULT_FORMAT),
      accumulated: [create('accumulated 0', RESULT_FORMAT), create('accumulated 1', RESULT_FORMAT)],
      horizontal: create('blurred', RESULT_FORMAT),
      result: create('result', RESULT_FORMAT),
      previousColor: create('previous color', RESULT_FORMAT),
    };
    this.#hasPrevious = false;
    return this.#textures;
  }

  #destroyTextures(): void {
    if (!this.#textures) return;
    const { positions, accumulated, ...rest } = this.#textures;
    for (const texture of [...positions, ...accumulated, ...Object.values(rest)]) texture.destroy();
    this.#textures = undefined;
  }
}

/** 视图空间 y、z 取反（AmbientOcclusion 的位置换成的 x 右、y 下、z 前，和标准的 y 上、z 后互换）。 */
const FLIP_YZ = Matrix.setIdentity(new Float32Array(16));
FLIP_YZ[5] = -1;
FLIP_YZ[10] = -1;
