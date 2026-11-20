/**
 * 材质，和 Stride 默认的 PBR 材质对应：漫反射颜色（可以带一张贴图，按运算符和颜色组合，即 Stride 材质里最常见的
 * ComputeTextureColor、ComputeBinaryColor 的形状）、金属度或镜面颜色工作流的镜面反射（GGX、Schlick、Smith-Schlick-GGX）、
 * 光泽度、自发光（可以乘一张贴图，或者是编译好的颜色树）、环境光遮蔽（可以是贴图）、cavity、法线贴图和透明混合，见 content/format.ts 的
 * MaterialFile。完整的材质（参数来自着色器反射、变体、实例参数）
 * 见 docs/architecture.md 的"外观：材质参数的分层"，等着色器系统一起做。和 Mesh 一样只是数据，GPU 资源由渲染特性管理。
 */
import { CEL_RAMP_STOPS, type AmbientOcclusionSlot, type CelShading, type ColorOperator, type MicrofacetModel, type TextureSampler } from '../../content/format';
import type { Branded } from '../../data/prop';
import { Color4, type ColorLike } from '../../data/vectors';
import { ResourceTable } from '../../engine/ResourceTable';
import type { Texture } from '../../graphics/Texture';

export type MaterialId = Branded<number, 'MaterialId'>;

export interface MaterialTexture {
  readonly texture: Texture;
  /** 采样坐标 = uv * scale + offset。 */
  readonly scale?: readonly [number, number];
  readonly offset?: readonly [number, number];
  /** 默认线性三线性过滤、重复寻址。 */
  readonly sampler?: TextureSampler;
}

/** 法线贴图（Stride 的 MaterialNormalMapFeature），各开关的意思见 content/format.ts 的 NormalMapSlot。 */
export interface MaterialNormalMap extends MaterialTexture {
  /** 把 0..1 映射到 -1..1，默认 true。 */
  readonly scaleAndBias?: boolean;
  /** 只用 xy，z 由单位长度算出，默认 true。 */
  readonly isXYNormal?: boolean;
  /** y 取反，默认 false（Stride 导入时按贴图的 InvertY 翻转绿色通道，管线把它记在这里）。 */
  readonly invertY?: boolean;
}

/** 环境光遮蔽，意思同 content/format.ts 的 AmbientOcclusionSlot。 */
export interface MaterialAmbientOcclusion extends Omit<AmbientOcclusionSlot, 'texture'> {
  readonly texture?: MaterialTexture & { readonly channel: 'r' | 'g' | 'b' | 'a' };
}

/** 透明混合（Stride 的 MaterialTransparencyBlendFeature），意思同 content/format.ts 的 TransparencyFile。 */
/**
 * 透明：可见的漫反射乘 alpha（输出的 alpha 也乘它），镜面乘 specularAlpha（默认同 alpha），都乘 tint（Stride 的
 * matDiffuseSpecularAlphaBlend 的两个分量）。
 */
export interface MaterialTransparency {
  readonly alpha: number;
  readonly specularAlpha?: number;
  readonly tint?: readonly [number, number, number];
  /** 阴影按 alpha 抖动（Stride 的 DitheredShadows），默认 true；false 时整块投，只丢掉 alpha 小于 0.1 的像素。 */
  readonly ditheredShadows?: boolean;
}

/**
 * 材质里编译成 WGSL 的颜色树（Stride 的 ComputeColor 树化不成"贴图乘颜色"时，比如有着色器类；见 colorTree.ts）。code 按有的树
 * 定义 `fn emissiveTree() -> vec4f`、`fn normalTree() -> vec4f`（片元着色器里算）、`fn displacementTree() -> f32`（顶点着色器里
 * 算），树里的贴图在绑定组 3。网格的着色器按 code 分变体。
 */
