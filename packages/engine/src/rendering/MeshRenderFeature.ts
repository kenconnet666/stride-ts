/**
 * 网格的根渲染特性（Stride 的 MeshRenderFeature）。着色和 Stride 默认的 PBR 材质一致（StrideForwardShadingEffect
 * 里 MaterialSurfaceShadingDiffuseLambert 加 MaterialSurfaceShadingSpecularMicrofacet）：
 * - 金属度工作流：镜面色 = lerp(0.02, albedo, 金属度)，漫反射色 = albedo · (1 - 金属度)，再乘 cavity；
 * - 直射光：漫反射 albedo / π · 光色 · 阴影 · N·L；镜面 F · G · D / 4 · 光色 · 阴影 · N·L，D 是 GGX，F 是 Schlick（用 L·H），
 *   G 是 Smith-Schlick-GGX（已除以 N·L · N·V），alphaR = 粗糙度²（至少 0.001），N·L 至少 0.0001；
 * - 方向光的阴影（ShadowMapReceiverDirectional）：按视图空间的深度选级联，采样点沿法线推出去一点（按 1 - N·L），
 *   深度减去偏移后在图集里比较采样（一次或 PCF），相邻级联在交界处混合；
 * - 环境光（Stride 的 LightSimpleAmbient）：漫反射和镜面都用环境色；
 * - 天空盒光（LightSkyboxShader）：漫反射用 3 阶球谐，镜面在反射方向上按 mip = sqrt(alphaR) · 级数 采样预滤波的
 *   立方体贴图；方向先按天空盒的旋转转回去，再把 z 取反（Stride 的立方体贴图约定）；
 * - 环境光的镜面项乘 DFG 查找表（MaterialSpecularMicrofacetEnvironmentGGXLUT：按 (1 - sqrt(alphaR), N·V) 采样，
 *   specular · r + g）。查找表启动时在 GPU 上积分生成，和 Stride 自带的那张一致（最大误差约 0.02）；
 * - 法线贴图（MaterialSurfaceNormalMap、NormalUpdate）：切线空间的法线（可选 y 取反、×2-1、由 xy 算 z）乘 TBN，
 *   副切线 = w · cross(法线, 切线)；之后的光照都用这个法线。网格没有切线时用顶点法线；
 * - 自发光直接加上。
 * 输出线性的 HDR 颜色，后处理和色调映射在后面（postfx/PostProcessingEffects）。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质，是否投射阴影，是否蒙皮）分批，每批记下实体的变换槽位；
 *   蒙皮的实体（Skinned）还记下变换槽位对应的蒙皮矩阵起点，带形变的（Morphed）记下形变权重的起点。
 * - Cull：各批的槽位连着写进 stride-native 的剔除工作区（FrustumCuller），一次调用剔除一组视图，每批用网格的包围盒；
 *   主视图顺带量出可见物体的距离范围（阴影级联要用）。一帧剔除两次：先主视图，再阴影级联。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），动画系统算好的蒙皮矩阵也直接从 wasm 内存上传，各次剔除的结果（每个视图一段可见槽位）
 *   也直接从 wasm 内存上传成实例缓冲，每个视图的常量（相机、光照、阴影、天空盒）写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是这个视图里这一批的起点。
 *   顶点布局（content/format.ts 的 VertexLayout）不同的网格用不同的管线；量化的属性在顶点着色器里按网格的参数还原
 *   （第 2 组绑定），八面体编码的法线也在那里解开。蒙皮的批次用带关节和权重属性的管线：顶点先乘 4 个蒙皮矩阵的加权和
 *   （GPU 蒙皮，Stride 的 TransformationSkinning），再乘世界矩阵。阴影投射阶段只画投射阴影的批次，管线只写深度。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import type { FrustumCuller } from '@stride-ts/native';
import type { AnimationSystem } from '../animation/AnimationSystem';
import type { EntityId } from '../data/prop';
import type { ColumnsOf } from '../engine/component';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { BRDF } from './brdf';
import { Morphed } from '../animation/morphs';
import { Instance, Instancing, Model, Skinned } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import { Material, type MaterialShaderLayer, type MaterialShaderTrees, type MaterialTexture } from './Material';
import { MESH_EFFECT_PARAMETERS, meshEffectCode, type MeshEffect } from './meshEffect';
import { MATERIAL_STREAMS } from './shaderClass';
import { vertexLayoutOffsets, type VertexLayout } from '../content/format';
import { Mesh } from './Mesh';
import { MAX_DIRECTIONAL_LIGHTS, MAX_LOCAL_LIGHTS, RootRenderFeature, type Lighting, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';

/** 一次实例化绘制：同一个网格和材质的实体。 */
export interface MeshBatch {
  readonly mesh: Mesh;
  readonly material: Material;
  /** 这批的实体投下阴影（Model.isShadowCaster）。 */
  readonly isShadowCaster: boolean;
  /** 这批的实体带 Skinned：按蒙皮矩阵画。 */
  readonly skinned: boolean;
  /** 实体的变换槽位，前 count 个有效。 */
  slots: Uint32Array;
  count: number;
  /** 在这一帧所有批次连起来的槽位列表里的起点，Cull 时算。 */
  first: number;
}

