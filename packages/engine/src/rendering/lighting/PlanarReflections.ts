/**
 * 平面反射（PlanarReflection 组件；同虚幻的 Planar Reflection、Unity HDRP 的 Planar Reflection Probe）：每帧把场景按平面镜像
 * 再画一遍，主画面着色时盒子里朝着平面法线的表面拿它当环境镜面反射。渲染系统一份（`renderSystem.planarReflections`）。
 *
 * - 镜像的相机：视图矩阵右乘关于平面的反射矩阵；投影再把 X 取反，行列式翻回正的，三角形的绕向不变（不用给每条管线加剔除翻转的
 *   变体），画面左右颠倒，着色时按屏幕坐标取的时候 u 翻回来。平面上的点镜像前后不动，所以主画面里地面上一个像素的倒影就在
 *   反射图的同一个（翻过的）屏幕位置。
 * - 平面以下的东西（地面本身、地下的）不能进倒影：投影的近平面换成反射平面（Lengyel 的斜裁剪，深度 0..1 的写法），往上挪一点
 *   免得地面自己闪。
 * - 反射图带 mip：粗糙的表面按粗糙度取模糊的那级（不是真的 GGX 卷积，近似）。
 * - 一帧只画一个：离相机最近、在相机前面、相机在它正面的那个。没有时着色器里不用（绑一张 1x1 的黑图）。
 */
import { Matrix } from '../../data/Matrix';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import type { GpuResources } from '../../graphics/GpuResources';
import { MipmapGenerator } from '../../graphics/MipmapGenerator';
import { PlanarReflection } from '../components';
import { RenderView, type RenderContext } from '../RenderSystem';

/** 反射图的格式：HDR。 */
export const PLANAR_FORMAT: GPUTextureFormat = 'rgba16float';
/** 斜裁剪的近平面往平面的正面挪多少（米）：地面自己（正好在平面上）不进倒影。 */
const CLIP_OFFSET = 0.01;

const REFLECT = new Float32Array(16);
const INVERSE = new Float32Array(16);
const BOX = new Float32Array(16);

/** 一个平面反射这一帧的样子：世界矩阵、设置、到相机的距离。 */
interface Candidate {
  readonly world: Float32Array;
  size: [number, number, number];
  resolution: number;
  distortion: number;
  intensity: number;
  distance: number;
}

export class PlanarReflections {
  /** 关掉时不画、着色时也不用（画质档位、调试用）。 */
  enabled = true;
  /**
   * 设备放得下视图的第 26 个绑定（屏幕的贴图：不透明阶段是平面反射图，透明阶段是折射拷的画面）没有：网格着色器的片元阶段已经
   * 用了 16 张（视图 7 张、材质 5 张、材质层的贴图），WebGPU 默认的上限就是 16（软件渲染、很多手机）；上限是 16 的设备上不画
   * 平面反射、不拷折射的画面，着色器里也不声明它（meshShader.ts 的 screenTextureCode）。
   */
  readonly supported: boolean;
  /** 这一帧镜像的视图（begin 设，不画时 undefined）。不接收阴影：倒影里的阴影是以后的事。 */
  readonly view = Object.assign(new RenderView(), { receivesShadows: false });
  /**
   * 主画面着色用的参数（MeshRenderFeature 写进主画面视图的常量）：世界到盒子的矩阵（盒子是 -1..1 的立方体）、
   * (用不用 1/0、最粗的 mip 级、1 / 主画面宽、1 / 主画面高)、(平面法线, 扭曲)、(强度, 0, 0, 0)。不画时 active 是 false。
   */
  readonly params = new Float32Array(16 + 12);
  active = false;
  /** 用这一帧的反射图着色的视图（主画面）；镜像的视图自己、别的视图不用。 */
  receiver: RenderView | undefined;
  /** 反射图（主画面绑定、着色时采样）；换了贴图就加一（MeshRenderFeature 据此重建绑定组）。 */
  generation = 0;

  readonly #device: GPUDevice;
  readonly #mipmaps: MipmapGenerator;
  readonly #empty: GPUTexture;
  #texture: GPUTexture | undefined;
  /** 这一帧挑中的那个（#candidate，复用一份）；没有时 undefined。 */
  #best: Candidate | undefined;
  readonly #candidate: Candidate = { world: new Float32Array(16), size: [0, 0, 0], resolution: 0.5, distortion: 0, intensity: 1, distance: Infinity };
  #eye = [0, 0, 0];

