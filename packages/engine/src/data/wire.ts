/**
 * typed JSON：bigint、小数、日期、时间、时刻、字节这类 JSON 装不下（或 JS 读了会丢精度）的值写成文字，
 * 根对象上的 `$types` 记下它们的位置和种类，读的一方据此还原。场景文件、编辑器和 Node 后端之间的消息都用它。
 *
 * 格式和 json-wire（~\IdeaProjects\json-wire，docs/format.md）一致，能和用它的 Java、TS 后端互通；
 * 实现是自己的、零依赖，值还原成本引擎的类型（Decimal、LocalDate、LocalTime、LocalDateTime、Instant）：
 *
 *   toWire({ id: 9007199254740993n, price: Decimal.parse('12.50'), on: LocalDate.of(2024, 1, 31) })
 *   // { id: "9007199254740993", price: "12.50", on: "2024-01-31", $types: { id: "bigint", price: "decimal", on: "date" } }
 *
 * 规则（同 json-wire）：路径从根开始用点连接属性名，数组不占一段；属性名里的 `~`、`.` 写成 `~0`、`~1`；
 * 同一路径只能有一种值；根不是对象时包成 `{ "$value": 根, "$types": … }`；`$types`、`$value` 在根上是保留的键。
 */
import { Decimal } from './Decimal';
import { Instant, LocalDate, LocalDateTime, LocalTime } from './temporal';

/** 要还原的值的种类，和 json-wire 是同一套词。 */
export type WireType = 'bigint' | 'decimal' | 'double' | 'date' | 'time' | 'timestamp' | 'timestamptz' | 'bytes';

/** JSON 能装的值。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** `$types` 标出的文字还原成什么；默认是 parseWire。要别的类型时包一层，只换自己关心的种类。 */
export type WireReader = (kind: WireType, text: string) => unknown;

const TYPES = '$types';
const VALUE = '$value';
const WIRE_TYPES = new Set<string>(['bigint', 'decimal', 'double', 'date', 'time', 'timestamp', 'timestamptz', 'bytes']);

/** 值要还原成哪一种；JSON 能原样装的值（文字、布尔、有限的数、null）是 undefined。 */
export function wireTypeOf(value: unknown): WireType | undefined {
  switch (typeof value) {
    case 'bigint':
      return 'bigint';
    case 'number':
      return Number.isFinite(value) ? undefined : 'double';
    case 'object':
      if (value instanceof Decimal) return 'decimal';
      if (value instanceof LocalDate) return 'date';
      if (value instanceof LocalTime) return 'time';
      if (value instanceof LocalDateTime) return 'timestamp';
      if (value instanceof Instant || value instanceof Date) return 'timestamptz';
      if (value instanceof Uint8Array) return 'bytes';
      return undefined;
    default:
      return undefined;
  }
}

/** 单个值写成线上的文字：小数不用科学计数法，日期时间是 ISO 写法，时刻换算成 UTC，字节是 base64。 */
export function wireText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date) return Instant.fromDate(value).toString();
  if (value instanceof Uint8Array) return encodeBase64(value);
  // wireTypeOf 认出来的（Decimal、日期时间、bigint）都有自己的 toString
  // oxlint-disable-next-line typescript/no-base-to-string
  if (wireTypeOf(value) !== undefined) return String(value);
  throw new TypeError(`wireText: ${describe(value)} is not a single value`);
}

/** 读线上的文字，还原成这个种类的值；读不出时抛错。 */
export function parseWire(kind: WireType, text: string): unknown {
  switch (kind) {
    case 'bigint':
      if (!/^[+-]?\d+$/.test(text.trim())) throw new SyntaxError(`'${text}' is not an integer`);
      return BigInt(text.trim());
    case 'decimal':
      return Decimal.parse(text);
    case 'double': {
      const special = { NaN: Number.NaN, Infinity: Number.POSITIVE_INFINITY, '-Infinity': Number.NEGATIVE_INFINITY }[text.trim()];
      if (special !== undefined) return special;
      const value = Number(text);
      if (text.trim() === '' || Number.isNaN(value)) throw new SyntaxError(`'${text}' is not a number`);
      return value;
    }
    case 'date':
      return LocalDate.parse(text);
    case 'time':
      return LocalTime.parse(text);
    case 'timestamp':
      return LocalDateTime.parse(text);
    case 'timestamptz':
      return Instant.parse(text);
    case 'bytes':
      return decodeBase64(text);
  }
}

/**
 * 把值写成线上的 JSON；没有要还原的值时结果就是普通 JSON。对象取自身可枚举的属性（undefined 和函数跳过），
 * 有 toJSON 的先调用它（本引擎的值类型除外，它们按种类写），Map 写成对象，Set 写成数组。循环引用报错。
 */
export function toWire(value: unknown): Json {
  if (isRecord(value) && (Object.hasOwn(value, TYPES) || Object.hasOwn(value, VALUE))) {
    throw new TypeError(`toWire: ${TYPES} and ${VALUE} are reserved on the root object`);
  }
  const found = new Map<string, WireType | 'text'>();
  const json = encode(value, '', found, new Set());
  const types: Record<string, WireType> = {};
  for (const [path, type] of found) if (type !== 'text') types[path] = type;
  if (Object.keys(types).length === 0) return json;
  if (isRecord(json)) return { ...json, [TYPES]: types };
  const wrapped: Record<string, WireType> = {};
  for (const [path, type] of Object.entries(types)) wrapped[path === '' ? VALUE : `${VALUE}.${path}`] = type;
  return { [VALUE]: json, [TYPES]: wrapped };
}

