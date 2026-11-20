/**
 * 网格的着色器源码（MeshRenderFeature 用）：固定的那一大段 WGSL（视图和材质的常量、光照、阴影、探针、各个阶段的入口），
 * 加上按材质生成的那一段（materialTreesCode：材质的颜色树、法线树、位移、材质层、清漆）。管线的着色器模块 =
 * MESH_SHADER + 网格效果的代码（meshEffect.ts）+ 材质生成的代码。另有预积分的 DFG 表的着色器。
 *
 * 着色和 Stride 默认的 PBR 材质一致（StrideForwardShadingEffect
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
 * 材质可以换微表面模型的各项（Material.microfacet）、用卡通着色（Material.celShading）。
 * 输出线性的 HDR 颜色，后处理和色调映射在后面（postfx/PostProcessingEffects）。
 */
import { CEL_RAMP_STOPS } from '../../content/format';
import { CLUSTER_WGSL } from '../lighting/Clusters';
import { LOCAL_LIGHT_WGSL } from '../lighting/LocalLights';
import { MAX_DIRECTIONAL_LIGHTS } from '../RenderSystem';
import { MATERIAL_STREAMS } from '../shaderClass';
import { BRDF, GRADIENT_NOISE } from '../wgsl';
import type { MaterialShaderClearCoat, MaterialShaderLayer, MaterialShaderTrees } from './Material';

/** DFG 查找表的尺寸（同 Stride 的 EnvironmentLightingDFGLUT16）。 */
export const DFG_LUT_WIDTH = 32;
export const DFG_LUT_HEIGHT = 64;

