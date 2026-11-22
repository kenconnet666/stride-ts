/**
 * 场景文件和预制体文件（说明见 format.ts）：实体和它的各种组件、场景级的设置（合成器、物理、导航）、粒子系统的模块、
 * 游戏设置。不依赖别的模块（除了同目录的格式文件）。
 */
import type { ParticleModuleFile, SpriteBlend, TextureRef, Vec3Tuple } from './assetFormat';

/** 方向光的阴影设置（Stride 的 LightDirectionalShadowMap），各字段的意思见 Light 组件。 */
export interface SceneLightShadow {
  readonly size: 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
  readonly filter: 'none' | 'pcf3x3' | 'pcf5x5' | 'pcf7x7' | 'pcss';
  readonly cascadeCount: 'one' | 'two' | 'four';
  readonly depthBias: number;
  readonly normalOffsetScale: number;
  readonly stabilization: 'none' | 'viewSnapping' | 'projectionSnapping';
  readonly pssmFactor: number;
  readonly depthRange: 'automatic' | 'manual';
  readonly minDistance: number;
  readonly maxDistance: number;
  readonly blendCascades: boolean;
  /** 光源的角直径（度），pcss 用；没写是 0.53（太阳）。Stride 没有。 */
  readonly lightAngle?: number;
}

/**
 * 点光、聚光的阴影设置（Stride 的 LightPointShadowMap、LightStandardShadowMap）。点光的阴影是立方体的六个面；
 * 和 Stride 不同：Stride 可以选抛物面的画法（LightPointShadowMapType.DualParaboloid），我们都按立方体画。
 */
export type SceneLocalLightShadow = Pick<SceneLightShadow, 'size' | 'filter' | 'depthBias' | 'normalOffsetScale'>;

/** 碰撞体里的一个形状（Stride.BepuPhysics 的 BoxCollider、CapsuleCollider…… 加 CompoundCollider 的本地位姿）。 */
export type ColliderShapeFile = (
  | { readonly type: 'box'; /** 边长。 */ readonly size: Vec3Tuple }
  /** Stride 的 EmptyCollider：没有形状、不碰撞，只能单独用。 */
  | { readonly type: 'empty' }
  | { readonly type: 'sphere'; readonly radius: number }
  /** 沿本地 Y，length 是两端球心的距离。 */
  | { readonly type: 'capsule'; readonly radius: number; readonly length: number }
  | { readonly type: 'cylinder'; readonly radius: number; readonly length: number }
  /** Stride 的 MeshCollider：模型（内容路径）的全部三角形，按实体的世界缩放。 */
  | { readonly type: 'mesh'; readonly model: string }
  /**
   * Stride 的 ConvexHullCollider 加 HullAsset（不做分解）：模型（内容路径）全部顶点的凸包，顶点先按 hull 的 scale、rotation、
   * offset 变换（HullAsset 的 Scaling、LocalRotation、LocalOffset），按实体的世界缩放。
   */
  | {
    readonly type: 'convexHull';
    readonly model: string;
    readonly hull: { readonly scale: Vec3Tuple; readonly rotation: readonly [number, number, number, number]; readonly offset: Vec3Tuple };
  }
) & {
  readonly position: Vec3Tuple;
  readonly rotation: readonly [number, number, number, number];
  readonly mass: number;
};

/** 物理物体的公共部分（Stride 的 CollidableComponent）。 */
export interface SceneCollidable {
  readonly shapes: readonly ColliderShapeFile[];
  /**
   * 形状的尺寸和本地位置按世界单位，不跟着实体的缩放（Stride 的规则：它只缩放网格）。从 Stride 导入的、2026-11-22 以前做的
   * 场景里缩放过的实体是这样；没写时跟着实体的世界缩放（编辑器里缩放实体，碰撞体一起变）。
   */
  readonly absoluteSize?: boolean;
  /** CollisionLayer，0..31。 */
  readonly layer: number;
  readonly friction: number;
  /** ContactEventHandler 是 Stride 的 Trigger。 */
  readonly trigger?: boolean;
}

/** Stride.BepuPhysics 的 BodyComponent：动态（或运动学）刚体。 */
export interface SceneBody extends SceneCollidable {
  readonly kinematic: boolean;
  readonly gravity: boolean;
  /** SleepThreshold；负数一直醒着。 */
  readonly sleepThreshold: number;
  readonly interpolated: boolean;
}

/** Stride 的 CharacterComponent。 */
export interface SceneCharacter extends SceneCollidable {
  readonly speed: number;
  readonly jumpForce: number;
  readonly maximumHorizontalForce: number;
  readonly maximumVerticalForce: number;
  readonly slopeAngle: number;
  readonly airControlForceScale: number;
  readonly airControlScale: number;
  readonly gravity: boolean;
  readonly interpolated: boolean;
}

