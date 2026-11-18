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
 * 输出线性的 HDR 颜色，色调映射在后面（ToneMapRenderer）。
 *
 * 数据流：
 * - Extract：遍历带 Model 和 Transform 的实体，按（网格，材质，是否投射阴影）分批，每批记下实体的变换槽位。
 * - Cull：各批的槽位连着写进 stride-native 的剔除工作区（FrustumCuller），一次调用剔除一组视图，每批用网格的包围盒；
 *   主视图顺带量出可见物体的距离范围（阴影级联要用）。一帧剔除两次：先主视图，再阴影级联。
 * - Prepare：把变换存储的世界矩阵列整段上传（直接从 wasm 内存，只传用到的那一段），各次剔除的结果（每个视图一段可见槽位）
 *   也直接从 wasm 内存上传成实例缓冲，每个视图的常量（相机、光照、阴影、天空盒）写进按视图分块的 uniform 缓冲（动态偏移）。
 * - Draw：每批一次实例化绘制；着色器用 worlds[slots[instance_index]] 取世界矩阵，firstInstance 是这个视图里这一批的起点。
 *   顶点布局（content/format.ts 的 VertexLayout）不同的网格用不同的管线；量化的属性在顶点着色器里按网格的参数还原
 *   （第 2 组绑定），八面体编码的法线也在那里解开。阴影投射阶段只画投射阴影的批次，管线只写深度。
 * 每帧上传都只写一次、在提交之前，不会碰到 writeBuffer 生效时机的坑（docs/lessons.md）。
 */
import type { FrustumCuller } from '@stride-ts/native';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { BRDF } from './brdf';
import { Model } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import { Material } from './Material';
import { vertexLayoutOffsets, type VertexLayout } from '../content/format';
import { Mesh } from './Mesh';
import { RootRenderFeature, type Lighting, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';

/** 一次实例化绘制：同一个网格和材质的实体。 */
export interface MeshBatch {
  readonly mesh: Mesh;
  readonly material: Material;
  /** 这批的实体投下阴影（Model.isShadowCaster）。 */
  readonly isShadowCaster: boolean;
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
  lightDirection: vec4f,
  lightColor: vec4f,
  ambientColor: vec4f,
  // x：天空盒光的强度（没有天空盒时是 0），y：镜面立方体贴图的级数
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
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> worlds: array<mat4x4f>;
@group(0) @binding(2) var<storage, read> slots: array<u32>;
@group(0) @binding(3) var skySpecular: texture_cube<f32>;
@group(0) @binding(4) var dfgLut: texture_2d<f32>;
@group(0) @binding(5) var linearClamp: sampler;
@group(0) @binding(6) var shadowAtlas: texture_depth_2d;
@group(0) @binding(7) var shadowComparison: sampler_comparison;

// 漫反射 = combine(贴图(uv * scale + offset), baseColor)；combine 0 是乘，1 是加（operator 是 WGSL 的保留字）。
// 没有贴图的材质绑一张 1x1 的白图。surface：金属度、粗糙度、漫反射 cavity、镜面 cavity。
// normalFlags：第 1 位有法线贴图，第 2 位 ×2-1，第 3 位 y 取反，第 4 位由 xy 算 z。
struct Material {
  baseColor: vec4f,
  uvTransform: vec4f,
  emissive: vec4f,
  surface: vec4f,
  normalUvTransform: vec4f,
  combine: u32,
  specular: u32,
  normalFlags: u32,
};
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(2) var baseColorSampler: sampler;
@group(1) @binding(3) var normalTexture: texture_2d<f32>;

// 网格的反量化：位置 = offset + 输入 · scale，UV = uvTransform.zw + 输入 · uvTransform.xy；flags 的第 1 位：法线是八面体编码。
// 不量化的网格 offset 0、scale 1。unorm16 的位置读进来是 vec4f，snorm16x2 的法线是 (x, y, 0)，都按 vec3f 用。
struct MeshParams { positionOffset: vec4f, positionScale: vec4f, uvTransform: vec4f, flags: u32 };
@group(2) @binding(0) var<uniform> mesh: MeshParams;

/** 八面体编码还原成单位向量（同 meshopt 的 octahedral 滤波，资源管线的编码见 packages/pipeline/src/mesh.ts）。 */
fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // 视图空间的深度（裁剪坐标的 w），选阴影级联用（Stride 的 DepthVS）
  @location(3) depth: f32,
  // 世界空间的切线和手性；网格没有切线时是 0
  @location(4) tangent: vec4f,
};

fn transformVertex(position: vec3f, normal: vec3f, uv: vec2f, tangent: vec4f, instance: u32) -> Varyings {
  let world = worlds[slots[instance]];
  let local = mesh.positionOffset.xyz + position * mesh.positionScale.xyz;
  let localNormal = select(normal, octDecode(normal.xy), (mesh.flags & 1u) != 0u);
  let worldPosition = world * vec4f(local, 1.0);
  var out: Varyings;
  out.position = view.viewProjection * worldPosition;
  out.world = worldPosition.xyz;
  // 均匀缩放下法线、切线直接用世界矩阵变换；非均匀缩放要用逆转置，等材质系统一起做
  out.normal = (world * vec4f(localNormal, 0.0)).xyz;
  out.uv = mesh.uvTransform.zw + uv * mesh.uvTransform.xy;
  out.depth = out.position.w;
  out.tangent = vec4f((world * vec4f(tangent.xyz, 0.0)).xyz, tangent.w);
  return out;
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32) -> Varyings {
  return transformVertex(position, normal, uv, vec4f(0.0), instance);
}

@vertex fn vsTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @builtin(instance_index) instance: u32) -> Varyings {
  return transformVertex(position, normal, uv, tangent, instance);
}

