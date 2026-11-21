/**
 * 渲染用的数据组件，和 Transform 一起用（对应 Stride 的 CameraComponent、LightComponent、ModelComponent、BackgroundComponent）。
 *
 *   entities.create({ components: [Transform.with({ position: [0, 3, 10] }), Camera] });
 *   entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: red.id })] });
 */
import { prop, type EntityId } from '../data/prop';
import { component, tag } from '../engine/component';
import type { CubemapId, SkyboxId } from './lighting/Skybox';
import type { SpriteSheetId } from './SpriteSheet';
import type { TextureId } from '../graphics/Texture';

/** 透视相机，看向本地 -Z。默认值和 Stride 一样：竖直视角 45°，近裁剪面 0.1，远裁剪面 1000。 */
export const Camera = component('Camera', {
  /** 透视或正交（Stride 的 CameraProjectionMode）。 */
  projection: prop.enum(['perspective', 'orthographic']).default('perspective'),
  /** 透视投影的竖直视角。 */
  verticalFieldOfView: prop.f32().default(45).min(1).max(179).unit('deg'),
  /** 正交投影看到的高度（世界单位），宽度按宽高比（Stride 的 OrthographicSize）。 */
  orthographicSize: prop.f32().default(10).min(0),
  nearClipPlane: prop.f32().default(0.1).min(0),
  farClipPlane: prop.f32().default(1000).min(0),
  /** 图形合成器的相机槽位（Stride 的 CameraComponent.Slot，按合成器的 Cameras 列表编号）；0 是主画面用的那个。 */
  slot: prop.u32().default(0),
  /**
   * 物理相机（Stride 没有；照虚幻的 CineCamera、Unity 的 Physical Camera）：开着时竖直视角按焦距和传感器的高算（verticalFieldOfView
   * 不用），景深按光圈、对焦距离算，运动模糊的快门按快门角，曝光加上补偿。只对主画面的相机起作用。
   */
  physical: prop.bool().default(false),
  /** 传感器（画幅）的宽、高，毫米；默认是全画幅 36x24。 */
  sensorWidth: prop.f32().default(36).min(1).unit('mm'),
  sensorHeight: prop.f32().default(24).min(1).unit('mm'),
  focalLength: prop.f32().default(50).min(1).unit('mm'),
  /** 光圈（f 值）：越小景深越浅。 */
  aperture: prop.f32().default(2.8).min(0.5),
  focusDistance: prop.f32().default(10).min(0.01).unit('m'),
  /** 快门角：360 是快门开着一整帧（运动模糊最长），180 是半帧（电影的常用值）。 */
  shutterAngle: prop.f32().default(180).min(0).max(360).unit('deg'),
  /** 曝光补偿（EV）：画面亮度乘 2 的这么多次方。 */
  exposureCompensation: prop.f32().default(0).unit('EV'),
  /** 按光圈、焦距、对焦距离算景深（要后处理开着）。 */
  depthOfField: prop.bool().default(false),
  /** 画幅（宽 / 高，比如 2.39、16/9、9/16）：主画面框成这个宽高比，多出来的画黑边；0 是整个画布。和物理相机无关，都能用。 */
  aspectRatio: prop.f32().default(0).min(0),
});

/**
 * 光源（Stride 的 LightComponent）：方向光、环境光、天空盒光。方向光照向实体的本地 -Z，同 Stride。颜色按 sRGB 写
 * （同 Stride 的编辑器），渲染时转成线性再乘强度。天空盒光用 skybox 列（Skybox.id）的球谐和预滤波立方体贴图，
 * 跟着实体旋转；它不用 color。
 *
 * shadow 开头的列是阴影的设置，默认值同 Stride。方向光（LightDirectionalShadowMap）：级联阴影图，按相机的可见范围对数划分，
 * 大小按画面和 shadowSize 定（xlarge 每个级联最多 2048）。点光（LightPointShadowMap）：立方体的六个面；聚光
 * （LightStandardShadowMap）：一个透视视图；这两种只看 shadow、shadowSize、shadowFilter、shadowDepthBias、
 * shadowNormalOffsetScale，大小按光源在画面上盖住多大定。
 */
