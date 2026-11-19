/**
 * 形变目标的权重（Stride 的 ModelComponent 上的形变 API 和 ModelMorphLayout）：每个模型实例一组权重，按模型的目标槽排
 * （各网格同名的目标是一个槽）。动画系统按剪辑的形变曲线写它们，脚本也可以直接改；渲染器每帧把所有实例的权重连成一个
 * 缓冲上传，带形变的网格实体（Morphed）记着自己那组在缓冲里的起点。
 *
 *   const morphs = game.animation.morphs(entity)!;
 *   morphs.setMorphWeight(morphs.findMorphTarget('Bigger'), 0.5);
 */
import type { MorphWeightCurve } from '../content/format';
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { AnimationClip } from './resources';

/** 带形变网格的实体：weights 是它的模型实例那组权重在连起来的权重缓冲里的起点。 */
export const Morphed = component('Morphed', {
  weights: prop.u32().default(0).transient(),
});

/** 一个模型实例的形变权重（Stride 的 ModelComponent.MorphTargetNames、FindMorphTarget、Get/SetMorphWeight）。 */
export class ModelMorphs {
  /** 目标名，按槽排。 */
  readonly morphTargetNames: readonly string[];
  /** 每个槽的权重（渲染器每帧整组上传）。 */
  readonly weights: Float32Array;
  /** @internal 在连起来的权重缓冲里的起点。 */
  readonly base: number;
  readonly #slotOf: ReadonlyMap<string, number>;

  constructor(morphTargetNames: readonly string[], base: number) {
    this.morphTargetNames = morphTargetNames;
    this.weights = new Float32Array(morphTargetNames.length);
    this.base = base;
    this.#slotOf = new Map(morphTargetNames.map((name, slot) => [name, slot]));
  }

  /** 名字对应的槽；没有这个目标时是 -1。 */
  findMorphTarget(name: string): number {
    return this.#slotOf.get(name) ?? -1;
  }

  getMorphWeight(slot: number): number {
    this.#check(slot);
    return this.weights[slot]!;
  }

  setMorphWeight(slot: number, weight: number): void {
    this.#check(slot);
    this.weights[slot] = weight;
  }

  setAllMorphWeights(weight: number): void {
    this.weights.fill(weight);
  }

  #check(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.weights.length) throw new RangeError(`morph target slot ${slot} is out of range (the model has ${this.weights.length})`);
  }
}

/** 曲线在 time 秒的值（线性插值，两端外取端点）。 */
export function evaluateMorphCurve({ times, values }: MorphWeightCurve, time: number): number {
  const last = times.length - 1;
  if (last < 0) return 0;
  if (time <= times[0]!) return values[0]!;
  if (time >= times[last]!) return values[last]!;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo]!, t1 = times[hi]!;
  return values[lo]! + (values[hi]! - values[lo]!) * ((time - t0) / (t1 - t0));
}

/**
 * 混合栈的形变部分：和骨架的姿势同样的后缀运算，在每个槽的权重上做。剪辑没有某个目标的曲线时这个槽不算它（mask），
 * 两边都没有的槽不改模型原来的权重。
 */
export class MorphStack {
  readonly #entries: { weights: Float32Array; mask: Uint8Array }[] = [];
  #depth = 0;
  #morphs: ModelMorphs | undefined;

  begin(morphs: ModelMorphs | undefined): void {
    this.#morphs = morphs;
    this.#depth = 0;
  }

  push(clip: AnimationClip, time: number): void {
    const morphs = this.#morphs;
    if (!morphs) return;
    const entry = this.#next(morphs.weights.length);
    for (const curve of clip.morphWeights) {
      const slot = morphs.findMorphTarget(curve.target);
      if (slot < 0) continue;
      entry.weights[slot] = evaluateMorphCurve(curve, Math.min(Math.max(time, 0), clip.duration));
      entry.mask[slot] = 1;
    }
  }

  /** lerp(a, b, factor)；只有一边有的槽取那一边。 */
  blend(factor: number): void {
    this.#combine((a, b) => a + (b - a) * factor);
  }

  add(factor: number): void {
    this.#combine((a, b) => a + b * factor);
  }

  subtract(factor: number): void {
    this.#combine((a, b) => a - b * factor);
  }

  /** 栈顶的结果写进模型的权重（没有曲线的槽不动）。 */
  apply(): void {
    const morphs = this.#morphs;
    if (!morphs || this.#depth === 0) return;
    const { weights, mask } = this.#entries[this.#depth - 1]!;
    for (let slot = 0; slot < weights.length; slot++) if (mask[slot]) morphs.weights[slot] = weights[slot]!;
  }

  #next(count: number): { weights: Float32Array; mask: Uint8Array } {
    let entry = this.#entries[this.#depth];
    if (!entry || entry.weights.length < count) this.#entries[this.#depth] = entry = { weights: new Float32Array(count), mask: new Uint8Array(count) };
    entry.weights.fill(0);
    entry.mask.fill(0);
    this.#depth++;
    return entry;
  }

  #combine(operation: (a: number, b: number) => number): void {
    if (!this.#morphs) return;
    if (this.#depth < 2) throw new Error('animation blend stack: an operation needs two poses');
    const b = this.#entries[--this.#depth]!, a = this.#entries[this.#depth - 1]!;
    for (let slot = 0; slot < a.weights.length; slot++) {
      if (a.mask[slot] && b.mask[slot]) a.weights[slot] = operation(a.weights[slot]!, b.weights[slot]!);
      else if (b.mask[slot]) {
        a.weights[slot] = b.weights[slot]!;
        a.mask[slot] = 1;
      }
    }
  }
}
