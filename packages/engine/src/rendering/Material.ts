/**
 * 材质，和 Stride 默认的 PBR 材质对应：漫反射颜色（可以带一张贴图，按运算符和颜色组合，即 Stride 材质里最常见的
 * ComputeTextureColor、ComputeBinaryColor 的形状）、金属度工作流的镜面反射（GGX、Schlick、Smith-Schlick-GGX）、
 * 光泽度、自发光和 cavity，见 content/format.ts 的 MaterialFile。完整的材质（参数来自着色器反射、变体、实例参数）
 * 见 docs/architecture.md 的"外观：材质参数的分层"，等着色器系统一起做。和 Mesh 一样只是数据，GPU 资源由渲染特性管理。
 */
import type { ColorOperator } from '../content/format';
import type { Branded } from '../data/prop';
import { Color4, type ColorLike } from '../mathematics/vectors';
import { ResourceTable } from './ResourceTable';
import type { Texture } from './Texture';

export type MaterialId = Branded<number, 'MaterialId'>;

export interface MaterialTexture {
  readonly texture: Texture;
  /** 采样坐标 = uv * scale + offset。 */
  readonly scale?: readonly [number, number];
  readonly offset?: readonly [number, number];
}

export interface MaterialDesc {
  /** 线性空间的颜色，默认白色。 */
  readonly baseColor?: Readonly<ColorLike> | readonly [number, number, number, number?];
  readonly baseColorTexture?: MaterialTexture;
  /** 贴图和 baseColor 怎么组合，默认 multiply。 */
  readonly baseColorOperator?: ColorOperator;
  /** 金属度（0 到 1）；不给时材质没有镜面反射（Stride 里没有 Specular 特性的材质）。 */
  readonly metalness?: number;
  /** 粗糙度 = 1 - 光泽度，默认 1。 */
  readonly roughness?: number;
  /** 自发光，线性颜色乘强度，默认没有。 */
  readonly emissive?: readonly [number, number, number];
  /** cavity：可见的漫反射、镜面分别乘的系数，默认 1。 */
  readonly cavity?: { readonly diffuse: number; readonly specular: number };
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
  readonly roughness: number;
  readonly emissive: readonly [number, number, number];
  readonly cavity: { readonly diffuse: number; readonly specular: number };
  /** 改了参数要递增，渲染特性据此重新上传。 */
  version = 0;

  constructor(name: string, desc: MaterialDesc = {}) {
    const { baseColor = [1, 1, 1, 1], baseColorTexture } = desc;
    this.name = name;
    this.baseColor = Array.isArray(baseColor)
      ? new Color4(baseColor[0], baseColor[1], baseColor[2], baseColor[3] ?? 1)
      : new Color4().copy(baseColor as ColorLike);
    this.baseColorTexture = baseColorTexture && { texture: baseColorTexture.texture, scale: baseColorTexture.scale ?? [1, 1], offset: baseColorTexture.offset ?? [0, 0] };
    this.baseColorOperator = desc.baseColorOperator ?? 'multiply';
    this.metalness = desc.metalness;
    this.roughness = desc.roughness ?? 1;
    this.emissive = desc.emissive ?? [0, 0, 0];
    this.cavity = desc.cavity ?? { diffuse: 1, specular: 1 };
    this.id = materials.add(this) as MaterialId;
  }

  /** 改基础色并让渲染特性重新上传。 */
  setBaseColor(color: Readonly<ColorLike>): void {
    this.baseColor.copy(color);
    this.version++;
  }

  /** @internal Model 组件里存的 id 对应的材质。 */
  static byId(id: number): Material | undefined {
    return materials.get(id);
  }
}
