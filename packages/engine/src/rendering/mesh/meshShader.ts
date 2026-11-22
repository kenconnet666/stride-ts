/**
 * 网格的着色器源码（MeshRenderFeature 用）：固定的那一大段 WGSL（视图和材质的常量、光照、阴影、探针、各个阶段的入口，
 * 按段落分在 wgsl/ 里：view、surfaceInputs、materialBindings、vertex、lighting、fragment），
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
import { IRRADIANCE_VOLUME_WGSL } from '../raytracing/IrradianceVolume';
import { MATERIAL_STREAMS } from '../shaderClass';
import { BRDF } from '../wgsl';
import type { MaterialShaderClearCoat, MaterialShaderLayer, MaterialShaderTrees } from './Material';
import { DFG_LUT_HEIGHT, DFG_LUT_WIDTH, MESH_VIEW } from './wgsl/view';
import { MESH_SURFACE_INPUTS } from './wgsl/surfaceInputs';
import { MESH_MATERIAL_BINDINGS } from './wgsl/materialBindings';
import { MESH_VERTEX } from './wgsl/vertex';
import { MESH_LIGHTING } from './wgsl/lighting';
import { MESH_FRAGMENT } from './wgsl/fragment';

/** 固定的那一大段 WGSL：按段落分在 wgsl/ 里，顺序就是着色器里的顺序。 */
export const MESH_SHADER = MESH_VIEW + MESH_SURFACE_INPUTS + MESH_MATERIAL_BINDINGS + MESH_VERTEX + MESH_LIGHTING + MESH_FRAGMENT;

/**
 * 材质的颜色树（Material.shaderTrees）接进网格着色器的三个函数，没有对应的树时用默认：
 * - emissiveColor：自发光（树先填共用的流，再乘强度；默认是贴图乘 emissive，没有贴图时是白图）；a 不小于 0 时输出的 alpha 用它；
 * - treeNormal：切线空间的法线（已经按 ScaleAndBias、IsXYNormal 换好），w 为 0 时没有法线树、用法线贴图；
 * - treeDisplacement：顶点沿模型空间的法线移动多少（顶点着色器里算）。
 */
/** 片元着色器里材质流的世界位置（渲染空间的位置加回渲染原点）和几何法线。 */
const FRAGMENT_WORLD = 'in.world + view.origin.xyz';
const FRAGMENT_NORMAL = 'normalize(in.normal)';

export function materialTreesCode(trees: MaterialShaderTrees | undefined): string {
  const { emissive, normal, displacement } = trees ?? {};
  // 顶点着色器里（位移）没有世界坐标和法线：给 0 和朝上
  const fill = (uv: string, local: string, world = 'vec3f(0.0)', normal = 'vec3f(0.0, 1.0, 0.0)') => `streams = MaterialStreams(${uv}, ${uv}, vec4f(1.0), vec4f(1.0), ${local}, view.locals.y, ${world}, ${normal}, vec2f(-1.0));`;
  const emissiveCode = emissive
    ? `fn emissiveColor(in: Varyings) -> vec4f {
  ${fill('in.uv', 'in.local', FRAGMENT_WORLD, FRAGMENT_NORMAL)}
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
  ${fill('in.uv', 'in.local', FRAGMENT_WORLD, FRAGMENT_NORMAL)}
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
  return [MATERIAL_STREAMS, trees?.code ?? '', emissiveCode, normalCode, displacementCode, layersCode(trees?.layers ?? [], trees?.graphs ?? []), clearCoatCode(trees?.clearCoat)].join('\n');
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
  const fill = `streams = MaterialStreams(in.uv, in.uv, vec4f(1.0), vec4f(1.0), in.local, view.locals.y, ${FRAGMENT_WORLD}, ${FRAGMENT_NORMAL}, in.position.xy);`;
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
function layersCode(layers: readonly MaterialShaderLayer[], graphs: readonly string[]): string {
  const fill = `streams = MaterialStreams(in.uv, in.uv, vec4f(1.0), vec4f(1.0), in.local, view.locals.y, ${FRAGMENT_WORLD}, ${FRAGMENT_NORMAL}, in.position.xy);`;
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
${graphs.length > 0 ? `  ${fill}\n${graphs.map((name) => `  ${name}();\n`).join('')}` : ''}${normals.length > 0 ? `${graphs.length > 0 ? '' : `  ${fill}\n`}  var n = m;\n${normals.join('\n')}\n  return vec4f(n, 1.0);` : '  return vec4f(m, 0.0);'}
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

/**
 * 视图的第 26、27 个绑定和用它们的函数：屏幕的贴图（不透明阶段是平面反射图，透明阶段是折射拷的画面）、辐照度体的图集。设备放得下
 * 这两张贴图时才声明（PlanarReflections.supported），放不下时取色返回黑、辐照度体不盖（这时 view.planar.x、view.decal.y、
 * view.giMin.w 总是 0，调不到）。
 */
export function screenTextureCode(supported: boolean): string {
  return supported
    ? /* wgsl */ `
@group(0) @binding(26) var screenTexture: texture_2d<f32>;
@group(0) @binding(27) var irradianceAtlas: texture_2d<f32>;
fn planarColor(uv: vec2f, level: f32) -> vec3f { return textureSampleLevel(screenTexture, linearClamp, uv, level).rgb; }
fn sceneColor(uv: vec2f, level: f32) -> vec3f { return textureSampleLevel(screenTexture, linearClamp, uv, level).rgb; }
${IRRADIANCE_VOLUME_WGSL}
/** 辐照度体在这一点的漫反射环境光（rgb，乘过强度）和盖住的程度（a）；没有体时是 0。 */
fn volumeIrradiance(p: vec3f, n: vec3f, v: vec3f) -> vec4f {
  if (view.giMin.w == 0.0) { return vec4f(0.0); }
  // 路径追踪的间接光代替（它从屏幕空间的间接光那里加进来）：盖满、自己不加
  if (view.giMin.w > 1.5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let s = giSample(irradianceAtlas, linearClamp, GiVolume(view.giMin, view.giSpacing, view.giCounts, view.giScroll), p, n, v);
  return vec4f(s.rgb * view.giSpacing.w, s.a);
}
`
    : /* wgsl */ `
fn planarColor(uv: vec2f, level: f32) -> vec3f { return vec3f(0.0); }
fn sceneColor(uv: vec2f, level: f32) -> vec3f { return vec3f(0.0); }
fn volumeIrradiance(p: vec3f, n: vec3f, v: vec3f) -> vec4f { return vec4f(0.0); }
`;
}
