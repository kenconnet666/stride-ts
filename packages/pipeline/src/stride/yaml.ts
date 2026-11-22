/**
 * 读 Stride 的 YAML 资源（.sdscene、.sdm3d、.sdmat、.sdprefab……），变成普通的 JS 对象：带标签的节点
 * （`!TransformComponent`、`!LightDirectional`）多一个 `$type` 字段，值是去掉 `!` 的类型名。
 *
 * Stride 用自己的 YAML 库（SharpYaml），允许标签里有逗号和方括号（`!Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics`），
 * 按 YAML 规范那是流式指示符，标准解析器会出错。所以解析前把标签里的 `,` `[` `]` 换成百分号编码（标签里允许），
 * 读出来再解码回去。
 * 派生资源（预制体的实例、模板）里改过的字段，键名后面带 `*`（覆盖标记，`Position*:`）：读的时候去掉，按原名访问。
 * 不带引号的标量按 YAML 的规则解析，`Text: 000` 读出来是数字 0；字段其实是字符串时用 scalarSource 取原文。
 */
import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';

export type StrideValue = string | number | boolean | null | StrideValue[] | StrideObject;
export interface StrideObject {
  readonly [key: string]: StrideValue | undefined;
  readonly $type?: string;
}

/** 映射里不带引号、解析成数字或布尔的值的原文（键 → 原文）；用 symbol 存在映射对象上，Object.entries 看不到。 */
const SOURCES = Symbol('sources');

/** 映射里 key 的值在文件里的原文（不带引号、读成数字或布尔的才有）。 */
export function scalarSource(object: StrideObject, key: string): string | undefined {
  return (object as { [SOURCES]?: Record<string, string> })[SOURCES]?.[key];
}

/**
 * 映射里 key 的文字：字符串照原样，不带引号的数字、布尔取文件里的原文（`Text: 000` 不变成 "0"），没有时是 fallback；
 * 是映射、列表时报错（不悄悄变成 "[object Object]"）。
 */