export const Light = component('Light', {
  type: prop.enum(['directional', 'ambient', 'skybox', 'point', 'spot', 'rect']).default('directional'),
  color: prop.color(),
  intensity: prop.f32().default(1).min(0),
  /** 点光的半径：光照在这里衰减到 0（Stride 的 LightPoint.Radius）。 */
  radius: prop.f32().default(1).min(0),
  /** 聚光、矩形光照到多远（Stride 的 LightSpot.Range）。 */
  range: prop.f32().default(3).min(0),
  /**
   * 矩形光（Stride 没有；同虚幻的 Rect Light）的宽、高（沿实体的本地 X、Y，乘实体的缩放）：发光的矩形朝本地 -Z 照，按 LTC
   * （线性变换的余弦）算漫反射和镜面反射。intensity 和点光的同一个意思（正前方同样远处同样亮），光摊在整个面上：面板越大越柔和、
   * 不是越亮。不投阴影。
   */
  width: prop.f32().default(1).min(0),
  height: prop.f32().default(1).min(0),
  /** 聚光的内锥角、外锥角（度，整个锥的张角）：内锥里全亮，到外锥平滑地暗到 0。 */
  angleInner: prop.f32().default(30).min(0).max(180).unit('deg'),
  angleOuter: prop.f32().default(35).min(0).max(180).unit('deg'),
  skybox: prop.u32().brand<'SkyboxId'>().default(0 as SkyboxId),
  shadow: prop.bool().default(false).group('Shadow'),
  shadowSize: prop.enum(['xsmall', 'small', 'medium', 'large', 'xlarge']).default('medium').group('Shadow'),
  /** none 是一次比较采样，pcfNxN 是 Stride 的 PCF 核，pcss 是接触硬化的软阴影（方向光；Stride 没有，点光、聚光按 pcf7x7）。 */
  shadowFilter: prop.enum(['none', 'pcf3x3', 'pcf5x5', 'pcf7x7', 'pcss']).default('none').group('Shadow'),
  shadowCascadeCount: prop.enum(['one', 'two', 'four']).default('four').group('Shadow'),
  shadowDepthBias: prop.f32().default(0.01).min(0).group('Shadow'),
  shadowNormalOffsetScale: prop.f32().default(10).min(0).group('Shadow'),
  shadowStabilization: prop.enum(['none', 'viewSnapping', 'projectionSnapping']).default('projectionSnapping').group('Shadow'),
  /** 级联的对数划分（Stride 的 PartitionLogarithmic）：0 是纯对数，1 是均匀。 */
  shadowPssmFactor: prop.f32().default(0.5).min(0).max(1).group('Shadow'),
  shadowDepthRange: prop.enum(['automatic', 'manual']).default('automatic').group('Shadow'),
  /** 手动深度范围：从相机近平面算起。 */
  shadowMinDistance: prop.f32().default(0).min(0).group('Shadow'),
  shadowMaxDistance: prop.f32().default(50).min(0).group('Shadow'),
  shadowBlendCascades: prop.bool().default(true).group('Shadow'),
  /** 方向光的角直径（太阳约 0.53°）：shadowFilter 是 pcss 时离遮挡物越远影子越软，半影按它算。Stride 没有。 */
  shadowLightAngle: prop.f32().default(0.53).min(0).max(20).unit('deg').group('Shadow'),
});

/**
 * 反射探针（Stride 没有；同 Unity、Godot 的 Reflection Probe）：在实体的位置拍一张立方体贴图，盒子里的表面的环境镜面反射用它
 * 代替天空盒（ReflectionProbes.ts）。盒子以实体为中心，边长是 size 乘实体的缩放（不跟旋转，同 Unity 的盒子按世界的轴摆）；
 * 离盒子的面 blendDistance 以内淡出，几个盒子重叠时小的优先。boxProjection 开着时按盒子做视差校正（室内、走廊这类近处的
 * 墙），关着时当作无穷远（室外）。refresh：once 是加进场景、改了设置或者调 ReflectionProbes.refresh 时拍，everyFrame 一直
 * 轮着拍（贵，一帧只拍一个面）。
 */
export const ReflectionProbe = component('ReflectionProbe', {
  size: prop.vec3().default([10, 10, 10]),
  blendDistance: prop.f32().default(1).min(0),
  boxProjection: prop.bool().default(true),
  intensity: prop.f32().default(1).min(0),
  refresh: prop.enum(['once', 'everyFrame']).default('once'),
});