/** 前向渲染器的设置（Stride 的 ForwardRenderer）。 */
export interface SceneForwardRenderer {
  /** 线性空间的清屏色。 */
  readonly clearColor: readonly [number, number, number, number];
  /** 后处理（Stride 的 ForwardRenderer.PostEffects）；null 是没有后处理。 */
  readonly postEffects: ScenePostEffects | null;
  /** 这台相机画哪些渲染组（Stride 的 SceneCameraRenderer.RenderMask，第 g 位是第 g 组）；没写是全部。 */
  readonly renderMask?: number;
  /** 画不画透明阶段（Stride 的 TransparentRenderStage 不为 null）；画进渲染目标贴图的常常不画，贴图里就不会再出现贴图自己。 */
  readonly transparent: boolean;
  /** 次表面散射的模糊（Stride 的 ForwardRenderer.SubsurfaceScatteringBlurEffect 不为 null）；没写是关着。 */
  readonly subsurfaceScattering?: true;
}

/** 后处理里各效果开不开（Stride 的 PostProcessingEffects 下各效果的 Enabled），只有运行时有的效果。 */
export interface ScenePostEffects {
  readonly brightFilter: boolean;
  readonly bloom: boolean;
  readonly lightStreak: boolean;
  readonly lensFlare: boolean;
  /** 色调映射（ColorTransforms 里的 ToneMap）；关掉时 HDR 画面加上泛光等叠加层直接输出，超过 1 的截断。 */
  readonly toneMap: boolean;
  /** 抗锯齿（Stride 的 Antialiasing，FXAA）。 */
  readonly antialiasing: boolean;
  /**
   * 抗锯齿用哪种（Stride 没有 TAA）：fxaa（没写时，Stride 的内容照原样画）或 temporal（时间抗锯齿加锐化，见
   * rendering/screenspace/TemporalAntialiasing.ts）。编辑器新建的场景是 temporal。
   */
  readonly antialiasingMode?: 'fxaa' | 'temporal';
  /** 环境光遮蔽（AmbientOcclusion，我们用 GTAO 只乘环境光）；没写是关着。radius 是 Stride 的 ParamRadius（世界单位）。 */
  readonly ambientOcclusion?: { readonly radius: number };
  /**
   * 屏幕空间反射（LocalReflections，见 rendering/screenspace/ScreenSpaceReflections.ts）；没写是关着。maxRoughness 是 1 减 Stride 的
   * GlossinessThreshold，edgeFade 是它的 EdgeFadeFactor。
   */
  readonly localReflections?: { readonly maxRoughness: number; readonly edgeFade: number };
  /** 调色和镜头（Stride 没有，见 rendering/postfx/tonemap/ToneMap.ts）；没写的项用不改变画面的默认值。 */
  readonly colorGrading?: SceneColorGrading;
  /** 自动曝光的测光（Stride 只有平均测光，见 rendering/postfx/tonemap/ToneMap.ts 的 metering）；没写是 Stride 的。 */
  readonly exposure?: SceneExposure;
}

/** 测光的方式和直方图的设置（各项的意思见 ToneMap 的 metering、histogramRange、histogramFilter、speedBrighten、speedDarken）。 */
export interface SceneExposure {
  readonly metering?: 'average' | 'histogram';
  /** 把平均亮度映射成多亮（中灰）；没写按 Stride 的公式随亮度自动算。 */
  readonly keyValue?: number;
  /** 直方图的对数亮度范围（log2）。 */
  readonly minLog?: number;
  readonly maxLog?: number;
  /** 参加平均的那一段（按像素数的比例）。 */
  readonly low?: number;
  readonly high?: number;
  readonly speedBrighten?: number;
  readonly speedDarken?: number;
  /** 局部曝光：亮处、暗处的反差系数（小于 1 压缩），细节的倍数，"底"里大半径模糊的比例（见 ToneMap 的 localHighlights 等）。 */
  readonly localHighlights?: number;
  readonly localShadows?: number;
  readonly localDetail?: number;
  readonly localBlur?: number;
}

/** 色调映射的算子、白平衡、对比度、饱和度，镜头的暗角、颗粒、色差、畸变（各项的意思见 ToneMap 的同名字段）。 */
export interface SceneColorGrading {
  readonly operator?: 'hejl2' | 'agx' | 'aces';
  readonly temperature?: number;
  readonly tint?: number;
  readonly contrast?: number;
  readonly saturation?: number;
  readonly vignette?: number;
  readonly grain?: number;
  readonly chromaticAberration?: number;
  readonly distortion?: number;
  /** 查找表（.cube 资源的内容路径），映射之后按显示空间的颜色查；lutStrength 是和原色混的比例（默认 1）。 */
  readonly lut?: string;
  readonly lutStrength?: number;
}

