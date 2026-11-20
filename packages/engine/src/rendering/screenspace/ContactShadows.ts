/**
 * 接触阴影（屏幕空间的阴影，Stride 没有，UE 的 Contact Shadows 那种）：投阴影的那盏方向光，每个像素在屏幕空间里朝光源沿着
 * 深度缓冲走一小段，被前面的东西挡住就在阴影里。补阴影图分辨率不够的地方——物体和地面接触处、小的凸起、角色的手指——那里
 * 阴影图的一个纹素比东西还大，加上深度偏移，影子会和物体分开（漏光）。
 *
 * 全分辨率（半分辨率时接触处的边缘发糊，正好是要补的地方），结果 r8unorm：1 是亮，0 是被挡住。着色时只乘那盏光的直射项
 * （见 MeshRenderFeature 的 screenContactShadow）。深度预通道之后、不透明阶段之前算，同 GTAO。
 */
import { GRADIENT_NOISE } from '../shaders/noise';
import type { RenderView } from '../RenderSystem';
import { FullscreenShader, UniformArena, type EffectFrame } from '../postfx/ImageEffect';

const SHADOW_FORMAT: GPUTextureFormat = 'r8unorm';

const SHADER = /* wgsl */ `
struct Contact {
  inverseViewProjection: mat4x4f,
  viewProjection: mat4x4f,
  /** xyz：从表面指向光源的方向（世界空间）；w：走多远（世界单位）。 */
  light: vec4f,
  /** x：走几步；y：厚度（挡在前面的东西被当作多厚，按到相机的距离的比例）；zw：宽高。 */
  params: vec4f,
};
@group(0) @binding(0) var<uniform> contact: Contact;
@group(0) @binding(1) var depth: texture_depth_2d;

/** 起点沿法线抬起多少、挡住至少要靠前多少（都按到相机的距离的比例）：深度缓冲按像素取样有量化误差，光线贴着表面走时会"撞"上表面自己。 */
const NORMAL_OFFSET = 0.002;
const MIN_OCCLUDER_GAP = 0.0005;

${GRADIENT_NOISE}

fn worldAt(uv: vec2f, z: f32) -> vec3f {
  let clip = contact.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, z, 1.0);
  return clip.xyz / clip.w;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(depth, pixel, 0);
  let size = contact.params.zw;
  let uv = (vec2f(pixel) + 0.5) / size;
  let origin = worldAt(uv, z);
  let eye = worldAt(uv, 0.0);
  // 法线由深度重建（导数要在分支之前取）；朝向相机那一面
  var normal = normalize(cross(dpdy(origin), dpdx(origin)));
  if (dot(normal, eye - origin) < 0.0) {
    normal = -normal;
  }
  if (z >= 1.0) {
    return vec4f(1.0);
  }
  // 背光的面直射项本来就是 0，不用再算；掠射的面上光线贴着表面走，最容易把自己当成挡住的东西
  if (dot(normal, contact.light.xyz) <= 0.0) {
    return vec4f(1.0);
  }
  let eyeDistance = distance(origin, eye);
  let start = origin + normal * eyeDistance * NORMAL_OFFSET;
  let startDepth = (contact.viewProjection * vec4f(start, 1.0)).w;
  let steps = i32(contact.params.x);
  let stepLength = contact.light.w / f32(steps);
  // 起点按像素错开一点（交错梯度噪声），走的步数少时也不出条纹
  let jitter = gradientNoise(vec2f(pixel));
  var lit = 1.0;
  for (var i = 1; i <= steps; i++) {
    let p = start + contact.light.xyz * stepLength * (f32(i) - jitter);
    let clip = contact.viewProjection * vec4f(p, 1.0);
    let ndc = clip.xyz / clip.w;
    let sampleUv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    if (any(sampleUv < vec2f(0.0)) || any(sampleUv > vec2f(1.0)) || clip.w <= 0.0) {
      break;
    }
    let sceneZ = textureLoad(depth, vec2i(sampleUv * size), 0);
    // 线性深度（clip.w）比：挡住的东西要比光线上的点靠前，但不能太靠前（那是背景前的另一个物体，光线从它后面过去）
    let sceneDepth = (contact.viewProjection * vec4f(worldAt(sampleUv, sceneZ), 1.0)).w;
    let gap = clip.w - sceneDepth;
    if (gap > MIN_OCCLUDER_GAP * startDepth && gap < contact.params.y * startDepth) {
      // 越靠近终点越淡，免得走到头时一刀切
      lit = f32(i) / f32(steps);
      lit = lit * lit;
      break;
    }
  }
  return vec4f(lit, 0.0, 0.0, 1.0);
}`;

export class ContactShadows {
  /** 默认关：Stride 没有它，开了以后和桌面 Stride 的画面不再逐像素一致。 */
  enabled = false;
  /** 朝光源走多远（世界单位）。 */
  length = 0.3;
  /** 走几步。 */
  steps = 16;
  /** 挡在前面的东西被当作多厚：比光线上的点靠前这么多以内才算挡住（按到相机的距离的比例），再靠前是光线从它后面过去。 */
  thickness = 0.005;

  readonly #device: GPUDevice;
  readonly #shader: FullscreenShader;
  readonly #arena: UniformArena;
  readonly #uniforms = new Float32Array(40);
  #result: GPUTexture | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#shader = new FullscreenShader(device, 'ContactShadows', SHADER);
    this.#arena = new UniformArena(device, 1024);
  }

  /**
   * 往这一帧的渲染图里加接触阴影的通道（深度预通道之后），返回结果贴图（全分辨率，见 RenderView.screenShadow）。
   * toLight 是从表面指向光源的单位向量（世界空间）。
   */
  record(frame: EffectFrame, depth: GPUTexture, view: RenderView, toLight: readonly [number, number, number]): GPUTexture {
    this.#arena.reset();
    const result = this.#resultFor(depth.width, depth.height);
    const u = this.#uniforms;
    u.set(view.inverseViewProjection, 0);
    u.set(view.viewProjection, 16);
    u.set([toLight[0], toLight[1], toLight[2], this.length], 32);
    u.set([this.steps, this.thickness, depth.width, depth.height], 36);
    // 结果写进自己的贴图（图外面的，着色时经视图的绑定组读）
    const target = frame.graph.import({ label: 'ContactShadows', width: result.width, height: result.height, format: SHADOW_FORMAT }, result.createView(), { texture: result });
    this.#shader.draw(frame, target, [this.#arena.push(u), depth]);
    return result;
  }

  /** 这一帧录的通道执行完以后调。 */
  flush(): void {
    this.#arena.flush();
  }

  warm(): Promise<void> | undefined {
    return this.#shader.warm([SHADOW_FORMAT]);
  }

  destroy(): void {
    this.#result?.destroy();
    this.#arena.destroy();
  }

  #resultFor(width: number, height: number): GPUTexture {
    if (this.#result?.width === width && this.#result.height === height) return this.#result;
    this.#result?.destroy();
    this.#result = this.#device.createTexture({
      label: `ContactShadows ${width}x${height}`, size: [width, height], format: SHADOW_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return this.#result;
  }
}
