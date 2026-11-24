/** 网格着色器的视图部分：视图的常量（View：相机、天空、阴影、方向光、雾、风……）和第 0 组的绑定（世界矩阵、天空盒、DFG 表、阴影图集、蒙皮、形变、地形高度页、屏幕空间的遮蔽和阴影、反射探针、云影、天空遮挡、贴花、分簇、LTC 表）。 */
import { MAX_DIRECTIONAL_LIGHTS } from '../../RenderSystem';
import { CLUSTER_WGSL } from '../../lighting/Clusters';
import { LOCAL_LIGHT_WGSL, LTC_WGSL } from '../../lighting/LocalLights';
import { BRDF } from '../../wgsl';

/** 植被的风带进着色器的局部风源个数（离相机最近的几个；每个顶点都要看一遍，少一点）。 */
export const VEGETATION_LOCAL_WINDS = 4;

/** DFG 查找表的尺寸（同 Stride 的 EnvironmentLightingDFGLUT16）。 */
export const DFG_LUT_WIDTH = 32;
export const DFG_LUT_HEIGHT = 64;

export const MESH_VIEW = /* wgsl */ `
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
  // x：级联数（0 是没有阴影），y：深度偏移，z：法线偏移比例，w：PCF 核大小（0 是一次比较采样，1 是 PCSS）
  shadow: vec4f,
  // x：图集一个像素的大小（1 / 尺寸），y：图集尺寸，z：级联交界处混合，w：深度范围是自动的
  shadowAtlas: vec4f,
  // 方向光：光线前进的方向（w：投阴影的那个是 PCSS 的光源角半径的正切）、颜色乘强度
  lightDirections: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  lightColors: array<vec4f, ${MAX_DIRECTIONAL_LIGHTS}>,
  // x：点光和聚光的个数（localLightData 里的光），y：游戏开始以来的秒数（Stride 的 Global.Time，材质的颜色树用），
  // z：screenOcclusion 是屏幕空间全局光照的（1）还是 GTAO 的（0），w：反射探针的个数（probes 的前几个）

  locals: vec4f,
  // 世界矩阵、蒙皮、形变的缓冲各分两半，每帧轮着写（另一半留着上一帧的，运动向量用）：这一帧和上一帧各自的起点。
  // [0]：世界矩阵（槽位）这一帧、上一帧，蒙皮表（槽位）这一帧、上一帧；[1]：蒙皮矩阵、形变表；[2].xy：形变权重
  bases: array<vec4u, 3>,
  // 运动向量：这一帧没挪过亚像素的视图投影、上一帧的
  unjitteredViewProjection: mat4x4f,
  previousViewProjection: mat4x4f,
  // 云的影子（cloudShadowMap）：x：地面点的水平位置（米）到贴图坐标的比例，yz：贴图坐标的偏移（风吹着走），
  // w：被云挡着的方向光的下标（没有云时 -1）
  cloudShadow: vec4f,
  // 天气（RenderSystem.surfaceWeather）：x：地面多湿，y：积了多少雪，z：积了多少水（水洼），w：雨多大（涟漪），都是 0 到 1
  weather: vec4f,
  // x：贴花的个数（decals 的前几个），y：折射拷的画面最粗的 mip 级 + 1（0 是这个视图没有，screenspace/Refraction.ts），zw 不用
  decal: vec4f,
  // 分簇（lighting/Clusters.ts 的 clusterParams）：(格数 / 视图宽、格数 / 视图高、层数 / ln(far / near)、分不分簇)，
  // (视图的前方, ln near)
  cluster: vec4f,
  clusterView: vec4f,
  // 平面反射（lighting/PlanarReflections.ts，只有主画面有）：世界到影响盒子（-1..1）的矩阵；(用不用、最粗的 mip 级、1 / 画面宽、
  // 1 / 画面高)；(平面法线, 扭曲)；(强度, 0, 0, 0)
  planarToBox: mat4x4f,
  planar: vec4f,
  planarNormal: vec4f,
  planarIntensity: vec4f,
  // 渲染原点（D18）按 65536 米取模的 xz：world 在渲染空间里，按世界坐标的图案（水洼、积雪的噪声）加上它，原点换了图案不跳
  origin: vec4f,
  // 全局风（RenderSystem.wind）：速度（米每秒，乘过这一刻的阵风）、湍流；植被的风（Material.wind）用
  wind: vec4f,
  // 离相机最近的几个局部风源：中心（渲染空间）、半径；强度（乘过阵风，0 是没有）
  windLocals: array<vec4f, ${VEGETATION_LOCAL_WINDS}>,
  windStrengths: vec4f,
  // 辐照度体（raytracing/IrradianceVolume.ts）：最小角（渲染空间）和用不用（2：路径追踪的间接光代替）、间距和强度、各轴的探针数、卷动
  giMin: vec4f,
  giSpacing: vec4f,
  giCounts: vec4f,
  giScroll: vec4f,
};
// 点光、聚光（Stride 的 LightPoint、LightSpot）和它们的阴影（点光是立方体的六个面 +Z、-Z、+X、-X、+Y、-Y 各一个矩阵，
// 聚光只用第一个），在一个缓冲里，见 lighting/LocalLights.ts
${LOCAL_LIGHT_WGSL}
// 透明阶段的管线（MeshRenderFeature 按阶段给）：第 26 个绑定在透明阶段是折射拷的画面，不透明阶段是平面反射图
override TRANSPARENT_STAGE: bool = false;
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> slots: array<u32>;
@group(0) @binding(3) var skySpecular: texture_cube<f32>;
// DFG 查找表（DFG_LUT_WIDTH x DFG_LUT_HEIGHT，按行存）：缓冲不是贴图——片元阶段的采样贴图默认最多 16 张，材质的颜色树
// 还要加，固定的绑定能省就省；双线性插值自己做（dfgLookup，和 clamp 的线性采样器一样）。32 KB 放得进 uniform 缓冲，也不占
// 片元阶段的存储缓冲（默认最多 8 个）
@group(0) @binding(4) var<uniform> dfgLut: array<vec4f, ${DFG_LUT_WIDTH * DFG_LUT_HEIGHT}>;
@group(0) @binding(5) var linearClamp: sampler;
@group(0) @binding(6) var shadowAtlas: texture_depth_2d;
@group(0) @binding(7) var shadowComparison: sampler_comparison;
// 蒙皮：按变换槽位找这个实体的蒙皮矩阵起点，蒙皮矩阵是所有蒙皮网格的连在一起
@group(0) @binding(8) var<storage, read> paletteOf: array<u32>;
@group(0) @binding(9) var<storage, read> palettes: array<mat4x4f>;
@group(0) @binding(10) var<storage, read> localLightData: array<vec4f>;
// 带形变网格的实体：变换槽位 → 它的模型实例那组形变权重在 morphWeights 里的起点
@group(0) @binding(11) var<storage, read> morphOf: array<u32>;
@group(0) @binding(12) var<storage, read> morphWeights: array<f32>;
// 地形块的高度页（HeightPages.ts）：页头 4 个 float（UV 原点 u、v，每格的 UV 步长，裙边深度）加一圈多的高度；块的起点在 morphOf 里
@group(0) @binding(13) var<storage, read> heights: array<f32>;
// 屏幕空间的环境光遮蔽，半分辨率，只乘环境光；没有时是 1x1 的白图。GTAO（AmbientOcclusion.ts）的在 r 里；view.locals.z 是 1 时是
// 屏幕空间全局光照（ScreenSpaceGlobalIllumination.ts）的：rgb 是间接光（乘漫反射颜色加上），a 是遮蔽
@group(0) @binding(14) var screenOcclusion: texture_2d<f32>;
// 反射探针（ReflectionProbes.ts）：每个探针一个立方体；center.w 是第几个立方体，boxMin.w 过渡距离，boxMax.w 强度，options.x 视差校正
struct Probe { center: vec4f, boxMin: vec4f, boxMax: vec4f, options: vec4f };
@group(0) @binding(16) var probeCubes: texture_cube_array<f32>;
@group(0) @binding(17) var<storage, read> probes: array<Probe>;
@group(0) @binding(15) var screenShadow: texture_2d<f32>;
// 云的影子：云重复的那一个周期里地面上每个点朝主光的透射率（Clouds.shadow），采样器 repeat
@group(0) @binding(18) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(19) var linearRepeat: sampler;
// 天空遮挡（world/SkyOcclusion.ts）：从上往下看的深度图，记着头顶最高的表面；valid.x 是 0 时（没有湿和雪、还没画过）不查，
// valid.y 是深度图的边长
struct SkyOcclusion { viewProjection: mat4x4f, valid: vec4u };
// 深度图拷进的缓冲（valid.y x valid.y 个，按行存）：同 DFG 表，不占采样贴图的名额；只取一个纹素，不插值
@group(0) @binding(20) var<storage, read> skyOcclusionDepth: array<f32>;
@group(0) @binding(21) var<uniform> skyOcclusion: SkyOcclusion;

// 贴花（mesh/Decals.ts 的 packDecal）：世界到盒子（-1..1）的矩阵，颜色、法线在图集里的位置（xy 左上角，zw 大小；z 是 0 是
// 没有），颜色乘数和不透明度，淡出（颜色换掉多少、法线、顶部、底部），盒子的三个轴（世界）
struct Decal { toBox: mat4x4f, albedo: vec4f, normal: vec4f, color: vec4f, fade: vec4f, axisX: vec4f, axisY: vec4f, axisZ: vec4f, pad: vec4f };
@group(0) @binding(22) var<storage, read> decals: array<Decal>;
// 图集：颜色的各页在前（存的是 sRGB 编码过的值），法线的各页接在后面；每个贴花用哪一层在 pad.x（颜色）、pad.y（法线）
@group(0) @binding(23) var decalAtlas: texture_2d_array<f32>;
// 每簇：光的个数、贴花的个数，再是光的下标、贴花的下标（lighting/Clusters.ts）
@group(0) @binding(24) var<storage, read> clusters: array<u32>;
${CLUSTER_WGSL}
// 矩形光的 LTC 查找表（lighting/ltcTable.ts，64 × 64，每格 8 个半精度数）；场景里有矩形光时才填（localLightData[0].y 是 1）
@group(0) @binding(25) var<uniform> ltcTable: array<vec4u, 4096>;
// 材质实例的参数（MaterialParams，MeshGpu 的 SlotParams）按变换槽位：tint（rgba8，a 是 0 时没有）、种子（0 是按槽位）、
// 状态层（湿、脏、旧、雪，各一个字节）、留着的一个
@group(0) @binding(29) var<storage, read> instanceParams: array<vec4u>;
// 平面反射图（镜像着画的场景，左右颠倒，带 mip）；这一帧没有平面反射时是 1x1 的空图
${LTC_WGSL}
`;