/** 渲染目标贴图（Stride 的 RenderTexture，.sdrendertex）：合成器里的相机画进去，精灵可以显示它。按内容路径区分。 */
export interface SceneRenderTexture {
  readonly renderTexture: string;
  readonly width: number;
  readonly height: number;
  /** Stride 的 Format：HDR 是 16 位浮点，LDR 是 8 位。 */
  readonly hdr: boolean;
  /** LDR 时按 sRGB 存（Stride 的 UseSRgbSampling）。 */
  readonly srgb: boolean;
}

/** 合成器里画进渲染目标贴图的相机（Stride 的 SceneCameraRenderer 加 RenderTextureSceneRenderer）。 */
export interface SceneTextureCamera extends SceneForwardRenderer {
  /** 相机槽位（Camera.slot）。 */
  readonly cameraSlot: number;
  readonly texture: SceneRenderTexture;
}

/** 场景用的图形合成器：主画面（槽位 0 的相机）的前向渲染器设置，和先画好的渲染目标贴图。 */
export interface SceneCompositor extends SceneForwardRenderer {
  readonly textureCameras?: readonly SceneTextureCamera[];
  /** false：整个合成器不画阴影（Stride 的 ForwardLightingRenderFeature 没有 ShadowMapRenderer）。没写是画。 */
  readonly shadows?: false;
  /**
   * true：粒子画在 UI 上面（Stride 的合成器把粒子放进自己的渲染阶段，在前向渲染器之后用 SingleStageRenderer 画，UIParticles）。
   * 没写时粒子在场景的透明阶段里。
   */
  readonly particlesOverUI?: true;
  /**
   * 网格用的效果（Stride 合成器里 MeshRenderFeature 的 EffectName，不是默认的 StrideForwardShadingEffect 时），运行时按名字对上
   * 游戏导出的 meshEffect（SpaceEscape 的 SpaceEscapeEffectMain）。没写是默认效果。
   */
  readonly meshEffect?: string;
}

/** 精灵（Stride 的 SpriteComponent）：一整张贴图（SpriteFromTexture）或精灵表里的一个精灵（SpriteFromSheet）。 */
export type SceneSprite = SceneSpriteSettings & (SceneSpriteFromTexture | SceneSpriteFromSheet);

export interface SceneSpriteFromTexture {
  readonly texture: TextureRef | SceneRenderTexture;
  /** 贴图的几个像素是 1 个单位。 */
  readonly pixelsPerUnit: number;
  /** 精灵的原点（实体的位置）在贴图上的像素位置：centerFromMiddle 时从贴图中心算，否则从左上角算。 */
  readonly center: readonly [number, number];
  readonly centerFromMiddle: boolean;
}

export interface SceneSpriteFromSheet {
  /** 精灵表的内容路径（`.sheet.json`）。 */
  readonly sheet: string;
  /** 默认显示第几个精灵（Stride 的 CurrentFrame）。 */
  readonly frame: number;
}

export interface SceneSpriteSettings {
  /** 没写是 true（Stride 的 Enabled）。 */
  readonly enabled?: boolean;
  /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。 */
  readonly renderGroup?: number;
  /** billboard 一直朝着相机。 */
  readonly type: 'sprite' | 'billboard';
  /** 乘在贴图上的颜色（RGBA）和强度。 */
  readonly color: readonly [number, number, number, number];
  readonly intensity: number;
  readonly isTransparent: boolean;
  readonly premultipliedAlpha: boolean;
  readonly ignoreDepth: boolean;
  readonly isAlphaCutoff: boolean;
  readonly blendMode: SpriteBlend;
  readonly sampler: 'linearClamp' | 'pointClamp' | 'anisotropicClamp';
}

/**
 * 背景（Stride 的 BackgroundComponent）：立方体贴图（内容路径），或者 Is2D 的平面图片（铺满画面，多出的部分裁掉）。
 */
export type SceneBackground =
  | { readonly type: 'cubemap'; readonly texture: string; readonly intensity: number; readonly renderGroup?: number }
  | { readonly type: '2d'; readonly image: TextureRef; readonly intensity: number; readonly renderGroup?: number };

/** 反射探针（Stride 没有）：各字段的意思见 ReflectionProbe 组件；没写的用组件的默认值。 */
export interface SceneReflectionProbe {
  readonly size: Vec3Tuple;
  readonly blendDistance?: number;
  readonly boxProjection?: boolean;
  readonly intensity?: number;
  readonly refresh?: 'once' | 'everyFrame';
}

