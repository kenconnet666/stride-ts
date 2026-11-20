/**
 * 渲染系统的骨架，名字和阶段照 Stride（Rendering/RenderSystem.cs）：合成器先收集视图（Collect），
 * 然后各个根渲染特性从实体里提取这一帧要画的东西（Extract）、上传数据（Prepare），最后按视图和阶段绘制（Draw）。
 * 和 Stride 不同的地方：没有通用的 RenderObject / RenderNode 列表，每个特性直接按列遍历实体（数据导向），
 * 剔除也由特性自己做（Cull，在 stride-native 里），还没有排列组合（效果系统等内容管线）。
 */
import type { SceneEntityFile } from '../content/format';
import type { Game } from '../games/Game';
import type { GameTime } from '../games/GameTime';
import type { GraphicsDevice } from '../graphics/GraphicsDevice';
import { Matrix } from '../mathematics/Matrix';
import { Color4, Vector3 } from '../mathematics/vectors';
import { GpuResources } from './GpuResources';
import type { Skybox } from './Skybox';
import { SubsurfaceMaterials } from './SubsurfaceScattering';

/** 一帧渲染里各阶段都要用的东西。 */
export interface RenderContext {
  readonly game: Game;
  readonly time: GameTime;
}

/**
 * 图形合成器的根渲染器（Stride 的 GraphicsCompositor.Game，ISceneRenderer）：每帧画整个画面。默认是前向渲染器，游戏可以换成
 * 自己的（比如 SpriteFonts 的 FontRenderer 只用 SpriteBatch 画字）。
 */
export interface SceneRenderer {
  draw(context: RenderContext): void;
  destroy?(): void;
}

/** 一个阶段画进去的目标格式（Stride 的 RenderOutputDescription）；只画深度的阶段没有颜色格式。 */
export interface RenderOutput {
  readonly colorFormat?: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  /**
   * 颜色之外还要写的表面（屏幕空间反射用，见 SURFACE_FORMATS）：不透明的网格按顺序写法线和粗糙度、镜面颜色，别的特性
   * 不写（这几个目标的写掩码是 0）。
   */
  readonly surfaceFormats?: readonly GPUTextureFormat[];
}

/**
 * 屏幕空间反射要的表面（RenderOutput.surfaceFormats），合成时用反射换掉着色时加的环境镜面反射：
 * 0. 法线（世界空间，八面体编码）、粗糙度、有没有表面（a）；
 * 1. 环境镜面反射的权重 w（镜面颜色乘 DFG，玻璃是它的反射比例；没有镜面反射的材质是 0）；
 * 2. 着色时加进去的环境镜面反射 E（环境光、天空盒的镜面项，已经乘过 w、遮蔽、强度）；a 是次表面散射的槽位 + 强度（没有是 0，
 *    见 SubsurfaceScattering.ts）。散射材质的像素 rgb 换成颜色里不散射的部分，不做反射。
 * 合成：颜色 += 命中的把握 · (w · 反射 - E)。
 */
export const SURFACE_FORMATS: readonly GPUTextureFormat[] = ['rgba16float', 'rgba8unorm', 'rgba16float'];

/**
 * 画进这个阶段的管线的颜色目标：主颜色，加上阶段要留的表面（RenderOutput.surfaceFormats）。表面只有不透明的网格写，别的
 * 特性的管线也要带上这几个目标（同一个渲染通道里每个附件都要有对应的目标），写掩码给 0。
 */
export function colorTargets(stage: RenderStage, color: GPUColorTargetState): GPUColorTargetState[] {
  return [color, ...(stage.output.surfaceFormats ?? []).map((format) => ({ format, writeMask: 0 }))];
}