export function textField(object: StrideObject, key: string, fallback = ''): string {
  const value = object[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return scalarSource(object, key) ?? String(value);
  throw new Error(`${key}: expected text, got ${JSON.stringify(value)}`);
}

const TAG = /(^|[\s:-])!([^\s!][^\s]*)/gm;

function escapeTags(text: string): string {
  return text.replace(TAG, (_, before: string, tag: string) => `${before}!${tag.replace(/[,[\]]/g, (c) => encodeURIComponent(c))}`);
}

function typeOf(tag: string | undefined): string | undefined {
  if (tag === undefined || !tag.startsWith('!') || tag.startsWith('tag:yaml.org')) return undefined;
  return decodeURIComponent(tag.slice(1));
}

function convert(node: Node | null | undefined): StrideValue {
  if (node === null || node === undefined) return null;
  const type = typeOf(node.tag);
  if (isMap(node)) {
    const object: Record<string, StrideValue> & { [SOURCES]?: Record<string, string> } = type === undefined ? {} : { $type: type };
    for (const pair of node.items) {
      const rawKey = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const key = rawKey.endsWith('*') ? rawKey.slice(0, -1) : rawKey;
      const value = convert(pair.value as Node | null);
      object[key] = value;
      if ((typeof value === 'number' || typeof value === 'boolean') && isScalar(pair.value) && pair.value.source !== undefined) {
        (object[SOURCES] ??= {})[key] = pair.value.source;
      }
    }
    return object;
  }
  if (isSeq(node)) return node.items.map((item) => convert(item as Node | null));
  if (isScalar(node)) {
    const value = node.value as StrideValue;
    // 带标签的标量（`!dir ../Assets`）：保留类型
    return type === undefined ? value : ({ $type: type, value } as StrideObject);
  }
  return null;
}

/** 解析一份 Stride 资源；出错时报出文件名和第一个错误。 */
export function parseStrideYaml(text: string, source = 'asset'): StrideObject {
  const doc = parseDocument(escapeTags(text), { uniqueKeys: false });
  if (doc.errors.length > 0) throw new Error(`${source}: ${doc.errors[0]!.message}`);
  const value = convert(doc.contents as Node | null);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: expected a mapping at the top level`);
  return value as StrideObject;
}

/** `guid:url` 形式的资源引用；空引用（null 或空串）返回 undefined。 */
export function parseAssetReference(value: StrideValue | undefined): { readonly id: string; readonly url: string } | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const colon = value.indexOf(':');
  if (colon < 0) return undefined;
  return { id: value.slice(0, colon), url: value.slice(colon + 1) };
}

/** `ref!! guid` 形式的对象引用（场景里子实体的 Transform）。 */
export function parseObjectReference(value: StrideValue | undefined): string | undefined {
  return typeof value === 'string' && value.startsWith('ref!! ') ? value.slice('ref!! '.length) : undefined;
}

/** Stride 序列化字典时键写成 "<项的 id>~<键>"：取出真正的键（没有 ~ 时原样返回）。 */
export function dictionaryKey(key: string): string {
  return key.slice(key.indexOf('~') + 1);
}

/**
 * 属性名、类型名改成首字母小写（导出的键名和枚举值）。开头的缩写整个小写：UILibrary → uiLibrary、IMESelectionColor →
 * imeSelectionColor、URL → url（缩写后面的单词首字母保留大写）。
 */
export function lowerFirst(name: string): string {
  const run = /^[A-Z]+/.exec(name)?.[0].length ?? 0;
  const lower = run > 1 && run < name.length ? run - 1 : Math.max(run, 1);
  return name.slice(0, lower).toLowerCase() + name.slice(lower);
}

export function asObject(value: StrideValue | undefined): StrideObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

export function asNumber(value: StrideValue | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** sRGB 的一个通道换到线性空间。 */
export const srgbToLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

export function vec3(value: StrideValue | undefined, fallback: number, whole?: [number, number, number]): [number, number, number] {
  const v = asObject(value);
  if (!v && whole) return whole;
  return [asNumber(v?.['X'], fallback), asNumber(v?.['Y'], fallback), asNumber(v?.['Z'], fallback)];
}

export function color4(value: StrideValue | undefined): [number, number, number, number] {
  const c = asObject(value) ?? {};
  return [asNumber(c['R'], 1), asNumber(c['G'], 1), asNumber(c['B'], 1), asNumber(c['A'], 1)];
}

/** Color3（{R, G, B}，原样不换色彩空间）；没写的通道用 fallback 里的。 */
export function color3(value: StrideValue | undefined, fallback: readonly [number, number, number]): [number, number, number] {
  const c = asObject(value) ?? {};
  return [asNumber(c['R'], fallback[0]), asNumber(c['G'], fallback[1]), asNumber(c['B'], fallback[2])];
}

export function vec2(value: StrideValue | undefined, fallback: number): [number, number] {
  const v = asObject(value) ?? {};
  return [asNumber(v['X'], fallback), asNumber(v['Y'], fallback)];
}

export function quaternion(value: StrideValue | undefined): [number, number, number, number] {
  const q = asObject(value) ?? {};
  return [asNumber(q['X'], 0), asNumber(q['Y'], 0), asNumber(q['Z'], 0), asNumber(q['W'], 1)];
}

/** Stride 的颜色值是 sRGB：转成线性。 */
export function linearColor(value: StrideValue | undefined): [number, number, number, number] {
  const c = asObject(value) ?? {};
  return [srgbToLinear(asNumber(c['R'], 1)), srgbToLinear(asNumber(c['G'], 1)), srgbToLinear(asNumber(c['B'], 1)), asNumber(c['A'], 1)];
}

/** Stride 的 TimeSpan 写法（"d:hh:mm:ss.fffffff" 或 "hh:mm:ss.fffffff"）换成秒。 */
export function timeSpanSeconds(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const parts = value.split(':').map(Number);
  const [seconds = 0, minutes = 0, hours = 0, days = 0] = parts.reverse();
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}