/**
 * 物理天空（Stride 没有；Hillaire 2020 的大气散射，见 Atmosphere.ts）：场景里有它时画天空、太阳圆盘，太阳（投阴影的方向光）的
 * 颜色按大气的透射率变（日出日落变红变暗），天空盒光换成大气算出来的。默认是地球的大气；距离是千米，散射、吸收系数是每千米。
 * 转太阳的实体就是日夜变化。场景里只用第一个。
 */
export const SkyAtmosphere = component('SkyAtmosphere', {
  planetRadius: prop.f32().default(6360).min(1).unit('km'),
  atmosphereHeight: prop.f32().default(100).min(0.1).unit('km'),
  rayleighScattering: prop.vec3().default([0.005802, 0.013558, 0.0331]),
  mieScattering: prop.f32().default(0.003996).min(0),
  mieAbsorption: prop.f32().default(0.000444).min(0),
  /** 米氏相函数的不对称参数（越接近 1 太阳周围的光晕越集中）。 */
  miePhaseG: prop.f32().default(0.8).min(-0.99).max(0.99),
  ozoneAbsorption: prop.vec3().default([0.00065, 0.001881, 0.000085]),
  /** 地面的反照率（多次散射里算地面反射回去的光）。 */
  groundAlbedo: prop.vec3().default([0.3, 0.3, 0.3]),
  /** 天空和环境光的亮度倍数（太阳的直射光不变）。 */
  skyIntensity: prop.f32().default(1).min(0),
  /** 空气透视（远处的东西被大气染色、变淡）的距离倍数：1 是真实的，几十米的小场景要看出效果可以调大；0 关掉。 */
  aerialPerspectiveScale: prop.f32().default(1).min(0),
  /** 太阳：带方向光的实体。没设时是要投阴影的那盏方向光（没有时是第一盏）。 */
  sun: prop.entity().default(-1 as EntityId).group('Night'),
  /**
   * 月亮：带方向光的实体，没设就没有月亮。光的颜色 · 强度是满月时的照度（实际的再乘月相：月亮和太阳的夹角算出来的被照亮的
   * 比例），角直径是 Light.shadowLightAngle。太阳落山以后轮到它投阴影（它的 Light.shadow 开着的话）。
   */
  moon: prop.entity().default(-1 as EntityId).group('Night'),
  /** 月面被照亮的地方的亮度是月光的颜色 · 强度的多少倍（太大了月面一片白，看不出月海）。 */
  moonDiskIntensity: prop.f32().default(1).min(0).group('Night'),
  /** 星星和银河的亮度；0 不画。星空跟着这个实体的旋转转（DayNightCycle 按时刻转它）。 */
  starsIntensity: prop.f32().default(1).min(0).group('Night'),
});

/**
 * 体积云（Stride 没有；见 VolumetricClouds.ts）：一层按星球的曲率弯下去的云，程序生成，被太阳或者月亮照着。要场景里有
 * SkyAtmosphere。场景里只用第一个。
 */
export const VolumetricClouds = component('VolumetricClouds', {
  /** 天上有多少云：0 没有，1 满天。 */
  coverage: prop.f32().default(0.5).min(0).max(1),
  /** 云有多浓（消光系数的倍数）：小了透光、发灰，大了边缘硬、底下暗。 */
  density: prop.f32().default(1).min(0),
  /** 云底的海拔。 */
  bottom: prop.f32().default(1500).min(0).unit('m'),
  /** 云层的厚度。 */
  thickness: prop.f32().default(2500).min(10).unit('m'),
  /** 云的种类：0 层云（薄的一层），0.5 层积云，1 积云（一朵一朵、往上鼓）。 */
  cloudType: prop.f32().default(0.7).min(0).max(1),
  /** 云的大小的倍数。 */
  scale: prop.f32().default(1).min(0.05),
  /** 云飘的速度，和吹向的方位（绕 Y 的角度：0 朝 +Z，90 朝 +X）。 */
  windSpeed: prop.f32().default(10).min(0).unit('m/s'),
  windDirection: prop.f32().default(0).unit('deg'),
});

/**
 * 体积雾和体积光（Stride 没有；见 sky/VolumetricFog.ts）：跟着相机的一块雾，越高越稀，被主光（投阴影的方向光）、点光、聚光
 * 和环境光照着；物体的影子在雾里是一道道的光柱。可以带噪声（一团一团，被风吹着走）；distance 以外接一段解析的高度雾。
 * 场景里只用第一个。
 */