export interface MaterialShaderTrees {
  readonly code: string;
  readonly textures: readonly { readonly texture: Texture; readonly sampler: TextureSampler }[];
  /** 自发光：乘在颜色上的强度（Stride 的 Intensity），输出的 alpha 用自发光的 alpha（UseAlpha）。 */
  readonly emissive?: { readonly intensity: number; readonly useAlpha: boolean };
  /** 法线贴图：值是 0..1 要换到 -1..1（ScaleAndBias），只存了 xy、z 现算（IsXYNormal）。 */
  readonly normal?: { readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  /** 位移贴图：顶点沿模型空间的法线移动 值 × intensity（scaleAndBias 时值先换到 -1..1）。 */
  readonly displacement?: { readonly intensity: number; readonly scaleAndBias: boolean };
  /**
   * 材质层（content/format.ts 的 MaterialLayerFile）：第 i 层的函数是 layer{i}Blend，有哪个属性就有 layer{i}Diffuse、
   * layer{i}Specular、layer{i}Metalness、layer{i}Gloss、layer{i}Normal。
   */
  readonly layers?: readonly MaterialShaderLayer[];
  /**
   * 清漆（content/format.ts 的 ClearCoatFile）：code 里有 coatLodDistance、coatBaseDiffuse、coatBaseGloss、coatFlakesDiffuse、
   * coatFlakesGloss、coatFlakesMetalness、coatFlakesNormal、coatTopGloss、coatTopMetalness、coatTopNormal 这些函数。
   */
  readonly clearCoat?: MaterialShaderClearCoat;
}

/** 清漆各棵树的开关（函数在 MaterialShaderTrees.code 里）。 */
export interface MaterialShaderClearCoat {
  readonly baseInvert: boolean;
  readonly flakesInvert: boolean;
  readonly flakesNormal: { readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  readonly topInvert: boolean;
  readonly topNormal: { readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
}

/** 一个材质层有哪些属性（函数在 MaterialShaderTrees.code 里）。 */
export interface MaterialShaderLayer {
  readonly diffuse: boolean;
  readonly specular: boolean;
  readonly metalness: boolean;
  /** invert 时光泽度树存的是粗糙度。 */
  readonly glossiness?: { readonly invert: boolean };
  readonly normal?: { readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  readonly emissive: boolean;
  /** 这层有环境光遮蔽：直射光受它影响的程度。 */
  readonly occlusion?: { readonly directLighting: number };
}

export interface MaterialDesc {
  /** 线性空间的颜色，默认白色。 */
  readonly baseColor?: Readonly<ColorLike> | readonly [number, number, number, number?];
  readonly baseColorTexture?: MaterialTexture;
  /** 贴图和 baseColor 怎么组合，默认 multiply。 */
  readonly baseColorOperator?: ColorOperator;
  /** 金属度（0 到 1）；metalness、specular 都不给时材质没有镜面反射（Stride 里没有 Specular 特性的材质）。 */
  readonly metalness?: number;
  /** 镜面工作流的镜面颜色（线性，已乘强度）；给了就不看 metalness。 */
  readonly specular?: readonly [number, number, number];
  /** 镜面工作流的能量守恒（漫反射乘 1 - 镜面，Stride 的 IsEnergyConservative），默认 true。 */
  readonly specularEnergyConservative?: boolean;
  /** 画不画镜面反射（Stride 的 SpecularModel 有没有），默认 true；false 时金属度、镜面颜色只影响漫反射。 */
  readonly specularShading?: boolean;
  /** 微表面镜面模型的各项（意思同 content/format.ts 的 MicrofacetModel），默认是 Stride 默认的那套。 */
  readonly microfacet?: MicrofacetModel;
  /** 卡通着色（意思同 content/format.ts 的 CelShading；渐变用 CEL_DEFAULT_RAMP 这些现成的，或者自己给节点）。 */
  readonly celShading?: CelShading;
  /** 算不算漫反射光照（Stride 的 DiffuseModel 有没有），默认 true。 */
  readonly diffuseShading?: boolean;
  /** 玻璃（意思同 content/format.ts 的 MaterialFile.glass）；有它的材质画在透明阶段。 */
  readonly glass?: { readonly refractiveIndex: number };
  /** 粗糙度 = 1 - 光泽度，默认 1。 */
  readonly roughness?: number;
  /** 光泽度贴图（意思同 content/format.ts 的 glossinessTexture）；有它时不看 roughness。 */
  readonly glossinessMap?: MaterialTexture & { readonly channel: 'r' | 'g' | 'b' | 'a'; readonly invert: boolean; readonly metalnessChannel?: 'r' | 'g' | 'b' | 'a' };
  /** 自发光，线性颜色乘强度，默认没有；有 emissiveTexture 时再乘贴图的颜色。 */
  readonly emissive?: readonly [number, number, number];
  readonly emissiveTexture?: MaterialTexture;
  /** 编译好的颜色树（自发光、法线贴图、位移贴图）；有自发光树时不看 emissive、emissiveTexture。 */
  readonly shaderTrees?: MaterialShaderTrees;
  /** 两面都画（Stride 的 CullMode 是 None），默认只画正面。 */
  readonly doubleSided?: boolean;
  /** 环境光遮蔽，默认没有遮蔽。 */
  readonly ambientOcclusion?: MaterialAmbientOcclusion;
  /** 透明混合；有它的材质画在透明阶段（不写深度、从远到近）。 */
  readonly transparency?: MaterialTransparency;
  /**
   * Alpha 裁剪（Stride 的 MaterialTransparencyCutoffFeature）：基础色的 alpha 低于它的像素丢掉，深度预通道和阴影里也丢；
   * 材质仍画在不透明阶段。默认没有。
   */
  readonly alphaCutoff?: number;
  /** cavity：可见的漫反射、镜面分别乘的系数，默认 1。 */
  readonly cavity?: { readonly diffuse: number; readonly specular: number };
  /** 法线贴图；用它的网格要有切线（资源管线给这样的网格生成 MikkTSpace 切线）。 */
  readonly normalMap?: MaterialNormalMap;
  /** 次表面散射（Stride 的 MaterialSubsurfaceScatteringFeature），默认没有；没写的字段用 Stride 皮肤的默认值。 */
  readonly subsurfaceScattering?: Partial<MaterialSubsurfaceScattering>;
  /** 光泽（布料、天鹅绒），默认没有。 */
  readonly sheen?: MaterialSheen;
  /** 各向异性（拉丝金属、头发），默认没有。 */
  readonly anisotropy?: MaterialAnisotropy;
}

/**
 * 光泽（Stride 没有；glTF 的 KHR_materials_sheen，着色照 Filament）：表面上一层朝外的细绒毛，掠射角上亮一圈，布料、天鹅绒、
 * 桃子皮这一类。Charlie 分布加 Neubelt 可见性；底下那层按光泽反射走的能量变暗。
 */
export interface MaterialSheen {
  /** 光泽的颜色（线性，0 到 1）；全 0 是没有。 */
  readonly color: readonly [number, number, number];
  /** 光泽的粗糙度（0 到 1，感知的）。 */
  readonly roughness: number;
}

/**
 * 各向异性（Stride 没有；glTF 的 KHR_materials_anisotropy，着色照 Filament）：高光沿一个方向拉长，拉丝金属、头发、光盘。
 * 方向是网格的切线（没有切线的网格按贴图坐标的导数算），绕法线转 rotation。
 */
export interface MaterialAnisotropy {
  /** -1 到 1：正的沿切线方向拉长，负的沿副切线方向，0 是没有。 */
  readonly strength: number;
  /** 方向绕法线转的角度（弧度）。 */
  readonly rotation?: number;
}

/**
 * 次表面散射（Stride 的 MaterialSubsurfaceScatteringFeature 和它的皮肤散射核）：光从表面进去、在里面散开、从旁边出来，
 * 皮肤、蜡、玉石这类东西的漫反射看起来柔和。着色后在屏幕空间按 Jimenez 的可分离核横竖各模糊一遍（SubsurfaceScattering.ts）。
 */
export interface MaterialSubsurfaceScattering {
  /** 光散开多远（世界单位，米），Stride 默认 0.015。 */
  readonly width: number;
  /** 透光的程度（0 到 1），乘在模糊的步长上，Stride 默认 0.83。 */
  readonly translucency: number;
  /** 每个颜色通道散开的比例（0 到 1），Stride 皮肤的默认 (0.48, 0.41, 0.28)。 */
  readonly strength: readonly [number, number, number];
  /** 每个颜色通道散开的距离（相对 width），Stride 皮肤的默认 (1, 0.37, 0.3)：红光走得最远。 */
  readonly falloff: readonly [number, number, number];
}

/** Stride 皮肤的默认值（MaterialSubsurfaceScatteringFeature、MaterialSubsurfaceScatteringScatteringKernelSkin）。 */
export const SKIN_SUBSURFACE_SCATTERING: MaterialSubsurfaceScattering = { width: 0.015, translucency: 0.83, strength: [0.48, 0.41, 0.28], falloff: [1, 0.37, 0.3] };

const materials = new ResourceTable<Material>();

export class Material {
  /** 从 1 开始；Model 组件的 material 列存它。 */
  readonly id: MaterialId;
  readonly name: string;
  readonly baseColor: Color4;
  readonly baseColorTexture: Required<MaterialTexture> | undefined;
  readonly baseColorOperator: ColorOperator;
  readonly metalness: number | undefined;
  readonly specular: readonly [number, number, number] | undefined;
  readonly specularEnergyConservative: boolean;
  readonly specularShading: boolean;
  readonly microfacet: Required<MicrofacetModel>;
  readonly celShading: CelShading | undefined;
  readonly diffuseShading: boolean;
  readonly glass: { readonly refractiveIndex: number } | undefined;
  readonly roughness: number;
  readonly glossinessMap: Required<MaterialTexture> & { readonly channel: 'r' | 'g' | 'b' | 'a'; readonly invert: boolean; readonly metalnessChannel?: 'r' | 'g' | 'b' | 'a' } | undefined;
  readonly emissive: readonly [number, number, number];
  readonly emissiveTexture: Required<MaterialTexture> | undefined;
  readonly shaderTrees: MaterialShaderTrees | undefined;
  readonly doubleSided: boolean;
  readonly ambientOcclusion: { readonly value: number; readonly texture: Required<MaterialTexture> & { readonly channel: 'r' | 'g' | 'b' | 'a' } | undefined; readonly directLighting: number };
  readonly transparency: Required<MaterialTransparency> | undefined;
  readonly alphaCutoff: number | undefined;
  readonly cavity: { readonly diffuse: number; readonly specular: number };
  readonly normalMap: Required<MaterialNormalMap> | undefined;
  /** 次表面散射；改它用 setSubsurfaceScattering。 */
  subsurfaceScattering: MaterialSubsurfaceScattering | undefined;
  /** 光泽、各向异性；改它们用 setSheen、setAnisotropy。 */
  sheen: MaterialSheen | undefined;
  anisotropy: Required<MaterialAnisotropy> | undefined;
  /** 改了参数要递增，渲染特性据此重新上传。 */
  version = 0;

  constructor(name: string, desc: MaterialDesc = {}) {
    const { baseColor = [1, 1, 1, 1], baseColorTexture } = desc;
    this.name = name;
    this.baseColor = Array.isArray(baseColor)
      ? new Color4(baseColor[0], baseColor[1], baseColor[2], baseColor[3] ?? 1)
      : new Color4().copy(baseColor as ColorLike);
    this.baseColorTexture = baseColorTexture && withTransform(baseColorTexture);
    this.baseColorOperator = desc.baseColorOperator ?? 'multiply';
    this.metalness = desc.metalness;
    this.specular = desc.specular;
    this.specularEnergyConservative = desc.specularEnergyConservative ?? true;
    this.specularShading = desc.specularShading ?? true;
    this.microfacet = { fresnel: 'schlick', distribution: 'ggx', visibility: 'smithSchlickGGX', environment: 'lut', ...desc.microfacet };
    for (const ramp of [desc.celShading?.diffuse?.ramp, desc.celShading?.specular?.ramp]) {
      if (ramp && (ramp.length === 0 || ramp.length > CEL_RAMP_STOPS)) throw new Error(`Material ${name}: a cel shading ramp needs 1 to ${CEL_RAMP_STOPS} stops, got ${ramp.length}`);
    }
    this.celShading = desc.celShading;
    this.diffuseShading = desc.diffuseShading ?? true;
    this.glass = desc.glass;
    this.roughness = desc.roughness ?? 1;
    const gloss = desc.glossinessMap;
    this.glossinessMap = gloss && { ...withTransform(gloss), channel: gloss.channel, invert: gloss.invert, ...(gloss.metalnessChannel ? { metalnessChannel: gloss.metalnessChannel } : {}) };
    this.emissive = desc.emissive ?? [0, 0, 0];
    this.emissiveTexture = desc.emissiveTexture && withTransform(desc.emissiveTexture);
    this.shaderTrees = desc.shaderTrees;
    this.doubleSided = desc.doubleSided ?? false;
    const occlusion = desc.ambientOcclusion;
    this.ambientOcclusion = {
      value: occlusion?.value ?? 1,
      texture: occlusion?.texture && { ...withTransform(occlusion.texture), channel: occlusion.texture.channel },
      directLighting: occlusion?.directLighting ?? 0,
    };
    const transparency = desc.transparency;
    this.transparency = transparency && { alpha: transparency.alpha, specularAlpha: transparency.specularAlpha ?? transparency.alpha, tint: transparency.tint ?? [1, 1, 1], ditheredShadows: transparency.ditheredShadows ?? true };
    this.alphaCutoff = desc.alphaCutoff;
    this.cavity = desc.cavity ?? { diffuse: 1, specular: 1 };
    const normalMap = desc.normalMap;
    this.normalMap = normalMap && {
      ...withTransform(normalMap),
      scaleAndBias: normalMap.scaleAndBias ?? true,
      isXYNormal: normalMap.isXYNormal ?? true,
      invertY: normalMap.invertY ?? false,
    };
    this.subsurfaceScattering = desc.subsurfaceScattering && { ...SKIN_SUBSURFACE_SCATTERING, ...desc.subsurfaceScattering };
    this.sheen = desc.sheen;
    this.anisotropy = desc.anisotropy && { rotation: 0, ...desc.anisotropy };
    this.id = materials.add(this) as MaterialId;
  }

  /** 加上、改掉或去掉光泽，并让渲染特性重新上传。 */
  setSheen(value: MaterialSheen | undefined): void {
    this.sheen = value;
    this.version++;
  }

  /** 加上、改掉或去掉各向异性，并让渲染特性重新上传。 */
  setAnisotropy(value: MaterialAnisotropy | undefined): void {
    this.anisotropy = value && { rotation: 0, ...value };
    this.version++;
  }

  /** 加上、改掉或去掉次表面散射（没写的字段用 Stride 皮肤的默认值），并让渲染特性重新上传。 */
  setSubsurfaceScattering(value: Partial<MaterialSubsurfaceScattering> | undefined): void {
    this.subsurfaceScattering = value && { ...SKIN_SUBSURFACE_SCATTERING, ...value };
    this.version++;
  }

  /** 改基础色并让渲染特性重新上传。 */
  setBaseColor(color: Readonly<ColorLike>): void {
    this.baseColor.copy(color);
    this.version++;
  }

  /** 有清漆：不透明阶段画底下一遍，透明阶段再叠一遍清漆。 */
  get hasClearCoat(): boolean {
    return this.shaderTrees?.clearCoat !== undefined;
  }

  /** 透明混合和玻璃的材质画在透明阶段。 */
  get isTransparent(): boolean {
    return this.transparency !== undefined || this.glass !== undefined;
  }

  /**
   * 只写深度的阶段（阴影投射、深度预通道）用的片元着色器，undefined 是不要片元着色器（整块写深度）。同 Stride：Alpha 裁剪的丢掉
   * 被裁的像素；透明混合的按 alpha 抖动着投阴影（ditheredShadows 关了时丢掉 alpha 小于 0.1 的）；只有玻璃的照不透明的投。
   */
  get depthFragment(): 'fsCutout' | 'fsDitheredShadow' | undefined {
    if (this.alphaCutoff !== undefined) return 'fsCutout';
    if (!this.transparency) return undefined;
    return this.transparency.ditheredShadows ? 'fsDitheredShadow' : 'fsCutout';
  }

  /** @internal Model 组件里存的 id 对应的材质。 */
  static byId(id: number): Material | undefined {
    return materials.get(id);
  }
}

/** 贴图槽补上默认的 uv 变换和采样器。 */
function withTransform({ texture, scale = [1, 1], offset = [0, 0], sampler = {} }: MaterialTexture): Required<MaterialTexture> {
  return { texture, scale, offset, sampler };
}