/** 渲染阶段（Opaque、Transparent、ShadowMapCaster……）：决定用哪套管线、画进什么格式。 */
export class RenderStage {
  readonly name: string;
  readonly output: RenderOutput;
  /** 阴影投射阶段：只画投射阴影的物体、只写深度（Stride 的 ShadowMapRenderStageSelector 选进来的）。 */
  readonly shadowCasters: boolean;
  /** 透明阶段（Stride 的 Transparent）：不透明的画完之后，混合着画（精灵、以后的透明材质）。 */
  readonly transparent: boolean;
  /**
   * 阴影投射阶段按近、远平面裁剪（Stride 的 ShadowMeshPipelineProcessor.DepthClipping）：透视的阴影视图（点光的六个面）要裁，
   * 方向光的级联不裁（级联前面的物体也要投下阴影）。
   */
  readonly depthClip: boolean;
  /**
   * 这个阶段画之前，同样的物体已经在深度预通道里画过：网格只比较深度相等、不再写深度（被挡住的像素不着色）。
   * 渲染器保证预通道和这个阶段画的是同一批东西。
   */
  readonly afterDepthPrepass: boolean;
  /** 点选用的编号缓冲（ScenePicker）：颜色写的是实例的编号；透明、不透明的都画，只有 supportsPicking 的特性画。 */
  readonly picking: boolean;
  /** 线框（调试视图）：网格的三角形的边画成线，叠在画好的场景上面；透明、不透明的都画，只有网格画。 */
  readonly wireframe: boolean;
  /**
   * 运动向量（TAA 用）：每个像素上一帧在画面上的位置减这一帧的（UV）。只画不透明的、supportsVelocity 的特性，比较深度相等
   * （不透明的已经画完、深度写好了）。
   */
  readonly velocity: boolean;

  constructor(
    name: string, output: RenderOutput,
    { shadowCasters = false, transparent = false, depthClip = false, afterDepthPrepass = false, picking = false, wireframe = false, velocity = false }:
    { shadowCasters?: boolean; transparent?: boolean; depthClip?: boolean; afterDepthPrepass?: boolean; picking?: boolean; wireframe?: boolean; velocity?: boolean } = {},
  ) {
    this.velocity = velocity;
    this.picking = picking;
    this.wireframe = wireframe;
    this.name = name;
    this.output = output;
    this.shadowCasters = shadowCasters;
    this.transparent = transparent;
    this.depthClip = depthClip;
    this.afterDepthPrepass = afterDepthPrepass;
  }
}

/** 画进目标的一块矩形（像素）。 */
export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 所有渲染组（Stride 的 RenderGroupMask.All）。 */
export const RENDER_GROUP_ALL = 0xffffffff;

/** 渲染组 group 在不在掩码 mask 里。 */
export function inRenderMask(mask: number, group: number): boolean {
  return ((mask >>> group) & 1) === 1;
}

/** 一个视角：相机、阴影级联等。矩阵的布局见 mathematics/Matrix.ts。 */
export class RenderView {
  readonly view = Matrix.identity();
  readonly projection = Matrix.identity();
  readonly viewProjection = Matrix.identity();
  /** 背景用它把屏幕坐标变回世界方向。 */
  readonly inverseViewProjection = Matrix.identity();
  /**
   * 屏幕空间的环境光遮蔽，着色时乘环境光；只有主画面有。GTAO（AmbientOcclusion.record）的是 r 通道的遮蔽；screenIndirect 时是
   * 屏幕空间全局光照（ScreenSpaceGlobalIllumination.record）的：rgb 间接光（着色时乘漫反射颜色加上）、a 遮蔽。screenIndirect 在写
   * 视图的 uniform（prepare）之前就要定下来，贴图在深度预通道之后才有。
   */
  screenOcclusion: GPUTexture | undefined;
  screenIndirect = false;
  /** 投阴影的方向光的接触阴影（ContactShadows.record 的结果），着色时乘那盏光；只有主画面有。 */
  screenShadow: GPUTexture | undefined;
  /** 运动向量用（TemporalAntialiasing.jitter 设）：这一帧没挪过亚像素的视图投影、上一帧的。 */
  readonly unjitteredViewProjection = Matrix.identity();
  readonly previousViewProjection = Matrix.identity();
  /** 相机在世界空间的位置（镜面反射要用视线方向）。 */
  readonly eye = new Vector3();
  nearClipPlane = 0.1;
  farClipPlane = 1000;
  /** 在 RenderSystem.views 里的下标；特性按它给每个视图的常量分块。 */
  index = -1;
  /** 目标的宽高（像素）；阴影图的大小按主视图的算。 */
  width = 1;
  height = 1;
  /** 画进目标的哪一块（阴影图集里的一个级联）；undefined 是整个目标。 */
  viewport: Viewport | undefined;
  /** 着色时用不用方向光的阴影；阴影级联是按主视图算的，别的相机（画进渲染目标贴图的）暂时不用。 */
  receivesShadows = true;
  /**
   * 画哪些渲染组（Stride 的 RenderView.CullingMask，合成器里相机渲染器的 RenderMask）：第 g 位是 1 时画第 g 组。
   * 默认全画。
   */
  cullingMask = RENDER_GROUP_ALL;
  /** 朝内的视锥平面：左、右、下、上、近、远，每个 xyzw（Matrix.frustumPlanes）。update() 算。 */
  readonly frustumPlanes = new Float32Array(24);
  /**
   * 相机近平面（法线是相机的前方，w = dot(n, 近平面上的点)，距离 = dot(n, p) - w），量可见物体的距离用，
   * 同 Stride 的 VisibilityGroup。update() 算。
   */
  readonly nearPlane = new Float32Array(4);
  /** 剔除时忽略近、远平面（Stride 的 VisiblityIgnoreDepthPlanes）：阴影级联前后的物体也要投下阴影。 */
  ignoreDepthPlanes = false;
  /** 可见物体的包围盒到近平面的最近、最远距离（Stride 的 MinimumDistance、MaximumDistance），剔除后才有。 */
  minimumDistance = Infinity;
  maximumDistance = -Infinity;

