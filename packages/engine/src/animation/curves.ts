/**
 * 属性曲线（Stride 的 AnimationClip.AddCurve、AnimationCurve<T>）：动画剪辑除了骨架的轨道，还可以带几条曲线，各自驱动实体上
 * 一个数据组件的一个属性（数、三维向量、四元数、颜色）。用代码建：
 *
 *   const clip = AnimationClip.fromCurves('Spin', 1, [
 *     propertyCurve(Transform, 'rotation', [[0, [0, 0, 0, 1]], [0.5, [1, 0, 0, 0]], [1, [0, 0, 0, -1]]]),
 *     propertyCurve(Light, 'intensity', [[0, 1], [1, 8]], 'cubic'),
 *   ], 'loopInfinite');
 *   animation.animations.set('Spin', clip);
 *   animation.play('Spin');
 *
 * 和 Stride 不同：目标写组件类型和属性名（类型检查得到），不是 "[TransformComponent.Key].Rotation" 这样的字符串路径；
 * 四元数的三次插值 Stride 没实现（抛 NotImplementedException），这里按分量做同样的三次插值再归一化。
 */
import type { ColorLike, QuatLike, Vec3Like } from '../mathematics/vectors';
import { tag, type ComponentType, type ViewOf } from '../engine/component';
import type { Entity } from '../engine/Entity';

/** 正在播带属性曲线的剪辑、又没有骨架和形变的实体（AnimationComponent 播的时候加上）：动画系统按它找到这些实体。 */
export const PropertyAnimated = tag('PropertyAnimated');

/** 关键帧之间怎么插值（Stride 的 AnimationCurveInterpolationType）：constant 取前一个关键帧的值；cubic 是过四个点的 Catmull-Rom。 */
export type CurveInterpolation = 'constant' | 'linear' | 'cubic';

type Animatable = number | Vec3Like | QuatLike | ColorLike;
/** 组件里能用曲线驱动的属性名。 */
export type AnimatableKey<C> = { [K in keyof ViewOf<C>]: ViewOf<C>[K] extends Animatable ? K : never }[keyof ViewOf<C>] & string;
/** 这个属性的关键帧的值：数就是数；向量、四元数、颜色按分量给（xyz、xyzw、rgba）。 */
export type KeyValue<V> = V extends number ? number : V extends QuatLike | ColorLike ? readonly [number, number, number, number] : readonly [number, number, number];

export interface PropertyCurve {
  readonly component: ComponentType<any, any>;
  readonly property: string;
  readonly interpolation: CurveInterpolation;
  /** 每个值几个分量：数 1，向量 3，四元数和颜色 4。 */
  readonly size: number;
  /** 值是四元数：线性插值走球面最短的弧，混合也一样。 */
  readonly quaternion: boolean;
  /** 关键帧的时刻（秒，升序）和值（每个 size 个分量）。 */
  readonly times: Float32Array;
  readonly values: Float32Array;
}

/**
 * 一条曲线：component 的 property 按 keys（[时刻, 值]，时刻升序）走。四元数的属性（Transform.rotation 这类）按球面插值，
 * 其余的按分量插值。
 */
export function propertyCurve<C extends ComponentType<any, any>, K extends AnimatableKey<C>>(
  component: C, property: K, keys: readonly (readonly [time: number, value: KeyValue<ViewOf<C>[K]>])[], interpolation: CurveInterpolation = 'linear',
): PropertyCurve {
  if (keys.length === 0) throw new Error(`the curve for ${component.name}.${property} has no key frames`);
  const first = keys[0]![1] as number | readonly number[];
  const size = typeof first === 'number' ? 1 : first.length;
  const times = new Float32Array(keys.length), values = new Float32Array(keys.length * size);
  keys.forEach(([time, value], i) => {
    if (i > 0 && time < keys[i - 1]![0]) throw new Error(`the key frames of ${component.name}.${property} are not sorted by time`);
    times[i] = time;
    values.set(typeof value === 'number' ? [value] : (value as readonly number[]), i * size);
  });
  return { component, property, interpolation, size, quaternion: component.schema.fields.find((field) => field.name === property)?.options.kind === 'quat', times, values };
}

/** 曲线在 time 秒的值写进 out（两端外取端点）。 */
export function evaluateCurve(curve: PropertyCurve, time: number, out: Float32Array): void {
  const { times, values, size } = curve, last = times.length - 1;
  const copy = (key: number) => {
    for (let c = 0; c < size; c++) out[c] = values[key * size + c]!;
  };
  if (time <= times[0]! || last === 0) return copy(0);
  if (time >= times[last]!) return copy(last);
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid;
    else hi = mid;
  }
  if (curve.interpolation === 'constant') return copy(lo);
  const t = (time - times[lo]!) / (times[hi]! - times[lo]!);
  if (curve.interpolation === 'linear') {
    if (curve.quaternion) slerp(out, values, lo * 4, values, hi * 4, t);
    else for (let c = 0; c < size; c++) out[c] = values[lo * size + c]! + (values[hi * size + c]! - values[lo * size + c]!) * t;
    return;
  }
  // 三次（Stride 的 Interpolator.Cubic）：前后各多看一个关键帧，没有的用端点自己
  const before = Math.max(lo - 1, 0), after = Math.min(hi + 1, last);
  const t2 = t * t, t3 = t2 * t;
  const f0 = -t3 + 2 * t2 - t, f1 = 3 * t3 - 5 * t2 + 2, f2 = -3 * t3 + 4 * t2 + t, f3 = t3 - t2;
  for (let c = 0; c < size; c++) {
    out[c] = 0.5 * (values[before * size + c]! * f0 + values[lo * size + c]! * f1 + values[hi * size + c]! * f2 + values[after * size + c]! * f3);
  }
  if (curve.quaternion) normalize4(out);
}