/** 辐照度体（Stride 没有，见 IrradianceVolume 组件）：以实体为中心的盒子里光追的探针算漫反射的间接光；没写的用组件的默认值。 */
export interface SceneIrradianceVolume {
  readonly size: Vec3Tuple;
  readonly spacing?: number;
  readonly rays?: number;
  readonly hysteresis?: number;
  readonly intensity?: number;
  readonly followCamera?: boolean;
  readonly budget?: number;
}

/** 平面反射（Stride 没有，见 PlanarReflection 组件）：平面过实体的原点、法线是本地 +Y；没写的用组件的默认值。 */
export interface ScenePlanarReflection {
  readonly size: Vec3Tuple;
  readonly resolution?: number;
  readonly distortion?: number;
  readonly intensity?: number;
}

/** 物理天空（Stride 没有）：各字段的意思见 SkyAtmosphere 组件；没写的用地球的默认值。 */
export interface SceneSkyAtmosphere {
  readonly planetRadius?: number;
  readonly atmosphereHeight?: number;
  readonly rayleighScattering?: Vec3Tuple;
  readonly mieScattering?: number;
  readonly mieAbsorption?: number;
  readonly miePhaseG?: number;
  readonly ozoneAbsorption?: Vec3Tuple;
  readonly groundAlbedo?: Vec3Tuple;
  readonly skyIntensity?: number;
  readonly aerialPerspectiveScale?: number;
  /** 太阳、月亮：带方向光的实体（场景里的 id）。太阳没写是要投阴影的那盏方向光，月亮没写就没有。 */
  readonly sun?: string;
  readonly moon?: string;
  readonly moonDiskIntensity?: number;
  readonly starsIntensity?: number;
}

/** 体积云（Stride 没有）：各字段的意思见 VolumetricClouds 组件；没写的用默认值。 */
export interface SceneVolumetricClouds {
  readonly coverage?: number;
  readonly density?: number;
  readonly bottom?: number;
  readonly thickness?: number;
  readonly cloudType?: number;
  readonly scale?: number;
  readonly windSpeed?: number;
  readonly windDirection?: number;
}

/** 体积雾（Stride 没有）：各字段的意思见 VolumetricFog 组件；没写的用默认值。 */
export interface SceneVolumetricFog {
  readonly density?: number;
  readonly heightFalloff?: number;
  readonly baseHeight?: number;
  readonly color?: Vec3Tuple;
  readonly anisotropy?: number;
  readonly distance?: number;
  readonly ambient?: number;
  readonly noise?: number;
  readonly noiseScale?: number;
  readonly farFog?: boolean;
}

/** 日夜循环（Stride 没有）：和 skyAtmosphere 在同一个实体上，各字段的意思见 DayNightCycle 组件；没写的用默认值。 */
export interface SceneDayNightCycle {
  readonly timeOfDay?: number;
  readonly dayLength?: number;
  readonly dayOfYear?: number;
  readonly latitude?: number;
  readonly north?: number;
  readonly moonPhase?: number;
}

/** 风源（Stride 没有，见 world/WindField.ts 的 WindZone 组件）：没写的用组件的默认值。 */
export interface SceneWindZone {
  readonly mode?: 'directional' | 'spherical';
  readonly strength?: number;
  readonly turbulence?: number;
  readonly pulseMagnitude?: number;
  readonly pulseFrequency?: number;
  readonly radius?: number;
}

/** 天气状态（Stride 没有，见 world/Weather.ts）：想要的天气；没写的用组件的默认值。 */
export interface SceneWeather {
  readonly cloudCoverage?: number;
  readonly cloudType?: number;
  readonly precipitation?: number;
  readonly temperature?: number;
  readonly fog?: number;
  readonly windSpeed?: number;
  readonly windDirection?: number;
  readonly gustiness?: number;
  readonly transitionTime?: number;
}

/** 世界的流式源（Stride 没有，见 world/WorldStreaming.ts）：世界的格子按它附近加载。 */
export interface SceneStreamingSource {
  readonly radiusScale?: number;
}

/** 贴花（Stride 没有，见 Decal 组件）：颜色、法线贴图（法线没写 srgb 时按线性读）；没写的用默认值。 */
export interface SceneDecal {
  readonly size?: Vec3Tuple;
  readonly albedo?: TextureRef;
  readonly normal?: TextureRef;
  readonly color?: Vec3Tuple;
  readonly opacity?: number;
  readonly albedoMix?: number;
  readonly normalFade?: number;
  readonly upperFade?: number;
  readonly lowerFade?: number;
}