export const VolumetricFog = component('VolumetricFog', {
  /** 雾有多浓：baseHeight 那个高度上每米的消光系数（0.02 大约能看 150 米，0.1 大约 30 米）。 */
  density: prop.f32().default(0.02).min(0),
  /** 往上每米稀多少（密度 · exp(-heightFalloff · (高度 - baseHeight))）；0 是不随高度变。 */
  heightFalloff: prop.f32().default(0.1).min(0),
  baseHeight: prop.f32().default(0).unit('m'),
  /** 雾的颜色（散射的反照率）。 */
  color: prop.vec3().default([1, 1, 1]),
  /** 相函数的不对称参数：越接近 1，朝着光看时越亮、光柱越明显。 */
  anisotropy: prop.f32().default(0.6).min(-0.9).max(0.9),
  /** 体素表盖多远；天空和更远的物体按这个距离上的雾算。 */
  distance: prop.f32().default(120).min(1).unit('m'),
  /** 环境光照进雾里的倍数。 */
  ambient: prop.f32().default(1).min(0),
  /** 雾里的噪声：0 是均匀的，1 是一团一团、团之间几乎没有；跟着全局风（`game.wind`）飘。 */
  noise: prop.f32().default(0).min(0).max(1),
  /** 噪声的团有多大。 */
  noiseScale: prop.f32().default(8).min(0.1).unit('m'),
  /** distance 以外接一段解析的高度雾（远处的物体、天空也有雾；没有阴影和噪声）。 */
  farFog: prop.bool().default(true),
});

/**
 * 贴花（Stride 没有；做法照 Godot 的 Decal，见 mesh/Decals.ts）：实体的位置、旋转定一个盒子（size 是三边长，米），沿本地的
 * -Y 往下投，盒子里的表面换上贴花的颜色（albedo，Texture.id，按 sRGB 读，alpha 是遮罩）和法线（normal，Texture.id，切线
 * 空间，OpenGL 的绿色朝上）。两张贴图都可以没有：只有颜色乘数时是一块纯色。
 */
export const Decal = component('Decal', {
  size: prop.vec3().default([2, 2, 2]),
  albedo: prop.u32().brand<'TextureId'>().default(0 as TextureId),
  normal: prop.u32().brand<'TextureId'>().default(0 as TextureId),
  /** 乘在颜色贴图上的颜色。 */
  color: prop.vec3().default([1, 1, 1]),
  /** 不透明度（乘在颜色贴图的 alpha 上）。 */
  opacity: prop.f32().default(1).min(0).max(1),
  /** 颜色换掉多少（0 是只改法线）。 */
  albedoMix: prop.f32().default(1).min(0).max(1),
  /** 表面越偏离投影方向越淡：0 是不淡，0.3 是和投影方向夹角大于 70° 左右的面看不到。 */
  normalFade: prop.f32().default(0.3).min(0).max(1),
  /** 盒子顶部、底部多大的一段里渐渐淡出（盒子高度的比例）。 */
  upperFade: prop.f32().default(0.3).min(0).max(1),
  lowerFade: prop.f32().default(0.3).min(0).max(1),
});

/**
 * 背景（Stride 的 BackgroundComponent）：在没画到的地方画立方体贴图（texture，Cubemap.id，跟着实体旋转），或者平面图片
 * （image，Texture.id，Stride 的 Is2D：保持比例铺满画面，多出的部分两边对称裁掉），乘强度。两个都设时用 image。
 */
export const Background = component('Background', {
  texture: prop.u32().brand<'CubemapId'>().default(0 as CubemapId),
  image: prop.u32().brand<'TextureId'>().default(0 as TextureId),
  intensity: prop.f32().default(1).min(0),
  /** 渲染组（Stride 的 RenderGroup，0 到 31）：视图的掩码里没有这一组时不画。 */
  renderGroup: prop.u8().max(31).default(0),
});

/**
 * 用一个网格和一个材质画出实体。列里存 Mesh.id、Material.id（类型是 MeshId、MaterialId）：数据组件的列
 * 只能放数字，内容管线做好后改成资源引用。相同网格加材质的实体合成一次实例化绘制。
 */