export const MESH_SHADER = /* wgsl */ `
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
  // x：贴花的个数（decals 的前几个）
  decal: vec4f,
  // 分簇（lighting/Clusters.ts 的 clusterParams）：(格数 / 视图宽、格数 / 视图高、层数 / ln(far / near)、分不分簇)，
  // (视图的前方, ln near)
  cluster: vec4f,
  clusterView: vec4f,
};
// 点光、聚光（Stride 的 LightPoint、LightSpot）和它们的阴影（点光是立方体的六个面 +Z、-Z、+X、-X、+Y、-Y 各一个矩阵，
// 聚光只用第一个），在一个缓冲里，见 lighting/LocalLights.ts
${LOCAL_LIGHT_WGSL}
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
// 天空遮挡（weather/SkyOcclusion.ts）：从上往下看的深度图，记着头顶最高的表面；valid.x 是 0 时（没有湿和雪、还没画过）不查，
// valid.y 是深度图的边长
struct SkyOcclusion { viewProjection: mat4x4f, valid: vec4u };
// 深度图拷进的缓冲（valid.y x valid.y 个，按行存）：同 DFG 表，不占采样贴图的名额；只取一个纹素，不插值
@group(0) @binding(20) var<storage, read> skyOcclusionDepth: array<f32>;
@group(0) @binding(21) var<uniform> skyOcclusion: SkyOcclusion;

// 贴花（mesh/Decals.ts 的 packDecal）：世界到盒子（-1..1）的矩阵，颜色、法线在图集里的位置（xy 左上角，zw 大小；z 是 0 是
// 没有），颜色乘数和不透明度，淡出（颜色换掉多少、法线、顶部、底部），盒子的三个轴（世界）
struct Decal { toBox: mat4x4f, albedo: vec4f, normal: vec4f, color: vec4f, fade: vec4f, axisX: vec4f, axisY: vec4f, axisZ: vec4f, pad: vec4f };
@group(0) @binding(22) var<storage, read> decals: array<Decal>;
// 图集：第 0 层颜色（存的是 sRGB 编码过的值），第 1 层法线
@group(0) @binding(23) var decalAtlas: texture_2d_array<f32>;
// 每簇：光的个数、贴花的个数，再是光的下标、贴花的下标（lighting/Clusters.ts）
@group(0) @binding(24) var<storage, read> clusters: array<u32>;
${CLUSTER_WGSL}

/** 像素所在的簇的簇头在 clusters 里的下标；视图没分簇时是 -1（看所有的光和贴花）。 */
fn clusterOf(position: vec4f, world: vec3f) -> i32 {
  if (view.cluster.w == 0.0) {
    return -1;
  }
  let depth = max(dot(world - view.eye.xyz, view.clusterView.xyz), 1e-4);
  let slice = u32(clamp((log(depth) - view.clusterView.w) * view.cluster.z, 0.0, f32(CLUSTER_Z - 1u)));
  let tile = min(vec2u(position.xy * view.cluster.xy), vec2u(CLUSTER_X - 1u, CLUSTER_Y - 1u));
  // cluster.w 是这个视图的槽 + 1；槽的簇头在缓冲的前面，一个槽 CLUSTER_HEADER_WORDS 个（第 0 个是计数器，然后每簇
  // CLUSTER_HEADER 个：起点、光数 | 贴花数 << 16、探针数）
  let slot = u32(view.cluster.w) - 1u;
  return i32(slot * CLUSTER_HEADER_WORDS + 1u + ((slice * CLUSTER_Y + tile.y) * CLUSTER_X + tile.x) * CLUSTER_HEADER);
}

/** 这一簇的光、贴花的个数（簇头的第二个数：光数 | 贴花数 << 16）。 */
fn clusterCounts(cluster: i32) -> vec2u {
  let packed = clusters[u32(cluster) + 1u];
  return vec2u(packed & 0xffffu, packed >> 16u);
}

/** 贴花、天气改过的表面和法线。 */
struct Decaled { surface: LayerSurface, normal: vec3f };

fn decodeSrgb(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

/**
 * 贴花（Godot 的做法）：world 落在哪个贴花的盒子里，就按盒子里的 xz 查贴图，颜色按 alpha 混进去，法线按贴花的切线空间
 * （x 轴是 u，-z 轴是贴图的上方，y 轴是法线）换算到世界再混进去；按表面和投影方向的夹角、在盒子里的高度淡出。后面的贴花
 * 盖在前面的上面。导数在循环外算（循环里是非一致的控制流）。
 */
fn applyDecals(world: vec3f, n: vec3f, s: LayerSurface, cluster: i32) -> Decaled {
  var r = Decaled(s, n);
  if (u32(view.decal.x) == 0u) {
    return r;
  }
  // 分了簇时只看这一簇的贴花（下标从小到大，先后不变；在这一簇的光的后面）
  let clustered = cluster >= 0;
  var count = u32(view.decal.x);
  var first = 0u;
  if (clustered) {
    let counts = clusterCounts(cluster);
    count = counts.y;
    first = clusters[u32(cluster)] + counts.x;
  }
  let dx = dpdx(world);
  let dy = dpdy(world);
  for (var k = 0u; k < count; k++) {
    let i = select(k, clusters[first + k], clustered);
    let d = decals[i];
    let p = (d.toBox * vec4f(world, 1.0)).xyz;
    if (any(abs(p) > vec3f(1.0))) {
      continue;
    }
    // 淡出：背着投影方向的面、盒子的顶部和底部
    var fade = d.color.w;
    if (d.fade.y > 0.0) {
      fade *= smoothstep(d.fade.y, min(d.fade.y + 0.3, 1.0), dot(n, d.axisY.xyz));
    }
    if (d.fade.z > 0.0) {
      fade *= saturate((1.0 - p.y) * 0.5 / d.fade.z);
    }
    if (d.fade.w > 0.0) {
      fade *= saturate((p.y + 1.0) * 0.5 / d.fade.w);
    }
    if (fade <= 0.0) {
      continue;
    }
    let uv = p.xz * 0.5 + 0.5;
    let duvx = (d.toBox * vec4f(dx, 0.0)).xz * 0.5;
    let duvy = (d.toBox * vec4f(dy, 0.0)).xz * 0.5;
    var alpha = fade;
    var albedo = d.color.rgb;
    if (d.albedo.z > 0.0) {
      let texel = textureSampleGrad(decalAtlas, linearClamp, d.albedo.xy + uv * d.albedo.zw, 0, duvx * d.albedo.zw, duvy * d.albedo.zw);
      albedo *= decodeSrgb(texel.rgb);
      alpha *= texel.a;
    }
    r.surface.albedo = mix(r.surface.albedo, albedo, alpha * d.fade.x);
    if (d.normal.z > 0.0) {
      let t = textureSampleGrad(decalAtlas, linearClamp, d.normal.xy + uv * d.normal.zw, 1, duvx * d.normal.zw, duvy * d.normal.zw).xyz * 2.0 - 1.0;
      let decalNormal = normalize(d.axisX.xyz * t.x - d.axisZ.xyz * t.y + d.axisY.xyz * max(t.z, 0.0));
      // 贴花的法线是相对一个平面的：按表面的法线转过去（平面上的凸起跟着表面走）
      r.normal = normalize(mix(r.normal, normalize(r.normal + decalNormal - d.axisY.xyz), alpha));
    }
  }
  return r;
}

/** DFG 查找表在 uv 处的值（x、y：GGX 的 scale、bias，z：光泽的）：双线性插值，边缘按 clamp（同原来的线性采样器）。 */
fn dfgLookup(uv: vec2f) -> vec4f {
  let size = vec2f(${DFG_LUT_WIDTH}.0, ${DFG_LUT_HEIGHT}.0);
  let t = clamp(uv * size - 0.5, vec2f(0.0), size - 1.0);
  let i0 = vec2u(floor(t));
  let i1 = min(i0 + 1u, vec2u(size) - 1u);
  let f = t - floor(t);
  let w = ${DFG_LUT_WIDTH}u;
  let a = mix(dfgLut[i0.y * w + i0.x], dfgLut[i0.y * w + i1.x], f.x);
  let b = mix(dfgLut[i1.y * w + i0.x], dfgLut[i1.y * w + i1.x], f.x);
  return mix(a, b, f.y);
}

/** world 淋不淋得到雨雪：1 是淋得到，0 是头顶有东西挡着（比深度图记的最高表面低 20 厘米以上）；图外、没有图时当淋得到。 */
fn skyExposure(world: vec3f) -> f32 {
  if (skyOcclusion.valid.x == 0u) {
    return 1.0;
  }
  let c = skyOcclusion.viewProjection * vec4f(world, 1.0);
  let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    return 1.0;
  }
  let size = skyOcclusion.valid.y;
  let texel = min(vec2u(uv * f32(size)), vec2u(size - 1u));
  let surface = skyOcclusionDepth[texel.y * size + texel.x];
  // 深度是线性的，覆盖 450 米（SkyOcclusion 的 ABOVE + BELOW）
  return select(1.0, 0.0, surface < 1.0 && c.z > surface + 0.2 / 450.0);
}

/** 整数格点的哈希，0..1（水洼、涟漪用）。 */
fn cellHash(p: vec2i) -> f32 {
  var h = bitcast<u32>(p.x) * 374761393u + bitcast<u32>(p.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32((h ^ (h >> 16u)) >> 8u) / 16777216.0;
}

/** 二维值噪声，0..1：格点上的哈希按 smoothstep 插值。 */
fn valueNoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(cellHash(i), cellHash(i + vec2i(1, 0)), u.x);
  let b = mix(cellHash(i + vec2i(0, 1)), cellHash(i + vec2i(1, 1)), u.x);
  return mix(a, b, u.y);
}

/**
 * 雨打水面的涟漪（Lagarde 2013 "Water drop 3" 的程序化版本）：xz 平面上每 RIPPLE_CELL 米一格，每格每个周期随机的位置落一滴
 * （下得小时一部分格子不落），水波一圈圈往外扩、越扩越弱。返回水面高度的梯度（xz），法线 = normalize(-gx, 1, -gz)。
 */
const RIPPLE_CELL = 0.35;
fn rippleGradient(p: vec2f, time: f32, rain: f32) -> vec2f {
  let cell = floor(p / RIPPLE_CELL);
  var g = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = vec2i(cell) + vec2i(x, y);
      // 一个周期 0.8 秒，每格的相位错开；下一个周期换一个位置
      let phase = time / 0.8 + cellHash(c + vec2i(7, 13));
      let cycle = i32(floor(phase));
      let t = phase - floor(phase);
      let seed = c * 3 + vec2i(cycle, cycle * 5);
      if (cellHash(seed + vec2i(3, 1)) > rain) {
        continue;
      }
      let center = (vec2f(c) + vec2f(cellHash(seed), cellHash(seed + vec2i(11, 17)))) * RIPPLE_CELL;
      let offset = p - center;
      let d = length(offset);
      // 波前在 t · 25 厘米处，波长 4 厘米，宽 3 厘米的包络，越往外越弱
      let w = d - t * 0.25;
      let k = 6.2831853 / 0.04;
      let envelope = exp(-w * w / (2.0 * 0.03 * 0.03)) * (1.0 - t) * (1.0 - t);
      let slope = 0.0025 * envelope * (k * cos(w * k) - w / (0.03 * 0.03) * sin(w * k));
      g += offset / max(d, 1e-4) * slope;
    }
  }
  return g;
}

/**
 * 天气改表面（Lagarde 2013 "Water drop 2 - Wet surfaces"、"Water drop 3 - Physically based wet surfaces" 的做法简化）：
 * - 湿：淋得到的非金属吸了水变暗（金属不吸水），表面一层水膜变光滑（朝上的更光滑）；
 * - 水洼：积了水以后，平的、淋得到的地方按世界 xz 的低频噪声积出一片片水（积得越多越大）：上面是一层平的水面——很光滑、
 *   按水的非金属算、底下的颜色更暗，法线朝上；下雨时有涟漪（rippleGradient）；
 * - 雪：淋得到、朝上的面积起来，积得越多越往斜面上长；积得不满时按世界 xz 的噪声一块一块的（满了就盖满）；雪是白的、
 *   粗糙的非金属，盖在水洼上面，把法线贴图的细节盖平（法线往几何法线 geometric 靠）。蒙皮的网格（skinned：角色、动物）一直
 *   在动，身上不积雪（湿照样湿）。
 * 竖着的面按往外 30 厘米的那一点判断淋不淋得到：墙面自己正上方是墙头，按自己的位置查总是被挡着。
 */
fn weatherSurface(world: vec3f, n: vec3f, geometric: vec3f, skinned: bool, s: LayerSurface) -> Decaled {
  let wetness = view.weather.x;
  let snowCover = view.weather.y;
  let puddles = view.weather.z;
  var result = Decaled(s, n);
  if (wetness <= 0.0 && snowCover <= 0.0 && puddles <= 0.0) {
    return result;
  }
  let exposure = skyExposure(world + vec3f(n.x, 0.0, n.z) * 0.3);
  let up = saturate(n.y);
  var r = s;
  // 水洼之间的地面按 wetness 湿：雨停了它先干（5 分钟），水洼还在（15 分钟）
  let wet = wetness * exposure;
  r.albedo *= mix(1.0, 0.45, wet * (1.0 - s.metalness));
  // 水膜让表面光滑一些，但保留材质自己粗糙度的变化（全压到一个很小的值，地面就成了一面映着天的镜子，贴图都看不见了）
  // 金属不吸水，水在上面成珠、不成一层均匀的膜：光滑得少（不然半金属的地面成了映着阴天的镜子）
  r.roughness = mix(s.roughness, max(s.roughness * 0.35, 0.1), wet * mix(0.6, 1.0, up) * (1.0 - 0.75 * s.metalness));
  if (puddles > 0.0 && exposure > 0.0) {
    // 两层噪声（几米和一米左右的斑块）；积水越多阈值越低、水洼越大，边缘 0.06 宽的过渡
    let noise = valueNoise(world.xz * 0.35) * 0.7 + valueNoise(world.xz * 1.1 + 13.7) * 0.3;
    let water = smoothstep(0.94 - puddles * 0.55, 1.0 - puddles * 0.55, noise) * smoothstep(0.9, 0.98, n.y);
    if (water > 0.0) {
      r.albedo *= mix(1.0, 0.6, water);
      r.metalness = mix(r.metalness, 0.0, water);
      r.specular = mix(r.specular, vec3f(0.02), water);
      r.roughness = mix(r.roughness, 0.03, water);
      let g = rippleGradient(world.xz, view.locals.y, view.weather.w) * water;
      result.normal = normalize(mix(n, normalize(vec3f(-g.x, 1.0, -g.y)), water));
    }
  }
  // 积雪 0 时一点不积（以前写成 up · 1.2 - (1 - 积雪)，没雪时朝上的面也算出 0.9 的雪，下雨的地面成了白的），1 时朝上 0.2 以上都积满；
  // 不满时加上两层噪声（一米多和几十厘米的斑块），积得越多噪声越弱
  var snow = 0.0;
  if (snowCover > 0.0 && !skinned) {
    let patches = valueNoise(world.xz * 0.6 + 41.3) * 0.6 + valueNoise(world.xz * 2.3 + 5.1) * 0.4 - 0.5;
    snow = exposure * smoothstep(0.0, 0.25, 1.2 * (up - 1.0 + snowCover) + patches * (1.0 - snowCover));
  }
  r.albedo = mix(r.albedo, vec3f(0.9), snow);
  r.metalness = mix(r.metalness, 0.0, snow);
  r.specular = mix(r.specular, vec3f(0.02), snow);
  r.roughness = mix(r.roughness, 0.75, snow);
  // 雪盖住了表面的细节（法线贴图、水洼的涟漪）
  result.normal = normalize(mix(result.normal, normalize(mix(n, geometric, 0.8)), snow));
  result.surface = r;
  return result;
}

/** 云的影子：从 world 朝光（toLight）看过去被云挡掉多少。先沿光线退到地面（y = 0）上的那个点，影子图是按地面上的点存的。 */
fn cloudShadow(world: vec3f, toLight: vec3f) -> f32 {
  let ground = world.xz - toLight.xz * (world.y / max(toLight.y, 0.05));
  return textureSampleLevel(cloudShadowMap, linearRepeat, ground * view.cloudShadow.x + view.cloudShadow.yz, 0.0).r;
}

/** xyz：屏幕空间的间接光（没有时是 0），w：环境光遮蔽。 */
fn screenAmbient(position: vec4f) -> vec4f {
  let size = textureDimensions(screenOcclusion);
  let texel = textureLoad(screenOcclusion, min(vec2u(position.xy) / 2u, size - 1u), 0);
  return select(vec4f(0.0, 0.0, 0.0, texel.r), texel, view.locals.z != 0.0);
}

/** 投阴影的方向光的接触阴影（ContactShadows，全分辨率；没开时是白图）。 */
fn screenContactShadow(position: vec4f) -> f32 {
  let size = textureDimensions(screenShadow);
  return textureLoad(screenShadow, min(vec2u(position.xy), size - 1u), 0).r;
}

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
/** 第 kind 种缓冲（0 世界矩阵，1 蒙皮表，2 蒙皮矩阵，3 形变表，4 形变权重）这一帧或上一帧的那一半从哪起。 */
fn frameBase(kind: u32, previous: bool) -> u32 {
  let k = kind * 2u + select(0u, 1u, previous);
  return view.bases[k / 4u][k % 4u];
}

fn morphDelta(slot: u32, vertex: u32, previous: bool) -> MorphDelta {
  var delta = MorphDelta(vec3f(0.0), vec3f(0.0));
  if (!MORPHED) { return delta; }
  let base = morphOf[frameBase(3u, previous) + slot] + frameBase(4u, previous);
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
  // 实例的变换槽位（点选的编号缓冲写它）
  @location(7) @interpolate(flat) slot: u32,
  // 1 是蒙皮的网格（角色、动物：一直在动，身上不积雪）
  @location(8) @interpolate(flat) skinned: u32,
};

const IDENTITY = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);

/**
 * skin 把网格空间的顶点变到模型空间（蒙皮矩阵的加权和；不蒙皮时是单位矩阵，编译器会把它消掉）；形变在蒙皮之前加上
 * （同 Stride：先形变后蒙皮）。
 */
fn transformVertex(position: vec3f, normal: vec3f, uv: vec2f, tangent: vec4f, slot: u32, vertex: u32, skin: mat4x4f, skinned: bool) -> Varyings {
  let world = worlds[frameBase(0u, false) + slot];
  let morph = morphDelta(slot, vertex, false);
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
  // 法线用世界矩阵的逆转置变换（Stride 的 WorldInverseTranspose）：缩放不等比时直接乘世界矩阵，斜着的法线会歪。
  // 逆转置乘上行列式就是余子式矩阵（三次叉乘），长度反正要在片元着色器里归一；行列式是负的（镜像）时方向要反回来
  let cofactor = mat3x3f(cross(world[1].xyz, world[2].xyz), cross(world[2].xyz, world[0].xyz), cross(world[0].xyz, world[1].xyz));
  out.normal = cofactor * localNormal * select(-1.0, 1.0, dot(world[0].xyz, cofactor[0]) >= 0.0);
  out.uv = effectUv(meshUv, mesh.effect);
  out.depth = out.position.w;
  out.tangent = vec4f((world * vec4f(localTangent, 0.0)).xyz, tangent.w);
  out.local = local;
  out.slot = slot;
  out.skinned = select(0u, 1u, skinned);
  return out;
}

/**
 * 上一帧这个顶点在世界里的位置（运动向量用）：同 transformVertex 的位置，只是世界矩阵、蒙皮、形变都取上一帧的。
 * 网格效果（随时间变的）按这一帧算。
 */
fn previousWorldPosition(position: vec3f, normal: vec3f, uv: vec2f, slot: u32, vertex: u32, skin: mat4x4f) -> vec4f {
  let world = worlds[frameBase(0u, true) + slot];
  let morph = morphDelta(slot, vertex, true);
  let local = (skin * vec4f(mesh.positionOffset.xyz + position * mesh.positionScale.xyz + morph.position, 1.0)).xyz;
  let localNormal = (skin * vec4f(select(normal, octDecode(normal.xy), (mesh.flags & 1u) != 0u) + morph.normal, 0.0)).xyz;
  let displaced = local + normalize(localNormal) * treeDisplacement(mesh.uvTransform.zw + uv * mesh.uvTransform.xy, local);
  return vec4f(effectWorldPosition((world * vec4f(displaced, 1.0)).xyz, mesh.effect), 1.0);
}

/** 顶点的蒙皮矩阵：4 个关节的蒙皮矩阵按权重相加（Stride 的 TransformationSkinning）；previous 取上一帧的。 */
fn skinMatrix(slot: u32, joints: vec4u, weights: vec4f, previous: bool) -> mat4x4f {
  let base = paletteOf[frameBase(1u, previous) + slot] + frameBase(2u, previous);
  return palettes[base + joints.x] * weights.x + palettes[base + joints.y] * weights.y
    + palettes[base + joints.z] * weights.z + palettes[base + joints.w] * weights.w;
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, vec4f(0.0), slots[instance], vertex, IDENTITY, false);
}

@vertex fn vsTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, tangent, slots[instance], vertex, IDENTITY, false);
}

@vertex fn vsSkinned(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, skinMatrix(slot, joints, weights, false), true);
}

@vertex fn vsSkinnedTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, tangent, slot, vertex, skinMatrix(slot, joints, weights, false), true);
}

// 运动向量（RenderStage.velocity）：位置和别的阶段一样算（@invariant，深度相等的比较才对得上），另外带上这一帧、上一帧
// 没挪过亚像素的裁剪坐标，片元着色器相减
struct VelocityVaryings {
  @invariant @builtin(position) position: vec4f,
  @location(0) current: vec4f,
  @location(1) previous: vec4f,
};

fn velocityVertex(position: vec3f, normal: vec3f, uv: vec2f, slot: u32, vertex: u32, skin: mat4x4f, previousSkin: mat4x4f) -> VelocityVaryings {
  let now = transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, skin, false);
  var out: VelocityVaryings;
  out.position = now.position;
  out.current = view.unjitteredViewProjection * vec4f(now.world, 1.0);
  out.previous = view.previousViewProjection * previousWorldPosition(position, normal, uv, slot, vertex, previousSkin);
  return out;
}

@vertex fn vsVelocity(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> VelocityVaryings {
  return velocityVertex(position, normal, uv, slots[instance], vertex, IDENTITY, IDENTITY);
}

@vertex fn vsVelocitySkinned(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> VelocityVaryings {
  let slot = slots[instance];
  return velocityVertex(position, normal, uv, slot, vertex, skinMatrix(slot, joints, weights, false), skinMatrix(slot, joints, weights, true));
}

/** 这个像素上一帧在画面上的位置减这一帧的（UV 单位，y 朝下）。 */
@fragment fn fsVelocity(in: VelocityVaryings) -> @location(0) vec4f {
  let current = in.current.xy / in.current.w;
  let previous = in.previous.xy / in.previous.w;
  return vec4f((previous - current) * vec2f(0.5, -0.5), 0.0, 1.0);
}

/**
 * 着色用的法线：有法线贴图、网格有切线时按切线空间的法线算（Stride 的 MaterialSurfaceNormalMap 加 UpdateNormalFromTangentSpace），
 * 否则是顶点法线。贴图总是采样（没有时绑白图），用 select 挑结果：采样必须在一致的控制流里。
 */
fn surfaceNormal(in: Varyings, coatPass: bool) -> vec3f {
  let n = normalize(in.normal);
  let flags = material.normalFlags;
  var m = vec3f(0.0, 0.0, 1.0);
  if ((flags & 1u) != 0u) {
    m = textureSample(normalTexture, normalSampler, in.uv * material.normalUvTransform.xy + material.normalUvTransform.zw).xyz;
    m.y = select(m.y, 1.0 - m.y, (flags & 4u) != 0u);
    m = select(m, 2.0 * m - 1.0, (flags & 2u) != 0u);
    m.z = select(m.z, sqrt(max(0.0, 1.0 - (m.x * m.x + m.y * m.y))), (flags & 8u) != 0u);
  }
  // 法线树（材质的颜色树，已经换好）优先于法线贴图
  let tree = treeNormal(in);
  m = select(m, tree.xyz, tree.w > 0.5);
  // 材质层的法线按遮罩混进来（没有法线贴图时底下是 (0, 0, 1)）
  let hasBase = (flags & 1u) != 0u || tree.w > 0.5;
  let layered = layerNormal(in, select(vec3f(0.0, 0.0, 1.0), m, hasBase));
  m = select(m, layered.xyz, layered.w > 0.5);
  // 清漆：底下一遍用金属碎片的法线，清漆那一遍用橘皮的法线
  let coat = coatNormal(in, coatPass);
  m = select(m, coat.xyz, coat.w > 0.5);
  let tangentLength = length(in.tangent.xyz);
  // 没有切线的网格（白盒、程序生成的形状）：按位置和 UV 的屏幕空间导数现算切线框架（Schüler 2013，"Normal Mapping Without
  // Precomputed Tangents"），T、B 是位置沿 U、V 的方向。和 Stride 不同：Stride 的法线贴图要求网格带切线。导数在分支外算
  let dp1 = dpdx(in.world);
  let dp2 = dpdy(in.world);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let ct = dp2perp * duv1.x + dp1perp * duv2.x;
  let cb = dp2perp * duv1.y + dp1perp * duv2.y;
  let frameScale = inverseSqrt(max(max(dot(ct, ct), dot(cb, cb)), 1e-20));
  let hasTangent = tangentLength > 0.0;
  let t = select(ct * frameScale, in.tangent.xyz / max(tangentLength, 1e-8), hasTangent);
  let b = select(cb * frameScale, in.tangent.w * cross(n, t), hasTangent);
  let mapped = normalize(m.x * t + m.y * b + m.z * n);
  return select(n, mapped, hasBase || layered.w > 0.5 || coat.w > 0.5);
}

/**
 * 反射探针的环境镜面反射（ReflectionProbes.ts）：rgb 是各探针按权重加起来的光（已乘强度），a 是探针盖住的比例。探针按盒子从小到大
 * 排，前面的先占：权重是到盒子的面的距离 / 过渡距离（盒子外是 0），乘还没被占的比例。视差校正：反射光线从这里出发打到盒子的
 * 内壁，用拍的位置到那一点的方向取（Lagarde 2012 的 box projection）。粗糙度 i / (级数 - 1) 在第 i 级。
 */
fn probeSpecular(position: vec3f, r: vec3f, roughness: f32, cluster: i32) -> vec4f {
  var sum = vec3f(0.0);
  var weight = 0.0;
  let maxLevel = f32(textureNumLevels(probeCubes) - 1u);
  // 分了簇时只看这一簇的探针（在这一簇的光、贴花后面，下标从小到大：小的盒子先占）
  let clustered = cluster >= 0;
  var count = u32(view.locals.w);
  var first = 0u;
  if (clustered) {
    let counts = clusterCounts(cluster);
    count = clusters[u32(cluster) + 2u];
    first = clusters[u32(cluster)] + counts.x + counts.y;
  }
  for (var k = 0u; k < count; k++) {
    let i = select(k, clusters[first + k], clustered);
    let p = probes[i];
    let inside = min(position - p.boxMin.xyz, p.boxMax.xyz - position);
    let distance = min(min(inside.x, inside.y), inside.z);
    if (distance <= 0.0) {
      continue;
    }
    let w = select(1.0, saturate(distance / p.boxMin.w), p.boxMin.w > 0.0) * (1.0 - weight);
    var direction = r;
    if (p.options.x > 0.5) {
      let far = max((p.boxMax.xyz - position) / r, (p.boxMin.xyz - position) / r);
      direction = position + r * min(min(far.x, far.y), far.z) - p.center.xyz;
    }
    sum += w * p.boxMax.w * textureSampleLevel(probeCubes, linearClamp, direction, i32(p.center.w), roughness * maxLevel).rgb;
    weight += w;
    if (weight >= 0.999) {
      break;
    }
  }
  return vec4f(sum, weight);
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
fn filterShadow(position: vec2f, depth: f32, size: u32) -> f32 {
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

fn shadowFromCascade(position: vec3f, cascade: u32, pixel: vec2f) -> f32 {
  let m = view.shadowMatrices[cascade];
  var p = m * vec4f(position, 1.0);
  p.z -= view.shadow.y;
  let s = p.xyz / p.w;
  let filterKind = u32(view.shadow.w);
  if (filterKind == 1u) {
    return pcssShadow(s, cascadeScale(m), view.lightDirections[u32(view.sky.w)].w, pixel);
  }
  return filterShadow(s.xy, s.z, filterKind);
}

/** 级联的矩阵（正交投影）把一个世界单位换成多少图集 UV（x）、多少深度（y）：前三列里那一行的长度。 */
fn cascadeScale(m: mat4x4f) -> vec2f {
  return vec2f(length(vec3f(m[0].x, m[1].x, m[2].x)), length(vec3f(m[0].z, m[1].z, m[2].z)));
}

/** Vogel 圆盘上 count 个点的第 i 个（单位圆里均匀铺开），整体转 angle。 */
fn vogelDisk(i: u32, count: u32, angle: f32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(count));
  let theta = f32(i) * 2.39996323 + angle;
  return r * vec2f(cos(theta), sin(theta));
}

${GRADIENT_NOISE}

const PCSS_BLOCKER_TAPS = 16u;
const PCSS_FILTER_TAPS = 16u;
/** 半影最大多少个图集像素（搜遮挡物的范围也到这里为止）。 */
const PCSS_MAX_TEXELS = 24.0;

/**
 * 接触硬化的软阴影（PCSS，Fernando 2005）：方向光有角大小，半影的半径 = 遮挡物到这里的距离 × tan(角半径)，所以影子在
 * 接触处硬、离得越远越软。s 是这个像素在图集里的位置和深度，scale 是 cascadeScale，tangent 是角半径的正切。
 * 1. 按遮挡物最远可能在的地方（级联的近平面）定搜的范围，找比这里离光近的深度，取平均；没有遮挡物就是亮的；
 * 2. 按平均的距离算半影，在这么大的圆盘里做比较采样（至少 1.5 个像素，接触处也不出锯齿）。
 * 和 Babylon 不同：方向光的半影直接按深度差和角大小算（不除深度、没有经验系数）。采样点按像素的噪声转，噪声留给 TAA 和画面的模糊。
 */
fn pcssShadow(s: vec3f, scale: vec2f, tangent: f32, pixel: vec2f) -> f32 {
  let texel = view.shadowAtlas.x;
  let angle = gradientNoise(pixel) * 6.28318531;
  let toUv = tangent * scale.x / scale.y;
  let searchRadius = clamp(s.z * toUv, texel, PCSS_MAX_TEXELS * texel);
  var blockers = 0.0;
  var blockerDepth = 0.0;
  let last = vec2i(i32(view.shadowAtlas.y) - 1);
  for (var i = 0u; i < PCSS_BLOCKER_TAPS; i++) {
    let uv = s.xy + vogelDisk(i, PCSS_BLOCKER_TAPS, angle) * searchRadius;
    let d = textureLoad(shadowAtlas, clamp(vec2i(uv * view.shadowAtlas.y), vec2i(0), last), 0);
    if (d < s.z) {
      blockers += 1.0;
      blockerDepth += d;
    }
  }
  if (blockers == 0.0) {
    return 1.0;
  }
  let penumbra = clamp((s.z - blockerDepth / blockers) * toUv, 1.5 * texel, PCSS_MAX_TEXELS * texel);
  var lit = 0.0;
  for (var i = 0u; i < PCSS_FILTER_TAPS; i++) {
    lit += textureSampleCompareLevel(shadowAtlas, shadowComparison, s.xy + vogelDisk(i, PCSS_FILTER_TAPS, angle) * penumbra, s.z);
  }
  return lit / f32(PCSS_FILTER_TAPS);
}

/**
 * 点光、聚光的阴影（Stride 的 ShadowMapReceiverPointCubeMap、ShadowMapReceiverSpot 的 ComputeShadow）。index 是阴影的下标
 * （光的 direction.w），lightPosition 是光源的位置。
 */
fn computeLocalShadow(index: u32, position: vec3f, normal: vec3f, nDotL: f32, lightPosition: vec3f) -> f32 {
  let start = localShadowStart(index);
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去（点光选面、算深度用没偏移过的位置）
  let p = position + 2.0 * SHADOW_OFFSET_TEXEL * localShadowParams(start).y * saturate(1.0 - nDotL) * normal;
  let coord = localShadowCoord(start, p, position, lightPosition);
  if (coord.w == 0.0) {
    return 1.0;
  }
  return filterShadow(coord.xy, coord.z, u32(localShadowOptions(start).x));
}

const CASCADE_INDICES = vec4u(0u, 1u, 2u, 3u);

/**
 * v 的第 i 个分量。不写 v[i]：动态下标取 uniform 里 vec4 的分量时，DXC 先把整行存进局部数组再按下标读
 * （DXIL 里的 alloca），像素着色器里很慢。
 */
fn component(v: vec4f, i: u32) -> f32 {
  return dot(v, select(vec4f(0.0), vec4f(1.0), CASCADE_INDICES == vec4u(i)));
}

/** 深度 depth 处用哪个级联：前 count - 1 个分界里深度超过了几个（分界递增，同 Stride 逐个比较取最后一个超过的）。 */
fn shadowCascade(depth: f32, count: u32) -> u32 {
  let passed = select(vec4f(0.0), vec4f(1.0), (vec4f(depth) > view.shadowSplits) & (CASCADE_INDICES + 1u < vec4u(count)));
  return u32(dot(passed, vec4f(1.0)));
}


// 阴影的法线偏移、厚度那几处按世界单位挪的量，用的"图集一个像素"是 Stride 固定的 4096² 图集的（它的
// ShadowMapTextureTexelSize 是整个图集的）：我们的图集按用到的大小建（1024² 到 4096²），按实际的算的话图集小了偏移就大了，
// 物体自己身上的影子变淡（CSharpBeginner 的茶壶）。采样时挪的步子还是按实际的图集算。
const SHADOW_OFFSET_TEXEL = 1.0 / 4096.0;

/** 方向光的阴影（Stride 的 ShadowMapReceiverDirectional.ComputeShadow）。 */
fn computeShadow(position: vec3f, normal: vec3f, nDotL: f32, depth: f32, pixel: vec2f) -> f32 {
  let count = u32(view.shadow.x);
  if (count == 0u) {
    return 1.0;
  }
  let splits = view.shadowSplits;
  let cascade = shadowCascade(depth, count);
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去
  let p = position + 2.0 * SHADOW_OFFSET_TEXEL * view.shadow.z * saturate(1.0 - nDotL) * normal;
  var shadow = shadowFromCascade(p, cascade, pixel);
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
      shadow = mix(shadowFromCascade(p, cascade + 1u, pixel), shadow, amount);
    }
  }
  return shadow;
}

/** 图集里 uv 处存的深度，四个像素双线性（深度图不能用普通的采样器过滤）。 */
fn shadowDepthAt(uv: vec2f) -> f32 {
  let texel = uv * view.shadowAtlas.y - 0.5;
  let base = vec2i(floor(texel));
  let w = fract(texel);
  let last = vec2i(i32(view.shadowAtlas.y) - 1);
  let d00 = textureLoad(shadowAtlas, clamp(base, vec2i(0), last), 0);
  let d10 = textureLoad(shadowAtlas, clamp(base + vec2i(1, 0), vec2i(0), last), 0);
  let d01 = textureLoad(shadowAtlas, clamp(base + vec2i(0, 1), vec2i(0), last), 0);
  let d11 = textureLoad(shadowAtlas, clamp(base + vec2i(1, 1), vec2i(0), last), 0);
  return mix(mix(d00, d10, w.x), mix(d01, d11, w.x), w.y);
}

/**
 * 方向光穿过这个像素所在物体的厚度（世界单位；Stride 的 ShadowMapFilterBase.SampleThickness）：阴影图里离光最近的表面到这里的
 * 距离。先往表面里缩 1.5 个阴影图像素的对角线，避开表面自己（同 Stride 的 CalculateAdjustedShadowSpacePixelPosition）。
 */
fn shadowThickness(position: vec3f, normal: vec3f, depth: f32) -> f32 {
  let m = view.shadowMatrices[shadowCascade(depth, u32(view.shadow.x))];
  let scale = cascadeScale(m);
  let uvPerUnit = scale.x;
  let depthPerUnit = scale.y;
  // 1.5 · √2 个像素
  let p = position - normal * (2.1213 * SHADOW_OFFSET_TEXEL / uvPerUnit);
  let s = m * vec4f(p, 1.0);
  let q = s.xyz / s.w;
  return max(q.z - shadowDepthAt(q.xy), 0.0) / depthPerUnit;
}

/** 皮肤的透射轮廓（Stride 的 MaterialSubsurfaceScatteringScatteringProfileSkin，取自 Jimenez 的 separable-sss）；dd 是 -d²。 */
fn skinTransmittanceProfile(dd: f32) -> vec3f {
  return vec3f(0.233, 0.455, 0.649) * exp(dd / 0.0064) + vec3f(0.1, 0.336, 0.344) * exp(dd / 0.0484)
    + vec3f(0.118, 0.198, 0.0) * exp(dd / 0.187) + vec3f(0.113, 0.007, 0.007) * exp(dd / 0.567)
    + vec3f(0.358, 0.004, 0.0) * exp(dd / 1.99) + vec3f(0.078, 0.0, 0.0) * exp(dd / 7.41);
}

/**
 * 次表面散射材质的透射（Stride 的 MaterialSurfaceSubsurfaceScatteringShading.CalculateTransmittance）：光从背面穿过薄的地方
 * （耳朵、鼻翼、手指）透出来。thickness 是 shadowThickness 算的厚度，lightColor 不乘阴影（挡住光的正是物体自己）。
 * 加进直射光的漫反射，和它一起被乘 π、被屏幕空间的散射模糊。
 */
fn transmittance(thickness: f32, n: vec3f, l: vec3f, lightColor: vec3f, albedo: vec3f) -> vec3f {
  let scale = 8.25 * (1.0 - material.subsurface.y) / max(material.subsurface.z, 0.0001);
  let d = scale * thickness;
  return skinTransmittanceProfile(-d * d) * saturate(0.3 + dot(l, -n)) * lightColor * albedo;
}

/**
 * 一个像素上着色要用的表面属性。光泽：颜色（全 0 是没有）、alpha、底下那层剩下的比例（直射光、环境光都乘）；各向异性：强度
 * （0 是没有）、切线和副切线（世界，已经按材质转过）。
 */
struct Surface {
  n: vec3f, v: vec3f, diffuse: vec3f, specular: vec3f, hasSpecular: bool, glass: bool, alphaR: f32, nDotV: f32,
  sheenColor: vec3f, sheenAlpha: f32, sheenScaling: f32, anisotropy: f32, t: vec3f, b: vec3f, microfacet: u32,
};

/**
 * 微表面模型的分布项（Stride 的 MaterialSpecularMicrofacetNormalDistribution*，公式同 BRDFMicrofacet.sdsl）：
 * kind 0 GGX、1 Beckmann、2 Blinn-Phong。
 */
fn microfacetDistribution(kind: u32, alphaR: f32, nDotH: f32) -> f32 {
  if (kind == 0u) {
    return normalDistributionGGX(alphaR, nDotH);
  }
  // Beckmann、Blinn-Phong 的 alpha² 有下限，免得指数太大
  let alphaR2 = max(alphaR * alphaR, 0.1);
  if (kind == 1u) {
    let nDotH2 = max(nDotH * nDotH, 0.0001);
    return exp((nDotH2 - 1.0) / (alphaR2 * nDotH2)) / (PI * alphaR2 * nDotH2 * nDotH2);
  }
  return pow(max(nDotH, 0.00001), 2.0 / alphaR2 - 2.0) / (PI * alphaR2);
}

/** Smith-Beckmann 的单向项（Walter 2007 的有理近似）。和 Stride 不同：Stride 的分母写成了 2577·c²（应为 2.577·c²）。 */
fn visibilityBeckmann(alphaR: f32, nDotX: f32) -> f32 {
  let c = nDotX / (alphaR * sqrt(max(1.0 - nDotX * nDotX, 1e-8)));
  return select(1.0, (3.535 * c + 2.181 * c * c) / (1.0 + 2.276 * c + 2.577 * c * c), c < 1.6);
}

fn visibilityGGXCorrelated(alphaR: f32, nDotX: f32) -> f32 {
  let nDotX2 = nDotX * nDotX;
  return sqrt(1.0 + alphaR * alphaR * (1.0 - nDotX2) / nDotX2);
}

fn visibilitySchlickBeckmann(alphaR: f32, nDotX: f32) -> f32 {
  let k = alphaR * sqrt(2.0 / PI);
  return nDotX / (nDotX * (1.0 - k) + k);
}

/**
 * 微表面模型的可见性项 V = G / (N·L · N·V)（Stride 的 MaterialSpecularMicrofacetVisibility*）：kind 0 Smith-Schlick-GGX、
 * 1 隐式、2 Neumann、3 Cook-Torrance、4 Kelemen、5 Smith-Beckmann、6 相关的 Smith-GGX、7 Smith-Schlick-Beckmann。
 * V·H 有下限（和 Stride 不同：Stride 在 V·H 是 0 时除出无穷大）。
 */
fn microfacetVisibility(kind: u32, alphaR: f32, nDotL: f32, nDotV: f32, nDotH: f32, vDotH: f32) -> f32 {
  let vh = max(vDotH, 0.0001);
  switch (kind) {
    case 1u: { return 1.0; }
    case 2u: { return 1.0 / max(nDotL, nDotV); }
    case 3u: { return min(1.0, min(2.0 * nDotH * nDotV / vh, 2.0 * nDotH * nDotL / vh)) / (nDotL * nDotV); }
    case 4u: { return 1.0 / (vh * vh); }
    case 5u: { return visibilityBeckmann(alphaR, nDotL) * visibilityBeckmann(alphaR, nDotV) / (nDotL * nDotV); }
    case 6u: { return 2.0 / (visibilityGGXCorrelated(alphaR, nDotL) + visibilityGGXCorrelated(alphaR, nDotV)) / (nDotL * nDotV); }
    case 7u: { return visibilitySchlickBeckmann(alphaR, nDotL) * visibilitySchlickBeckmann(alphaR, nDotV) / (nDotL * nDotV); }
    default: { return visibilitySmithSchlickGGX(alphaR, nDotL, nDotV); }
  }
}

/** 环境光镜面系数的多项式近似（Stride 的 MaterialSpecularMicrofacetEnvironmentGGXPolynomial，Lazarov 2013 的拟合）。 */
fn environmentDfgPolynomial(specularColor: vec3f, alphaR: f32, nDotV: f32) -> vec3f {
  let x = 1.0 - alphaR;
  let y = nDotV;
  var bias = saturate(min(-0.1688 * x + 1.895 * x * x, 0.9903 - 4.853 * y + 8.404 * y * y - 5.069 * y * y * y));
  let delta = saturate(0.6045 + 1.699 * x - 0.5228 * y - 3.603 * x * x + 1.404 * x * y + 0.1939 * y * y + 2.661 * x * x * x);
  let scale = delta - bias;
  bias *= saturate(50.0 * specularColor.y);
  return specularColor * scale + bias;
}

/** 光泽的分布（Estevez、Kulla 2017 的 Charlie，Filament 的 D_Charlie）：alpha 是光泽粗糙度的平方。 */
fn distributionCharlie(alpha: f32, nDotH: f32) -> f32 {
  let invAlpha = 1.0 / alpha;
  let sin2h = max(1.0 - nDotH * nDotH, 0.0078125);
  return (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * PI);
}

/** 光泽的可见性（Neubelt、Pettineo 2013，Filament 的 V_Neubelt）：已经除以 4 · N·L · N·V。 */
fn visibilityNeubelt(nDotV: f32, nDotL: f32) -> f32 {
  return saturate(1.0 / (4.0 * (nDotL + nDotV - nDotL * nDotV)));
}

/** 各向异性的 GGX 分布（Filament 的 D_GGX_Anisotropic）：at、ab 是切线、副切线方向的 alpha。 */
fn distributionGGXAnisotropic(at: f32, ab: f32, tDotH: f32, bDotH: f32, nDotH: f32) -> f32 {
  let a2 = at * ab;
  let d = vec3f(ab * tDotH, at * bDotH, a2 * nDotH);
  let b2 = a2 / dot(d, d);
  return a2 * b2 * b2 / PI;
}

/** 各向异性的相关 Smith 可见性（Heitz 2014，Filament 的 V_SmithGGXCorrelated_Anisotropic）：已经除以 4 · N·L · N·V。 */
fn visibilityGGXAnisotropic(at: f32, ab: f32, tDotV: f32, bDotV: f32, tDotL: f32, bDotL: f32, nDotV: f32, nDotL: f32) -> f32 {
  let lambdaV = nDotL * length(vec3f(at * tDotV, ab * bDotV, nDotV));
  let lambdaL = nDotV * length(vec3f(at * tDotL, ab * bDotL, nDotL));
  return saturate(0.5 / (lambdaV + lambdaL));
}

/**
 * 没有顶点切线的网格的切线（Schüler 2006 的余切框架）：按世界坐标和贴图坐标在屏幕上的导数算 u 增大的方向。导数要在一致的
 * 控制流里取（调用的地方只按材质的常量分支）。
 */
fn derivativeTangent(world: vec3f, uv: vec2f, n: vec3f) -> vec3f {
  let dp1 = dpdx(world);
  let dp2 = dpdy(world);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  return cross(dp2, n) * duv1.x + cross(n, dp1) * duv2.x;
}

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
  var texel = vec4f(1.0);
  if ((u32(material.flags.w) & 1u) != 0u) {
    texel = textureSample(baseColorTexture, baseColorSampler, in.uv * material.uvTransform.xy + material.uvTransform.zw);
  }
  return select(texel * material.baseColor, texel + material.baseColor, material.combine == 1u);
}

/** 一个光源照出来的漫反射和镜面反射（分开是因为次表面散射只模糊漫反射）。 */
struct Lit { diffuse: vec3f, specular: vec3f };

/**
 * 卡通着色的渐变（Stride 的 IMaterialCelShadingLightFunction.Compute）：在材质的节点间按 x 线性插值，同一位置的两个节点是台阶，
 * 两头外面取端点的颜色。diffuse 选漫反射还是镜面的那条。
 */
fn celRamp(diffuse: bool, x: f32) -> vec3f {
  let count = u32(select(material.cel.y, material.cel.x, diffuse));
  var previous = select(material.celSpecular[0], material.celDiffuse[0], diffuse);
  if (x <= previous.x) {
    return previous.yzw;
  }
  for (var i = 1u; i < count; i++) {
    let next = select(material.celSpecular[i], material.celDiffuse[i], diffuse);
    if (x < next.x) {
      return mix(previous.yzw, next.yzw, (x - previous.x) / (next.x - previous.x));
    }
    previous = next;
  }
  return previous.yzw;
}

/** 颜色按亮度过渐变、色相不变（Stride 的 IMaterialCelShadingLightFunction.ComputeColor，亮度是 LuminanceUtils.Luma）。 */
fn celColor(diffuse: bool, color: vec3f) -> vec3f {
  let luma = max(dot(color, vec3f(0.299, 0.587, 0.114)), 0.0001);
  return celRamp(diffuse, luma) * color / luma;
}

/** 环境光的漫反射：卡通着色的材质按亮度过渐变（MaterialSurfaceShadingDiffuseCelShading.ComputeEnvironmentLightContribution）。 */
fn celEnvironment(color: vec3f) -> vec3f {
  return select(color, celColor(true, color), material.cel.x > 0.0);
}

/**
 * 一个光源的直射光：Lambert 漫反射加微表面镜面（默认菲涅耳 Schlick、GGX、Smith-Schlick-GGX，材质可以换，见 Surface.microfacet；
 * Stride 的 MaterialSurfaceShadingDiffuseLambert、SpecularMicrofacet），卡通着色的材质两项各过渐变。l 是指向光源的单位向量；
 * attenuation 是距离、角度衰减，visibility 是阴影乘遮蔽（卡通着色只让衰减进渐变）。
 */
fn shadeLight(s: Surface, l: vec3f, lightColor: vec3f, attenuation: f32, visibility: f32) -> Lit {
  let nDotL = max(dot(s.n, l), 0.0001);
  let lightColorNdotL = lightColor * (attenuation * visibility * nDotL);
  var diffuseLight = lightColorNdotL;
  if (material.cel.x > 0.0) {
    // MaterialSurfaceShadingDiffuseCelShading：N·L 乘衰减（FakeNDotL 大于 0 时再乘它）过渐变，替代 N·L 和衰减
    let fake = material.cel.z;
    diffuseLight = celRamp(true, nDotL * attenuation * select(1.0, fake, fake > 0.0)) * lightColor * visibility;
  }
  var result = Lit(s.diffuse / PI * diffuseLight, vec3f(0.0));
  let hasSheen = any(s.sheenColor > vec3f(0.0));
  if (!s.hasSpecular && !hasSheen) {
    return result;
  }
  let h = normalize(s.v + l);
  let nDotH = saturate(dot(s.n, h));
  if (s.hasSpecular) {
    let lDotH = saturate(dot(l, h));
    // 玻璃的菲涅耳项就是它的反射比例（MaterialSpecularMicrofacetFresnelThinGlass），放在 s.specular 里；菲涅耳为 none 时就是 f0
    let fresnel = select(s.specular + (1.0 - s.specular) * pow(1.0 - lDotH, 5.0), s.specular, s.glass || (s.microfacet & 1u) != 0u);
    if (s.anisotropy != 0.0) {
      // 各向异性（Filament）：切线、副切线方向的粗糙度不同，可见性用相关的 Smith（已经含 1 / (4 · N·L · N·V)）
      let at = max(s.alphaR * (1.0 + s.anisotropy), 0.001);
      let ab = max(s.alphaR * (1.0 - s.anisotropy), 0.001);
      let d = distributionGGXAnisotropic(at, ab, dot(s.t, h), dot(s.b, h), nDotH);
      let visibility = visibilityGGXAnisotropic(at, ab, dot(s.t, s.v), dot(s.b, s.v), dot(s.t, l), dot(s.b, l), s.nDotV, nDotL);
      result.specular = fresnel * d * visibility * lightColorNdotL;
    } else {
      let d = microfacetDistribution((s.microfacet >> 1u) & 3u, s.alphaR, nDotH);
      let geometric = microfacetVisibility((s.microfacet >> 3u) & 7u, s.alphaR, nDotL, s.nDotV, nDotH, dot(s.v, h));
      let reflected = fresnel * geometric * d / 4.0;
      // 卡通着色（MaterialSurfaceShadingSpecularCelShading）：反射的那部分按亮度过渐变
      result.specular = select(reflected, celColor(false, reflected), material.cel.y > 0.0) * lightColorNdotL;
    }
  }
  if (hasSheen) {
    // 光泽在底下那层的上面：底下的镜面按光泽反射走的能量变暗（漫反射在 s.diffuse 里已经乘过）
    result.specular = result.specular * s.sheenScaling + s.sheenColor * distributionCharlie(s.sheenAlpha, nDotH) * visibilityNeubelt(s.nDotV, nDotL) * lightColorNdotL;
  }
  return result;
}

/** 点选的编号缓冲：写实例的变换槽位加一（0 留给"什么都没有"）；Alpha 裁剪掉的像素点不到。 */
@fragment fn fsPick(in: Varyings) -> @location(0) u32 {
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
  return in.slot + 1u;
}

struct WireOutput {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

/**
 * 线框：一个固定的浅色。线和它所在的三角形深度几乎一样，直接比会一段有一段没有，所以把深度往相机这边挪一点再比
 * （WebGPU 不许给线的管线设深度偏移，在这里改写出去的深度；线框的管线不写深度缓冲）。
 */
@fragment fn fsWire(in: Varyings) -> WireOutput {
  return WireOutput(vec4f(0.75, 0.9, 1.0, 1.0), in.position.z * 0.9995);
}

/**
 * 只写深度的阶段里丢掉被裁的像素：Alpha 裁剪按材质的阈值；关了抖动阴影的透明混合同 Stride 丢掉 alpha 小于 0.1 的
 * （matAlphaDiscard 的默认值；没有裁剪时 flags.y 是 -1）。
 */
@fragment fn fsCutout(in: Varyings) {
  let threshold = select(0.1, material.flags.y, material.flags.y >= 0.0);
  if (baseColor(in).a * material.blend.a < threshold) {
    discard;
  }
}

/** 4x4 的 Bayer 矩阵，同 Stride 的 ShadowMapCasterAlphaDithered。 */
const BAYER_4X4 = array<f32, 16>(
  0.0, 0.53333336, 0.13333334, 0.6666667,
  0.8, 0.26666668, 0.9333333, 0.4,
  0.2, 0.73333335, 0.06666667, 0.6,
  1.0, 0.4666667, 0.8666667, 0.33333334);

/**
 * 透明混合的材质投阴影：按 alpha 在阴影图上抖动着丢像素（同 Stride 的 ShadowMapCasterAlphaDithered），PCF 一滤就是半透明的影子。
 * alpha 同颜色那一遍（漫反射的 alpha 乘透明的系数）。
 */
@fragment fn fsDitheredShadow(in: Varyings) {
  let alpha = saturate(baseColor(in).a * material.blend.a);
  let cell = vec2u(in.position.xy) % 4u;
  if (-1.01 + BAYER_4X4[cell.x + cell.y * 4u] + alpha * 1.01 < 0.0) {
    discard;
  }
}

/** 玻璃透射的那一遍（Stride 的 MaterialSurfaceTransmittanceShading）：输出的颜色乘到背景上（混合是 目标 × 源）。 */
@fragment fn fsGlassTransmittance(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = facingNormal(surfaceNormal(in, false), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  let glass = thinGlass(base.rgb, max(dot(n, v), 0.0001), material.flags.z);
  return vec4f(mix(vec3f(1.0), glass.transmittance, saturate(base.a * material.blend.a)), 1.0);
}

@fragment fn fs(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return shade(in, front, false).color;
}

/** 清漆叠在上面的那一遍（透明阶段，加到画面上）。 */
@fragment fn fsClearCoat(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return shade(in, front, true).color;
}

struct SurfaceOutput {
  @location(0) color: vec4f,
  @location(1) normalRoughness: vec4f,
  @location(2) specularWeight: vec4f,
  @location(3) environment: vec4f,
};

/** 不透明阶段给屏幕空间反射留下表面（RenderOutput.surfaceFormats、SURFACE_FORMATS）。 */
@fragment fn fsSurface(in: Varyings, @builtin(front_facing) front: bool) -> SurfaceOutput {
  let s = shade(in, front, false);
  // 第 3 张表面的 a：次表面散射的槽位 + 强度（强度的小数部分到 0.99 为止，整数部分不会进位）。散射材质的 rgb 换成颜色里
  // 不散射的部分（镜面反射、自发光），模糊时只糊剩下的漫反射光；这些像素不做屏幕空间反射
  let scatters = material.subsurface.x > 0.0;
  let scattering = select(0.0, material.subsurface.x + clamp(material.subsurface.y, 0.0, 0.99), scatters);
  let kept = select(s.environment, s.color.rgb - s.scattered, scatters);
  return SurfaceOutput(s.color, vec4f(octahedralEncode(s.normal), s.roughness, 1.0), vec4f(s.specularWeight, 1.0), vec4f(kept, scattering));
}

/** 单位向量的八面体编码（-1..1 的两个数）：法线放进两个通道，比存 xyz 少一个通道、精度均匀。 */
fn octahedralEncode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  return select(p, (1.0 - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), n.z < 0.0);
}

/** 一个像素着色的结果：颜色，和屏幕空间反射要的表面（SURFACE_FORMATS）。 */
struct Shaded {
  color: vec4f,
  normal: vec3f,
  roughness: f32,
  /** 环境镜面反射的权重（镜面颜色乘 DFG）。 */
  specularWeight: vec3f,
  /** 加进颜色里的环境镜面反射。 */
  environment: vec3f,
  /** 加进颜色里的漫反射光（直射、环境、天空、屏幕空间的间接光）。 */
  scattered: vec3f,
};

/** 一个像素的光照；coatPass 为真时是清漆的那一遍。 */
fn shade(in: Varyings, front: bool, coatPass: bool) -> Shaded {
  var n = facingNormal(surfaceNormal(in, coatPass), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
  // 粗糙度：常量，或者光泽度贴图的一个通道（没有贴图时 mask 是 0，取常量）
  let hasGlossTexture = dot(material.glossinessMask, vec4f(1.0)) > 0.0;
  var glossTexel = 0.0;
  var metalnessScale = 1.0;
  if (hasGlossTexture) {
    let texel = textureSample(glossinessTexture, glossinessSampler, in.uv * material.glossinessUvTransform.xy + material.glossinessUvTransform.zw);
    glossTexel = dot(texel, material.glossinessMask);
    // 同一张贴图里的金属度（不用动态下标取向量的分量：DXC 会先存进局部数组）
    let metalnessChannel = (u32(material.flags.w) >> 3u) & 7u;
    if (metalnessChannel > 0u) {
      metalnessScale = dot(texel, select(vec4f(0.0), vec4f(1.0), vec4u(1u, 2u, 3u, 4u) == vec4u(metalnessChannel)));
    }
  }
  // 材质层按遮罩混进各个属性（没有层时原样）
  let layers = materialLayers(in, LayerSurface(base.rgb, material.surface.x * metalnessScale, material.specularColor.rgb,
    select(material.surface.y, select(1.0 - glossTexel, glossTexel, material.flags.x > 0.5), hasGlossTexture)));
  // 清漆把漫反射色、金属度、粗糙度换成这一遍的（没有清漆时原样）
  // 贴花盖在材质上，天气（湿、雪）再盖在贴花上
  let cluster = clusterOf(in.position, in.world);
  let decaled = applyDecals(in.world, n, coatSurface(in, layers, coatPass), cluster);
  n = decaled.normal;
  // 水洼的水面是平的（下雨时有涟漪）：天气也可能换法线
  let weathered = weatherSurface(in.world, n, facingNormal(normalize(in.normal), front), in.skinned != 0u, decaled.surface);
  n = weathered.normal;
  let layered = weathered.surface;
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
  let baseDiffuse = select(litDiffuse, vec3f(0.0), (material.specular & 8u) != 0u);
  // 环境光遮蔽：环境光全乘，直射光乘 lerp(1, ao, 直射光受影响的程度)；材质层可以把这两个数换成自己的
  var occlusionBase = material.occlusionMask.x;
  if ((u32(material.flags.w) & 4u) != 0u) {
    occlusionBase = dot(textureSample(occlusionTexture, occlusionSampler, in.uv * material.occlusionUvTransform.xy + material.occlusionUvTransform.zw), material.occlusionMask);
  }
  let occlusion = layerOcclusion(in, vec2f(occlusionBase, material.occlusionDirect));
  // 屏幕空间的遮蔽只算进环境光（直射光的遮蔽是有没有影子，不归它管）
  let screen = screenAmbient(in.position);
  let ao = occlusion.x * screen.w;
  let directOcclusion = mix(1.0, occlusion.x, occlusion.y);
  let roughness = layered.roughness;
  let alphaR = max(roughness * roughness, 0.001);
  let nDotV = max(dot(n, v), 0.0001);

  // 扩展材质（Stride 没有）：光泽在底下那层的上面，底下那层按光泽反射走的能量（查找表的 z）变暗
  let sheenColor = material.sheen.rgb;
  let sheenRoughness = clamp(material.sheen.w, 0.07, 1.0);
  var sheenDfg = 0.0;
  if (any(sheenColor > vec3f(0.0))) {
    sheenDfg = dfgLookup(vec2f(1.0 - sheenRoughness, nDotV)).z;
  }
  let sheenScaling = 1.0 - max(sheenColor.r, max(sheenColor.g, sheenColor.b)) * sheenDfg;
  let diffuse = baseDiffuse * sheenScaling;
  // 各向异性的方向：顶点切线（没有时按贴图坐标的导数算），转材质给的角度。导数在按材质常量的分支里取（一致的控制流）
  let anisotropy = clamp(material.anisotropy.x, -0.99, 0.99);
  var anisotropicT = vec3f(1.0, 0.0, 0.0);
  var anisotropicB = vec3f(0.0, 0.0, 1.0);
  if (anisotropy != 0.0) {
    let derived = derivativeTangent(in.world, in.uv, n);
    let vertexTangent = dot(in.tangent.xyz, in.tangent.xyz) > 1e-12;
    var t = select(derived, in.tangent.xyz, vertexTangent);
    t = normalize(t - n * dot(n, t) + vec3f(1e-6, 0.0, 0.0));
    let b = cross(n, t) * select(1.0, in.tangent.w, vertexTangent && in.tangent.w != 0.0);
    anisotropicT = normalize(t * material.anisotropy.y + b * material.anisotropy.z);
    anisotropicB = normalize(cross(n, anisotropicT));
  }
  // 环境光的反射方向：各向异性时按 Filament 把法线往"沿拉长方向的法线"弯过去
  var reflection = reflect(-v, n);
  if (anisotropy != 0.0) {
    let direction = select(anisotropicT, anisotropicB, anisotropy >= 0.0);
    let bentNormal = normalize(mix(n, cross(cross(direction, v), direction), abs(anisotropy)));
    reflection = reflect(-v, bentNormal);
  }

  // 直射光（DirectLightGroup.PrepareDirectLight：光色 · 衰减 · 阴影 · N·L），逐个光源相加
  // 玻璃：镜面的菲涅耳项和环境光的镜面系数都换成它的反射比例（Stride 的 FresnelThinGlass、EnvironmentThinGlass）
  let isGlass = material.flags.z > 0.0;
  // 不是玻璃的材质不算（里面有三次 pow，每个像素都算的话是这个着色器里最贵的一段）
  var glass = Glass(vec3f(1.0), vec3f(0.0));
  if (isGlass) {
    glass = thinGlass(base.rgb, nDotV, material.flags.z);
  }
  // 微表面模型的各项在 material.specular 的第 4 位往上（MeshRenderFeature 的 microfacetBits）
  let microfacet = material.specular >> 4u;
  let surface = Surface(n, v, diffuse, select(specular, glass.reflectance, isGlass), hasSpecular, isGlass, alphaR, nDotV,
    sheenColor, sheenRoughness * sheenRoughness, sheenScaling, anisotropy, anisotropicT, anisotropicB, microfacet);
  var direct = Lit(vec3f(0.0), vec3f(0.0));
  // 次表面散射的材质（有槽位）算透射
  let scatters = material.subsurface.x > 0.0;
  let lightCount = u32(view.sky.z);
  let shadowLight = i32(view.sky.w);
  for (var i = 0u; i < lightCount; i++) {
    let l = -view.lightDirections[i].xyz;
    var shadow = 1.0;
    if (i32(i) == shadowLight) {
      shadow = computeShadow(in.world, n, max(dot(n, l), 0.0001), in.depth, in.position.xy) * screenContactShadow(in.position);
      // 和 Stride 不同：没有阴影图的光不算透射（不知道厚度；Stride 当厚度是 0，被照到的地方都透亮）
      if (scatters && view.shadow.x > 0.0) {
        direct.diffuse += transmittance(shadowThickness(in.world, n, in.depth), n, l, view.lightColors[i].rgb * directOcclusion, diffuse);
      }
    }
    if (i32(i) == i32(view.cloudShadow.w)) { shadow *= cloudShadow(in.world, l); }
    let lit = shadeLight(surface, l, view.lightColors[i].rgb, 1.0, shadow * directOcclusion);
    direct.diffuse += lit.diffuse;
    direct.specular += lit.specular;
  }
  // 点光、聚光：距离衰减（LightUtil.GetDistanceAttenuation），聚光再乘角度衰减（GetAngularAttenuation）
  // 分了簇时只看这一簇的光
  let clustered = cluster >= 0;
  var localCount = u32(view.locals.x);
  var firstLight = 0u;
  if (clustered) {
    localCount = clusterCounts(cluster).x;
    firstLight = clusters[u32(cluster)];
  }
  for (var k = 0u; k < localCount; k++) {
    let light = localLight(select(k, clusters[firstLight + k], clustered));
    let at = localLightAt(light, in.world);
    let l = at.xyz;
    let attenuation = at.w;
    // 这个视图用不用阴影看图集的尺寸（不用时是 0）
    var shadow = 1.0;
    if (light.direction.w >= 0.0 && view.shadowAtlas.y > 0.0 && attenuation > 0.0) {
      shadow = computeLocalShadow(u32(light.direction.w), in.world, n, max(dot(n, l), 0.0001), light.position.xyz);
    }
    let lit = shadeLight(surface, l, light.color.rgb, attenuation, shadow * directOcclusion);
    direct.diffuse += lit.diffuse;
    direct.specular += lit.specular;
  }
  // 直射光的总和乘 π（MaterialSurfaceLightingAndShading："*PI over hemisphere"），光源强度因此和 Stride 的场景一致。
  // scattered 是所有漫反射光（次表面散射模糊的就是它），镜面反射和自发光另加
  var scattered = direct.diffuse * PI;

  // 环境光和天空盒光都没有的场景（只有直射光）整段跳过
  let hasAmbient = any(view.ambientColor.rgb > vec3f(0.0));
  let hasSky = view.sky.x > 0.0;
  // 环境光：镜面项都乘 DFG（Stride 的环境 BRDF 查找表）；屏幕空间反射合成时要这个权重和加进去的环境镜面反射
  var environmentSpecular = vec3f(0.0);
  var environment = vec3f(0.0);
  if (hasSpecular) {
    let dfg = dfgLookup(vec2f(1.0 - sqrt(alphaR), nDotV));
    let layerSpecular = select(specular * dfg.x + dfg.y, environmentDfgPolynomial(specular, alphaR, nDotV), (microfacet & 64u) != 0u);
    // 光泽：底下那层乘剩下的比例，加上光泽自己的（环境光的方向、粗糙度按底下那层的取，Filament 另按光泽粗糙度取一次）
    environmentSpecular = select(layerSpecular * sheenScaling + sheenColor * sheenDfg, glass.reflectance, isGlass);
  }
  // 反射探针盖住的地方用它的镜面反射，盖不住的部分（1 - a）才用环境光和天空盒的
  var probe = vec4f(0.0);
  if (hasSpecular && view.locals.w > 0.0) {
    probe = probeSpecular(in.world, reflection, sqrt(alphaR), cluster);
    environment = environmentSpecular * probe.rgb * ao;
  }
  if (hasAmbient || hasSky) {
    scattered += diffuse * celEnvironment(view.ambientColor.rgb) * ao;
    environment += environmentSpecular * view.ambientColor.rgb * ao * (1.0 - probe.a);
    if (hasSky) {
      let skyIntensity = view.sky.x * ao;
      scattered += diffuse * celEnvironment(evaluateSH(skyDirection(n)) * view.sky.x) * ao;
      if (hasSpecular && probe.a < 1.0) {
        environment += environmentSpecular * textureSampleLevel(skySpecular, linearClamp, skyDirection(reflection), sqrt(alphaR) * view.sky.y).rgb * skyIntensity * (1.0 - probe.a);
      }
    }
  }
  // 屏幕空间的间接光（近处表面反射过来的漫反射光；材质自己的遮蔽照样乘）
  scattered += diffuse * screen.xyz * occlusion.x;

  // 自发光：a 不小于 0 时输出的 alpha 用它（Stride 的 UseAlpha）
  let emitted = emissiveColor(in);
  // 限在 float16 的上限以内：很光滑的表面（湿的地面）对着太阳的高光能超过 65504，变成无穷大，泛光把它摊成整帧的 NaN
  let color = min(scattered + direct.specular * PI + environment + layerEmissive(in, emitted.rgb), vec3f(60000.0));
  let alpha = select(base.a, emitted.a, emitted.a >= 0.0);
  // 预乘 alpha：颜色已经乘过 alpha；不透明的阶段不混合，alpha 不起作用。网格效果最后可以改颜色（Stride 的 ShadingBase.Shading）
  return Shaded(effectShading(vec4f(color, saturate(alpha * material.blend.a)), in.effect), n, roughness, environmentSpecular, environment, scattered);
}`;