/** 雨雪（Stride 没有，见 world/Precipitation.ts）：没写的用组件的默认值；场景里有天气状态时种类和强度由它给。 */
export interface ScenePrecipitation {
  readonly kind?: 'rain' | 'snow';
  readonly intensity?: number;
  readonly radius?: number;
  readonly height?: number;
}

/** Stride 的 AnimationComponent：按名字列出的剪辑（内容路径），脚本按名字播放。 */
export interface SceneAnimation {
  readonly animations: readonly { readonly name: string; readonly clip: string }[];
}

/** 脚本属性引用的资源种类。 */
/**
 * scene：只记路径，不随引用它的场景加载（场景之间常常互相引用），切换时才加载（Game.setRootScene）。
 * prefab：随场景加载好（和它引用的资源一起），脚本运行中实例化。
 */
export type SceneAssetKind = 'model' | 'material' | 'animation' | 'scene' | 'prefab' | 'font' | 'texture' | 'spriteSheet' | 'uiPage' | 'uiLibrary' | 'sound' | 'timeline' | 'spline';

/**
 * 游戏设置（Stride 的 GameSettings）：默认场景和图形合成器。合成器的根（Stride 的 GraphicsCompositor.Game）是游戏自己的渲染器时
 * （SpriteFonts 的 FontRenderer），renderer 是它的类型名和属性，运行时按类型名对上游戏给的 TS 渲染器（Game.loadGameSettings）。
 */
export interface GameSettingsFile {
  readonly name: string;
  /** 默认场景的内容路径（只记路径，场景要另外导入）；没有时是 null（SpriteFonts）。 */
  readonly defaultScene: string | null;
  readonly renderer: SceneScript | null;
  /**
   * 默认的后备缓冲大小（Stride 的 RenderingSettings.DefaultBackBufferWidth、Height）：桌面 Stride 的窗口一开始就是这么大，
   * 游戏在初始化时取后备缓冲大小当设计分辨率（JumpyJet 的背景、管子的个数）。没写时是 Stride 的默认 1280x720。
   */
  readonly defaultBackBufferSize?: readonly [number, number];
}

/**
 * 脚本的属性值（Stride 序列化的值换过来）：标量原样；列表是数组；Vector2、Vector3、Quaternion 是数组；别的结构是键名改成
 * 小写开头的对象；对实体或组件的引用是 { $entity: 场景里的实体 id }；对资源的引用是 { $asset: 内容路径, kind }。
 */
export type SceneScriptValue =
  | null
  | boolean
  | number
  | string
  | readonly SceneScriptValue[]
  | { readonly $entity: string }
  | { readonly $asset: string; readonly kind: SceneAssetKind }
  | { readonly [key: string]: SceneScriptValue };

/** 场景里的一个脚本组件：Stride 的类型名（不带程序集）和属性（键名改成小写开头）。 */
export interface SceneScript {
  readonly type: string;
  readonly props: Readonly<Record<string, SceneScriptValue>>;
}

/** 仿真设置（Stride 的 GameSettings 里 BepuConfiguration 的 BepuSimulation）。 */
/** 导航的设置（Stride 的 RecastNavigationConfiguration，在 GameSettings 里）。 */
export interface SceneNavigation {
  readonly build: {
    readonly cellSize: number;
    readonly cellHeight: number;
    readonly agentHeight: number;
    readonly agentRadius: number;
    readonly agentMaxClimb: number;
    readonly agentMaxSlopeDegrees: number;
    readonly tileSize: number;
    readonly maxEdgeLength: number;
    readonly maxSimplificationError: number;
    readonly minRegionSize: number;
    readonly mergeRegionSize: number;
    readonly detailSampleDistance: number;
    readonly detailSampleMaxError: number;
  };
  /** 参与的碰撞层，第 n 位是层 n。 */
  readonly includedLayers: number;
}

export interface ScenePhysics {
  readonly gravity: Vec3Tuple;
  readonly linearDamping: number;
  readonly angularDamping: number;
  /** 秒。 */
  readonly fixedTimeStep: number;
  /** 秒；一帧最多补多少仿真时间，没写是 0.25。 */
  readonly maximumTimeToProcess?: number;
  /** 一帧补不完的时间丢掉，不留到后面的帧；没写是不丢。 */
  readonly dropPostponedTicks?: true;
  /** 碰撞矩阵（Stride 的 Layer0 到 Layer31）：collisionMasks[a] 的第 b 位为 1 表示层 a 和层 b 碰撞；没写是全部碰撞。 */
  readonly collisionMasks?: readonly number[];
}

