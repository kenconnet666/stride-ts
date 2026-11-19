/**
 * 材质，和 Stride 默认的 PBR 材质对应：漫反射颜色（可以带一张贴图，按运算符和颜色组合，即 Stride 材质里最常见的
 * ComputeTextureColor、ComputeBinaryColor 的形状）、金属度或镜面颜色工作流的镜面反射（GGX、Schlick、Smith-Schlick-GGX）、
 * 光泽度、自发光（可以乘一张贴图，或者是编译好的颜色树）、环境光遮蔽（可以是贴图）、cavity、法线贴图和透明混合，见 content/format.ts 的
 * MaterialFile。完整的材质（参数来自着色器反射、变体、实例参数）
 * 见 docs/architecture.md 的"外观：材质参数的分层"，等着色器系统一起做。和 Mesh 一样只是数据，GPU 资源由渲染特性管理。
 */
import type { AmbientOcclusionSlot, ColorOperator, TextureSampler } from '../content/format';
import type { Branded } from '../data/prop';
import { Color4, type ColorLike } from '../mathematics/vectors';
import { ResourceTable } from '../engine/ResourceTable';
import type { Texture } from './Texture';

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
  /** 粗糙度 = 1 - 光泽度，默认 1。 */
  readonly roughness?: number;
  /** 光泽度贴图（意思同 content/format.ts 的 glossinessTexture）；有它时不看 roughness。 */
  readonly glossinessMap?: MaterialTexture & { readonly channel: 'r' | 'g' | 'b' | 'a'; readonly invert: boolean };
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
}

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
  readonly roughness: number;
  readonly glossinessMap: Required<MaterialTexture> & { readonly channel: 'r' | 'g' | 'b' | 'a'; readonly invert: boolean } | undefined;
  readonly emissive: readonly [number, number, number];
  readonly emissiveTexture: Required<MaterialTexture> | undefined;
  readonly shaderTrees: MaterialShaderTrees | undefined;
  readonly doubleSided: boolean;
  readonly ambientOcclusion: { readonly value: number; readonly texture: Required<MaterialTexture> & { readonly channel: 'r' | 'g' | 'b' | 'a' } | undefined; readonly directLighting: number };
  readonly transparency: Required<MaterialTransparency> | undefined;
  readonly alphaCutoff: number | undefined;
  readonly cavity: { readonly diffuse: number; readonly specular: number };
  readonly normalMap: Required<MaterialNormalMap> | undefined;
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
    this.roughness = desc.roughness ?? 1;
    const gloss = desc.glossinessMap;
    this.glossinessMap = gloss && { ...withTransform(gloss), channel: gloss.channel, invert: gloss.invert };
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
    this.transparency = transparency && { alpha: transparency.alpha, specularAlpha: transparency.specularAlpha ?? transparency.alpha, tint: transparency.tint ?? [1, 1, 1] };
    this.alphaCutoff = desc.alphaCutoff;
    this.cavity = desc.cavity ?? { diffuse: 1, specular: 1 };
    const normalMap = desc.normalMap;
    this.normalMap = normalMap && {
      ...withTransform(normalMap),
      scaleAndBias: normalMap.scaleAndBias ?? true,
      isXYNormal: normalMap.isXYNormal ?? true,
      invertY: normalMap.invertY ?? false,
    };
    this.id = materials.add(this) as MaterialId;
  }

  /** 改基础色并让渲染特性重新上传。 */
  setBaseColor(color: Readonly<ColorLike>): void {
    this.baseColor.copy(color);
    this.version++;
  }

  /** 透明材质画在透明阶段。 */
  get isTransparent(): boolean {
    return this.transparency !== undefined;
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