  /** 由 view 和 projection 算出其余的矩阵、相机位置和剔除用的平面。 */
  update(): void {
    Matrix.multiply(this.viewProjection, this.projection, this.view);
    Matrix.invert(this.inverseViewProjection, this.viewProjection);
    Matrix.frustumPlanes(this.frustumPlanes, this.viewProjection);
    if (!Matrix.invert(CAMERA_WORLD, this.view)) return;
    this.eye.set(CAMERA_WORLD[12]!, CAMERA_WORLD[13]!, CAMERA_WORLD[14]!);
    // 相机看向本地 -Z
    const fx = -CAMERA_WORLD[8]!, fy = -CAMERA_WORLD[9]!, fz = -CAMERA_WORLD[10]!;
    const length = Math.hypot(fx, fy, fz) || 1;
    const nx = fx / length, ny = fy / length, nz = fz / length;
    const near = this.nearClipPlane;
    this.nearPlane.set([nx, ny, nz, nx * (this.eye.x + nx * near) + ny * (this.eye.y + ny * near) + nz * (this.eye.z + nz * near)]);
  }
}

/** 根渲染特性（Stride 的 RootRenderFeature）：负责一类可画的东西，比如网格。 */
export abstract class RootRenderFeature {
  /** 名字（调试统计里用；类名在正式构建里会被压缩，所以显式写）。 */
  abstract readonly name: string;
  #system: RenderSystem | undefined;