/**
 * Stride 的 CollisionMask 在资源文件里的写法（`Everything`、`None`，或者 `Layer0, Layer3, …`）换成位掩码：第 n 位是层 n。
 * 没写当全部。场景里的脚本属性是这种字符串时（射线的 CollideWith）脚本自己调它；已经是数字的原样返回。
 */
export function parseCollisionMask(value: unknown): number {
  if (typeof value === 'number') return value >>> 0;
  if (value === undefined || value === null || value === 'Everything') return 0xffffffff;
  if (value === 'None') return 0;
  let mask = 0;
  for (const flag of String(value).split(',')) {
    const layer = /^Layer(\d+)$/.exec(flag.trim());
    if (layer) mask |= 1 << Number(layer[1]);
  }
  return mask >>> 0;
}

/**
 * 场景（或预制体）里的一个预制体实例（docs/prefabs.md，用户 2026-11-20 定）：带着它的实体就是预制体的根（身份和摆放是
 * 实例自己的）；根下面的成员不存，加载时由预制体合并出来，在场景里的 id 是 `<实例 id>/<预制体里的 id>`（prefabInstances.ts）。
 */
export interface PrefabInstanceFile {
  /** 预制体的内容路径。 */
  readonly path: string;
  /** 放的是预制体的哪个根（预制体里的 id）；预制体只有一个根时不用写。 */
  readonly root?: string;
  /**
   * 在预制体某个实体（预制体里的 id）的某条路径上改成的值；脚本组件在路径里按类型名指（`scripts`, `Game.Health`）。没有 value
   * 是去掉这个键（例如去掉根上的一个组件）。
   */
  readonly set?: readonly { readonly entity: string; readonly path: readonly (string | number)[]; readonly value?: unknown }[];
  /** 这个实例不要的预制体实体（连后代），预制体里的 id。 */
  readonly removed?: readonly string[];
}