const SHADER = /* wgsl */ `
${BRDF}

struct View {
  viewProjection: mat4x4f,
  eye: vec4f,
  ambientColor: vec4f,
  // x：天空盒光的强度（没有天空盒时是 0），y：镜面立方体贴图的级数，z：方向光的个数，w：投阴影的方向光的下标（没有时 -1）
  sky: vec4f,
  skySH: array<vec4f, 9>,
  skyRotation: mat4x4f,
  // 方向光的阴影：每个级联从世界坐标到图集 UV 和深度的矩阵、各级联结束处的视图深度
  shadowMatrices: array<mat4x4f, 4>,
  shadowSplits: vec4f,
  // x：级联数（0 是没有阴影），y：深度偏移，z：法线偏移比例，w：PCF 核大小（0 是一次比较采样）
  shadow: vec4f,
  // x：图集一个像素的大小（1 / 尺寸），y：图集尺寸，z：级联交界处混合，w：深度范围是自动的
  shadowAtlas: vec4f,
  // 方向光：光线前进的方向、颜色乘强度
  lightDirections: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  lightColors: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  // x：点光和聚光的个数（localLights 的前几个），y：游戏开始以来的秒数（Stride 的 Global.Time，材质的颜色树用）
  locals: vec4f,
};
// 点光、聚光（Stride 的 LightPoint、LightSpot）：position.w 是半径平方的倒数，color.w 为 1 是聚光，
// direction 是聚光照向的方向，angle 是角度衰减的 scale、offset
struct LocalLight { position: vec4f, color: vec4f, direction: vec4f, angle: vec4f };
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> slots: array<u32>;
@group(0) @binding(3) var skySpecular: texture_cube<f32>;
@group(0) @binding(4) var dfgLut: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;
@group(0) @binding(6) var shadowAtlas: texture_depth_2d;
@group(0) @binding(7) var shadowComparison: sampler_comparison;
// 蒙皮：按变换槽位找这个实体的蒙皮矩阵起点，蒙皮矩阵是所有蒙皮网格的连在一起
@group(0) @binding(8) var<storage, read> paletteOf: array<u32>;
@group(0) @binding(9) var<storage, read> palettes: array<mat4x4f>;
@group(0) @binding(10) var<storage, read> localLights: array<LocalLight>;
// 带形变网格的实体：变换槽位 → 它的模型实例那组形变权重在 morphWeights 里的起点
@group(0) @binding(11) var<storage, read> morphOf: array<u32>;
@group(0) @binding(12) var<storage, read> morphWeights: array<f32>;

// 漫反射 = combine(贴图(uv * scale + offset), baseColor)；combine 0 是乘，1 是加（operator 是 WGSL 的保留字）。
// 没有贴图的槽绑一张 1x1 的白图，所以不用分支：自发光 = 贴图 · emissive，遮蔽 = dot(贴图, occlusionMask)（mask 是
// 通道的单位向量，没有贴图时是 (值, 0, 0, 0)）。surface：金属度、粗糙度、漫反射 cavity、镜面 cavity。
// specular：0 没有镜面，1 金属度工作流，2 镜面颜色工作流（specularColor），3 镜面颜色工作流并且能量守恒（漫反射乘 1 - 镜面）。blend：透明的 tint 和漫反射的 alpha（不透明是 1），
// emissive.w：镜面的透明系数（Stride 的 matDiffuseSpecularAlphaBlend.y）。
// normalFlags：第 1 位有法线贴图，第 2 位 ×2-1，第 3 位 y 取反，第 4 位由 xy 算 z。occlusionDirect：直射光受遮蔽的程度。
struct Material {
  baseColor: vec4f,
  uvTransform: vec4f,
  emissive: vec4f,
  surface: vec4f,
  normalUvTransform: vec4f,
  specularColor: vec4f,
  emissiveUvTransform: vec4f,
  occlusionMask: vec4f,
  occlusionUvTransform: vec4f,
  blend: vec4f,
  combine: u32,
  specular: u32,
  normalFlags: u32,
  occlusionDirect: f32,
  // 光泽度贴图：通道的单位向量（没有贴图时是 0）
  glossinessMask: vec4f,
  glossinessUvTransform: vec4f,
  // x 为 1 时光泽度贴图存的是粗糙度（Stride 的 Invert）；y 是 Alpha 裁剪的阈值，没有时是 -1；z 是玻璃的折射率，不是玻璃时是 0
  flags: vec4f,
};
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler: sampler;
@group(1) @binding(3) var normalTexture: texture_2d<f32>;
@group(1) @binding(4) var emissiveTexture: texture_2d<f32>;
@group(1) @binding(5) var occlusionTexture: texture_2d<f32>;
// 每张贴图各自的采样器（Stride 的 ComputeTextureBase.Filtering、AddressModeU/V）
@group(1) @binding(6) var normalSampler: sampler;
@group(1) @binding(7) var emissiveSampler: sampler;
@group(1) @binding(8) var occlusionSampler: sampler;
@group(1) @binding(9) var glossinessTexture: texture_2d<f32>;
@group(1) @binding(10) var glossinessSampler: sampler;

// 网格的反量化：位置 = offset + 输入 · scale，UV = uvTransform.zw + 输入 · uvTransform.xy；flags 的第 1 位：法线是八面体编码。
// 不量化的网格 offset 0、scale 1。unorm16 的位置读进来是 vec4f，snorm16x2 的法线是 (x, y, 0)，都按 vec3f 用。
// effect：网格效果的参数（meshEffect.ts，Stride 的 Mesh.Parameters），没有效果时没用
struct MeshParams { positionOffset: vec4f, positionScale: vec4f, uvTransform: vec4f, flags: u32, effect: MeshEffectParameters };
@group(2) @binding(0) var<uniform> mesh: MeshParams;
// 网格的形变数据（布局见 content/format.ts 的 MeshMorph）；没有形变的网格绑一个空的
@group(2) @binding(1) var<storage, read> morphData: array<u32>;
// 管线常量：网格有形变时为 true，没有时形变的代码整段去掉
override MORPHED: bool = false;

/** 顶点的形变增量（Stride 的 MorphTargets：按权重加各个目标的位置和法线增量），在网格空间里、蒙皮之前。 */
struct MorphDelta { position: vec3f, normal: vec3f };
fn morphDelta(slot: u32, vertex: u32) -> MorphDelta {
  var delta = MorphDelta(vec3f(0.0), vec3f(0.0));
  if (!MORPHED) { return delta; }
  let base = morphOf[slot];
  let first = morphData[0];
  for (var e = morphData[1u + vertex]; e < morphData[2u + vertex]; e++) {
    let at = first + e * 8u;
    let w = morphWeights[base + morphData[at + 3u]];
    delta.position += w * vec3f(bitcast<f32>(morphData[at]), bitcast<f32>(morphData[at + 1u]), bitcast<f32>(morphData[at + 2u]));
    delta.normal += w * vec3f(bitcast<f32>(morphData[at + 4u]), bitcast<f32>(morphData[at + 5u]), bitcast<f32>(morphData[at + 6u]));
  }
  return delta;
}

/** 八面体编码还原成单位向量（同 meshopt 的 octahedral 滤波，资源管线的编码见 packages/pipeline/src/mesh.ts）。 */
fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

struct Varyings {
  // invariant：深度预通道和不透明阶段的管线算出完全相同的深度，less-equal 才不会漏掉像素
  @invariant @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // 视图空间的深度（裁剪坐标的 w），选阴影级联用（Stride 的 DepthVS）
  @location(3) depth: f32,
  // 世界空间的切线和手性；网格没有切线时是 0
  @location(4) tangent: vec4f,
  // 模型空间的位置（材质的颜色树里的 streams.position，Stride 的 POSITION）
  @location(5) local: vec3f,
  // 网格效果在顶点着色器里算、给片元着色器用的值（effectVarying，比如雾因子）
  @location(6) effect: vec4f,
};

const IDENTITY = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);

/**
 * skin 把网格空间的顶点变到模型空间（蒙皮矩阵的加权和；不蒙皮时是单位矩阵，编译器会把它消掉）；形变在蒙皮之前加上
 * （同 Stride：先形变后蒙皮）。
 */
fn transformVertex(position: vec3f, normal: vec3f, uv: vec2f, tangent: vec4f, slot: u32, vertex: u32, skin: mat4x4f) -> Varyings {
  let world = worlds[slot];
  let morph = morphDelta(slot, vertex);
  let local = (skin * vec4f(mesh.positionOffset.xyz + position * mesh.positionScale.xyz + morph.position, 1.0)).xyz;
  let localNormal = (skin * vec4f(select(normal, octDecode(normal.xy), (mesh.flags & 1u) != 0u) + morph.normal, 0.0)).xyz;
  let localTangent = (skin * vec4f(tangent.xyz, 0.0)).xyz;
  let meshUv = mesh.uvTransform.zw + uv * mesh.uvTransform.xy;
  // 材质的位移贴图：顶点沿模型空间的法线移动（Stride 的 MaterialSurfaceDisplacement，MaterialShader 的水波）
  let displaced = local + normalize(localNormal) * treeDisplacement(meshUv, local);
  // 网格效果可以在投影前改世界位置（Stride 的 PreTransformPosition，SpaceEscape 的走廊往远处弯）
  let worldPosition = vec4f(effectWorldPosition((world * vec4f(displaced, 1.0)).xyz, mesh.effect), 1.0);
  var out: Varyings;
  out.position = view.viewProjection * worldPosition;
  out.world = worldPosition.xyz;
  out.effect = effectVarying(out.position, worldPosition.xyz, mesh.effect);
  // 均匀缩放下法线、切线直接用世界矩阵变换；非均匀缩放要用逆转置，等材质系统一起做
  out.normal = (world * vec4f(localNormal, 0.0)).xyz;
  out.uv = effectUv(meshUv, mesh.effect);
  out.depth = out.position.w;
  out.tangent = vec4f((world * vec4f(localTangent, 0.0)).xyz, tangent.w);
  out.local = local;
  return out;
}

/** 顶点的蒙皮矩阵：4 个关节的蒙皮矩阵按权重相加（Stride 的 TransformationSkinning）。 */
fn skinMatrix(slot: u32, joints: vec4u, weights: vec4f) -> mat4x4f {
  let base = paletteOf[slot];
  return palettes[base + joints.x] * weights.x + palettes[base + joints.y] * weights.y
    + palettes[base + joints.z] * weights.z + palettes[base + joints.w] * weights.w;
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, vec4f(0.0), slots[instance], vertex, IDENTITY);
}

@vertex fn vsTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, tangent, slots[instance], vertex, IDENTITY);
}

@vertex fn vsSkinned(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, skinMatrix(slot, joints, weights));
}

@vertex fn vsSkinnedTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, tangent, slot, vertex, skinMatrix(slot, joints, weights));
}

/**
 * 着色用的法线：有法线贴图、网格有切线时按切线空间的法线算（Stride 的 MaterialSurfaceNormalMap 加 UpdateNormalFromTangentSpace），
 * 否则是顶点法线。贴图总是采样（没有时绑白图），用 select 挑结果：采样必须在一致的控制流里。
 */
fn surfaceNormal(in: Varyings) -> vec3f {
  let n = normalize(in.normal);
  var m = textureSample(normalTexture, normalSampler, in.uv * material.normalUvTransform.xy + material.normalUvTransform.zw).xyz;
  let flags = material.normalFlags;
  m.y = select(m.y, 1.0 - m.y, (flags & 4u) != 0u);
  m = select(m, 2.0 * m - 1.0, (flags & 2u) != 0u);
  m.z = select(m.z, sqrt(max(0.0, 1.0 - (m.x * m.x + m.y * m.y))), (flags & 8u) != 0u);
  // 法线树（材质的颜色树，已经换好）优先于法线贴图
  let tree = treeNormal(in);
  m = select(m, tree.xyz, tree.w > 0.5);
  // 材质层的法线按遮罩混进来（没有法线贴图时底下是 (0, 0, 1)）
  let hasBase = (flags & 1u) != 0u || tree.w > 0.5;
  let layered = layerNormal(in, select(vec3f(0.0, 0.0, 1.0), m, hasBase));
  m = select(m, layered.xyz, layered.w > 0.5);
  let tangentLength = length(in.tangent.xyz);
  let t = in.tangent.xyz / max(tangentLength, 1e-8);
  let b = in.tangent.w * cross(n, t);
  let mapped = normalize(m.x * t + m.y * b + m.z * n);
  return select(n, mapped, (hasBase || layered.w > 0.5) && tangentLength > 0.0);
}

/** 世界方向转到天空盒的立方体贴图里：按天空盒的旋转转回去（行向量乘矩阵 = 乘转置），z 取反。 */
fn skyDirection(direction: vec3f) -> vec3f {
  let rotation = mat3x3f(view.skyRotation[0].xyz, view.skyRotation[1].xyz, view.skyRotation[2].xyz);
  let d = direction * rotation;
  return vec3f(d.xy, -d.z);
}

/** 3 阶球谐求值，同 Stride 的 EvaluateSphericalHarmonics（系数已乘过基函数常数）。 */
fn evaluateSH(d: vec3f) -> vec3f {
  var color = view.skySH[0].rgb;
  color += view.skySH[1].rgb * d.y;
  color += view.skySH[2].rgb * d.z;
  color += view.skySH[3].rgb * d.x;
  color += view.skySH[4].rgb * d.y * d.x;
  color += view.skySH[5].rgb * d.y * d.z;
  color += view.skySH[6].rgb * (3.0 * d.z * d.z - 1.0);
  color += view.skySH[7].rgb * d.x * d.z;
  color += view.skySH[8].rgb * (d.x * d.x - d.y * d.y);
  return color;
}

/** 图集里一次双线性的比较采样，乘权重；offset 以像素为单位，相对 PCF 的基准像素。 */
fn pcfTap(base: vec2f, offset: vec2f, weight: f32, depth: f32) -> f32 {
  return weight * textureSampleCompareLevel(shadowAtlas, shadowComparison, base + offset * view.shadowAtlas.x, depth);
}

// PCF 的一行：x 方向的偏移和权重按分量写开（不用动态下标，编译器才能把采样都放在寄存器里）
fn pcfRow2(base: vec2f, ox: vec2f, wx: vec2f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth));
}
fn pcfRow3(base: vec2f, ox: vec3f, wx: vec3f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth) + pcfTap(base, vec2f(ox.z, oy), wx.z, depth));
}
fn pcfRow4(base: vec2f, ox: vec4f, wx: vec4f, oy: f32, wy: f32, depth: f32) -> f32 {
  return wy * (pcfTap(base, vec2f(ox.x, oy), wx.x, depth) + pcfTap(base, vec2f(ox.y, oy), wx.y, depth)
    + pcfTap(base, vec2f(ox.z, oy), wx.z, depth) + pcfTap(base, vec2f(ox.w, oy), wx.w, depth));
}

// Stride 的 ShadowMapFilterPcf：3x3、5x5、7x7 的核分别用 2x2、3x3、4x4 次双线性比较采样，权重的和是 16、144、2704。
// Stride 的核大小是编译期常量、循环 [unroll]；这里按核大小分三个函数全部展开（运行时的动态循环加动态下标，
// TPP 的不透明通道慢了约 1.9 ms）
fn pcf3(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 3.0 - 2.0 * st;
  let w1 = 1.0 + 2.0 * st;
  let o0 = (2.0 - st) / w0 - 1.0;
  let o1 = st / w1 + 1.0;
  let ox = vec2f(o0.x, o1.x);
  let wx = vec2f(w0.x, w1.x);
  return (pcfRow2(base, ox, wx, o0.y, w0.y, depth) + pcfRow2(base, ox, wx, o1.y, w1.y, depth)) / 16.0;
}

fn pcf5(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 4.0 - 3.0 * st;
  let w1 = vec2f(7.0);
  let w2 = 1.0 + 3.0 * st;
  let o0 = (3.0 - 2.0 * st) / w0 - 2.0;
  let o1 = (3.0 + st) / w1;
  let o2 = st / w2 + 2.0;
  let ox = vec3f(o0.x, o1.x, o2.x);
  let wx = vec3f(w0.x, w1.x, w2.x);
  return (pcfRow3(base, ox, wx, o0.y, w0.y, depth) + pcfRow3(base, ox, wx, o1.y, w1.y, depth) + pcfRow3(base, ox, wx, o2.y, w2.y, depth)) / 144.0;
}

fn pcf7(base: vec2f, st: vec2f, depth: f32) -> f32 {
  let w0 = 5.0 * st - 6.0;
  let w1 = 11.0 * st - 28.0;
  let w2 = -(11.0 * st + 17.0);
  let w3 = -(5.0 * st + 1.0);
  let o0 = (4.0 * st - 5.0) / w0 - 3.0;
  let o1 = (4.0 * st - 16.0) / w1 - 1.0;
  let o2 = -(7.0 * st + 5.0) / w2 + 1.0;
  let o3 = -st / w3 + 3.0;
  let ox = vec4f(o0.x, o1.x, o2.x, o3.x);
  let wx = vec4f(w0.x, w1.x, w2.x, w3.x);
  return (pcfRow4(base, ox, wx, o0.y, w0.y, depth) + pcfRow4(base, ox, wx, o1.y, w1.y, depth)
    + pcfRow4(base, ox, wx, o2.y, w2.y, depth) + pcfRow4(base, ox, wx, o3.y, w3.y, depth)) / 2704.0;
}

/** 图集里 position 处的阴影（1 是亮）：一次双线性的比较采样，或者 PCF（Stride 的 CalculatePCFKernelParameters）。 */
fn filterShadow(position: vec2f, depth: f32) -> f32 {
  let size = u32(view.shadow.w);
  if (size == 0u) {
    return textureSampleCompareLevel(shadowAtlas, shadowComparison, position, depth);
  }
  let uv = position * view.shadowAtlas.y;
  let rounded = floor(uv + 0.5);
  let st = uv + 0.5 - rounded;
  let base = (rounded - 0.5) * view.shadowAtlas.x;
  if (size == 3u) {
    return pcf3(base, st, depth);
  }
  if (size == 5u) {
    return pcf5(base, st, depth);
  }
  return pcf7(base, st, depth);
}

fn shadowFromCascade(position: vec3f, cascade: u32) -> f32 {
  var p = view.shadowMatrices[cascade] * vec4f(position, 1.0);
  p.z -= view.shadow.y;
  let s = p.xyz / p.w;
  return filterShadow(s.xy, s.z);
}

const CASCADE_INDICES = vec4u(0u, 1u, 2u, 3u);

/**
 * v 的第 i 个分量。不写 v[i]：动态下标取 uniform 里 vec4 的分量时，DXC 先把整行存进局部数组再按下标读
 * （DXIL 里的 alloca），像素着色器里很慢。
 */
fn component(v: vec4f, i: u32) -> f32 {
  return dot(v, select(vec4f(0.0), vec4f(1.0), CASCADE_INDICES == vec4u(i)));
}

/** 方向光的阴影（Stride 的 ShadowMapReceiverDirectional.ComputeShadow）。 */
fn computeShadow(position: vec3f, normal: vec3f, nDotL: f32, depth: f32) -> f32 {
  let count = u32(view.shadow.x);
  if (count == 0u) {
    return 1.0;
  }
  // 级联：前 count - 1 个分界里深度超过了几个（分界递增，同 Stride 逐个比较取最后一个超过的）
  let splits = view.shadowSplits;
  let passed = select(vec4f(0.0), vec4f(1.0), (vec4f(depth) > splits) & (CASCADE_INDICES + 1u < vec4u(count)));
  let cascade = u32(dot(passed, vec4f(1.0)));
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去
  let p = position + 2.0 * view.shadowAtlas.x * view.shadow.z * saturate(1.0 - nDotL) * normal;
  var shadow = shadowFromCascade(p, cascade);
  let nextSplit = component(splits, cascade);
  var splitSize = nextSplit;
  if (cascade > 0u) {
    splitSize = nextSplit - component(splits, cascade - 1u);
  }
  let splitDistance = (nextSplit - depth) / splitSize;
  if (splitDistance < 0.2) {
    let amount = smoothstep(0.0, 0.2, splitDistance);
    if (cascade == count - 1u) {
      // 最后一个级联的末尾：手动深度范围时淡出，自动时不淡出
      if (view.shadowAtlas.w == 0.0) {
        shadow = mix(1.0, shadow, amount);
      }
    } else if (view.shadowAtlas.z != 0.0) {
      shadow = mix(shadowFromCascade(p, cascade + 1u), shadow, amount);
    }
  }
  return shadow;
}

/** 一个像素上着色要用的表面属性。 */
struct Surface { n: vec3f, v: vec3f, diffuse: vec3f, specular: vec3f, hasSpecular: bool, glass: bool, alphaR: f32, nDotV: f32 };

/** 薄玻璃（Stride 的 MaterialTransmittanceReflectanceStream）：按折射率、视角和玻璃的颜色算光透过去的比例和反射的比例。 */
struct Glass { transmittance: vec3f, reflectance: vec3f };
fn thinGlass(color: vec3f, cosTheta: f32, refractiveIndex: f32) -> Glass {
  let eta = max(refractiveIndex, 1.0001);
  let cosRefracted = sqrt(1.0 - (1.0 - cosTheta * cosTheta) / (eta * eta));
  let r0 = (eta * cosRefracted - cosTheta) / (eta * cosRefracted + cosTheta);
  let r1 = (eta * cosTheta - cosRefracted) / (eta * cosTheta + cosRefracted);
  // 进入界面时的菲涅耳反射率，剩下的透进去
  let r = 0.5 * saturate(r0 * r0 + r1 * r1);
  let t = 1.0 - r;
  // 玻璃里的吸收：颜色按光在里面走的路程（1 / cos）取幂
  let k = pow(max(color, vec3f(0.001)), vec3f(1.0 / cosRefracted));
  let rk = r * k;
  let transmittance = saturate(t * t * k / (1.0 - rk * rk));
  return Glass(transmittance, saturate(rk * transmittance + r));
}

/** 背面的法线翻过来朝着相机（Stride 的 MaterialSurfaceLightingAndShading）：两面画的材质背面也按正对着算光照。 */
fn facingNormal(n: vec3f, front: bool) -> vec3f {
  return select(-n, n, front);
}

/** 漫反射的基础色：贴图和颜色按运算符组合。 */
fn baseColor(in: Varyings) -> vec4f {
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv * material.uvTransform.xy + material.uvTransform.zw);
  return select(texel * material.baseColor, texel + material.baseColor, material.combine == 1u);
}

/**
 * 一个光源的直射光：Lambert 漫反射加 GGX 镜面（Fresnel Schlick、Smith-Schlick-GGX 可见性），l 是指向光源的单位向量，
 * lightColor 已经乘过衰减、阴影和遮蔽（Stride 的 MaterialSurfaceShadingDiffuseLambert、SpecularMicrofacet）。
 */
fn shadeLight(s: Surface, l: vec3f, lightColor: vec3f) -> vec3f {
  let nDotL = max(dot(s.n, l), 0.0001);
  let lightColorNdotL = lightColor * nDotL;
  var result = s.diffuse / PI * lightColorNdotL;
  let h = normalize(s.v + l);
  let nDotH = saturate(dot(s.n, h));
  let lDotH = saturate(dot(l, h));
  // 玻璃的菲涅耳项就是它的反射比例（MaterialSpecularMicrofacetFresnelThinGlass），放在 s.specular 里
  let fresnel = select(s.specular + (1.0 - s.specular) * pow(1.0 - lDotH, 5.0), s.specular, s.glass);
  let reflected = fresnel * visibilitySmithSchlickGGX(s.alphaR, nDotL, s.nDotV) * normalDistributionGGX(s.alphaR, nDotH) / 4.0;
  return result + select(vec3f(0.0), reflected * lightColorNdotL, s.hasSpecular);
}

/** Alpha 裁剪的材质在只写深度的阶段（深度预通道、阴影）：同不透明阶段一样丢掉 alpha 低于阈值的像素。 */
@fragment fn fsCutout(in: Varyings) {
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
}

/** 玻璃透射的那一遍（Stride 的 MaterialSurfaceTransmittanceShading）：输出的颜色乘到背景上（混合是 目标 × 源）。 */
@fragment fn fsGlassTransmittance(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = facingNormal(surfaceNormal(in), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  let glass = thinGlass(base.rgb, max(dot(n, v), 0.0001), material.flags.z);
  return vec4f(mix(vec3f(1.0), glass.transmittance, saturate(base.a * material.blend.a)), 1.0);
}

@fragment fn fs(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = facingNormal(surfaceNormal(in), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
  // 粗糙度：常量，或者光泽度贴图的一个通道（没有贴图时 mask 是 0，取常量）
  let glossTexel = dot(textureSample(glossinessTexture, glossinessSampler, in.uv * material.glossinessUvTransform.xy + material.glossinessUvTransform.zw), material.glossinessMask);
  let hasGlossTexture = dot(material.glossinessMask, vec4f(1.0)) > 0.0;
  // 材质层按遮罩混进各个属性（没有层时原样）
  let layered = materialLayers(in, LayerSurface(base.rgb, material.surface.x, material.specularColor.rgb,
    select(material.surface.y, select(1.0 - glossTexel, glossTexel, material.flags.x > 0.5), hasGlossTexture)));
  let albedo = layered.albedo;

  // 金属度工作流（MaterialSurfaceMetalness）或镜面颜色（MaterialSpecularMapFeature），再乘 cavity 和透明的 alpha、tint
  // （PrepareMaterialForLightingAndShading；镜面项的 alpha 是 matDiffuseSpecularAlphaBlend.y）
  // material.specular 的低两位是工作流（0 没有，1 金属度，2 镜面颜色，3 镜面颜色且能量守恒）；第 3 位（4）表示没有镜面着色模型：
  // 不画镜面反射，可见的镜面色（matSpecularVisible）照常算，只用来折进漫反射；第 4 位（8）表示没有漫反射着色模型：不算漫反射光照
  let workflow = material.specular & 3u;
  let hasSpecular = workflow != 0u && (material.specular & 4u) == 0u;
  let metalness = layered.metalness;
  let isMetalness = workflow == 1u;
  let f0 = select(layered.specular, mix(vec3f(0.02), albedo, metalness), isMetalness);
  let visibleSpecular = select(vec3f(0.0), f0, workflow != 0u) * material.surface.w * material.blend.rgb * material.emissive.w;
  let specular = select(vec3f(0.0), visibleSpecular, hasSpecular);
  // 镜面颜色工作流默认能量守恒（Stride 的 IsEnergyConservative：MaterialSurfaceShadingDiffuseLambert 的漫反射乘 1 - 镜面）
  let conserved = select(vec3f(1.0), 1.0 - visibleSpecular, workflow == 3u);
  let litDiffuse = select(albedo, albedo * (1.0 - metalness), isMetalness) * material.surface.z * material.blend.rgb * material.blend.a * conserved;
  let diffuse = select(litDiffuse, vec3f(0.0), (material.specular & 8u) != 0u);
  // 环境光遮蔽：环境光全乘，直射光乘 lerp(1, ao, occlusionDirect)
  let ao = dot(textureSample(occlusionTexture, occlusionSampler, in.uv * material.occlusionUvTransform.xy + material.occlusionUvTransform.zw), material.occlusionMask);
  let directOcclusion = mix(1.0, ao, material.occlusionDirect);
  let roughness = layered.roughness;
  let alphaR = max(roughness * roughness, 0.001);
  let nDotV = max(dot(n, v), 0.0001);

  // 直射光（DirectLightGroup.PrepareDirectLight：光色 · 衰减 · 阴影 · N·L），逐个光源相加
  // 玻璃：镜面的菲涅耳项和环境光的镜面系数都换成它的反射比例（Stride 的 FresnelThinGlass、EnvironmentThinGlass）
  let isGlass = material.flags.z > 0.0;
  let glass = thinGlass(base.rgb, nDotV, material.flags.z);
  let surface = Surface(n, v, diffuse, select(specular, glass.reflectance, isGlass), hasSpecular, isGlass, alphaR, nDotV);
  var direct = vec3f(0.0);
  let lightCount = u32(view.sky.z);
  let shadowLight = i32(view.sky.w);
  for (var i = 0u; i < lightCount; i++) {
    let l = -view.lightDirections[i].xyz;
    var shadow = 1.0;
    if (i32(i) == shadowLight) {
      shadow = computeShadow(in.world, n, max(dot(n, l), 0.0001), in.depth);
    }
    direct += shadeLight(surface, l, view.lightColors[i].rgb * shadow * directOcclusion);
  }
  // 点光、聚光：距离衰减（LightUtil.GetDistanceAttenuation），聚光再乘角度衰减（GetAngularAttenuation）
  for (var i = 0u; i < u32(view.locals.x); i++) {
    let light = localLights[i];
    let toLight = light.position.xyz - in.world;
    let distance = length(toLight);
    let l = toLight / distance;
    let d2 = distance * distance;
    let falloff = saturate(1.0 - pow(d2 * light.position.w, 2.0));
    var attenuation = falloff * falloff / max(d2, 0.0001);
    if (light.color.w > 0.5) {
      let angular = saturate(dot(-l, light.direction.xyz) * light.angle.x + light.angle.y);
      attenuation *= angular * angular;
    }
    direct += shadeLight(surface, l, light.color.rgb * attenuation * directOcclusion);
  }
  // 直射光的总和乘 π（MaterialSurfaceLightingAndShading："*PI over hemisphere"），光源强度因此和 Stride 的场景一致
  var color = direct * PI;

  // 环境光：镜面项都乘 DFG（Stride 的环境 BRDF 查找表）
  let dfg = textureSampleLevel(dfgLut, linearClamp, vec2f(1.0 - sqrt(alphaR), nDotV), 0.0).rg;
  let environmentSpecular = select(vec3f(0.0), select(specular * dfg.x + dfg.y, glass.reflectance, isGlass), hasSpecular);
  color += (diffuse * view.ambientColor.rgb + environmentSpecular * view.ambientColor.rgb) * ao;

  // 天空盒光：强度是 0 时贡献也是 0，不用分支
  let skyIntensity = view.sky.x * ao;
  let skyDiffuse = evaluateSH(skyDirection(n)) * skyIntensity;
  let reflection = skyDirection(reflect(-v, n));
  let skySpecularColor = textureSampleLevel(skySpecular, linearClamp, reflection, sqrt(alphaR) * view.sky.y).rgb * skyIntensity;
  color += diffuse * skyDiffuse + environmentSpecular * skySpecularColor;

  // 自发光：a 不小于 0 时输出的 alpha 用它（Stride 的 UseAlpha）
  let emitted = emissiveColor(in);
  color += layerEmissive(in, emitted.rgb);
  let alpha = select(base.a, emitted.a, emitted.a >= 0.0);
  // 预乘 alpha：颜色已经乘过 alpha；不透明的阶段不混合，alpha 不起作用。网格效果最后可以改颜色（Stride 的 ShadingBase.Shading）
  return effectShading(vec4f(color, saturate(alpha * material.blend.a)), in.effect);
}`;

