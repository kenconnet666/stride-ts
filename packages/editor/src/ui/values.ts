/**
 * 属性面板上的值和文件里的值之间的换算：旋转（文件里是四元数，面板上按欧拉角改）、颜色（文件里可能是线性的，取色器是
 * sRGB 的）、新加的值从什么开始、多选时几个实体的值并成一个。纯函数，单测在 test/values.test.ts。
 */
import type { FieldType } from '@stride-ts/engine/editor-fields';
import { sameValue } from '@stride-ts/engine/content-prefabs';

const DEGREES = 180 / Math.PI;

/**
 * 四元数 [x, y, z, w] → 欧拉角 [绕 X, 绕 Y, 绕 Z]（度），顺序同 Stride 的 Quaternion.RotationYawPitchRoll：先绕 Z（roll）、
 * 再绕 X（pitch）、再绕 Y（yaw）。Stride 编辑器的属性面板也按这个顺序显示。
 */
export function quaternionToEuler([x, y, z, w]: readonly number[]): [number, number, number] {
  const sinPitch = Math.max(-1, Math.min(1, 2 * (w! * x! - y! * z!)));
  const pitch = Math.asin(sinPitch);
  // 万向锁（pitch 是 ±90 度）：yaw 和 roll 绕的是同一根轴，全算给 yaw
  if (Math.abs(sinPitch) > 0.9999999) return [pitch * DEGREES, 2 * Math.atan2(y!, w!) * DEGREES, 0].map(tidy) as [number, number, number];
  const yaw = Math.atan2(2 * (x! * z! + w! * y!), 1 - 2 * (x! * x! + y! * y!));
  const roll = Math.atan2(2 * (x! * y! + w! * z!), 1 - 2 * (x! * x! + z! * z!));
  return [pitch * DEGREES, yaw * DEGREES, roll * DEGREES].map(tidy) as [number, number, number];
}

/** 欧拉角（度，[绕 X, 绕 Y, 绕 Z]）→ 四元数 [x, y, z, w]，同 Stride 的 Quaternion.RotationYawPitchRoll(Y, X, Z)。 */
export function eulerToQuaternion([pitchDegrees, yawDegrees, rollDegrees]: readonly number[]): [number, number, number, number] {
  const half = (degrees: number) => degrees / DEGREES / 2;
  const sp = Math.sin(half(pitchDegrees!)), cp = Math.cos(half(pitchDegrees!));
  const sy = Math.sin(half(yawDegrees!)), cy = Math.cos(half(yawDegrees!));
  const sr = Math.sin(half(rollDegrees!)), cr = Math.cos(half(rollDegrees!));
  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ].map((value) => Math.round(value * 1e7) / 1e7) as [number, number, number, number];
}

/** 面板上显示的角度：去掉浮点的零头（0.30000000000000004 显示成 0.3）。 */
const tidy = (degrees: number): number => {
  const rounded = Math.round(degrees * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const toSrgb = (linear: number) => (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055);
const toLinear = (srgb: number) => (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);

/** 文件里的颜色（0 到 1 的通道，space 是它存成哪种）→ 取色器的 `#rrggbb`（sRGB）。超出 0 到 1 的（HDR）夹住。 */
export function colorToHex(color: readonly number[], space: 'srgb' | 'linear'): string {
  return `#${[0, 1, 2].map((i) => {
    const channel = Math.max(0, Math.min(1, color[i] ?? 0));
    return Math.round((space === 'linear' ? toSrgb(channel) : channel) * 255).toString(16).padStart(2, '0');
  }).join('')}`;
}

/** 取色器的 `#rrggbb` → 文件里的颜色通道；alpha 照原来的（有的话）。 */
export function hexToColor(hex: string, space: 'srgb' | 'linear', previous: readonly number[]): number[] {
  const rgb = [1, 3, 5].map((at) => {
    const srgb = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return Math.round((space === 'linear' ? toLinear(srgb) : srgb) * 1e5) / 1e5;
  });
  return previous.length > 3 ? [...rgb, previous[3]!] : rgb;
}

/** 一个字段新加时（列表里加一项、换了联合的种类、给可以是 null 的设上值）从什么开始：数是 0，向量全 0，旋转不转，颜色白色。 */
export function emptyValue(type: FieldType): unknown {
  switch (type.kind) {
    case 'number': return type.min !== undefined && type.min > 0 ? type.min : 0;
    case 'bool': return false;
    case 'string': return '';
    case 'enum': return type.values[0];
    case 'vector': return new Array<number>(type.size).fill(0);
    case 'rotation': return [0, 0, 0, 1];
    case 'color': return type.alpha ? [1, 1, 1, 1] : [1, 1, 1];
    case 'asset': return type.form === 'ref' ? { $asset: '', kind: type.refKind ?? type.asset } : '';
    case 'entity': return null;
    case 'list': return [];
    case 'object': return Object.fromEntries(type.fields.filter((field) => !field.optional).map((field) => [field.name, field.nullable ? null : emptyValue(field.type)]));
    case 'union': {
      const [tag, fields = []] = Object.entries(type.variants)[0] ?? [];
      return { [type.tag]: tag, ...Object.fromEntries([...(type.common ?? []), ...fields].filter((field) => !field.optional).map((field) => [field.name, emptyValue(field.type)])) };
    }
    case 'json': return {};
  }
}

/** 多选时几个实体上这一处的值不一样：属性面板显示"多个值"。 */
export const MIXED: unique symbol = Symbol('mixed');

/**
 * 几个实体上同一处的值并成一个给属性面板显示：都一样就是它；一样长的列表、对象逐项并（位置的 x 一样、y 不一样时只有
 * y 是 MIXED）；别的不一样（列表长短不同、有的没写）就是 MIXED。只有一个值时原样返回。
 */
export function mergeValues(values: readonly unknown[]): unknown {
  const [first] = values;
  if (values.every((value) => sameValue(value, first))) return first;
  if (values.every((value) => Array.isArray(value) && value.length === (first as unknown[]).length)) {
    return (first as unknown[]).map((_, i) => mergeValues(values.map((value) => (value as unknown[])[i])));
  }
  if (values.every(isObject)) {
    const keys = new Set(values.flatMap((value) => Object.keys(value as object)));
    return Object.fromEntries([...keys].map((key) => [key, mergeValues(values.map((value) => (value as Record<string, unknown>)[key]))]));
  }
  return MIXED;
}

/** 值里（任何一层）有没有 MIXED。 */
export function hasMixed(value: unknown): boolean {
  if (value === MIXED) return true;
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(hasMixed);
}

const isObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 不改原值，把 JSON 值里 path 上的值设成 value，返回新的根；路径上缺的对象、列表按下一段的键补上。 */
export function withPath(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  const container = root !== null && typeof root === 'object' ? root : typeof key === 'number' ? [] : {};
  const copy = (Array.isArray(container) ? container.slice() : { ...container }) as Record<string | number, unknown>;
  copy[key] = withPath(copy[key], rest, value);
  return copy;
}