  constructor(device: GPUDevice, _resources: GpuResources) {
    this.#device = device;
    this.supported = device.limits.maxSampledTexturesPerShaderStage > 16;
    this.#mipmaps = new MipmapGenerator(device);
    this.#empty = device.createTexture({ label: 'PlanarReflections empty', size: [1, 1], format: PLANAR_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING });
  }

  /** 着色器采样的反射图：这一帧没有平面反射时是 1x1 的空图。 */
  get texture(): GPUTexture {
    return this.#texture ?? this.#empty;
  }

  /** 1x1 的空图：不用平面反射的视图绑它。 */
  get empty(): GPUTexture {
    return this.#empty;
  }

  /**
   * 每帧开头（剔除之前）：挑这一帧画的平面反射，按主画面算镜像的视图。返回它，不画时 undefined。
   */
  begin(context: RenderContext, main: RenderView): RenderView | undefined {
    this.active = false;
    this.#best = undefined;
    if (!this.enabled || !this.supported) return undefined;
    this.#eye = [main.eye.x, main.eye.y, main.eye.z];
    context.game.entities.run(this.#collect, context.time);
    // run 里设的：类型推断以为还是开头赋的 undefined
    const reflection = this.#best as Candidate | undefined;
    if (!reflection) return undefined;
    const world = reflection.world;
    const { normal, point } = planeOf(world);
    const d = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];

    // 视图：先按平面镜像，再是主相机的视图
    reflectionMatrix(REFLECT, normal, d);
    const view = this.view;
    Matrix.multiply(view.view, main.view, REFLECT);
    // 投影：主相机的，近平面换成反射平面（在镜像相机的视空间里），再把 X 取反
    view.projection.set(main.projection);
    // 斜裁剪的公式是正向 Z 的：反向 Z 的投影先换回正向（z 行换成 w − z，再换一次就回来），裁剪完再换回去
    if (main.reversedDepth) flipDepth(view.projection);
    obliqueNearPlane(view.projection, view.view, normal, d + CLIP_OFFSET);
    if (main.reversedDepth) flipDepth(view.projection);
    for (const i of [0, 4, 8, 12]) view.projection[i] = -view.projection[i]!;
    view.nearClipPlane = main.nearClipPlane;
    view.farClipPlane = main.farClipPlane;
    view.cullingMask = main.cullingMask;
    view.width = Math.max(1, Math.round(main.width * reflection.resolution));
    view.height = Math.max(1, Math.round(main.height * reflection.resolution));
    view.update();
    this.#ensureTexture(view.width, view.height);

    // 着色用的参数：盒子是实体的世界矩阵乘 size 的一半（-1..1）
    Matrix.multiply(BOX, world, Matrix.scaleTranslation(INVERSE, reflection.size[0] / 2, reflection.size[1] / 2, reflection.size[2] / 2, 0, 0, 0));
    Matrix.invert(INVERSE, BOX);
    this.params.set(INVERSE, 0);
    this.params.set([1, this.texture.mipLevelCount - 1, 1 / main.width, 1 / main.height], 16);
    this.params.set([normal[0], normal[1], normal[2], reflection.distortion], 20);
    this.params.set([reflection.intensity, 0, 0, 0], 24);
    this.active = true;
    this.receiver = main;
    return view;
  }

  /** 镜像的画面画进哪（反射图的第 0 级）；begin 返回了视图时才有。 */
  target(): GPUTextureView | undefined {
    return this.active && this.#texture ? this.#texture.createView({ baseMipLevel: 0, mipLevelCount: 1 }) : undefined;
  }