export const Model = component('Model', {
  mesh: prop.u32().brand<'MeshId'>(),
  material: prop.u32().brand<'MaterialId'>(),
  /** 投下阴影（Stride 的 ModelComponent.IsShadowCaster）。 */
  isShadowCaster: prop.bool().default(true),
  /**
   * 渲染组（Stride 的 RenderGroup，0 到 31）：视图只画它的掩码（RenderView.cullingMask）里有的组。编辑器的辅助图形、
   * 只给某台相机看的东西放在自己的组里。
   */
  renderGroup: prop.u8().max(31).default(0),
});

/**
 * 精灵（Stride 的 SpriteComponent）：在实体的 XY 平面上画成 宽 / pixelsPerUnit × 高 / pixelsPerUnit 的矩形，billboard 时
 * 一直朝着相机。画的东西二选一：
 * - SpriteFromTexture：一整张贴图（texture 是 Texture.id，也可以是渲染目标贴图），用这里的 pixelsPerUnit、center；
 * - SpriteFromSheet：sheet 不是 0 时用精灵表（SpriteSheet.id）里的第 frame 个精灵（循环取），区域、尺寸和原点用那个精灵的。
 * center 是实体位置落在图上的像素（centerFromMiddle 时从中心算，否则从左上角算）。color 按 sRGB 写（同 Stride 的编辑器），
 * 画的时候转成线性，和 intensity 一起乘在贴图上。画在透明阶段，从远到近；enabled 是 false 时不画。
 */
export const Sprite = component('Sprite', {
  enabled: prop.bool().default(true),
  texture: prop.u32().brand<'TextureId'>().default(0 as TextureId),
  sheet: prop.u32().brand<'SpriteSheetId'>().default(0 as SpriteSheetId),
  /** 精灵表里的第几个精灵（Stride 的 SpriteFromSheet.CurrentFrame）。 */
  frame: prop.int().default(0),
  pixelsPerUnit: prop.f32().default(100).min(0),
  centerX: prop.f32().default(0),
  centerY: prop.f32().default(0),
  centerFromMiddle: prop.bool().default(true),
  type: prop.enum(['sprite', 'billboard']).default('sprite'),
  color: prop.color(),
  intensity: prop.f32().default(1).min(0),
  /** 贴图有透明部分（SpriteFromTexture.IsTransparent）：blendMode 是 auto 时决定混不混合。 */
  isTransparent: prop.bool().default(true),
  premultipliedAlpha: prop.bool().default(true),
  ignoreDepth: prop.bool().default(false),
  /** alpha 小于 0.1 的像素不画（Stride 的 IsAlphaCutoff）。 */
  isAlphaCutoff: prop.bool().default(false),
  blendMode: prop.enum(['auto', 'none', 'alphaBlend', 'additiveBlend', 'noColor']).default('auto'),
  sampler: prop.enum(['linearClamp', 'pointClamp', 'anisotropicClamp']).default('linearClamp'),
  /** 渲染组（Stride 的 RenderGroup，0 到 31）：视图的掩码里没有这一组时不画。 */
  renderGroup: prop.u8().max(31).default(0),
});

/**
 * 蒙皮网格：画的时候顶点按蒙皮矩阵变换（GPU 蒙皮）。palette 是这个网格的蒙皮矩阵在所有蒙皮矩阵连起来的缓冲里的
 * 起点（按关节数），动画系统挂骨架时分配并每帧更新（animation/AnimationSystem.ts）。
 */
/**
 * 模型实例化的主实体（Stride 的 InstancingComponent，InstancingEntityTransform）：它的 Model 不按自己的变换画，而是在每个
 * 引用它的 Instance 实体的位置画一份。和 Stride 不同：我们的渲染器本来就把同一网格、同一材质的物体合成一次实例化绘制，
 * 这里只是"借用主实体的模型"；主实体的模型拆成多个子实体时（多网格的模型）只用主实体自己那个网格。
 */
export const Instancing = component('Instancing', {});

/** 模型实例化的一个实例（Stride 的 InstanceComponent）：按自己的世界矩阵画 master（带 Instancing 的实体）的模型；master 是 -1 时不画。 */
export const Instance = component('Instance', {
  master: prop.entity().default(-1 as EntityId),
});

/** 模型多出来的网格所在的子实体（一个实体只能有一个 Model，ContentManager.addModel 把其余网格挂成带这个标记的子实体）。 */
export const ModelPart = tag('ModelPart');

export const Skinned = component('Skinned', {
  palette: prop.u32().default(0).transient(),
});