/**
 * 材质的颜色树（Material.shaderTrees）接进网格着色器的三个函数，没有对应的树时用默认：
 * - emissiveColor：自发光（树先填共用的流，再乘强度；默认是贴图乘 emissive，没有贴图时是白图）；a 不小于 0 时输出的 alpha 用它；
 * - treeNormal：切线空间的法线（已经按 ScaleAndBias、IsXYNormal 换好），w 为 0 时没有法线树、用法线贴图；
 * - treeDisplacement：顶点沿模型空间的法线移动多少（顶点着色器里算）。
 */
function materialTreesCode(trees: MaterialShaderTrees | undefined): string {
  const { emissive, normal, displacement } = trees ?? {};
  const fill = (uv: string, local: string) => `streams = MaterialStreams(${uv}, ${uv}, vec4f(1.0), vec4f(1.0), ${local}, view.locals.y);`;
  const emissiveCode = emissive
    ? `fn emissiveColor(in: Varyings) -> vec4f {
  ${fill('in.uv', 'in.local')}
  let e = emissiveTree();
  return vec4f(e.rgb * ${wgslFloat(emissive.intensity)}, ${emissive.useAlpha ? 'e.a' : '-1.0'});
}`
    : `fn emissiveColor(in: Varyings) -> vec4f {
  return vec4f(textureSample(emissiveTexture, emissiveSampler, in.uv * material.emissiveUvTransform.xy + material.emissiveUvTransform.zw).rgb * material.emissive.rgb, -1.0);
}`;
  const normalCode = normal
    ? `fn treeNormal(in: Varyings) -> vec4f {
  ${fill('in.uv', 'in.local')}
  var m = normalTree().xyz;
  ${normal.scaleAndBias ? 'm = 2.0 * m - 1.0;' : ''}
  ${normal.isXYNormal ? 'm.z = sqrt(max(0.0, 1.0 - (m.x * m.x + m.y * m.y)));' : ''}
  return vec4f(m, 1.0);
}`
    : 'fn treeNormal(in: Varyings) -> vec4f { return vec4f(0.0); }';
  const displacementCode = displacement
    ? `fn treeDisplacement(uv: vec2f, local: vec3f) -> f32 {
  ${fill('uv', 'local')}
  let d = displacementTree();
  return ${displacement.scaleAndBias ? '(2.0 * d - 1.0)' : 'd'} * ${wgslFloat(displacement.intensity)};
}`
    : 'fn treeDisplacement(uv: vec2f, local: vec3f) -> f32 { return 0.0; }';
  return [MATERIAL_STREAMS, trees?.code ?? '', emissiveCode, normalCode, displacementCode, layersCode(trees?.layers ?? [])].join('\n');
}