/**
 * 着色用的法线：有法线贴图、网格有切线时按切线空间的法线算（Stride 的 MaterialSurfaceNormalMap 加 UpdateNormalFromTangentSpace），
 * 否则是顶点法线。贴图总是采样（没有时绑白图），用 select 挑结果：采样必须在一致的控制流里。
 */
fn surfaceNormal(in: Varyings) -> vec3f {
  let n = normalize(in.normal);
  var m = textureSample(normalTexture, baseColorSampler, in.uv * material.normalUvTransform.xy + material.normalUvTransform.zw).xyz;
  let flags = material.normalFlags;
  m.y = select(m.y, 1.0 - m.y, (flags & 4u) != 0u);
  m = select(m, 2.0 * m - 1.0, (flags & 2u) != 0u);
  m.z = select(m.z, sqrt(max(0.0, 1.0 - (m.x * m.x + m.y * m.y))), (flags & 8u) != 0u);
  let tangentLength = length(in.tangent.xyz);
  let t = in.tangent.xyz / max(tangentLength, 1e-8);
  let b = in.tangent.w * cross(n, t);
  let mapped = normalize(m.x * t + m.y * b + m.z * n);
  return select(n, mapped, (flags & 1u) != 0u && tangentLength > 0.0);
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

/** PCF 核在一个轴上的采样位置（相对基准像素，单位是像素）和权重（Stride 的 ShadowMapFilterPcf，核是两个轴的乘积）。 */
struct PcfAxis { offsets: vec4f, weights: vec4f, count: u32 };

fn pcfAxis(size: u32, s: f32) -> PcfAxis {
  if (size == 3u) {
    let w = vec2f(3.0 - 2.0 * s, 1.0 + 2.0 * s);
    return PcfAxis(vec4f((2.0 - s) / w.x - 1.0, s / w.y + 1.0, 0.0, 0.0), vec4f(w, 0.0, 0.0), 2u);
  }
  if (size == 5u) {
    let w = vec3f(4.0 - 3.0 * s, 7.0, 1.0 + 3.0 * s);
    return PcfAxis(vec4f((3.0 - 2.0 * s) / w.x - 2.0, (3.0 + s) / w.y, s / w.z + 2.0, 0.0), vec4f(w, 0.0), 3u);
  }
  let w = vec4f(5.0 * s - 6.0, 11.0 * s - 28.0, -(11.0 * s + 17.0), -(5.0 * s + 1.0));
  return PcfAxis(vec4f((4.0 * s - 5.0) / w.x - 3.0, (4.0 * s - 16.0) / w.y - 1.0, -(7.0 * s + 5.0) / w.z + 1.0, -s / w.w + 3.0), w, 4u);
}

/** 图集里 position 处的阴影（1 是亮）：一次双线性的比较采样，或者 PCF（权重的和是 16、144、2704，同 Stride 的归一化）。 */
fn filterShadow(position: vec2f, depth: f32) -> f32 {
  let size = u32(view.shadow.w);
  if (size == 0u) {
    return textureSampleCompareLevel(shadowAtlas, shadowComparison, position, depth);
  }
  let texel = view.shadowAtlas.x;
  let uv = position * view.shadowAtlas.y;
  let rounded = floor(uv + 0.5);
  let st = uv + 0.5 - rounded;
  let base = (rounded - 0.5) * texel;
  let ax = pcfAxis(size, st.x);
  let ay = pcfAxis(size, st.y);
  var shadow = 0.0;
  var total = 0.0;
  for (var j = 0u; j < ay.count; j++) {
    for (var i = 0u; i < ax.count; i++) {
      let w = ax.weights[i] * ay.weights[j];
      shadow += w * textureSampleCompareLevel(shadowAtlas, shadowComparison, base + vec2f(ax.offsets[i], ay.offsets[j]) * texel, depth);
      total += w;
    }
  }
  return shadow / total;
}

fn shadowFromCascade(position: vec3f, cascade: u32) -> f32 {
  var p = view.shadowMatrices[cascade] * vec4f(position, 1.0);
  p.z -= view.shadow.y;
  let s = p.xyz / p.w;
  return filterShadow(s.xy, s.z);
}

/** 方向光的阴影（Stride 的 ShadowMapReceiverDirectional.ComputeShadow）。 */
fn computeShadow(position: vec3f, normal: vec3f, nDotL: f32, depth: f32) -> f32 {
  let count = u32(view.shadow.x);
  if (count == 0u) {
    return 1.0;
  }
  var cascade = 0u;
  for (var i = 0u; i + 1u < count; i++) {
    if (depth > view.shadowSplits[i]) {
      cascade = i + 1u;
    }
  }
  // 法线偏移：按图集的像素大小和 1 - N·L 沿法线推出去
  let p = position + 2.0 * view.shadowAtlas.x * view.shadow.z * saturate(1.0 - nDotL) * normal;
  var shadow = shadowFromCascade(p, cascade);
  let nextSplit = view.shadowSplits[cascade];
  var splitSize = nextSplit;
  if (cascade > 0u) {
    splitSize = nextSplit - view.shadowSplits[cascade - 1u];
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

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let n = surfaceNormal(in);
  let v = normalize(view.eye.xyz - in.world);
  let texel = textureSample(baseColorTexture, baseColorSampler, in.uv * material.uvTransform.xy + material.uvTransform.zw).rgb;
  let albedo = select(texel * material.baseColor.rgb, texel + material.baseColor.rgb, material.combine == 1u);

  // 金属度工作流（MaterialSurfaceMetalness），再乘 cavity（PrepareMaterialForLightingAndShading）
  let hasSpecular = material.specular == 1u;
  let metalness = material.surface.x;
  let diffuse = select(albedo, albedo * (1.0 - metalness), hasSpecular) * material.surface.z;
  let specular = select(vec3f(0.0), mix(vec3f(0.02), albedo, metalness), hasSpecular) * material.surface.w;
  let roughness = material.surface.y;
  let alphaR = max(roughness * roughness, 0.001);
  let nDotV = max(dot(n, v), 0.0001);

  // 直射光（DirectLightGroup.PrepareDirectLight：光色 · 阴影 · N·L）
  let l = -view.lightDirection.xyz;
  let nDotL = max(dot(n, l), 0.0001);
  let shadow = computeShadow(in.world, n, nDotL, in.depth);
  let lightColorNdotL = view.lightColor.rgb * shadow * nDotL;
  var color = diffuse / PI * lightColorNdotL;
  let h = normalize(v + l);
  let nDotH = saturate(dot(n, h));
  let lDotH = saturate(dot(l, h));
  let fresnel = specular + (1.0 - specular) * pow(1.0 - lDotH, 5.0);
  let reflected = fresnel * visibilitySmithSchlickGGX(alphaR, nDotL, nDotV) * normalDistributionGGX(alphaR, nDotH) / 4.0;
  color += select(vec3f(0.0), reflected * lightColorNdotL, hasSpecular);

  // 环境光：镜面项都乘 DFG（Stride 的环境 BRDF 查找表）
  let dfg = textureSampleLevel(dfgLut, linearClamp, vec2f(1.0 - sqrt(alphaR), nDotV), 0.0).rg;
  let environmentSpecular = select(vec3f(0.0), specular * dfg.x + dfg.y, hasSpecular);
  color += diffuse * view.ambientColor.rgb + environmentSpecular * view.ambientColor.rgb;

  // 天空盒光：强度是 0 时贡献也是 0，不用分支
  let skyIntensity = view.sky.x;
  let skyDiffuse = evaluateSH(skyDirection(n)) * skyIntensity;
  let reflection = skyDirection(reflect(-v, n));
  let skySpecularColor = textureSampleLevel(skySpecular, linearClamp, reflection, sqrt(alphaR) * view.sky.y).rgb * skyIntensity;
  color += diffuse * skyDiffuse + environmentSpecular * skySpecularColor;

  color += material.emissive.rgb;
  return vec4f(color, 1.0);
}`;

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
/** View 结构：viewProjection 16、eye 4、光方向 4、光色 4、环境色 4、sky 4、球谐 36、天空盒旋转 16、阴影矩阵 64、阴影参数 12。 */
const VIEW_FLOATS = 164;
/** 一帧最多的视图数：主视图加 4 个阴影级联，留些余量。 */
const MAX_VIEWS = 8;
/** 材质 uniform：baseColor、uvTransform、emissive、surface、normalUvTransform 各一个 vec4，再加三个 u32，补齐到 16 字节。 */
const MATERIAL_BYTES = 96;
const OPERATOR_CODES = { multiply: 0, add: 1 } as const;
/** 网格参数的 uniform：positionOffset、positionScale、uvTransform 各一个 vec4，再加 flags，补齐到 16 字节。 */
const MESH_PARAMS_BYTES = 64;

/** 一次剔除：一个剔除工作区和它剔除的视图；结果在实例缓冲里从 offset 开始，每个视图 slotCount 个。 */
interface CullPass {
  readonly culler: FrustumCuller;
  readonly views: RenderView[];
  slotCount: number;
  batchCount: number;
  offset: number;
}

interface GpuMesh {
  /** 第 2 组绑定：反量化参数。 */
  readonly params: GPUBuffer;
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
  /** 这一帧的批次，按第一次出现的顺序；空的批次留着下一帧复用。 */
  readonly batches: MeshBatch[] = [];
  readonly #batchByKey = new Map<number, MeshBatch>();
  #instanceCount = 0;
  /** 这一帧各视图实际画了多少实例、多少次绘制（剔除之后，所有视图加起来）。 */
  drawnInstances = 0;
  drawCalls = 0;

  readonly #extractSystem = system('MeshRenderFeature.extract', {
    with: { model: Model, transform: Transform },
    update: ({ model, transform, count }) => {
      const { mesh, material, isShadowCaster } = model;
      const { slot } = transform;
      // 相邻的行大多是同一批，先比较上一批，省掉大部分 Map 查找
      let batch: MeshBatch | undefined;
      for (let i = 0; i < count; i++) {
        const meshId = mesh[i]!, materialId = material[i]!, caster = isShadowCaster[i] !== 0;
        if (!batch || batch.mesh.id !== meshId || batch.material.id !== materialId || batch.isShadowCaster !== caster) batch = this.#batchFor(meshId, materialId, caster);
        if (batch.count === batch.slots.length) batch.slots = grow(batch.slots, batch.count * 2);
        batch.slots[batch.count++] = slot[i]!;
      }
    },
  });

  // 剔除：一帧里第 k 次 cull 用第 k 个工作区；视图到（剔除，视图在其中的下标）
  readonly #cullPasses: CullPass[] = [];
  #cullPassCount = 0;
  readonly #viewCulling = new Map<RenderView, { pass: CullPass; index: number }>();

  // GPU 资源，第一次 Prepare 时创建
  #gpu: Gpu | undefined;

  override extract(context: RenderContext): void {
    for (const batch of this.batches) batch.count = 0;
    context.game.entities.run(this.#extractSystem, context.time);
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
      const { min, max } = batch.mesh.bounds;
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
    const passes = this.#cullPasses.slice(0, this.#cullPassCount);
    let offset = 0;
    for (const pass of passes) {
      pass.offset = offset;
      offset += pass.views.length * pass.slotCount;
    }
    gpu.uploadInstances(passes, offset);
    gpu.uploadViews(this.system.views, this.system.lighting);
  }

  override draw(_context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    const culling = this.#viewCulling.get(view);
    if (!gpu || !culling) return;
    const { pass: cullPass, index } = culling;
    const counts = cullPass.culler.counts;
    const shadow = stage.shadowCasters ? undefined : this.system.lighting.shadow;
    pass.setBindGroup(0, gpu.viewBindGroup(shadow?.atlas), [view.index * VIEW_STRIDE]);
    let mesh: Mesh | undefined, material: Material | undefined, pipeline: GPURenderPipeline | undefined;
    const viewOffset = cullPass.offset + index * cullPass.slotCount;
    for (let b = 0; b < cullPass.batchCount; b++) {
      const batch = this.batches[b]!;
      const count = counts[index * cullPass.batchCount + b]!;
      if (count === 0 || (stage.shadowCasters && !batch.isShadowCaster)) continue;
      // pass 内只在变化时重设状态（docs/lessons.md）
      if (batch.material !== material) {
        material = batch.material;
        pass.setBindGroup(1, gpu.material(material));
      }
      const gpuMesh = gpu.mesh(batch.mesh);
      if (batch.mesh !== mesh) {
        mesh = batch.mesh;
        const next = gpu.pipelineFor(stage, mesh.layout);
        if (next !== pipeline) pass.setPipeline((pipeline = next));
        pass.setBindGroup(2, gpuMesh.bindGroup);
        pass.setVertexBuffer(0, gpuMesh.vertices);
        pass.setIndexBuffer(gpuMesh.indices, gpuMesh.indexFormat);
      }
      pass.drawIndexed(gpuMesh.indexCount, count, 0, 0, viewOffset + batch.first);
      this.drawnInstances += count;
      this.drawCalls++;
    }
  }

  override destroy(): void {
    this.#gpu?.destroy();
    this.#gpu = undefined;
    for (const pass of this.#cullPasses) pass.culler.destroy();
    this.#cullPasses.length = 0;
  }

  #batchFor(meshId: number, materialId: number, isShadowCaster: boolean): MeshBatch {
    // 两个 id 都远小于 2^25，拼成一个整数键不会冲突
    const key = (meshId * 0x2000000 + materialId) * 2 + (isShadowCaster ? 1 : 0);
    let batch = this.#batchByKey.get(key);
    if (!batch) {
      const mesh = Mesh.byId(meshId);
      const material = Material.byId(materialId);
      if (!mesh) throw new Error(`Model refers to mesh ${meshId}, which does not exist`);
      if (!material) throw new Error(`Model refers to material ${materialId}, which does not exist`);
      batch = { mesh, material, isShadowCaster, slots: new Uint32Array(64), count: 0, first: 0 };
      this.#batchByKey.set(key, batch);
      this.batches.push(batch);
    }
    return batch;
  }
}

function grow(array: Uint32Array, capacity: number): Uint32Array {
  const grown = new Uint32Array(capacity);
  grown.set(array);
  return grown;
}

/** 一个特性在一个设备上的 GPU 资源。 */
class Gpu {
  readonly device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #unclippedDepth: boolean;
  readonly #module: GPUShaderModule;
  readonly #viewLayout: GPUBindGroupLayout;
  readonly #materialLayout: GPUBindGroupLayout;
  readonly #meshLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #meshes = new Map<Mesh, GpuMesh>();
  readonly #materials = new Map<Material, GpuMaterial>();
  readonly #materialData = new ArrayBuffer(MATERIAL_BYTES);
  readonly #dfgLut: GPUTexture;

  #worlds: GPUBuffer | undefined;
  #instances: GPUBuffer | undefined;
  #views: GPUBuffer | undefined;
  readonly #viewData = new Float32Array((VIEW_STRIDE / 4) * MAX_VIEWS);
  /** 视图绑定组，按绑在阴影位置上的深度图分开：画阴影图集时不能同时采样它。 */
  readonly #viewBindGroups = new Map<GPUTexture, GPUBindGroup>();
  /** 视图绑定组里的天空盒镜面立方体贴图；换了天空盒要重建绑定组。 */
  #skySpecular: GPUTexture | undefined;

  constructor(device: GPUDevice, resources: GpuResources, unclippedDepth: boolean) {
    this.device = device;
    this.#resources = resources;
    this.#unclippedDepth = unclippedDepth;
    this.#module = device.createShaderModule({ label: 'MeshRenderFeature', code: SHADER });
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
      ],
    });
    this.#materialLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature material',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.#meshLayout = device.createBindGroupLayout({
      label: 'MeshRenderFeature mesh',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.#viewLayout, this.#materialLayout, this.#meshLayout] });
    this.#dfgLut = createDfgLut(device);
  }

  /**
   * 一个阶段加一种顶点布局一条管线。只有深度的阶段（阴影投射）不剔背面、不做深度裁剪（Stride 的 ShadowMeshPipelineProcessor），
   * 没有片元着色器。
   */
  pipelineFor(stage: RenderStage, layout: VertexLayout): GPURenderPipeline {
    const { colorFormat, depthFormat } = stage.output;
    const key = `${stage.name}:${colorFormat}:${depthFormat}:${layout.position}:${layout.normal}:${layout.uv}:${layout.tangent}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const offsets = vertexLayoutOffsets(layout);
      pipeline = this.device.createRenderPipeline({
        label: `MeshRenderFeature ${stage.name} ${layout.position}/${layout.normal}/${layout.uv}`,
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#module,
          entryPoint: layout.tangent ? 'vsTangent' : 'vs',
          buffers: [{
            arrayStride: offsets.stride,
            attributes: [
              { shaderLocation: 0, offset: offsets.position, format: layout.position },
              { shaderLocation: 1, offset: offsets.normal, format: layout.normal },
              { shaderLocation: 2, offset: offsets.uv, format: layout.uv },
              ...(layout.tangent ? [{ shaderLocation: 3, offset: offsets.tangent!, format: layout.tangent }] : []),
            ],
          }],
        },
        ...(colorFormat ? { fragment: { module: this.#module, entryPoint: 'fs', targets: [{ format: colorFormat }] } } : {}),
        primitive: colorFormat
          ? { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' }
          : { topology: 'triangle-list', cullMode: 'none', unclippedDepth: this.#unclippedDepth },
        depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
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

  uploadViews(views: readonly RenderView[], lighting: Lighting): void {
    const stride = VIEW_STRIDE / 4;
    if (views.length > MAX_VIEWS) throw new RangeError(`MeshRenderFeature supports ${MAX_VIEWS} views, got ${views.length}`);
    const { direction, color, ambient, skybox, shadow } = lighting;
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const data = this.#viewData;
    for (const view of views) {
      const o = view.index * stride;
      data.set(view.viewProjection, o);
      data.set([view.eye.x, view.eye.y, view.eye.z, 1], o + 16);
      data.set([direction.x / length, direction.y / length, direction.z / length, 0], o + 20);
      data.set([color.r, color.g, color.b, 1], o + 24);
      data.set([ambient.r, ambient.g, ambient.b, 1], o + 28);
      data.set([skybox?.intensity ?? 0, skybox?.skybox.specularLevels ?? 0, 0, 0], o + 32);
      for (let c = 0; c < 9; c++) {
        const sh = skybox?.skybox.diffuseSH;
        data.set(sh ? [sh[c * 3]!, sh[c * 3 + 1]!, sh[c * 3 + 2]!, 0] : [0, 0, 0, 0], o + 36 + c * 4);
      }
      data.set(skybox ? skybox.rotation : IDENTITY, o + 72);
      if (shadow) {
        const atlasSize = shadow.atlas.width;
        data.set(shadow.worldToShadow, o + 88);
        data.set(shadow.splits, o + 152);
        data.set([shadow.cascadeCount, shadow.depthBias, shadow.normalOffsetScale, shadow.filterSize], o + 156);
        data.set([1 / atlasSize, atlasSize, shadow.blendCascades ? 1 : 0, shadow.depthRangeAutomatic ? 1 : 0], o + 160);
      } else {
        data.fill(0, o + 88, o + VIEW_FLOATS);
      }
    }
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
        ],
      });
      this.#viewBindGroups.set(atlas, group);
    }
    return group;
  }

  mesh(mesh: Mesh): GpuMesh {
    let gpu = this.#meshes.get(mesh);
    if (!gpu) {
      const { vertices, indices } = mesh.data;
      const { positionOffset: po, positionScale: ps, uvOffset: uo, uvScale: us } = mesh.dequantize;
      const data = new ArrayBuffer(MESH_PARAMS_BYTES);
      new Float32Array(data).set([...po, 0, ...ps, 0, us[0], us[1], uo[0], uo[1]]);
      new Uint32Array(data)[12] = mesh.layout.normal === 'snorm16x2' ? 1 : 0;
      const params = this.#createFilled(`${mesh.name} params`, GPUBufferUsage.UNIFORM, new Uint8Array(data));
      gpu = {
        params,
        bindGroup: this.device.createBindGroup({ label: `${mesh.name} params`, layout: this.#meshLayout, entries: [{ binding: 0, resource: { buffer: params } }] }),
        vertices: this.#createFilled(`${mesh.name} vertices`, GPUBufferUsage.VERTEX, vertices),
        indices: this.#createFilled(`${mesh.name} indices`, GPUBufferUsage.INDEX, indices),
        indexFormat: indices instanceof Uint16Array ? 'uint16' : 'uint32',
        indexCount: indices.length,
      };
      this.#meshes.set(mesh, gpu);
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
      const slot = material.baseColorTexture;
      const { r, g, b, a } = material.baseColor;
      const normalMap = material.normalMap;
      const floats = new Float32Array(this.#materialData);
      floats.set([r, g, b, a, ...(slot?.scale ?? [1, 1]), ...(slot?.offset ?? [0, 0]), ...material.emissive, 0]);
      floats.set([material.metalness ?? 0, material.roughness, material.cavity.diffuse, material.cavity.specular], 12);
      floats.set([...(normalMap?.scale ?? [1, 1]), ...(normalMap?.offset ?? [0, 0])], 16);
      const codes = new Uint32Array(this.#materialData);
      codes[20] = OPERATOR_CODES[material.baseColorOperator];
      codes[21] = material.metalness === undefined ? 0 : 1;
      codes[22] = normalMap ? 1 | (normalMap.scaleAndBias ? 2 : 0) | (normalMap.invertY ? 4 : 0) | (normalMap.isXYNormal ? 8 : 0) : 0;
      this.device.queue.writeBuffer(gpu.buffer, 0, this.#materialData);
      gpu.bindGroup = this.device.createBindGroup({
        label: `${material.name} material`,
        layout: this.#materialLayout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: (slot ? this.#resources.texture(slot.texture) : this.#resources.white).createView() },
          { binding: 2, resource: this.#resources.linearRepeat },
          { binding: 3, resource: (normalMap ? this.#resources.texture(normalMap.texture) : this.#resources.white).createView() },
        ],
      });
      gpu.version = material.version;
    }
    return gpu.bindGroup;
  }

  destroy(): void {
    for (const buffer of [this.#worlds, this.#instances, this.#views]) buffer?.destroy();
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
