/**
 * 渲染用的数据组件，和 Transform 一起用（对应 Stride 的 CameraComponent、LightComponent、ModelComponent、BackgroundComponent）。
 *
 *   entities.create({ components: [Transform.with({ position: [0, 3, 10] }), Camera] });
 *   entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: red.id })] });
 */
import { prop, type EntityId } from '../data/prop';
import { component, tag } from '../engine/component';
import type { CubemapId, SkyboxId } from './Skybox';
import type { SpriteSheetId } from './SpriteSheet';
import type { TextureId } from './Texture';

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
  type: prop.enum(['directional', 'ambient', 'skybox', 'point', 'spot']).default('directional'),
  color: prop.color(),
  intensity: prop.f32().default(1).min(0),
  /** 点光的半径：光照在这里衰减到 0（Stride 的 LightPoint.Radius）。 */
  radius: prop.f32().default(1).min(0),
  /** 聚光照到多远（Stride 的 LightSpot.Range）。 */
  range: prop.f32().default(3).min(0),
  /** 聚光的内锥角、外锥角（度，整个锥的张角）：内锥里全亮，到外锥平滑地暗到 0。 */
  angleInner: prop.f32().default(30).min(0).max(180).unit('deg'),
  angleOuter: prop.f32().default(35).min(0).max(180).unit('deg'),
  skybox: prop.u32().brand<'SkyboxId'>().default(0 as SkyboxId),
  shadow: prop.bool().default(false).group('Shadow'),
  shadowSize: prop.enum(['xsmall', 'small', 'medium', 'large', 'xlarge']).default('medium').group('Shadow'),
  /** none 是一次比较采样，pcfNxN 是 Stride 的 PCF 核。 */
  shadowFilter: prop.enum(['none', 'pcf3x3', 'pcf5x5', 'pcf7x7']).default('none').group('Shadow'),
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
});

/**
 * 背景（Stride 的 BackgroundComponent）：在没画到的地方画立方体贴图（texture，Cubemap.id，跟着实体旋转），或者平面图片
 * （image，Texture.id，Stride 的 Is2D：保持比例铺满画面，多出的部分两边对称裁掉），乘强度。两个都设时用 image。
 */
export const Background = component('Background', {
  texture: prop.u32().brand<'CubemapId'>().default(0 as CubemapId),
  image: prop.u32().brand<'TextureId'>().default(0 as TextureId),
  intensity: prop.f32().default(1).min(0),
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