/** 球面线性插值（走最短的弧），a、b 是两个数组里从各自的偏移开始的四个数。 */
function slerp(out: Float32Array, a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, t: number): void {
  let dot = a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - t, wb = t;
  if (dot < 0.9999) {
    const angle = Math.acos(dot), sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = Math.sin(t * angle) / sin;
  }
  for (let c = 0; c < 4; c++) out[c] = a[ao + c]! * wa + b[bo + c]! * wb * sign;
}

function normalize4(q: Float32Array): void {
  const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
  for (let c = 0; c < 4; c++) q[c] = q[c]! / length;
}

interface Channel {
  curve: PropertyCurve;
  value: Float32Array;
}

/**
 * 混合栈的属性曲线部分：和骨架的姿势同样的后缀运算，在每条曲线的目标（组件加属性）上做。只有一边有的目标取那一边；
 * 没有任何曲线的属性不动。
 */
export class PropertyStack {
  readonly #entries: Map<string, Channel>[] = [];
  #depth = 0;

  begin(): void {
    this.#depth = 0;
  }

  push(curves: readonly PropertyCurve[], time: number): void {
    const entry = (this.#entries[this.#depth++] ??= new Map());
    entry.clear();
    for (const curve of curves) {
      const value = new Float32Array(curve.size);
      evaluateCurve(curve, time, value);
      entry.set(`${curve.component.name}.${curve.property}`, { curve, value });
    }
  }

  /** lerp(a, b, factor)，四元数走球面。 */
  blend(factor: number): void {
    this.#combine((a, b, quaternion) => {
      if (quaternion) slerp(a, a, 0, b, 0, factor);
      else for (let c = 0; c < a.length; c++) a[c] = a[c]! + (b[c]! - a[c]!) * factor;
    });
  }

  /** a + b · factor；四元数的"加"是在 a 上再转 b 的 factor 倍（从不转到 b 的球面插值）。 */
  add(factor: number): void {
    this.#combine((a, b, quaternion) => {
      if (quaternion) multiplyScaled(a, b, factor);
      else for (let c = 0; c < a.length; c++) a[c] = a[c]! + b[c]! * factor;
    });
  }

  subtract(factor: number): void {
    this.#combine((a, b, quaternion) => {
      if (quaternion) multiplyScaled(a, b, -factor);
      else for (let c = 0; c < a.length; c++) a[c] = a[c]! - b[c]! * factor;
    });
  }

  /** 栈顶的结果写到实体的组件上；实体没有那个组件的曲线跳过。 */
  apply(entity: Entity): void {
    if (this.#depth === 0) return;
    for (const { curve, value } of this.#entries[this.#depth - 1]!.values()) {
      const view = entity.get(curve.component) as Record<string, unknown> | undefined;
      if (!view) continue;
      if (curve.size === 1) view[curve.property] = value[0]!;
      else if (curve.size === 3) Object.assign(view[curve.property] as object, { x: value[0]!, y: value[1]!, z: value[2]! });
      else if (curve.quaternion) Object.assign(view[curve.property] as object, { x: value[0]!, y: value[1]!, z: value[2]!, w: value[3]! });
      else Object.assign(view[curve.property] as object, { r: value[0]!, g: value[1]!, b: value[2]!, a: value[3]! });
    }
  }

  #combine(operation: (a: Float32Array, b: Float32Array, quaternion: boolean) => void): void {
    if (this.#depth < 2) throw new Error('animation blend stack: an operation needs two poses');
    const b = this.#entries[--this.#depth]!, a = this.#entries[this.#depth - 1]!;
    for (const [key, channel] of b) {
      const existing = a.get(key);
      if (existing) operation(existing.value, channel.value, channel.curve.quaternion);
      else a.set(key, channel);
    }
  }
}

const IDENTITY = new Float32Array([0, 0, 0, 1]);
const SCALED = new Float32Array(4);

/** a = a · (b 的 factor 倍)：factor 是负的时候往反方向转。 */
function multiplyScaled(a: Float32Array, b: Float32Array, factor: number): void {
  slerp(SCALED, IDENTITY, 0, b, 0, Math.abs(factor));
  // 反方向：共轭
  const s = factor < 0 ? -1 : 1;
  const bx = SCALED[0]! * s, by = SCALED[1]! * s, bz = SCALED[2]! * s, bw = SCALED[3]!;
  const [ax, ay, az, aw] = [a[0]!, a[1]!, a[2]!, a[3]!];
  a[0] = aw * bx + ax * bw + ay * bz - az * by;
  a[1] = aw * by - ax * bz + ay * bw + az * bx;
  a[2] = aw * bz + ax * by - ay * bx + az * bw;
  a[3] = aw * bw - ax * bx - ay * by - az * bz;
}