/**
 * 材质的颜色树（Material.shaderTrees）接进网格着色器的三个函数，没有对应的树时用默认：
 * - emissiveColor：自发光（树先填共用的流，再乘强度；默认是贴图乘 emissive，没有贴图时是白图）；a 不小于 0 时输出的 alpha 用它；
 * - treeNormal：切线空间的法线（已经按 ScaleAndBias、IsXYNormal 换好），w 为 0 时没有法线树、用法线贴图；
 * - treeDisplacement：顶点沿模型空间的法线移动多少（顶点着色器里算）。
 */
export function materialTreesCode(trees: MaterialShaderTrees | undefined): string {
  const { emissive, normal, displacement } = trees ?? {};
  const fill = (uv: string, local: string) => `streams = MaterialStreams(${uv}, ${uv}, vec4f(1.0), vec4f(1.0), ${local}, view.locals.y);`;
  const emissiveCode = emissive
    ? `fn emissiveColor(in: Varyings) -> vec4f {
  ${fill('in.uv', 'in.local')}
  let e = emissiveTree();
  return vec4f(e.rgb * ${wgslFloat(emissive.intensity)}, ${emissive.useAlpha ? 'e.a' : '-1.0'});
}`
    : `fn emissiveColor(in: Varyings) -> vec4f {
  var texel = vec3f(1.0);
  if ((u32(material.flags.w) & 2u) != 0u) {
    texel = textureSample(emissiveTexture, emissiveSampler, in.uv * material.emissiveUvTransform.xy + material.emissiveUvTransform.zw).rgb;
  }
  return vec4f(texel * material.emissive.rgb, -1.0);
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
  return [MATERIAL_STREAMS, trees?.code ?? '', emissiveCode, normalCode, displacementCode, layersCode(trees?.layers ?? [], trees?.graph ?? false), clearCoatCode(trees?.clearCoat)].join('\n');
}

/**
 * 清漆（Stride 的 MaterialClearCoatFeature）接进网格着色器的两个函数，没有清漆时原样返回：
 * - coatNormal：切线空间的法线，w 为 0 时没有清漆。底下一遍是金属碎片的，清漆那一遍是橘皮的；
 * - coatSurface：这一遍的漫反射色、金属度、粗糙度。底下一遍（MaterialSurfaceDiffuseMetalFlakes、GlossinessMapMetalFlakes）：
 *   漫反射色和光泽度按到相机的距离从金属碎片过渡到底漆，碎片的光泽度先按法线贴图的长度压低（法线越乱越粗糙）；
 *   清漆那一遍：材质自己的漫反射色，配清漆的金属度和光泽度。
 */
function clearCoatCode(coat: MaterialShaderClearCoat | undefined): string {
  if (!coat) {
    return `fn coatNormal(in: Varyings, coatPass: bool) -> vec4f { return vec4f(0.0); }
fn coatSurface(in: Varyings, s: LayerSurface, coatPass: bool) -> LayerSurface { return s; }`;
  }
  const fill = `streams = MaterialStreams(in.uv, in.uv, vec4f(1.0), vec4f(1.0), in.local, view.locals.y);`;
  const unpack = (name: string, { scaleAndBias, isXYNormal }: { scaleAndBias: boolean; isXYNormal: boolean }) => [
    scaleAndBias ? `  ${name} = 2.0 * ${name} - 1.0;` : '',
    isXYNormal ? `  ${name}.z = sqrt(max(0.0, 1.0 - (${name}.x * ${name}.x + ${name}.y * ${name}.y)));` : '',
  ].filter(Boolean).join('\n');
  const gloss = (call: string, invert: boolean) => (invert ? `(1.0 - ${call})` : call);
  return `fn coatFlakes() -> vec3f {
  var flakes = coatFlakesNormal().xyz;
${unpack('flakes', coat.flakesNormal)}
  return flakes;
}
fn coatNormal(in: Varyings, coatPass: bool) -> vec4f {
  ${fill}
  var peel = coatTopNormal().xyz;
${unpack('peel', coat.topNormal)}
  return vec4f(select(coatFlakes(), peel, coatPass), 1.0);
}
fn coatSurface(in: Varyings, s: LayerSurface, coatPass: bool) -> LayerSurface {
  ${fill}
  let top = LayerSurface(s.albedo, coatTopMetalness(), s.specular, 1.0 - ${gloss('coatTopGloss()', coat.topInvert)});
  let lod = saturate(distance(view.eye.xyz, in.world) * coatLodDistance());
  let normalLength = length(coatFlakes());
  let flakesGloss = ${gloss('coatFlakesGloss()', coat.flakesInvert)};
  let corrected = normalLength * flakesGloss / (normalLength + flakesGloss * (1.0 - normalLength));
  let glossiness = mix(corrected, ${gloss('coatBaseGloss()', coat.baseInvert)}, lod);
  let under = LayerSurface(mix(coatFlakesDiffuse().rgb, coatBaseDiffuse().rgb, lod), coatFlakesMetalness(), s.specular, 1.0 - glossiness);
  if (coatPass) { return top; }
  return under;
}`;
}

/**
 * 材质层（Stride 的 MaterialBlendLayer、MaterialStreamLinearBlend）：每层的遮罩 b，各个属性 mix(下面的, 这层的, b)；光泽度换成粗糙度
 * 再混，法线在切线空间里混再归一化，自发光（乘过强度的）、环境光遮蔽和它对直射光的影响也一样混。没有层时这几个函数原样返回。
 */
function layersCode(layers: readonly MaterialShaderLayer[], graph: boolean): string {
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
  const occlusion = layers.map((layer, i) => (layer.occlusion
    ? `  o = mix(o, vec2f(layer${i}Occlusion(), ${wgslFloat(layer.occlusion.directLighting)}), saturate(layer${i}Blend()));` : '')).filter(Boolean);
  return `struct LayerSurface { albedo: vec3f, metalness: f32, specular: vec3f, roughness: f32 };
fn layerEmissive(in: Varyings, base: vec3f) -> vec3f {
${emissive.length > 0 ? `  ${fill}\n  var e = base;\n${emissive.join('\n')}\n  return e;` : '  return base;'}
}
// base：环境光遮蔽、直射光受它影响的程度
fn layerOcclusion(in: Varyings, base: vec2f) -> vec2f {
${occlusion.length > 0 ? `  ${fill}\n  var o = base;\n${occlusion.join('\n')}\n  return o;` : '  return base;'}
}
fn materialLayers(in: Varyings, s: LayerSurface) -> LayerSurface {
  var r = s;
${layers.length > 0 ? `  ${fill}\n${surface}` : ''}
  return r;
}
fn layerNormal(in: Varyings, m: vec3f) -> vec4f {
${graph ? `  ${fill}\n  materialGraph();\n` : ''}${normals.length > 0 ? `${graph ? '' : `  ${fill}\n`}  var n = m;\n${normals.join('\n')}\n  return vec4f(n, 1.0);` : '  return vec4f(m, 0.0);'}
}`;
}

/** WGSL 的浮点字面量（整数也带小数点）。 */
function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}


/**
 * 环境 BRDF 的 DFG 查找表：x 是光泽度（1 - sqrt(alphaR)），y 是 N·V，值是 (scale, bias)，镜面项 = specular · scale + bias。
 * GGX 重要性采样（1024 个 Hammersley 点），G 用 Smith-Schlick-GGX，F 用 Schlick；尺寸同 Stride 的 EnvironmentLightingDFGLUT16。
 */
export const DFG_LUT_SHADER = /* wgsl */ `
${BRDF}

const SAMPLES = 1024u;
@group(0) @binding(0) var<storage, read_write> lut: array<vec4f>;

/**
 * 光泽的 DFG（Filament 的 DFV_Charlie_Uniform）：Charlie 分布乘 Ashikhmin 的可见性，半球上均匀采样（Charlie 的峰不尖，重要性
 * 采样没必要）。alpha 是光泽粗糙度的平方。
 */
fn sheenDfg(nDotV: f32, alpha: f32) -> f32 {
  let v = vec3f(sqrt(1.0 - nDotV * nDotV), 0.0, nDotV);
  var sum = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let xi = vec2f(f32(reverseBits(i)) * 2.3283064365386963e-10, (f32(i) + 0.5) / f32(SAMPLES));
    let phi = 2.0 * PI * xi.x;
    let cosTheta = 1.0 - xi.y;
    let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
    let h = vec3f(sinTheta * cos(phi), sinTheta * sin(phi), cosTheta);
    let vDotH = saturate(dot(v, h));
    let l = 2.0 * dot(v, h) * h - v;
    let nDotL = saturate(l.z);
    if (nDotL > 0.0) {
      let visibility = 1.0 / (4.0 * (nDotL + nDotV - nDotL * nDotV));
      let invAlpha = 1.0 / alpha;
      let sin2h = max(1.0 - h.z * h.z, 0.0078125);
      let d = (2.0 + invAlpha) * pow(sin2h, invAlpha * 0.5) / (2.0 * PI);
      sum += visibility * d * nDotL * vDotH;
    }
  }
  return sum * 4.0 * 2.0 * PI / f32(SAMPLES);
}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${DFG_LUT_WIDTH}u || id.y >= ${DFG_LUT_HEIGHT}u) {
    return;
  }
  // 纹素的中心（原来是全屏绘制里像素的位置）
  let position = vec2f(id.xy) + 0.5;
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
  lut[id.y * ${DFG_LUT_WIDTH}u + id.x] = vec4f(scale / f32(SAMPLES), bias / f32(SAMPLES), sheenDfg(nDotV, alphaR), 0.0);
}`;