/**
 * 材质层（Stride 的 MaterialBlendLayer、MaterialStreamLinearBlend）：每层的遮罩 b，各个属性 mix(下面的, 这层的, b)；光泽度换成粗糙度
 * 再混，法线在切线空间里混再归一化，自发光（乘过强度的）也一样混。没有层时三个函数原样返回。
 */
function layersCode(layers: readonly MaterialShaderLayer[]): string {
  const fill = `streams = MaterialStreams(in.uv, in.uv, vec4f(1.0), vec4f(1.0), in.local, view.locals.y);`;
  const surface = layers.map((layer, i) => [
    `  let b${i} = saturate(layer${i}Blend());`,
    layer.diffuse ? `  r.albedo = mix(r.albedo, layer${i}Diffuse().rgb, b${i});` : '',
    layer.specular ? `  r.specular = mix(r.specular, layer${i}Specular(), b${i});` : '',
    layer.metalness ? `  r.metalness = mix(r.metalness, layer${i}Metalness(), b${i});` : '',
    layer.glossiness ? `  r.roughness = mix(r.roughness, ${layer.glossiness.invert ? '' : '1.0 - '}layer${i}Gloss(), b${i});` : '',
  ].filter(Boolean).join('\n')).join('\n');
  const normals = layers.map((layer, i) => (layer.normal ? [
    `  var l${i} = layer${i}Normal().xyz;`,
    layer.normal.scaleAndBias ? `  l${i} = 2.0 * l${i} - 1.0;` : '',
    layer.normal.isXYNormal ? `  l${i}.z = sqrt(max(0.0, 1.0 - (l${i}.x * l${i}.x + l${i}.y * l${i}.y)));` : '',
    `  n = normalize(mix(n, l${i}, saturate(layer${i}Blend())));`,
  ].filter(Boolean).join('\n') : '')).filter(Boolean);
  const emissive = layers.map((layer, i) => (layer.emissive ? `  e = mix(e, layer${i}Emissive(), saturate(layer${i}Blend()));` : '')).filter(Boolean);
  return `struct LayerSurface { albedo: vec3f, metalness: f32, specular: vec3f, roughness: f32 };
fn layerEmissive(in: Varyings, base: vec3f) -> vec3f {
${emissive.length > 0 ? `  ${fill}\n  var e = base;\n${emissive.join('\n')}\n  return e;` : '  return base;'}
}
fn materialLayers(in: Varyings, s: LayerSurface) -> LayerSurface {
  var r = s;
${layers.length > 0 ? `  ${fill}\n${surface}` : ''}
  return r;
}
fn layerNormal(in: Varyings, m: vec3f) -> vec4f {
${normals.length > 0 ? `  ${fill}\n  var n = m;\n${normals.join('\n')}\n  return vec4f(n, 1.0);` : '  return vec4f(m, 0.0);'}
}`;
}

/** WGSL 的浮点字面量（整数也带小数点）。 */
function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const DFG_LUT_WIDTH = 32;
const DFG_LUT_HEIGHT = 64;

/**
 * 环境 BRDF 的 DFG 查找表：x 是光泽度（1 - sqrt(alphaR)），y 是 N·V，值是 (scale, bias)，镜面项 = specular · scale + bias。
 * GGX 重要性采样（1024 个 Hammersley 点），G 用 Smith-Schlick-GGX，F 用 Schlick；尺寸同 Stride 的 EnvironmentLightingDFGLUT16。
 */
const DFG_LUT_SHADER = /* wgsl */ `
${BRDF}
${FULLSCREEN_VERTEX}

const SAMPLES = 1024u;

@fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2f(${DFG_LUT_WIDTH}.0, ${DFG_LUT_HEIGHT}.0);
  let glossiness = position.x / size.x;
  let nDotV = position.y / size.y;
  let roughness = 1.0 - glossiness;
  let alphaR = roughness * roughness;
  let a2 = alphaR * alphaR;
  let v = vec3f(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
  var scale = 0.0;
  var bias = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let xi = vec2f(f32(reverseBits(i)) * 2.3283064365386963e-10, (f32(i) + 0.5) / f32(SAMPLES));
    let phi = 2.0 * PI * xi.x;
    let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    let h = vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
    let vDotH = dot(v, h);
    let l = 2.0 * vDotH * h - v;
    let nDotL = l.z;
    if (nDotL > 0.0) {
      let g = visibilitySchlickGGX(alphaR, nDotL) * visibilitySchlickGGX(alphaR, nDotV);
      let visibility = g * max(vDotH, 0.0) / (max(h.z, 0.0) * nDotV);
      let fc = pow(1.0 - max(vDotH, 0.0), 5.0);
      scale += (1.0 - fc) * visibility;
      bias += fc * visibility;
    }
  }
  return vec4f(scale / f32(SAMPLES), bias / f32(SAMPLES), 0.0, 1.0);
}`;

