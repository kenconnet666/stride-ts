/**
 * 渲染用的数据组件，和 Transform 一起用（对应 Stride 的 CameraComponent、LightComponent、ModelComponent、BackgroundComponent）。
 *
 *   entities.create({ components: [Transform.with({ position: [0, 3, 10] }), Camera] });
 *   entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: red.id })] });
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { SkyboxId } from './Skybox';

/** 透视相机，看向本地 -Z。默认值和 Stride 一样：竖直视角 45°，近裁剪面 0.1，远裁剪面 1000。 */
export const Camera = component('Camera', {
  verticalFieldOfView: prop.f32().default(45).min(1).max(179).unit('deg'),
  nearClipPlane: prop.f32().default(0.1).min(0),
  farClipPlane: prop.f32().default(1000).min(0),
});

/**
 * 光源（Stride 的 LightComponent）：方向光、环境光、天空盒光。方向光照向实体的本地 -Z，同 Stride。颜色按 sRGB 写
 * （同 Stride 的编辑器），渲染时转成线性再乘强度。天空盒光用 skybox 列（Skybox.id）的球谐和预滤波立方体贴图，
 * 跟着实体旋转；它不用 color。
 *
 * shadow 开头的列是方向光的阴影（Stride 的 LightDirectionalShadowMap），默认值同 Stride：级联阴影图，按相机的可见范围
 * 对数划分，大小按画面和 shadowSize 定（xlarge 每个级联最多 2048）。
 */
export const Light = component('Light', {
  type: prop.enum(['directional', 'ambient', 'skybox']).default('directional'),
  color: prop.color(),
  intensity: prop.f32().default(1).min(0),
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

/** 背景（Stride 的 BackgroundComponent）：在没画到的地方画立方体贴图（Cubemap.id），乘强度，跟着实体旋转。 */
export const Background = component('Background', {
  texture: prop.u32().brand<'CubemapId'>(),
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
 * 蒙皮网格：画的时候顶点按蒙皮矩阵变换（GPU 蒙皮）。palette 是这个网格的蒙皮矩阵在所有蒙皮矩阵连起来的缓冲里的
 * 起点（按关节数），动画系统挂骨架时分配并每帧更新（animation/AnimationSystem.ts）。
 */
export const Skinned = component('Skinned', {
  palette: prop.u32().default(0).transient(),
});