  /** 加入渲染系统后可用。 */
  get system(): RenderSystem {
    if (!this.#system) throw new Error(`${this.name} has not been added to a RenderSystem`);
    return this.#system;
  }

  /** @internal 由 RenderSystem.addFeature 调用。 */
  attach(system: RenderSystem): void {
    this.#system = system;
  }

  /** 从实体里取出这一帧要画的东西，只在 CPU 上做。 */
  abstract extract(context: RenderContext): void;
  /** 这一帧有没有东西要画进只写深度的阶段（深度预通道）；都没有时渲染器不开这一遍。extract 之后才准。 */
  get drawsDepth(): boolean {
    return false;
  }
  /** 会不会画点选的编号缓冲（RenderStage.picking）；不会的特性在那个阶段不被调用。 */
  get supportsPicking(): boolean {
    return false;
  }
  /** 会不会画运动向量（RenderStage.velocity）；不会的特性在那个阶段不被调用（那里按深度重投影）。 */
  get supportsVelocity(): boolean {
    return false;
  }

  /** 会不会画线框（RenderStage.wireframe）；不会的特性在那个阶段不被调用。 */
  get supportsWireframe(): boolean {
    return false;
  }
  /**
   * 剔除：算出每个视图里可见的东西，并把可见物体的距离并进视图的 minimumDistance、maximumDistance。
   * 一帧里可能调用多次（先主视图，再按主视图的距离范围算出的阴影级联）。
   */
  cull(_context: RenderContext, _views: readonly RenderView[]): void {}
  /** 上传这一帧的数据；这时视图都已收集好。 */
  abstract prepare(context: RenderContext): void;
  /** 把这个特性的东西画进一个视图的一个阶段。 */
  abstract draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void;
  /** 上一帧的统计（调试的 perf 命令读），比如画了多少实例、多少次绘制。 */
  stats(): Record<string, number> {
    return {};
  }
  /**
   * 预热：要加载的这些实体会让这个特性在 stages 里画东西时要的管线，在后台编好（ContentManager.pipelineWarmer）。返回编着的；
   * 网格要按加载好的模型算，走 MeshRenderFeature.warm。
   */
  warmFiles(_files: readonly SceneEntityFile[], _stages: readonly RenderStage[]): Promise<void>[] {
    return [];
  }
  destroy(): void {}
}

const CAMERA_WORLD = Matrix.identity();

/** 天空盒光：天空盒、强度和实体的旋转。 */
export interface SkyboxLight {
  skybox: Skybox;
  intensity: number;
  /** 天空盒实体世界矩阵的旋转部分（列主序 4x4，平移为 0）。 */
  readonly rotation: Float32Array;
}

/** 方向光的阴影设置（Stride 的 LightDirectionalShadowMap），来自 Light 组件。 */
export interface DirectionalShadowSettings {
  size: ShadowMapSize;
  filter: ShadowMapFilter;
  cascadeCount: 1 | 2 | 4;
  /** 从阴影空间的深度里减去的偏移。 */
  depthBias: number;
  /** 沿法线把采样点推出去的比例（按阴影图集的像素大小和 1 - N·L 缩放）。 */
  normalOffsetScale: number;
  stabilization: ShadowStabilization;
  /** 对数划分里对数分布的比重是 1 - pssmFactor。 */
  pssmFactor: number;
  /** automatic：按可见物体的距离范围；manual：相机近平面加 minDistance 到 maxDistance。 */
  depthRange: 'automatic' | 'manual';
  minDistance: number;
  maxDistance: number;
  /** 相邻级联在交界处混合。 */
  blendCascades: boolean;
  /** 光源的角直径（度，太阳约 0.53）：pcss 的半影按它算。 */
  lightAngle: number;
}

/** 点光、聚光的阴影设置（Stride 的 LightPointShadowMap、LightStandardShadowMap），来自 Light 组件。 */
export interface LocalShadowSettings {
  size: ShadowMapSize;
  filter: ShadowMapFilter;
  depthBias: number;
  normalOffsetScale: number;
}

export type ShadowMapSize = 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
/** none 是一次比较采样，pcfNxN 是 Stride 的 PCF 核，pcss 是接触硬化的软阴影（方向光；点光、聚光按 pcf7x7）。 */
export type ShadowMapFilter = 'none' | 'pcf3x3' | 'pcf5x5' | 'pcf7x7' | 'pcss';
export type ShadowStabilization = 'none' | 'viewSnapping' | 'projectionSnapping';

/** 着色时要的阴影数据（Stride 的 ShadowMapReceiverDirectional 的参数），由 ShadowMapRenderer 每帧填。 */
export interface ShadowReceiver {
  cascadeCount: number;
  /** 每个级联 16 个 float：世界坐标到图集 UV（xy）和深度（z）。 */
  readonly worldToShadow: Float32Array;
  /** 每个级联的结束距离（视图空间的深度）。 */
  readonly splits: Float32Array;
  depthBias: number;
  normalOffsetScale: number;
  /** 0：单次比较采样；3、5、7：PCF 的核大小；1：PCSS。 */
  filterSize: number;
  /** PCSS 用：光源角半径的正切（半影的半径 = 遮挡物到这里的距离 × 它）。 */
  penumbraTangent: number;
  blendCascades: boolean;
  depthRangeAutomatic: boolean;
}

/**
 * 着色时要的一盏点光或聚光的阴影（Stride 的 ShadowMapReceiverPointCubeMap、ShadowMapReceiverSpot 的参数），由 ShadowMapRenderer
 * 每帧填。点光是立方体的六个面各占图集里一块，聚光只有一块。
 */
export interface LocalShadowReceiver {
  point: boolean;
  /** 每个面 16 个 float：世界坐标到图集 UV（xy）和深度（z）；聚光只用第一个。 */
  readonly worldToShadow: Float32Array;
  /** 点光：深度 = depthA + depthB / 沿这个面的轴到光源的距离（Stride 的 CameraKeys.ZProjectionACalculate）。 */
  depthA: number;
  depthB: number;
  depthBias: number;
  normalOffsetScale: number;
  /** 0：单次比较采样；3、5、7：PCF 的核大小。 */
  filterSize: number;
}

/** 最多几个方向光（Stride 的 LightDirectionalGroupRenderer 默认也是一组最多 8 个；4 个足够常见的场景）。 */
export const MAX_DIRECTIONAL_LIGHTS = 4;

/** 一个方向光。 */
export interface DirectionalLight {
  /** 光线前进的方向（世界空间，不必归一化）。 */
  readonly direction: Vector3;
  /** 线性空间的颜色乘强度。 */
  readonly color: Color4;
}

/**
 * 这一帧的光照：最多 MAX_DIRECTIONAL_LIGHTS 个方向光、环境光和一个天空盒光（点光源以后加）。
 * 和 Stride 不同（暂时）：只有一个方向光能投阴影（第一个打开阴影的），其余的不投。
 */
/** 一帧最多这么多个点光和聚光（超出的不画）。 */
export const MAX_LOCAL_LIGHTS = 256;

/**
 * 点光或聚光（Stride 的 LightPoint、LightSpot）：位置、颜色乘强度、半径平方的倒数（距离衰减到 0 的地方）；聚光还有照向的
 * 方向和角度衰减的 scale、offset（saturate(dot(-L, direction) · scale + offset)²）。
 */
export interface LocalLight {
  spot: boolean;
  readonly position: Vector3;
  readonly direction: Vector3;
  readonly color: Color4;
  /** 点光的半径、聚光的射程。 */
  radius: number;
  invSquareRadius: number;
  angleScale: number;
  angleOffset: number;
  /** 聚光外锥的全角（度），阴影视图的视场角。 */
  angleOuter: number;
  /** 投不投阴影（Light.shadow）；投的时候 shadow 里是设置，world 是光源实体的世界矩阵（聚光的阴影视图按它摆）。 */
  castsShadow: boolean;
  readonly shadow: LocalShadowSettings;
  readonly world: Float32Array;
  /** 这一帧它的阴影在 Lighting.localShadows 里的下标；不投阴影、或者图集放不下时是 -1。ShadowMapRenderer 填。 */
  shadowIndex: number;
}

/** 一盏还没用上的点光或聚光（Lighting.locals 预先分配）。 */
export function createLocalLight(): LocalLight {
  return {
    spot: false, position: new Vector3(), direction: new Vector3(), color: new Color4(), radius: 1, invSquareRadius: 1, angleScale: 0, angleOffset: 1, angleOuter: 35,
    castsShadow: false, shadow: { size: 'medium', filter: 'none', depthBias: 0.01, normalOffsetScale: 10 }, world: new Float32Array(16), shadowIndex: -1,
  };
}

export interface Lighting {
  /** 预先分配了 MAX_DIRECTIONAL_LIGHTS 个，前 directionalCount 个有效。 */
  readonly directionals: readonly DirectionalLight[];
  directionalCount: number;
  /** 投阴影的方向光在 directionals 里的下标；没有时是 -1。 */
  shadowLight: number;
  /** 投阴影的方向光的阴影设置；没有时是 undefined。 */
  directionalShadow: DirectionalShadowSettings | undefined;
  /** 这一帧画好的方向光的阴影；没有时是 undefined。 */
  shadow: ShadowReceiver | undefined;
  /** 这一帧的阴影图集（方向光、点光、聚光共用一张）；没有任何阴影时是 undefined。 */
  shadowAtlas: GPUTexture | undefined;
  /** 环境光：线性空间的颜色乘强度。 */
  readonly ambient: Color4;
  /** 没有天空盒光时是 undefined。 */
  skybox: SkyboxLight | undefined;
  /** 预先分配了 MAX_LOCAL_LIGHTS 个，前 localCount 个有效。 */
  readonly locals: readonly LocalLight[];
  localCount: number;
  /** 这一帧画好的点光、聚光的阴影，前 localShadowCount 个有效（按需变长）。 */
  readonly localShadows: LocalShadowReceiver[];
  localShadowCount: number;
}

export class RenderSystem {
  readonly graphicsDevice: GraphicsDevice;
  readonly features: RootRenderFeature[] = [];
  /** 场景里用到的次表面散射材质（网格特性上传材质时登记槽位，合成器做模糊时读核）。 */
  readonly subsurfaceMaterials = new SubsurfaceMaterials();
  /** 这一帧的视图，由合成器在 Collect 时填。 */
  readonly views: RenderView[] = [];
  /** 这一帧的光照，由合成器在 Collect 时从 Light 组件收集。 */
  readonly lighting: Lighting = {
    directionals: directionalLights(),
    directionalCount: 0,
    shadowLight: -1,
    directionalShadow: undefined,
    shadow: undefined,
    shadowAtlas: undefined,
    ambient: new Color4(),
    skybox: undefined,
    locals: Array.from({ length: MAX_LOCAL_LIGHTS }, createLocalLight),
    localCount: 0,
    localShadows: [],
    localShadowCount: 0,
  };
  /** 场景里没有 Light 组件时用的光照（直射光的漫反射要除以 π，所以强度 3 大约是满亮度）。 */
  readonly defaultLighting: Lighting = {
    directionals: [{ direction: new Vector3(-0.4, -1, -0.6), color: new Color4(3, 3, 3, 1) }],
    directionalCount: 1,
    shadowLight: -1,
    directionalShadow: undefined,
    shadow: undefined,
    shadowAtlas: undefined,
    ambient: new Color4(0.15, 0.15, 0.18, 1),
    skybox: undefined,
    locals: [],
    localCount: 0,
    localShadows: [],
    localShadowCount: 0,
  };
  /** 特性共用的贴图、立方体贴图和采样器。 */
  readonly resources: GpuResources;