export interface SceneEntityFile {
  readonly id: string;
  readonly name: string;
  /** 父实体的 id；根实体是 null。 */
  readonly parent: string | null;
  /** 这个实体是一个预制体的实例（见 PrefabInstanceFile）。 */
  readonly prefab?: PrefabInstanceFile;
  readonly position: Vec3Tuple;
  readonly rotation: readonly [number, number, number, number];
  readonly scale: Vec3Tuple;
  readonly components: {
    /**
     * Stride.BepuPhysics 的约束组件（BallSocketConstraintComponent 等），可以有几个。type 是约束种类（类名去掉
     * ConstraintComponent、首字母小写），bodyA、bodyB 是带物理组件的实体（场景里的 id，单体约束没有 bodyB），settings 是
     * 其余属性（名字首字母小写，同 Simulation.addConstraint 的设置；向量、四元数是数组）。
     */
    readonly constraints?: readonly SceneConstraint[];
    /** Stride 的 InstancingComponent：这个实体的模型给 instance 引用它的实体画。 */
    readonly instancing?: Record<string, never>;
    /** Stride 的 InstanceComponent：master 是带 instancing 的实体（场景里的 id），null 是还没指定（运行时由脚本设）。 */
    readonly instance?: { readonly master: string | null };
    /**
     * Stride 的 ModelNodeLinkComponent：挂到 target（带模型的实体，场景里的 id；null 是父实体）的骨骼节点 nodeName 上。
     */
    readonly nodeLink?: { readonly target: string | null; readonly nodeName: string };
    /**
     * Stride 的 UIElementLinkComponent：跟着 UI 元素 nodeName 走。target 是带 UI 组件的实体（场景里的 id；null 是父实体），
     * camera 是带相机的实体（Stride 用它算面向相机的 UI 的朝向；引擎按 UI 实际画的相机算，不用它，见 UIElementLink）。
     */
    readonly uiElementLink?: { readonly target: string | null; readonly camera: string | null; readonly nodeName: string };
    /** Stride 的 ParticleSystemComponent（Control、Color、Speed 和 ParticleSystem），见 ParticleModuleFile。 */
    readonly particleSystem?: ParticleModuleFile;
    readonly model?: {
      /** 模型的内容路径。 */
      readonly model: string;
      /** 按槽覆盖模型的材质；null 表示用模型自带的。没写是都不覆盖。 */
      readonly materials?: readonly (string | null)[];
      /** 投下阴影；没有时是 true（同 Stride 的 ModelComponent.IsShadowCaster）。 */
      readonly isShadowCaster?: boolean;
      /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。 */
      readonly renderGroup?: number;
    };
    /** slot：图形合成器的相机槽位下标（Stride 的 CameraComponent.Slot），默认 0。 */
    readonly camera?: {
      readonly verticalFieldOfView: number;
      readonly nearClipPlane: number;
      readonly farClipPlane: number;
      readonly slot?: number;
      /** 没写是透视。 */
      readonly projection?: 'orthographic';
      readonly orthographicSize?: number;
      /** 画幅（宽 / 高）；没写或 0 是整个画布。 */
      readonly aspectRatio?: number;
      /** 物理相机（Stride 没有，见 Camera 组件）：写了就开着；没写的项用组件的默认值。 */
      readonly physical?: {
        readonly sensor?: readonly [number, number];
        readonly focalLength?: number;
        readonly aperture?: number;
        readonly focusDistance?: number;
        readonly shutterAngle?: number;
        readonly exposureCompensation?: number;
        readonly depthOfField?: boolean;
      };
    };
    readonly light?:
      | {
        readonly type: 'directional' | 'ambient';
        /** sRGB，同 Light 组件。 */
        readonly color: Vec3Tuple;
        readonly intensity: number;
        /** 方向光的阴影，字段同 Light 组件的 shadow 开头的列；没有就是不投阴影。 */
        readonly shadow?: SceneLightShadow;
      }
      | {
        readonly type: 'skybox';
        /** 天空盒的内容路径。 */
        readonly skybox: string;
        readonly intensity: number;
      }
      /** 点光（Stride 的 LightPoint）；profile 是配光曲线（IES 文件）的内容路径，0° 对着本地 -Z。 */
      | { readonly type: 'point'; readonly color: Vec3Tuple; readonly intensity: number; readonly radius: number; readonly shadow?: SceneLocalLightShadow; readonly profile?: string }
      /** 聚光（Stride 的 LightSpot），锥角是度、整个锥的张角。 */
      | {
        readonly type: 'spot'; readonly color: Vec3Tuple; readonly intensity: number; readonly range: number; readonly angleInner: number; readonly angleOuter: number;
        readonly shadow?: SceneLocalLightShadow;
        /** 配光曲线（IES 文件）的内容路径，乘在锥角的衰减上。 */
        readonly profile?: string;
      }
      /**
       * 矩形光（Stride 没有；同虚幻的 Rect Light、Unity HDRP 的矩形面光源）：width × height 的发光矩形（沿本地 X、Y），朝本地 -Z 照，
       * range 以外照不到；intensity 同点光的（正前方同样远处同样亮，面板越大越柔和），不投阴影。
       */
      | { readonly type: 'rect'; readonly color: Vec3Tuple; readonly intensity: number; readonly width: number; readonly height: number; readonly range: number }
      /** 圆盘光（同 HDRP 的 Disc Light）：直径 diameter 的发光圆盘，朝本地 -Z 照；其余同矩形光。 */
      | { readonly type: 'disc'; readonly color: Vec3Tuple; readonly intensity: number; readonly diameter: number; readonly range: number }
      /** 管状光（同 HDRP 的 Tube Light）：沿本地 X、长 length 的发光线段，往四周照（灯管、霓虹灯条）；其余同矩形光。 */
      | { readonly type: 'tube'; readonly color: Vec3Tuple; readonly intensity: number; readonly length: number; readonly range: number };
    readonly background?: SceneBackground;
    readonly reflectionProbe?: SceneReflectionProbe;
    readonly planarReflection?: ScenePlanarReflection;
    readonly irradianceVolume?: SceneIrradianceVolume;
    /** 高斯泼溅：splats 是泼溅资源（.splat）的内容路径。 */
    readonly gaussianSplat?: { readonly splats: string };
    /** 矢量地形（Stride 没有，见 Terrain 组件）：terrain 是地形资源（.terrain.json）的内容路径；没写的项用组件的默认值。 */
    readonly terrain?: { readonly terrain: string; readonly size?: number; readonly detail?: number; readonly lodFactor?: number; readonly isShadowCaster?: boolean; readonly renderGroup?: number };
    /** 程序化摆放（Stride 没有，见 world/Scatter.ts）：在同一个实体的地形上按 .scatter.json 的规则撒模型。 */
    readonly scatter?: { readonly scatter: string };
    /** 城市（Stride 没有，见 world/City.ts）：按 .city.json 的规则沿路摆楼，楼是这个实体的子实体。 */
    readonly city?: { readonly city: string };
    /** 水体（Stride 没有，见 world/Water.ts）：实体的位置是水面，按 .water.json 画湖或海。 */
    readonly water?: { readonly water: string };
    /** 浮力（Stride 没有，见 world/Buoyancy.ts）：刚体在水里浮起来；没写的项用组件的默认值。 */
    readonly buoyancy?: { readonly buoyancy?: number; readonly linearDrag?: number; readonly angularDrag?: number };
    readonly skyAtmosphere?: SceneSkyAtmosphere;
    /** 镜头系统（Stride 没有，见 CameraRig 组件）：跟随、注视的实体是场景文件里的 id；没写的项用组件的默认值。 */
    readonly cameraRig?: {
      readonly follow?: string;
      readonly offset?: Vec3Tuple;
      readonly followDamping?: number;
      readonly lookAt?: string;
      readonly lookOffset?: Vec3Tuple;
      readonly lookDamping?: number;
      readonly shakeRotation?: number;
      readonly shakePosition?: number;
      readonly shakeFrequency?: number;
    };
    readonly dayNightCycle?: SceneDayNightCycle;
    readonly volumetricClouds?: SceneVolumetricClouds;
    readonly volumetricFog?: SceneVolumetricFog;
    readonly windZone?: SceneWindZone;
    readonly precipitation?: ScenePrecipitation;
    readonly weather?: SceneWeather;
    readonly streamingSource?: SceneStreamingSource;
    readonly decal?: SceneDecal;
    /** Stride.BepuPhysics 的 StaticComponent。 */
    readonly static?: SceneCollidable;
    readonly character?: SceneCharacter;
    readonly body?: SceneBody;
    /** 游戏的脚本（Stride 的 ScriptComponent），按场景文件里的顺序；运行时按类型名找对应的 TS 脚本。 */
    readonly scripts?: readonly SceneScript[];
    readonly animation?: SceneAnimation;
    readonly sprite?: SceneSprite;
    readonly ui?: SceneUI;
  };
}