/**
 * 读线上的 JSON：按根上的 `$types` 把文字还原成值，去掉 `$types`（`{ $value, $types }` 拆成里面的值）。
 * 就地改写传入的对象，通常它刚由 JSON.parse 得到。路径上的值是 null 或已经不是文字时跳过；读不出时报错并带上路径。
 */
export function fromWire<T = unknown>(json: unknown, reader: WireReader = parseWire): T {
  if (!isRecord(json) || !Object.hasOwn(json, TYPES)) return json as T;
  const types = json[TYPES];
  if (!isRecord(types)) throw new TypeError(`fromWire: ${TYPES} must be an object of path → type`);
  delete json[TYPES];
  for (const [path, type] of Object.entries(types)) {
    if (typeof type !== 'string' || !WIRE_TYPES.has(type)) throw new TypeError(`fromWire: unknown type ${String(type)} at ${path}`);
    const steps = path.split('.').map(unescape);
    try {
      revive(json, steps[0]!, steps.slice(1), type as WireType, reader);
    } catch (error) {
      throw new TypeError(`fromWire: ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const keys = Object.keys(json);
  return (keys.length === 1 && keys[0] === VALUE ? json[VALUE] : json) as T;
}

/** `JSON.stringify(toWire(value))`。 */
export function stringifyWire(value: unknown, indent?: number): string {
  return JSON.stringify(toWire(value), null, indent);
}

/** `fromWire(JSON.parse(text))`。 */
export function parseWireJson<T = unknown>(text: string, reader?: WireReader): T {
  return fromWire<T>(JSON.parse(text), reader);
}

function encode(value: unknown, path: string, found: Map<string, WireType | 'text'>, seen: Set<object>): Json {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      note(found, path, 'text');
      return value;
    case 'boolean':
      return value;
    case 'number':
      if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
      break;
    case 'function':
    case 'symbol':
      return null;
    default:
      // 对象、bigint 往下按单值的类型、数组、记录处理
      break;
  }
  const type = wireTypeOf(value);
  if (type !== undefined) {
    note(found, path, type);
    // oxlint-disable-next-line typescript/no-base-to-string -- double 是 Decimal，toString 是它的文字
    return type === 'double' ? String(value) : wireText(value);
  }
  const object = value as object;
  if (seen.has(object)) throw new TypeError(`toWire: ${path || 'the root'} refers back to itself`);
  seen.add(object);
  try {
    if (Array.isArray(object) || object instanceof Set) return [...object].map((item) => encode(item, path, found, seen));
    if (typeof (object as { toJSON?: unknown }).toJSON === 'function') return encode((object as { toJSON(): unknown }).toJSON(), path, found, seen);
    const entries: [string, unknown][] = object instanceof Map ? [...object].map(([k, v]) => [String(k), v]) : Object.entries(object);
    const out: { [key: string]: Json } = {};
    for (const [key, item] of entries) {
      if (item === undefined || typeof item === 'function') continue;
      out[key] = encode(item, path === '' ? escape(key) : `${path}.${escape(key)}`, found, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** 记下 path 上的值的种类；同一路径出现两种时报错（读的一方无从还原）。 */
function note(found: Map<string, WireType | 'text'>, path: string, type: WireType | 'text'): void {
  const known = found.get(path);
  if (known !== undefined && known !== type) {
    throw new TypeError(`toWire: values at ${path || 'the root'} are both ${known} and ${type}; one path carries one kind of value`);
  }
  found.set(path, type);
}

/** 沿路径往下，把末端的文字换成值；数组不占一段，逐个元素往下。 */
function revive(holder: Record<string | number, unknown>, key: string | number, rest: readonly string[], type: WireType, reader: WireReader): void {
  const value = holder[key];
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) revive(value as unknown as Record<number, unknown>, i, rest, type, reader);
    return;
  }
  if (rest.length === 0) {
    if (typeof value === 'string') holder[key] = reader(type, value);
    return;
  }
  if (isRecord(value)) revive(value, rest[0]!, rest.slice(1), type, reader);
}

const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('.', '~1');
const unescape = (step: string) => step.replaceAll('~1', '.').replaceAll('~0', '~');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return `a ${value?.constructor?.name ?? 'object'}`;
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value === 'function' || typeof value === 'symbol' ? `a ${typeof value}` : JSON.stringify(value) ?? typeof value;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 标准 base64，带 `=` 补齐。 */
export function encodeBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    text += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    text += b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    text += c === undefined ? '=' : BASE64[c & 63]!;
  }
  return text;
}

export function decodeBase64(text: string): Uint8Array {
  const clean = text.trim();
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new SyntaxError('not standard base64');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((clean.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, BASE64.indexOf(clean[i + k]!)), 0);
    for (const shift of [16, 8, 0]) if (out < bytes.length) bytes[out++] = (n >> shift) & 255;
  }
  return bytes;
}