/** 每个视图的常量占一块：uniform 的动态偏移必须是 minUniformBufferOffsetAlignment（256）的整数倍。 */
const VIEW_STRIDE = 768;
/** View 结构：viewProjection 16、eye 4、环境色 4、sky 4、球谐 36、天空盒旋转 16、阴影矩阵 64、阴影参数 12、方向光 8 · 4。 */
const VIEW_FLOATS = 192;
/** 一个点光或聚光在存储缓冲里的 float 数（LocalLight）。 */
const LOCAL_LIGHT_FLOATS = 16;
/** 一帧最多的视图数：主视图加 4 个阴影级联，留些余量。 */
const MAX_VIEWS = 8;
/** 材质 uniform：Material 结构（11 个 vec4、四个标量、光泽度贴图的三个 vec4），按 16 字节对齐。 */
const MATERIAL_BYTES = 224;
const CHANNELS = { r: [1, 0, 0, 0], g: [0, 1, 0, 0], b: [0, 0, 1, 0], a: [0, 0, 0, 1] } as const;
const OPERATOR_CODES = { multiply: 0, add: 1 } as const;
/** 网格参数的 uniform：positionOffset、positionScale、uvTransform 各一个 vec4，再加 flags，补齐到 16 字节。 */
/** 反量化参数和 flags（64 字节），加上网格效果的 16 个参数。 */
const MESH_PARAMS_BYTES = 64 + MESH_EFFECT_PARAMETERS * 4;

/** 一次剔除：一个剔除工作区和它剔除的视图；结果在实例缓冲里从 offset 开始，每个视图 slotCount 个。 */
interface CullPass {
  readonly culler: FrustumCuller;
  readonly views: RenderView[];
  slotCount: number;
  batchCount: number;
  offset: number;
}

interface GpuMesh {
  /** 第 2 组绑定：反量化参数、网格效果的参数。 */
  readonly params: GPUBuffer;
  /** 上传的效果参数是哪个效果、网格的哪个版本（变了就重新上传）。 */
  effect: MeshEffect | undefined;
  effectVersion: number;
  readonly bindGroup: GPUBindGroup;
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly indexFormat: GPUIndexFormat;
  readonly indexCount: number;
}

interface GpuMaterial {
  readonly buffer: GPUBuffer;
  bindGroup: GPUBindGroup | undefined;
  version: number;
}

export class MeshRenderFeature extends RootRenderFeature {
  readonly name = 'MeshRenderFeature';
  /** 网格效果（Stride 合成器里 MeshRenderFeature 的 EffectName 指的效果）：所有网格都用它画；没有时是默认的效果。 */
  effect: MeshEffect | undefined;
  /** 这一帧的批次，按第一次出现的顺序；空的批次留着下一帧复用。 */
  readonly batches: MeshBatch[] = [];
  readonly #batchByKey = new Map<number, MeshBatch>();
  #instanceCount = 0;
  /** 这一帧各视图实际画了多少实例、多少次绘制（剔除之后，所有视图加起来）。 */
  drawnInstances = 0;
  drawCalls = 0;