/** Stride 的 UIComponent：在这个实体上显示一个 UI 页面。 */
export interface SceneUI {
  /** UI 页面（UIFile）的内容路径；null 是还没指定（运行时由脚本设）。 */
  readonly page: string | null;
  /** 虚拟分辨率（页面按它布局），宽、高；深度 Z 只用于 3D 的 UI，没写是 1000。 */
  readonly resolution: readonly [number, number, number];
  /** 在场景里的大小（非全屏时），同 Stride 的 Size。 */
  readonly size: readonly [number, number, number];
  readonly resolutionStretch: 'fixedWidthFixedHeight' | 'fixedWidthAdaptableHeight' | 'fixedHeightAdaptableWidth';
  /** 渲染组（Stride 的 RenderGroup，0 到 31）；没写是 0。主相机的掩码里没有这一组时不画。 */
  readonly renderGroup?: number;
  /** 没写是 true（同 Stride）。 */
  readonly isFullScreen?: boolean;
  readonly isBillboard?: boolean;
  readonly isFixedSize?: boolean;
  readonly snapText?: boolean;
  readonly sampler?: 'linearClamp' | 'pointClamp' | 'anisotropicClamp';
  readonly enabled?: boolean;
}

export interface SceneFile {
  readonly name: string;
  /** 场景用的仿真设置；没有时用引擎的默认值。 */
  readonly physics?: ScenePhysics;
  /** 场景用的导航设置；没有时用 Stride 的默认值。 */
  readonly navigation?: SceneNavigation;
  /**
   * 整个场景的平移（Stride 的 Scene.Offset，TopDownRPG 的分块场景用它摆到各自的位置）：场景在变换存储里占一个隐藏的根，
   * 偏移在它上面，实体的本地位置不带偏移；子场景的根挂在父场景的根下面，偏移一层层累加（见 engine/transform.ts 的 SceneRoot）。
   */
  readonly offset?: readonly [number, number, number];
  /** 主画面的合成器设置；没有时用前向渲染器的默认值。 */
  readonly compositor?: SceneCompositor;
  /**
   * 子场景（Stride 的 SceneAsset.ChildrenIds）的内容路径：编辑器里一起看（参考场景，摆在各自的 offset 上），游戏运行时不自动
   * 加载（同 Stride：由脚本按需加载，TopDownRPG 的分块）。
   */
  readonly children?: readonly string[];
  /** 父实体都排在子实体前面。 */
  readonly entities: readonly SceneEntityFile[];
}

export interface SceneConstraint {
  readonly type: string;
  readonly enabled: boolean;
  readonly bodyA: string;
  readonly bodyB?: string;
  readonly settings: Readonly<Record<string, number | readonly number[]>>;
}

/** 预制体（Stride 的 PrefabAsset）：和场景一样的实体层级，实例化时才建出来。 */
export interface PrefabFile {
  readonly name: string;
  /** 父实体都排在子实体前面。 */
  readonly entities: readonly SceneEntityFile[];
}
