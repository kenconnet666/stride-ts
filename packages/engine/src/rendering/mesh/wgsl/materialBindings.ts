/** 网格着色器的材质和网格的绑定：材质的常量（Material）和贴图（第 1 组），网格的反量化参数和形变数据（第 2 组）。 */
import { CEL_RAMP_STOPS } from '../../../content/formats/format';

export const MESH_MATERIAL_BINDINGS = /* wgsl */ `
// 漫反射 = combine(贴图(uv * scale + offset), baseColor)；combine 0 是乘，1 是加（operator 是 WGSL 的保留字）。
// 没有贴图的槽绑一张 1x1 的白图（绑定组的形状不随材质变）：自发光 = 贴图 · emissive，遮蔽 = dot(贴图, occlusionMask)（mask 是
// 通道的单位向量，没有贴图时是 (值, 0, 0, 0)）。没有贴图的槽不采样：flags.w 的各位记着哪些槽有贴图，着色器按它跳过
// （条件只看 uniform，是一致的控制流，里面可以用 textureSample；白图采一次也要花时间，全屏的物体上加起来不少）。
// surface：金属度、粗糙度、漫反射 cavity、镜面 cavity。
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
  // x 为 1 时光泽度贴图存的是粗糙度（Stride 的 Invert）；y 是 Alpha 裁剪的阈值，没有时是 -1；z 是玻璃的折射率，不是玻璃时是 0；
  // w 的各位：1 有漫反射贴图，2 有自发光贴图，4 有遮蔽贴图（法线贴图看 normalFlags，光泽度贴图看 glossinessMask）；第 3..5 位是
  // 光泽度贴图里金属度的通道 + 1（glTF 的金属度粗糙度贴图，0 是没有）
  flags: vec4f,
  // 次表面散射：x 是槽位（RenderSystem.subsurfaceMaterials，0 是没有），y 是强度（透光度），z 是散射宽度
  subsurface: vec4f,
  // 光泽（Material.sheen）：颜色、粗糙度（感知的）；颜色全 0 是没有
  sheen: vec4f,
  // 各向异性（Material.anisotropy）：强度（0 是没有）、方向转角的 cos、sin
  anisotropy: vec4f,
  // 卡通着色（Material.celShading）：x、y 是漫反射、镜面渐变的节点数（0 是不用），z 是 FakeNDotL（0 是不改）
  cel: vec4f,
  // 两条渐变的节点（位置、线性颜色）
  celDiffuse: array<vec4f, ${CEL_RAMP_STOPS}>,
  celSpecular: array<vec4f, ${CEL_RAMP_STOPS}>,
  // 透射（Material.transmission）：比例（0 是没有）、折射率、厚度（0 是薄的面）；吸收系数（每米，-ln(颜色) / 距离）
  transmission: vec4f,
  absorption: vec4f,
  // 植被的风（Material.wind）：x 是弯，y 是叶子抖，都是 10 米每秒的风里的米数，都是 0 是没有；z 是 1 时是草的模式
  wind: vec4f,
  // 室内映射（Material.interior）：房间的宽、高、深（米，宽是 0 是没有），亮灯的比例；x 是亮灯的房间的亮度
  interior: vec4f,
  interiorLight: vec4f,
  // 视差遮挡（Material.normalMap.parallax）：最深处的深度（贴图坐标的单位，0 是没有）、正对时最多几层
  parallax: vec4f,
  // 薄膜干涉（Material.iridescence）：比例（0 是没有）、膜的折射率、膜厚（纳米）
  iridescence: vec4f,
  // 漫透射（Material.diffuseTransmission）：透过去的颜色，比例（0 是没有）
  diffuseTransmission: vec4f,
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
// uvBounds：网格（解量化后）的纹理坐标的最小角和 1 / 范围（表面颜色的烘焙按它把纹理坐标铺满一格）
struct MeshParams { positionOffset: vec4f, positionScale: vec4f, uvTransform: vec4f, flags: u32, effect: MeshEffectParameters, uvBounds: vec4f };
@group(2) @binding(0) var<uniform> mesh: MeshParams;
// 网格的形变数据（布局见 content/formats/format.ts 的 MeshMorph）；没有形变的网格绑一个空的
@group(2) @binding(1) var<storage, read> morphData: array<u32>;
// 管线常量：网格有形变时为 true，没有时形变的代码整段去掉
override MORPHED: bool = false;
`;
