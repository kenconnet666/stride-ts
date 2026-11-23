/** 没有手写描述的值的字段：按值推（inferFields）、按脚本的 prop 声明换（scriptFields）。 */
import type { SceneScriptValue } from '../../content/formats/format';
import type { AssetKind } from '../../content/references';
import type { PropOptions } from '../../data/prop';
import type { ScriptConstructor } from '../../engine/scripts';
import { number, bool, string, vector, rotation, list, object, type FieldType, type Field } from '../../content/schema/builders.ts';

/**
 * 按值推出字段（游戏自己的渲染器、没有声明的脚本属性：代码里没有字段描述，文件里的值就是全部信息）：资源引用
 * `{ $asset, kind }` 是资源，`{ $entity }` 是实体，数、布尔、文字照原样，两到四个数的数组是向量，对象逐个推，别的（null、
 * 混着的数组）按 JSON 改。
 */
export function inferFields(values: Readonly<Record<string, SceneScriptValue>>): Field[] {
  return Object.entries(values).map(([name, value]) => ({ name, type: inferType(value) }));
}

function inferType(value: SceneScriptValue): FieldType {
  if (typeof value === 'number') return number();
  if (typeof value === 'boolean') return bool;
  if (typeof value === 'string') return string;
  if (Array.isArray(value)) return value.length >= 2 && value.length <= 4 && value.every((item) => typeof item === 'number') ? vector(value.length as 2 | 3 | 4) : { kind: 'json' };
  if (value === null || typeof value !== 'object') return { kind: 'json' };
  if ('$asset' in value && typeof value.kind === 'string') {
    const kind = value.kind as string;
    return { kind: 'asset', asset: (kind === 'uiPage' || kind === 'uiLibrary' ? 'ui' : kind) as AssetKind, form: 'ref', refKind: kind };
  }
  if ('$entity' in value) return { kind: 'entity', form: 'ref' };
  return object(inferFields(value as Readonly<Record<string, SceneScriptValue>>));
}

const INTEGER_KINDS: ReadonlySet<string> = new Set(['int', 'u8', 'u32']);

/** 脚本属性的声明（prop 的选项）换成字段的类型。脚本属性里对实体、资源的引用在文件里是 `{ $entity }`、`{ $asset, kind }`。 */
function propType(options: PropOptions): FieldType {
  const { kind } = options;
  if (kind === 'number' || kind === 'f32' || INTEGER_KINDS.has(kind)) {
    return {
      kind: 'number',
      ...(INTEGER_KINDS.has(kind) ? { integer: true } : {}),
      ...(options.min !== undefined ? { min: options.min } : {}), ...(options.max !== undefined ? { max: options.max } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}), ...(options.unit !== undefined ? { unit: options.unit } : {}),
    };
  }
  if (kind === 'bool') return bool;
  if (kind === 'string') return string;
  if (kind === 'enum') return { kind: 'enum', values: options.values ?? [] };
  if (kind === 'vec3') return vector(3, options.unit);
  if (kind === 'quat') return rotation;
  if (kind === 'color') return { kind: 'color', alpha: true, space: 'linear' };
  if (kind === 'entity' || kind === 'component') return { kind: 'entity', form: 'ref' };
  if (kind === 'asset') {
    const refKind = options.assetKind ?? '';
    return { kind: 'asset', asset: (refKind === 'uiPage' || refKind === 'uiLibrary' ? 'ui' : refKind) as AssetKind, form: 'ref', refKind };
  }
  if (kind === 'list' && options.item) return list(propType(options.item.options));
  if (kind === 'object' && options.shape) return object(shapeFields(options.shape));
  if (kind === 'union' && options.variants && options.discriminator) {
    return { kind: 'union', tag: options.discriminator, variants: Object.fromEntries(Object.entries(options.variants).map(([name, shape]) => [name, shapeFields(shape)])) };
  }
  return { kind: 'json' };
}

/** 嵌套的 shape（prop.object、prop.union）里的字段；字面量是"这个类型、这个默认值"的简写。 */
function shapeFields(shape: Readonly<Record<string, unknown>>): Field[] {
  return Object.entries(shape).map(([name, value]) => {
    const options = (value as { options?: PropOptions } | null)?.options;
    if (options) return propField(name, options);
    const type: FieldType = typeof value === 'number' ? number() : typeof value === 'boolean' ? bool : string;
    return { name, type, optional: true, default: value };
  });
}

function propField(name: string, options: PropOptions): Field {
  return {
    name,
    type: propType(options),
    ...(options.hasDefault ? { optional: true, default: options.defaultValue } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.group !== undefined ? { group: options.group } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
}

/** 一个脚本类能在面板上改的属性（`props` 里的字段）：运行时状态（transient）、受管的（sealed）、藏起来的（hidden）不算。 */
export function scriptFields(script: ScriptConstructor): Field[] {
  return script.schema.fields
    .filter(({ options }) => !options.transient && !options.sealed && !options.hidden)
    .map(({ name, options }) => propField(name, options));
}

