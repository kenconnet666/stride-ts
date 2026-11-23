/** 字段描述的种类（FieldType、Field）和写描述用的小函数，同目录的各份描述共用。 */
import { TEXTURE_EXTENSIONS, type TextureEncoding, type TextureRef } from '../formats/assetFormat.ts';
import type { AssetKind } from '../references';

export type FieldType =
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number; readonly unit?: string; readonly integer?: boolean }
  | { readonly kind: 'bool' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** 几个数的数组。 */
  | { readonly kind: 'vector'; readonly size: 2 | 3 | 4; readonly unit?: string }
  /** 四元数 [x, y, z, w]；面板上按欧拉角改。 */
  | { readonly kind: 'rotation' }
  /** 颜色：3 个或 4 个数（alpha）；space 是文件里存的是哪种（面板的取色器是 sRGB 的）。 */
  | { readonly kind: 'color'; readonly alpha: boolean; readonly space: 'srgb' | 'linear' }
  /** 一个资源。form 是文件里怎么写：path 是内容路径的字符串，ref 是脚本属性的 `{ $asset, kind }`（refKind 是其中的 kind）。 */
  | { readonly kind: 'asset'; readonly asset: AssetKind; readonly form: 'path' | 'ref'; readonly refKind?: string }
  /** 场景里的一个实体。form：id 是实体 id 的字符串，ref 是脚本属性的 `{ $entity }`。 */
  | { readonly kind: 'entity'; readonly form: 'id' | 'ref' }
  /** nullableItems：列表里可以有 null（模型的材质槽：null 是用模型自带的）。 */
  | { readonly kind: 'list'; readonly item: FieldType; readonly nullableItems?: boolean }
  | { readonly kind: 'object'; readonly fields: readonly Field[] }
  /** 几种形状之一，tag 那个字段的值说是哪种；common 是每种都有的字段。 */
  | { readonly kind: 'union'; readonly tag: string; readonly variants: Readonly<Record<string, readonly Field[]>>; readonly common?: readonly Field[] }
  /**
   * 形状由代码定、文件里写全了的一组值（游戏自己的根渲染器的属性、约束的设置）：字段就是值里现在的那些键，种类按值推
   * （inferFields）；checkFields 只查它是对象。
   */
  | { readonly kind: 'record' }
  /** 还没有描述（粒子的模块）：面板按原样的 JSON 改，checkFields 不看里面。 */
  | { readonly kind: 'json' };

export interface Field {
  readonly name: string;
  readonly type: FieldType;
  /** 文件里可以不写；不写时用 default（没有 default 的就是"没设"）。 */
  readonly optional?: boolean;
  /** 可以是 null（没指定）。 */
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
}

/** 一个字段怎么写：只有类型，或者带上可不可以不写这些。 */
export type FieldSpec = FieldType | (Omit<Field, 'name' | 'type'> & { readonly type: FieldType });

/** 照着文件格式的类型 T 写它的字段：T 的每个字段都要写到，写了 T 没有的也报错。 */
export function fields<T>(spec: { readonly [K in keyof Required<T>]: FieldSpec }): Field[] {
  return Object.entries<FieldSpec>(spec).map(([name, value]) => ('kind' in value ? { name, type: value } : { name, ...value }));
}

export const number = (options: Omit<Extract<FieldType, { kind: 'number' }>, 'kind'> = {}): FieldType => ({ kind: 'number', ...options });
export const integer = (min?: number, max?: number): FieldType => ({ kind: 'number', integer: true, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
export const bool: FieldType = { kind: 'bool' };
export const string: FieldType = { kind: 'string' };
export const oneOf = (...values: string[]): FieldType => ({ kind: 'enum', values });
export const vector = (size: 2 | 3 | 4, unit?: string): FieldType => ({ kind: 'vector', size, ...(unit !== undefined ? { unit } : {}) });
export const rotation: FieldType = { kind: 'rotation' };
export const asset = (kind: AssetKind): FieldType => ({ kind: 'asset', asset: kind, form: 'path' });
export const entity: FieldType = { kind: 'entity', form: 'id' };
export const list = (item: FieldType): FieldType => ({ kind: 'list', item });
export const object = (of: readonly Field[]): FieldType => ({ kind: 'object', fields: of });
export const optional = (type: FieldType, fallback?: unknown): FieldSpec => ({ type, optional: true, ...(fallback !== undefined ? { default: fallback } : {}) });
export const nullable = (type: FieldType): FieldSpec => ({ type, nullable: true });

/** 一张贴图文件，或者（精灵、背景）一张渲染目标贴图。 */
export const textureRef = fields<TextureRef>({
  texture: asset('image'),
  encoding: optional(oneOf(...(Object.keys(TEXTURE_EXTENSIONS) as TextureEncoding[])), 'ktx2'),
  size: optional(vector(2, 'px')),
  srgb: optional(bool),
  invertY: optional(bool, false),
});