  readonly #extractSystem = system('MeshRenderFeature.extract', {
    with: { model: Model, transform: Transform },
    without: [Skinned, Instancing],
    update: ({ model, transform, count }) => this.#extract(model, transform.slot, count, false),
  });

  /** 实例：画主实体的模型（每帧按主实体查一次）。 */
  readonly #masters = new Map<EntityId, { mesh: number; material: number; isShadowCaster: boolean } | null>();
  #entityManager: EntityManager | undefined;
  readonly #extractInstancesSystem = system('MeshRenderFeature.extractInstances', {
    with: { instance: Instance, transform: Transform },
    update: ({ instance, transform, count }) => {
      const masters = this.#masters, entities = this.#entityManager!;
      for (let i = 0; i < count; i++) {
        const id = instance.master[i]! as EntityId;
        let master = masters.get(id);
        if (master === undefined) {
          const model = id >= 0 && entities.isAlive(id) ? entities.entity(id).get(Model) : undefined;
          master = model ? { mesh: model.mesh, material: model.material, isShadowCaster: model.isShadowCaster } : null;
          masters.set(id, master);
        }
        if (!master) continue;
        const batch = this.#batchFor(master.mesh, master.material, master.isShadowCaster, false);
        if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
        batch.slots[batch.count++] = transform.slot[i]!;
      }
    },
  });

  readonly #extractSkinnedSystem = system('MeshRenderFeature.extractSkinned', {
    with: { model: Model, transform: Transform, skinned: Skinned },
    update: ({ model, transform, skinned, count }) => {
      this.#extract(model, transform.slot, count, true);
      for (let i = 0; i < count; i++) this.#paletteOf.set(transform.slot[i]!, skinned.palette[i]!);
    },
  });

  /** 变换槽位 → 蒙皮矩阵的起点（只有蒙皮的槽位有意义），改了才重新上传。 */
  readonly #paletteOf = new SlotTable();

  readonly #extractMorphedSystem = system('MeshRenderFeature.extractMorphed', {
    with: { transform: Transform, morphed: Morphed },
    update: ({ transform, morphed, count }) => {
      for (let i = 0; i < count; i++) this.#morphOf.set(transform.slot[i]!, morphed.weights[i]!);
    },
  });

  /** 变换槽位 → 形变权重的起点（只有带形变网格的槽位有意义）。 */
  readonly #morphOf = new SlotTable();

  // 剔除：一帧里第 k 次 cull 用第 k 个工作区；视图到（剔除，视图在其中的下标）
  readonly #cullPasses: CullPass[] = [];
  #cullPassCount = 0;
  readonly #viewCulling = new Map<RenderView, { pass: CullPass; index: number }>();

  // GPU 资源，第一次 Prepare 时创建
  #gpu: Gpu | undefined;

  override extract(context: RenderContext): void {
    for (const batch of this.batches) batch.count = 0;
    context.game.entities.run(this.#extractSystem, context.time);
    context.game.entities.run(this.#extractSkinnedSystem, context.time);
    context.game.entities.run(this.#extractMorphedSystem, context.time);
    this.#masters.clear();
    this.#entityManager = context.game.entities;
    context.game.entities.run(this.#extractInstancesSystem, context.time);
    let first = 0;
    for (const batch of this.batches) {
      batch.first = first;
      first += batch.count;
    }
    this.#instanceCount = first;
    this.#cullPassCount = 0;
    this.#viewCulling.clear();
    this.drawnInstances = this.drawCalls = 0;
  }

  /** 这一帧提取到的实例总数（剔除之前）。 */
  get instanceCount(): number {
    return this.#instanceCount;
  }

  override stats(): Record<string, number> {
    return { instances: this.#instanceCount, drawnInstances: this.drawnInstances, drawCalls: this.drawCalls };
  }

  override cull(context: RenderContext, views: readonly RenderView[]): void {
    if (views.length === 0) return;
    const pass = (this.#cullPasses[this.#cullPassCount] ??= { culler: context.game.transforms.createCuller(), views: [], slotCount: 0, batchCount: 0, offset: 0 });
    this.#cullPassCount++;
    const { culler } = pass;
    const slotCount = this.#instanceCount, batchCount = this.batches.length;
    culler.reserve(slotCount, batchCount);
    const { slots, batchEnds, bounds } = culler;
    this.batches.forEach((batch, b) => {
      slots.set(batch.slots.subarray(0, batch.count), batch.first);
      batchEnds[b] = batch.first + batch.count;
      const { min, max } = batch.mesh.cullBounds;
      for (let c = 0; c < 3; c++) {
        bounds[b * 6 + c] = (min[c]! + max[c]!) / 2;
        bounds[b * 6 + 3 + c] = (max[c]! - min[c]!) / 2;
      }
    });
    views.forEach((view, i) => {
      culler.setView(i, view.frustumPlanes, view.ignoreDepthPlanes ? 4 : 6, view.ignoreDepthPlanes ? undefined : view.nearPlane);
      this.#viewCulling.set(view, { pass, index: i });
    });
    culler.cull(slotCount, batchCount, views.length);
    views.forEach((view, i) => {
      view.minimumDistance = Math.min(view.minimumDistance, culler.minDistance(i));
      view.maximumDistance = Math.max(view.maximumDistance, culler.maxDistance(i));
    });
    pass.views.length = 0;
    pass.views.push(...views);
    pass.slotCount = slotCount;
    pass.batchCount = batchCount;
  }

  override prepare(context: RenderContext): void {
    const gpu = (this.#gpu ??= new Gpu(this.system.device, this.system.resources, this.system.graphicsDevice.depthClipControl));
    gpu.uploadWorlds(context.game.transforms.world, context.game.transforms.slotLimit);
    gpu.uploadSkinning(this.#paletteOf, context.game.animation);
    gpu.uploadMorphs(this.#morphOf, context.game.animation);
    const passes = this.#cullPasses.slice(0, this.#cullPassCount);
    let offset = 0;
    for (const pass of passes) {
      pass.offset = offset;
      offset += pass.views.length * pass.slotCount;
    }
    gpu.uploadInstances(passes, offset);
    gpu.uploadViews(this.system.views, this.system.lighting, context.game.updateTime.total);
  }

  /**
   * 不透明的批画在深度预通道、不透明和阴影阶段，透明材质的批只画在透明阶段（不投阴影，和 Stride 不同：Stride 默认按 alpha
   * 抖动着投阴影）。透明的批按第一个实例到相机的距离从远到近画；同一批的实例不排序（和 Stride 不同：Stride 按每个物体排）。
   */
  override draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    const culling = this.#viewCulling.get(view);
    if (!gpu || !culling) return;
    const { pass: cullPass, index } = culling;
    const counts = cullPass.culler.counts;
    const visible = (b: number) => counts[index * cullPass.batchCount + b]! > 0 && this.batches[b]!.material.isTransparent === stage.transparent;
    const order = stage.transparent ? this.#backToFront(context, view, cullPass.batchCount, visible) : undefined;
    if (order?.length === 0) return;
    const shadow = stage.shadowCasters ? undefined : this.system.lighting.shadow;
    pass.setBindGroup(0, gpu.viewBindGroup(shadow?.atlas), [view.index * VIEW_STRIDE]);
    let mesh: Mesh | undefined, material: Material | undefined, pipeline: GPURenderPipeline | undefined, skinned = false;
    const viewOffset = cullPass.offset + index * cullPass.slotCount;
    for (let i = 0, end = order?.length ?? cullPass.batchCount; i < end; i++) {
      const b = order ? order[i]! : i;
      const batch = this.batches[b]!;
      const count = counts[index * cullPass.batchCount + b]!;
      if (!visible(b) || (stage.shadowCasters && !batch.isShadowCaster)) continue;
      // pass 内只在变化时重设状态（docs/lessons.md）
      const gpuMesh = gpu.mesh(batch.mesh, this.effect);
      const materialChanged = batch.material !== material, meshChanged = batch.mesh !== mesh || batch.skinned !== skinned;
      const glassPasses = glassPassCount(stage, batch.material);
      const pipelineOf = (glassPass?: number) => gpu.pipelineFor(stage, batch.mesh.layout, batch.skinned, batch.mesh.data.morph !== undefined, batch.material, this.effect, glassPass);
      if (glassPasses === 0 && (materialChanged || meshChanged)) {
        // 管线也按材质分（自发光变体、两面画），同样的组合是同一条管线
        const next = pipelineOf();
        if (next !== pipeline) pass.setPipeline((pipeline = next));
      }
      if (materialChanged) {
        material = batch.material;
        pass.setBindGroup(1, gpu.material(material));
        const tree = gpu.treeBindGroup(material);
        if (tree) pass.setBindGroup(3, tree);
      }
      if (meshChanged) {
        mesh = batch.mesh;
        skinned = batch.skinned;
        pass.setBindGroup(2, gpuMesh.bindGroup);
        pass.setVertexBuffer(0, gpuMesh.vertices);
        pass.setIndexBuffer(gpuMesh.indices, gpuMesh.indexFormat);
      }
      // 玻璃一遍一条管线，其余只画一遍
      for (let glassPass = 0; glassPass < Math.max(glassPasses, 1); glassPass++) {
        if (glassPasses > 0) pass.setPipeline((pipeline = pipelineOf(glassPass)));
        pass.drawIndexed(gpuMesh.indexCount, count, 0, 0, viewOffset + batch.first);
        this.drawCalls++;
      }
      this.drawnInstances += count;
    }
  }

  override destroy(): void {
    this.#gpu?.destroy();
    this.#gpu = undefined;
    for (const pass of this.#cullPasses) pass.culler.destroy();
    this.#cullPasses.length = 0;
  }

  /** 可见的透明批按第一个实例到相机的距离从远到近排。 */
  #backToFront(context: RenderContext, view: RenderView, batchCount: number, visible: (b: number) => boolean): number[] {
    const world = context.game.transforms.world;
    const { x, y, z } = view.eye;
    const distance = (b: number) => {
      const at = this.batches[b]!.slots[0]! * 16;
      return (world[at + 12]! - x) ** 2 + (world[at + 13]! - y) ** 2 + (world[at + 14]! - z) ** 2;
    };
    const order: number[] = [];
    for (let b = 0; b < batchCount; b++) if (visible(b)) order.push(b);
    return order.length < 2 ? order : order.map((b) => [b, distance(b)] as const).sort((p, q) => q[1] - p[1]).map(([b]) => b);
  }

  /** 一张表的行按批记下变换槽位。相邻的行大多是同一批，先比较上一批，省掉大部分 Map 查找。 */
  #extract(model: ColumnsOf<typeof Model>, slots: ArrayLike<number>, count: number, skinned: boolean): void {
    const { mesh, material, isShadowCaster } = model;
    let batch: MeshBatch | undefined;
    for (let i = 0; i < count; i++) {
      const meshId = mesh[i]!, materialId = material[i]!, caster = isShadowCaster[i] !== 0;
      if (!batch || batch.mesh.id !== meshId || batch.material.id !== materialId || batch.isShadowCaster !== caster) batch = this.#batchFor(meshId, materialId, caster, skinned);
      if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
      batch.slots[batch.count++] = slots[i]!;
    }
  }

  #batchFor(meshId: number, materialId: number, isShadowCaster: boolean, skinned: boolean): MeshBatch {
    // 两个 id 都远小于 2^25，拼成一个整数键不会冲突（最大约 2^52，在双精度的整数范围里）
    const key = ((meshId * 0x2000000 + materialId) * 2 + (isShadowCaster ? 1 : 0)) * 2 + (skinned ? 1 : 0);
    let batch = this.#batchByKey.get(key);
    if (!batch) {
      const mesh = Mesh.byId(meshId);
      const material = Material.byId(materialId);
      if (!mesh) throw new Error(`Model refers to mesh ${meshId}, which does not exist`);
      if (!material) throw new Error(`Model refers to material ${materialId}, which does not exist`);
      if (skinned && !mesh.layout.joints) throw new Error(`mesh '${mesh.name}' is drawn skinned but has no joints and weights`);
      batch = { mesh, material, isShadowCaster, skinned, slots: new Uint32Array(64), count: 0, first: 0 };
      this.#batchByKey.set(key, batch);
      this.batches.push(batch);
    }
    return batch;
  }
}

/** 按变换槽位存的 u32（蒙皮矩阵的起点）：按需增长，记着有没有改过。 */
class SlotTable {
  values = new Uint32Array(256);
  dirty = true;

  set(slot: number, value: number): void {
    if (slot >= this.values.length) {
      this.values = grow(this.values, Math.max(slot + 1, this.values.length * 2));
      this.dirty = true;
    }
    if (this.values[slot] === value) return;
    this.values[slot] = value;
    this.dirty = true;
  }
}

function grow(array: Uint32Array, capacity: number): Uint32Array<ArrayBuffer> {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

/** 一个特性在一个设备上的 GPU 资源。 */
class Gpu {
  readonly device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #unclippedDepth: boolean;
  /** 着色器按自发光分变体：默认的是 ''，颜色树的按它的代码。 */
  readonly #modules = new Map<string, GPUShaderModule>();
  readonly #viewLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #meshLayout: GPUBindGroupLayout;
  /** 按颜色树的贴图数：0 是三个绑定组，多的再加绑定组 3。 */
  readonly #pipelineLayouts = new Map<number, { readonly layout: GPUPipelineLayout; readonly textures?: GPUBindGroupLayout }>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  /** 颜色树的贴图绑定组（绑定组 3）。 */
  readonly #treeBindGroups = new Map<Material, GPUBindGroup>();
  readonly #meshes = new Map<Mesh, GpuMesh>();
  readonly #materials = new Map<Material, GpuMaterial>();
  readonly #materialData = new ArrayBuffer(MATERIAL_BYTES);
  readonly #dfgLut: GPUTexture;

  #worlds: GPUBuffer | undefined;
  #instances: GPUBuffer | undefined;
  #paletteOf: GPUBuffer | undefined;
  #palettes: GPUBuffer | undefined;
  #morphOf: GPUBuffer | undefined;
  #morphWeights: GPUBuffer | undefined;
  /** 没有形变的网格绑的空缓冲。 */
  readonly #noMorph: GPUBuffer;
  #views: GPUBuffer | undefined;
  readonly #viewData = new Float32Array((VIEW_STRIDE / 4) * MAX_VIEWS);
  readonly #localLightData = new Float32Array(MAX_LOCAL_LIGHTS * LOCAL_LIGHT_FLOATS);
  readonly #localLights: GPUBuffer;
  /** 视图绑定组，按绑在阴影位置上的深度图分开：画阴影图集时不能同时采样它。 */
  readonly #viewBindGroups = new Map<GPUTexture, GPUBindGroup>();
  /** 视图绑定组里的天空盒镜面立方体贴图；换了天空盒要重建绑定组。 */
  #skySpecular: GPUTexture | undefined;

  constructor(device: GPUDevice, resources: GpuResources, unclippedDepth: boolean) {
    this.device = device;
    this.#resources = resources;
    this.#unclippedDepth = unclippedDepth;
    this.#viewLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIEW_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 9, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 11, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 12, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        ...[6, 7, 8].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} })),
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#meshLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature mesh',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.#noMorph = this.#createFilled('MeshRenderFeature no morph', GPUBufferUsage.STORAGE, new Uint32Array(4));
    this.#dfgLut = createDfgLut(device);
    this.#localLights = this.#createStorage('MeshRenderFeature local lights', MAX_LOCAL_LIGHTS * LOCAL_LIGHT_FLOATS * 4);
  }

  /** 着色器模块：按自发光的颜色树和网格效果分变体（两段代码是键）。 */
  #module(trees: MaterialShaderTrees | undefined, effect: MeshEffect | undefined): GPUShaderModule {
    const key = `${trees ? JSON.stringify([trees.code, trees.emissive, trees.normal, trees.displacement, trees.layers]) : ''}|${effect?.code ?? ''}`;
    let module = this.#modules.get(key);
    if (!module) {
      const label = `MeshRenderFeature${trees ? ' (material trees)' : ''}${effect ? ' (mesh effect)' : ''}`;
      module = createCheckedShaderModule(this.device, label, SHADER + meshEffectCode(effect) + materialTreesCode(trees));
      this.#modules.set(key, module);
    }
    return module;
  }

  /** 颜色树有 textureCount 张贴图时的管线布局（贴图在绑定组 3）。 */
  #layout(textureCount: number): { readonly layout: GPUPipelineLayout; readonly textures?: GPUBindGroupLayout } {
    let found = this.#pipelineLayouts.get(textureCount);
    if (!found) {
      const groups = [this.#viewLayout, this.#materialLayout, this.#meshLayout];
      const textures = textureCount > 0 ? this.device.createBindGroupLayout({
        label: `MeshRenderFeature material trees ${textureCount}`,
        entries: Array.from({ length: textureCount }, (_, i) => [
          // 位移贴图的树在顶点着色器里采样
          { binding: i * 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
          { binding: i * 2 + 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
        ]).flat(),
      }) : undefined;
      found = { layout: this.device.createPipelineLayout({ bindGroupLayouts: textures ? [...groups, textures] : groups }), ...(textures ? { textures } : {}) };
      this.#pipelineLayouts.set(textureCount, found);
    }
    return found;
  }

  /** 材质的颜色树贴图的绑定组（没有颜色树或者没有贴图时是 undefined）。 */
  treeBindGroup(material: Material): GPUBindGroup | undefined {
    const shader = material.shaderTrees;
    if (!shader || shader.textures.length === 0) return undefined;
    let group = this.#treeBindGroups.get(material);
    if (!group) {
      group = this.device.createBindGroup({
        label: `${material.name} material trees`,
        layout: this.#layout(shader.textures.length).textures!,
        entries: shader.textures.flatMap(({ texture, sampler }, i) => [
          { binding: i * 2, resource: this.#resources.texture(texture).createView() },
          { binding: i * 2 + 1, resource: this.#resources.sampler(sampler) },
        ]),
      });
      this.#treeBindGroups.set(material, group);
    }
    return group;
  }

  /**
   * 一个阶段加一种顶点布局（再分蒙皮不蒙皮）一条管线；画颜色的阶段再按材质的自发光变体和两面画分。只有深度的阶段（深度预通道、
   * 阴影投射）没有片元着色器；阴影投射还不剔背面、不做深度裁剪（Stride 的 ShadowMeshPipelineProcessor）。深度比较是 less-equal
   * （Stride 的 DepthStencilStates.Default），不透明阶段靠它复用深度预通道的结果。
   */
  pipelineFor(stage: RenderStage, layout: VertexLayout, skinned: boolean, morphed: boolean, material: Material, effect: MeshEffect | undefined, glassPass?: number): GPURenderPipeline {
    const { colorFormat, depthFormat } = stage.output;
    // 玻璃的各遍（见 glassPassCount）：偶数遍是透射（乘到背景上），奇数遍是反射（加上去）；两面画时前两遍画背面
    const transmittance = glassPass !== undefined && glassPass % 2 === 0;
    const backFaces = glassPass !== undefined && material.doubleSided && glassPass < 2;
    const skin = skinned ? `${layout.joints}:${layout.weights}` : 'static';
    // 只有深度的阶段不看材质（两面画的材质也只影响颜色阶段，阴影投射本来就不剔背面）
    // 颜色树的变体每个阶段都用：位移贴图在只写深度的阶段也要算（深度预通道和不透明阶段的深度要一样）
    const trees = material.shaderTrees;
    const doubleSided = colorFormat !== undefined && material.doubleSided;
    // Alpha 裁剪的材质在只写深度的阶段也要片元着色器（丢掉被裁的像素），别的材质那里不要
    const cutout = colorFormat === undefined && material.alphaCutoff !== undefined;
    const key = `${stage.name}:${colorFormat}:${depthFormat}:${layout.position}:${layout.normal}:${layout.uv}:${layout.tangent}:${skin}:${morphed}:${doubleSided}:${cutout}:${glassPass}:${trees ? JSON.stringify([trees.code, trees.emissive, trees.normal, trees.displacement, trees.layers]) : ''}:${effect?.code ?? ''}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const offsets = vertexLayoutOffsets(layout);
      const entryPoint = `vs${skinned ? 'Skinned' : ''}${layout.tangent ? 'Tangent' : ''}`;
      const module = this.#module(trees, effect);
      pipeline = this.device.createRenderPipeline({
        label: `MeshRenderFeature ${stage.name} ${layout.position}/${layout.normal}/${layout.uv}${skinned ? ' skinned' : ''}${morphed ? ' morphed' : ''}${trees ? ' material trees' : ''}`,
        layout: this.#layout(trees?.textures.length ?? 0).layout,
        vertex: {
          module,
          entryPoint,
          ...(morphed ? { constants: { MORPHED: 1 } } : {}),
          buffers: [{
            arrayStride: offsets.stride,
            attributes: [
              { shaderLocation: 0, offset: offsets.position, format: layout.position },
              { shaderLocation: 1, offset: offsets.normal, format: layout.normal },
              { shaderLocation: 2, offset: offsets.uv, format: layout.uv },
              ...(layout.tangent ? [{ shaderLocation: 3, offset: offsets.tangent!, format: layout.tangent }] : []),
              ...(skinned ? [
                { shaderLocation: 4, offset: offsets.joints!, format: layout.joints! },
                { shaderLocation: 5, offset: offsets.weights!, format: layout.weights! },
              ] : []),
            ],
          }],
        },
        ...(colorFormat ? {
          fragment: {
            module,
            entryPoint: transmittance ? 'fsGlassTransmittance' : 'fs',
            targets: [{ format: colorFormat, ...(stage.transparent ? { blend: glassPass === undefined ? PREMULTIPLIED_ALPHA : transmittance ? GLASS_TRANSMITTANCE : GLASS_REFLECTANCE } : {}) }],
          },
        } : {}),
        ...(cutout ? { fragment: { module, entryPoint: 'fsCutout', targets: [] } } : {}),
        primitive: stage.shadowCasters
          ? { topology: 'triangle-list', cullMode: 'none', unclippedDepth: this.#unclippedDepth }
          : { topology: 'triangle-list', cullMode: glassPass !== undefined ? (backFaces ? 'front' : 'back') : doubleSided ? 'none' : 'back', frontFace: 'ccw' },
        depthStencil: { format: depthFormat, depthWriteEnabled: !stage.transparent, depthCompare: 'less-equal' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /** 世界矩阵列的 1..slotLimit 段（槽位 0 是空的，一起传，下标就和槽位一致）。 */
  uploadWorlds(world: Float32Array, slotLimit: number): void {
    const floats = (slotLimit + 1) * 16;
    if (!this.#worlds || this.#worlds.size < floats * 4) {
      this.#worlds?.destroy();
      this.#worlds = this.#createStorage('MeshRenderFeature worlds', capacityFor(floats * 4));
      this.#viewBindGroups.clear();
    }
    // 直接从 wasm 的共享内存上传，不经过 JS 数组
    this.device.queue.writeBuffer(this.#worlds, 0, world, 0, floats);
  }

  /**
   * 蒙皮：变换槽位到蒙皮矩阵起点的表（改了才传），和所有蒙皮矩阵（每帧传，直接从 wasm 内存）。没有蒙皮网格时也建一个
   * 小缓冲：绑定组里的存储缓冲不能缺。
   */
  uploadSkinning(paletteOf: SlotTable, animation: AnimationSystem): void {
    const tableBytes = paletteOf.values.byteLength;
    if (!this.#paletteOf || this.#paletteOf.size < tableBytes) {
      this.#paletteOf?.destroy();
      this.#paletteOf = this.#createStorage('MeshRenderFeature paletteOf', capacityFor(tableBytes));
      this.#viewBindGroups.clear();
      paletteOf.dirty = true;
    }
    if (paletteOf.dirty) {
      this.device.queue.writeBuffer(this.#paletteOf, 0, paletteOf.values);
      paletteOf.dirty = false;
    }
    const paletteBytes = Math.max(animation.paletteCapacity, 1) * 64;
    if (!this.#palettes || this.#palettes.size < paletteBytes) {
      this.#palettes?.destroy();
      this.#palettes = this.#createStorage('MeshRenderFeature palettes', capacityFor(paletteBytes));
      this.#viewBindGroups.clear();
    }
    const palettes = this.#palettes;
    animation.forEachPalette((base, matrices) => this.device.queue.writeBuffer(palettes, base * 64, matrices));
  }

  /** 形变：槽位到权重起点的表（改了才传）和所有模型实例的权重（每帧传）。 */
  uploadMorphs(morphOf: SlotTable, animation: AnimationSystem): void {
    const tableBytes = morphOf.values.byteLength;
    if (!this.#morphOf || this.#morphOf.size < tableBytes) {
      this.#morphOf?.destroy();
      this.#morphOf = this.#createStorage('MeshRenderFeature morphOf', capacityFor(tableBytes));
      this.#viewBindGroups.clear();
      morphOf.dirty = true;
    }
    if (morphOf.dirty) {
      this.device.queue.writeBuffer(this.#morphOf, 0, morphOf.values);
      morphOf.dirty = false;
    }
    const weightBytes = Math.max(animation.morphCapacity, 1) * 4;
    if (!this.#morphWeights || this.#morphWeights.size < weightBytes) {
      this.#morphWeights?.destroy();
      this.#morphWeights = this.#createStorage('MeshRenderFeature morph weights', capacityFor(weightBytes));
      this.#viewBindGroups.clear();
    }
    const weights = this.#morphWeights;
    animation.forEachMorph((base, values) => this.device.queue.writeBuffer(weights, base * 4, values));
  }

  /** 各次剔除的可见槽位（每个视图一段，直接在 wasm 内存里）依次拼成实例缓冲。 */
  uploadInstances(passes: readonly CullPass[], total: number): void {
    const bytes = Math.max(total, 1) * 4;
    if (!this.#instances || this.#instances.size < bytes) {
      this.#instances?.destroy();
      this.#instances = this.#createStorage('MeshRenderFeature instances', capacityFor(bytes));
      this.#viewBindGroups.clear();
    }
    for (const pass of passes) {
      const length = pass.views.length * pass.slotCount;
      if (length > 0) this.device.queue.writeBuffer(this.#instances, pass.offset * 4, pass.culler.visibleSlots, 0, length);
    }
  }

  uploadViews(views: readonly RenderView[], lighting: Lighting, time: number): void {
    const stride = VIEW_STRIDE / 4;
    if (views.length > MAX_VIEWS) throw new RangeError(`MeshRenderFeature supports ${MAX_VIEWS} views, got ${views.length}`);
    const { directionals, directionalCount, ambient, skybox, shadow, locals, localCount } = lighting;
    const data = this.#viewData;
    for (const view of views) {
      const o = view.index * stride;
      data.set(view.viewProjection, o);
      data.set([view.eye.x, view.eye.y, view.eye.z, 1], o + 16);
      data.set([ambient.r, ambient.g, ambient.b, 1], o + 20);
      data.set([skybox?.intensity ?? 0, skybox?.skybox.specularLevels ?? 0, directionalCount, shadow && view.receivesShadows ? lighting.shadowLight : -1], o + 24);
      for (let c = 0; c < 9; c++) {
        const sh = skybox?.skybox.diffuseSH;
        data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], o + 28 + c * 4);
      }
      data.set(skybox ? skybox.rotation : IDENTITY, o + 64);
      if (shadow && view.receivesShadows) {
        const atlasSize = shadow.atlas.width;
        data.set(shadow.worldToShadow, o + 80);
        data.set(shadow.splits, o + 144);
        data.set([shadow.cascadeCount, shadow.depthBias, shadow.normalOffsetScale, shadow.filterSize], o + 148);
        data.set([1 / atlasSize, atlasSize, shadow.blendCascades ? 1 : 0, shadow.depthRangeAutomatic ? 1 : 0], o + 152);
      } else {
        data.fill(0, o + 80, o + 156);
      }
      for (let i = 0; i < directionalCount; i++) {
        const { direction, color } = directionals[i]!;
        const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
        data.set([direction.x / length, direction.y / length, direction.z / length, 0], o + 156 + i * 4);
        data.set([color.r, color.g, color.b, 1], o + 172 + i * 4);
      }
      data.set([localCount, time, 0, 0], o + 188);
    }
    // 点光、聚光：所有视图共用一份
    const lights = this.#localLightData;
    for (let i = 0; i < localCount; i++) {
      const { position: p, color: c, direction: d, spot, invSquareRadius, angleScale, angleOffset } = locals[i]!;
      lights.set([p.x, p.y, p.z, invSquareRadius, c.r, c.g, c.b, spot ? 1 : 0, d.x, d.y, d.z, 0, angleScale, angleOffset, 0, 0], i * LOCAL_LIGHT_FLOATS);
    }
    if (localCount > 0) this.device.queue.writeBuffer(this.#localLights, 0, lights, 0, localCount * LOCAL_LIGHT_FLOATS);
    this.#views ??= this.device.createBuffer({ label: 'MeshRenderFeature views', size: this.#viewData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    if (views.length > 0) this.device.queue.writeBuffer(this.#views, 0, this.#viewData, 0, views.length * stride);

    const skySpecular = skybox ? this.#resources.skyboxSpecular(skybox.skybox) : this.#resources.blackCube;
    if (skySpecular !== this.#skySpecular) {
      this.#skySpecular = skySpecular;
      this.#viewBindGroups.clear();
    }
  }

  /** 视图绑定组；shadowAtlas 是这个阶段采样的阴影图集，没有阴影或者正在画阴影时用空的。 */
  viewBindGroup(shadowAtlas: GPUTexture | undefined): GPUBindGroup {
    const atlas = shadowAtlas ?? this.#resources.emptyShadowAtlas;
    let group = this.#viewBindGroups.get(atlas);
    if (!group) {
      group = this.device.createBindGroup({
        label: 'MeshRenderFeature view',
        layout: this.#viewLayout,
        entries: [
          { binding: 0, resource: { buffer: this.#views!, size: VIEW_FLOATS * 4 } },
          { binding: 1, resource: { buffer: this.#worlds! } },
          { binding: 2, resource: { buffer: this.#instances! } },
          { binding: 3, resource: this.#skySpecular!.createView({ dimension: 'cube' }) },
          { binding: 4, resource: this.#dfgLut.createView() },
          { binding: 5, resource: this.#resources.linearClamp },
          { binding: 6, resource: atlas.createView() },
          { binding: 7, resource: this.#resources.shadowComparison },
          { binding: 8, resource: { buffer: this.#paletteOf! } },
          { binding: 9, resource: { buffer: this.#palettes! } },
          { binding: 10, resource: { buffer: this.#localLights } },
          { binding: 11, resource: { buffer: this.#morphOf! } },
          { binding: 12, resource: { buffer: this.#morphWeights! } },
        ],
      });
      this.#viewBindGroups.set(atlas, group);
    }
    return group;
  }

  mesh(mesh: Mesh, effect: MeshEffect | undefined): GpuMesh {
    let gpu = this.#meshes.get(mesh);
    if (!gpu) {
      const { vertices, indices } = mesh.data;
      const { positionOffset: po, positionScale: ps, uvOffset: uo, uvScale: us } = mesh.dequantize;
      const data = new ArrayBuffer(MESH_PARAMS_BYTES);
      new Float32Array(data).set([...po, 0, ...ps, 0, us[0], us[1], uo[0], uo[1]]);
      new Uint32Array(data)[12] = mesh.layout.normal === 'snorm16x2' ? 1 : 0;
      const params = this.#createFilled(`${mesh.name} params`, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, new Uint8Array(data));
      gpu = {
        params,
        effect: undefined,
        effectVersion: -1,
        bindGroup: this.device.createBindGroup({
          label: `${mesh.name} params`,
          layout: this.#meshLayout,
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: { buffer: mesh.data.morph ? this.#createFilled(`${mesh.name} morph`, GPUBufferUsage.STORAGE, mesh.data.morph) : this.#noMorph } },
          ],
        }),
        vertices: this.#createFilled(`${mesh.name} vertices`, GPUBufferUsage.VERTEX, vertices),
        indices: this.#createFilled(`${mesh.name} indices`, GPUBufferUsage.INDEX, indices),
        indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        indexCount: indices.length,
      };
      this.#meshes.set(mesh, gpu);
    }
    if (effect && (gpu.effect !== effect || gpu.effectVersion !== mesh.effectVersion)) {
      // 网格改过的参数盖在效果的默认值上（NaN 是没改）
      const values = Float32Array.from(effect.defaults, (value, i) => {
        const own = mesh.effectParameters?.[i];
        return own === undefined || Number.isNaN(own) ? value : own;
      });
      this.device.queue.writeBuffer(gpu.params, 64, values);
      gpu.effect = effect;
      gpu.effectVersion = mesh.effectVersion;
    }
    return gpu;
  }

  /** 材质的绑定组；参数改了（version 变了）就重新上传。 */
  material(material: Material): GPUBindGroup {
    let gpu = this.#materials.get(material);
    if (!gpu) {
      const buffer = this.device.createBuffer({ label: `${material.name} material`, size: MATERIAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu = { buffer, bindGroup: undefined, version: -1 };
      this.#materials.set(material, gpu);
    }
    if (gpu.version !== material.version || !gpu.bindGroup) {
      const { baseColorTexture: slot, normalMap, emissiveTexture, ambientOcclusion: occlusion, transparency } = material;
      const { r, g, b, a } = material.baseColor;
      const uv = (texture: Required<MaterialTexture> | undefined) => [...(texture?.scale ?? [1, 1]), ...(texture?.offset ?? [0, 0])];
      const floats = new Float32Array(this.#materialData);
      // emissive.w：镜面项的透明系数（matDiffuseSpecularAlphaBlend.y），不透明是 1
      floats.set([r, g, b, a, ...uv(slot), ...material.emissive, transparency ? transparency.specularAlpha : 1]);
      floats.set([material.metalness ?? 0, material.roughness, material.cavity.diffuse, material.cavity.specular], 12);
      floats.set(uv(normalMap), 16);
      floats.set([...(material.specular ?? [0, 0, 0]), 0], 20);
      floats.set(uv(emissiveTexture), 24);
      floats.set(occlusion.texture ? CHANNELS[occlusion.texture.channel] : [occlusion.value, 0, 0, 0], 28);
      floats.set(uv(occlusion.texture), 32);
      floats.set(transparency ? [...transparency.tint, transparency.alpha] : [1, 1, 1, 1], 36);
      const codes = new Uint32Array(this.#materialData);
      codes[40] = OPERATOR_CODES[material.baseColorOperator];
      codes[41] = (material.specular ? (material.specularEnergyConservative ? 3 : 2) : material.metalness === undefined ? 0 : 1) | (material.specularShading ? 0 : 4) | (material.diffuseShading ? 0 : 8);
      codes[42] = normalMap ? 1 | (normalMap.scaleAndBias ? 2 : 0) | (normalMap.invertY ? 4 : 0) | (normalMap.isXYNormal ? 8 : 0) : 0;
      floats[43] = occlusion.directLighting;
      const gloss = material.glossinessMap;
      floats.set(gloss ? CHANNELS[gloss.channel] : [0, 0, 0, 0], 44);
      floats.set(uv(gloss), 48);
      floats.set([gloss?.invert ? 1 : 0, material.alphaCutoff ?? -1, material.glass?.refractiveIndex ?? 0, 0], 52);
      this.device.queue.writeBuffer(gpu.buffer, 0, this.#materialData);
      const view = (texture: Required<MaterialTexture> | undefined) => (texture ? this.#resources.texture(texture.texture) : this.#resources.white).createView();
      const sampler = (texture: Required<MaterialTexture> | undefined) => this.#resources.sampler(texture?.sampler ?? {});
      gpu.bindGroup = this.device.createBindGroup({
        label: `${material.name} material`,
        layout: this.#materialLayout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: view(slot) },
          { binding: 2, resource: sampler(slot) },
          { binding: 3, resource: view(normalMap) },
          { binding: 4, resource: view(emissiveTexture) },
          { binding: 5, resource: view(occlusion.texture) },
          { binding: 6, resource: sampler(normalMap) },
          { binding: 7, resource: sampler(emissiveTexture) },
          { binding: 8, resource: sampler(occlusion.texture) },
          { binding: 9, resource: view(gloss) },
          { binding: 10, resource: sampler(gloss) },
        ],
      });
      gpu.version = material.version;
    }
    return gpu.bindGroup;
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#views, this.#paletteOf, this.#palettes, this.#localLights, this.#morphOf, this.#morphWeights, this.#noMorph]) buffer?.destroy();
    for (const { params, vertices, indices } of this.#meshes.values()) {
      params.destroy();
      vertices.destroy();
      indices.destroy();
    }
    for (const { buffer } of this.#materials.values()) buffer.destroy();
    this.#dfgLut.destroy();
  }

  #createStorage(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** 建好就填上数据的缓冲；用 mappedAtCreation，所以 16 位索引的字节数不必是 4 的倍数。 */
  #createFilled(label: string, usage: number, data: ArrayBufferView): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
  }
}

/** Stride 的 BlendStates.AlphaBlend：颜色已经乘过 alpha。 */
/** 玻璃透射的那一遍：背景乘上着色器的输出；alpha 不动。 */
const GLASS_TRANSMITTANCE: GPUBlendState = { color: { srcFactor: 'zero', dstFactor: 'src' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
/** 玻璃反射的那一遍：加到背景上（Stride 的 BlendStates.Additive：源乘它的 alpha）；alpha 不动。 */
const GLASS_REFLECTANCE: GPUBlendState = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };

/**
 * 玻璃材质在透明阶段画几遍（别的材质是 0，照常画一遍）：透射、反射两遍；两面画时背面两遍、正面两遍。
 * 和 Stride 不同：Stride 的注释写的是先背面后正面，代码却是先正面（前两遍剔掉背面）；我们照注释的顺序，离相机远的面先画，
 * 它的反射才会被近的面挡掉一部分。
 */
function glassPassCount(stage: RenderStage, material: Material): number {
  return stage.transparent && material.glass ? (material.doubleSided ? 4 : 2) : 0;
}

const PREMULTIPLIED_ALPHA: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** 在 GPU 上积分出 DFG 查找表（一次全屏绘制）。 */
function createDfgLut(device: GPUDevice): GPUTexture {
  const texture = device.createTexture({ label: 'DFG LUT', size: [DFG_LUT_WIDTH, DFG_LUT_HEIGHT], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const module = device.createShaderModule({ label: 'DFG LUT', code: DFG_LUT_SHADER });
  const pipeline = device.createRenderPipeline({
    label: 'DFG LUT',
    layout: 'auto',
    vertex: { module, entryPoint: 'fullscreenVertex' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rg16float' }] },
  });
  const encoder = device.createCommandEncoder({ label: 'DFG LUT' });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return texture;
}

/** 缓冲按 2 的幂增长，避免每多一个实体就重建。 */
function capacityFor(bytes: number): number {
  return Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
}

/**
 * 建着色器模块，编译出错时把出错的行打到控制台（会进调试 CLI 的日志）：游戏写的颜色树、着色器类、网格效果拼进来的 WGSL 出错时，
 * 不然只看到管线无效、画面全黑。
 */
function createCheckedShaderModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  void module.getCompilationInfo().then(({ messages }) => {
    const lines = code.split('\n');
    for (const m of messages) {
      if (m.type !== 'error') continue;
      console.error(`[stride] ${label}: WGSL ${m.lineNum}:${m.linePos}: ${m.message}\n  ${lines[m.lineNum - 1]?.trim() ?? ''}`);
    }
  });
  return module;
}
