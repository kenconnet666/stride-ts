/**
 * 属性面板上的值和文件里的值之间的换算：旋转（文件里是四元数，面板上按欧拉角改）、多选时几个实体的值并成一个（颜色、
 * 新加的值从什么开始、按路径改值在 vue-tsx-pro 的 PropertyGrid 里）。纯函数，单测在 test/values.test.ts。
 */
import { PROPERTY_MIXED } from '@zerodep-dev/vue-tsx-pro-ui';
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

/**
 * 几个实体上同一处的值并成一个给属性面板显示：都一样就是它；一样长的列表、对象逐项并（位置的 x 一样、y 不一样时只有
 * y 是 PROPERTY_MIXED）；别的不一样（列表长短不同、有的没写）就是 PROPERTY_MIXED（vue-tsx-pro 的 PropertyGrid 显示"多个值"）。只有一个值时原样返回。
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
  return PROPERTY_MIXED;
}

const isObject = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