  /** 画完之后（录进同一个编码器）：出 mip（粗糙的表面取模糊的级）。 */
  finish(encoder: GPUCommandEncoder): void {
    if (this.active && this.#texture) this.#mipmaps.generate(this.#texture, encoder);
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#empty.destroy();
  }

  /** 离相机最近、相机在它正面的那个（相机到平面的距离是正的才算）。 */
  readonly #collect = system('PlanarReflections.collect', {
    with: { reflection: PlanarReflection, transform: Transform },
    update: ({ reflection, transform, count }) => {
      const [x, y, z] = this.#eye;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16, world = transform.renderWorld.subarray(w, w + 16);
        const { normal, point } = planeOf(world);
        const above = (x! - point[0]) * normal[0] + (y! - point[1]) * normal[1] + (z! - point[2]) * normal[2];
        if (above <= CLIP_OFFSET) continue;
        const distance = Math.hypot(x! - point[0], y! - point[1], z! - point[2]);
        if (this.#best && distance >= this.#best.distance) continue;
        const best = (this.#best = this.#candidate);
        best.world.set(world);
        best.size = [reflection.size[i * 3]!, reflection.size[i * 3 + 1]!, reflection.size[i * 3 + 2]!];
        best.resolution = reflection.resolution[i]!;
        best.distortion = reflection.distortion[i]!;
        best.intensity = reflection.intensity[i]!;
        best.distance = distance;
      }
    },
  });

  #ensureTexture(width: number, height: number): void {
    if (this.#texture && this.#texture.width === width && this.#texture.height === height) return;
    this.#texture?.destroy();
    this.#texture = this.#device.createTexture({
      label: 'PlanarReflections', size: [width, height], format: PLANAR_FORMAT, mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.generation++;
  }
}

/** 实体的世界矩阵定的平面：过原点、法线是本地 +Y（单位化）。 */
function planeOf(world: Float32Array): { normal: [number, number, number]; point: [number, number, number] } {
  const length = Math.hypot(world[4]!, world[5]!, world[6]!) || 1;
  return { normal: [world[4]! / length, world[5]! / length, world[6]! / length], point: [world[12]!, world[13]!, world[14]!] };
}

/** 关于平面 n·x = d 的反射矩阵（列主序）：x' = x - 2 (n·x - d) n。 */
function reflectionMatrix(out: Float32Array, [x, y, z]: readonly [number, number, number], d: number): void {
  out.set([
    1 - 2 * x * x, -2 * x * y, -2 * x * z, 0,
    -2 * y * x, 1 - 2 * y * y, -2 * y * z, 0,
    -2 * z * x, -2 * z * y, 1 - 2 * z * z, 0,
    2 * d * x, 2 * d * y, 2 * d * z, 1,
  ]);
}

/** 投影的深度在正向 Z 和反向 Z 之间换：裁剪空间的 z 换成 w − z（行 3 换成行 4 减行 3），换两次是原样。 */
function flipDepth(projection: Float32Array): void {
  for (let c = 0; c < 4; c++) projection[c * 4 + 2] = projection[c * 4 + 3]! - projection[c * 4 + 2]!;
}

/**
 * Lengyel 的斜裁剪（深度 0..1 的写法）：把投影的近平面换成平面 n·x = d（世界空间，正面朝相机看的那边留下），view 是这个相机的
 * 视图矩阵。投影的第三行换成视空间里的平面，按远角缩放，远平面跟着斜过去。
 */
function obliqueNearPlane(projection: Float32Array, view: Float32Array, normal: readonly number[], d: number): void {
  // 平面变进视空间：plane_view = (V⁻¹)ᵀ · plane_world
  Matrix.invert(INVERSE, view);
  const world = [normal[0]!, normal[1]!, normal[2]!, -d];
  const plane = [0, 1, 2, 3].map((row) => INVERSE[row * 4]! * world[0]! + INVERSE[row * 4 + 1]! * world[1]! + INVERSE[row * 4 + 2]! * world[2]! + INVERSE[row * 4 + 3]! * world[3]!);
  // 裁剪空间里平面对面的那个远角，变回视空间（投影矩阵的逆，只取用得到的几项）
  const p = projection;
  const qx = (Math.sign(plane[0]!) + p[8]!) / p[0]!;
  const qy = (Math.sign(plane[1]!) + p[9]!) / p[5]!;
  const qz = -1;
  const qw = (1 + p[10]!) / p[14]!;
  const scale = 1 / (plane[0]! * qx + plane[1]! * qy + plane[2]! * qz + plane[3]! * qw);
  p[2] = plane[0]! * scale;
  p[6] = plane[1]! * scale;
  p[10] = plane[2]! * scale;
  p[14] = plane[3]! * scale;
}