  constructor(graphicsDevice: GraphicsDevice) {
    this.graphicsDevice = graphicsDevice;
    this.resources = new GpuResources(graphicsDevice.device);
  }

  get device(): GPUDevice {
    return this.graphicsDevice.device;
  }

  addFeature<F extends RootRenderFeature>(feature: F): F {
    feature.attach(this);
    this.features.push(feature);
    return feature;
  }

  /** Collect：这一帧要画的视图（先清空）。 */
  collect(views: readonly RenderView[]): void {
    this.views.length = 0;
    this.addViews(views);
  }

  /** 追加视图（阴影级联在主视图剔除之后才算得出来）。 */
  addViews(views: readonly RenderView[]): void {
    for (const view of views) {
      view.index = this.views.length;
      this.views.push(view);
    }
  }

  extract(context: RenderContext): void {
    for (const feature of this.features) feature.extract(context);
  }

  /** 剔除这些视图：先重置距离范围，再交给各特性。 */
  cull(context: RenderContext, views: readonly RenderView[]): void {
    for (const view of views) {
      view.minimumDistance = Infinity;
      view.maximumDistance = -Infinity;
    }
    for (const feature of this.features) feature.cull(context, views);
  }

  prepare(context: RenderContext): void {
    for (const feature of this.features) feature.prepare(context);
  }

  draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    for (const feature of this.features) {
      if ((!stage.picking || feature.supportsPicking) && (!stage.wireframe || feature.supportsWireframe) && (!stage.velocity || feature.supportsVelocity)) feature.draw(context, pass, view, stage);
    }
  }

  /** 这一帧有没有特性要画深度预通道（纯 2D 的画面没有网格，这一遍是空的，可以省掉）。 */
  get drawsDepth(): boolean {
    return this.features.some((feature) => feature.drawsDepth);
  }

  destroy(): void {
    for (const feature of this.features) feature.destroy();
    this.resources.destroy();
  }
}

function directionalLights(): DirectionalLight[] {
  return Array.from({ length: MAX_DIRECTIONAL_LIGHTS }, () => ({ direction: new Vector3(), color: new Color4() }));
}
