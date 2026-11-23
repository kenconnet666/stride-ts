/**
 * 动画状态机的运行（content/formats/animationGraphFormat.ts 的 `.animgraph.json`）：一个实例记着参数和每一层（基础层加 layers）
 * 的当前状态、相位、正在淡出的上一个状态；每帧 update 推进时间、按过渡换状态，buildBlendTree 把要混的剪辑压进动画系统的混合栈，
 * 每一层按遮罩盖在（或叠在）下面的层上。不依赖实体，测试里直接用；挂到实体上用 Animator 脚本。
 */
import type { AnimationGraphData, AnimationLayerData, AnimationMachineData, AnimationMotionData, AnimationStateData } from '../content/formats/animationGraphFormat';
import type { AnimationBlendStack, BlendTreeBuilder } from './AnimationComponent';
import type { AnimationClip } from './resources';

/** 加载好的状态机：文件加上引用的剪辑（按内容路径）。 */
export interface AnimationGraph {
  readonly path: string;
  readonly data: AnimationGraphData;
  readonly clips: ReadonlyMap<string, AnimationClip>;
}

/** 正在放的一个状态：相位 0..1。 */
interface Playing {
  readonly state: AnimationStateData;
  phase: number;
}

/** 一个动作这一刻要混的剪辑和权重（权重加起来是 1）。 */
type Weighted = readonly { readonly clip: AnimationClip; readonly weight: number }[];

/** 一套状态和过渡的运行（基础层或一层）：当前状态、淡出中的上一个。 */
class Machine {
  readonly #data: AnimationMachineData;
  readonly #graph: AnimationGraphInstance;
  current: Playing;
  fading: { readonly from: Playing; elapsed: number; readonly duration: number } | undefined;

  constructor(data: AnimationMachineData, graph: AnimationGraphInstance) {
    this.#data = data;
    this.#graph = graph;
    this.current = { state: this.state(data.initial), phase: 0 };
  }

  state(name: string): AnimationStateData {
    const state = this.#data.states.find((candidate) => candidate.name === name);
    if (!state) throw new Error(`animation graph '${this.#graph.graph.path}' has no state '${name}'`);
    return state;
  }

  update(elapsed: number): void {
    this.#takeTransition();
    this.#advance(this.current, elapsed);
    const fading = this.fading;
    if (fading) {
      this.#advance(fading.from, elapsed);
      fading.elapsed += elapsed;
      if (fading.elapsed >= fading.duration) this.fading = undefined;
    }
  }

  push(stack: AnimationBlendStack): void {
    const fading = this.fading;
    if (fading) this.#pushPlaying(stack, fading.from);
    this.#pushPlaying(stack, this.current);
    if (fading) stack.blend(Math.min(1, fading.elapsed / fading.duration));
  }

  #takeTransition(): void {
    const current = this.current;
    for (const transition of this.#data.transitions) {
      if (transition.from !== '*' && transition.from !== current.state.name) continue;
      if (transition.from === '*' && transition.to === current.state.name) continue;
      const exitTime = transition.exitTime ?? (transition.when.length === 0 ? 1 : undefined);
      if (exitTime !== undefined && current.phase < exitTime) continue;
      if (!transition.when.every((condition) => {
        const value = this.#graph.get(condition.parameter);
        switch (condition.test) {
          case '>': return value > condition.value;
          case '<': return value < condition.value;
          case 'true': case 'trigger': return value !== 0;
          case 'false': return value === 0;
        }
      })) continue;
      for (const condition of transition.when) if (condition.test === 'trigger') this.#graph.set(condition.parameter, 0);
      this.fading = transition.duration > 0 ? { from: current, elapsed: 0, duration: transition.duration } : undefined;
      this.current = { state: this.state(transition.to), phase: 0 };
      return;
    }
  }

  #advance(playing: Playing, elapsed: number): void {
    const weighted = this.#graph.weights(playing.state.motion);
    const duration = weighted.reduce((sum, { clip, weight }) => sum + clip.duration * weight, 0);
    if (duration <= 0) return;
    const phase = playing.phase + (elapsed * playing.state.speed) / duration;
    playing.phase = playing.state.loop ? phase - Math.floor(phase) : Math.min(1, phase);
  }

  /** 按权重依次压、依次混（第 k 个按它的权重占前 k 个的比例混进去）。 */
  #pushPlaying(stack: AnimationBlendStack, { state, phase }: Playing): void {
    let total = 0;
    for (const { clip, weight } of this.#graph.weights(state.motion)) {
      if (weight <= 0) continue;
      stack.push(clip, phase * clip.duration);
      total += weight;
      if (total > weight) stack.blend(weight / total);
    }
  }
}

export class AnimationGraphInstance implements BlendTreeBuilder {
  readonly graph: AnimationGraph;
  readonly #parameters = new Map<string, number>();
  readonly #base: Machine;
  readonly #layers: { readonly data: AnimationLayerData; readonly machine: Machine }[];

  constructor(graph: AnimationGraph) {
    this.graph = graph;
    for (const parameter of graph.data.parameters) this.#parameters.set(parameter.name, parameter.default);
    this.#base = new Machine(graph.data, this);
    this.#layers = graph.data.layers.map((data) => ({ data, machine: new Machine(data, this) }));
  }

  /** 基础层现在的状态名。 */
  get state(): string {
    return this.#base.current.state.name;
  }

  /** 基础层现在状态的相位（0..1）。 */
  get phase(): number {
    return this.#base.current.phase;
  }

  /** 基础层正在从哪个状态淡过来；不在淡入淡出时是 undefined。 */
  get fadingFrom(): string | undefined {
    return this.#base.fading?.from.state.name;
  }

  /** 某一层现在的状态名。 */
  layerState(layer: string): string {
    const found = this.#layers.find(({ data }) => data.name === layer);
    if (!found) throw new Error(`animation graph '${this.graph.path}' has no layer '${layer}'`);
    return found.machine.current.state.name;
  }

  get(name: string): number {
    const value = this.#parameters.get(name);
    if (value === undefined) throw new Error(`animation graph '${this.graph.path}' has no parameter '${name}'`);
    return value;
  }

  /** 设数或开关参数（开关用 true、false）。 */
  set(name: string, value: number | boolean): void {
    this.get(name);
    this.#parameters.set(name, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  /** 触发：一直留着，直到一条用到它的过渡生效。 */
  trigger(name: string): void {
    this.set(name, 1);
  }

  /** 基础层直接跳到某个状态（不淡入淡出），相位从 0 开始。 */
  jump(state: string): void {
    this.#base.current = { state: this.#base.state(state), phase: 0 };
    this.#base.fading = undefined;
  }

  /** 推进 elapsed 秒：每一层先按过渡换状态，再推进相位。 */
  update(elapsed: number): void {
    this.#base.update(elapsed);
    for (const { machine } of this.#layers) machine.update(elapsed);
  }

  buildBlendTree(stack: AnimationBlendStack): void {
    this.#base.push(stack);
    for (const { data, machine } of this.#layers) {
      const weight = data.weight * (data.weightParameter === undefined ? 1 : Math.min(1, Math.max(0, this.get(data.weightParameter))));
      if (weight <= 0) continue;
      machine.push(stack);
      if (data.mode === 'additive') stack.addMasked(weight, data.mask);
      else stack.blendMasked(weight, data.mask);
    }
  }

  /** 动作这一刻要混的剪辑和权重。 */
  weights(motion: AnimationMotionData): Weighted {
    switch (motion.type) {
      case 'clip':
        return [{ clip: this.#clip(motion.clip), weight: 1 }];
      case 'blend1d':
        return blend1d(this.get(motion.parameter), motion.points).map(({ index, weight }) => ({ clip: this.#clip(motion.points[index]!.clip), weight }));
      case 'blend2d':
        return blend2d([this.get(motion.parameterX), this.get(motion.parameterY)], motion.points.map((point) => point.at)).map((weight, i) => ({ clip: this.#clip(motion.points[i]!.clip), weight }));
    }
  }

  #clip(path: string): AnimationClip {
    const clip = this.graph.clips.get(path);
    if (!clip) throw new Error(`animation graph '${this.graph.path}': clip '${path}' is not loaded`);
    return clip;
  }
}

/** 一维混合：参数在两点之间时两个点按位置插值，两头之外取最近的一个。 */
export function blend1d(value: number, points: readonly { readonly at: number }[]): { index: number; weight: number }[] {
  if (value <= points[0]!.at) return [{ index: 0, weight: 1 }];
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1]!.at, hi = points[i]!.at;
    if (value <= hi) {
      const t = hi > lo ? (value - lo) / (hi - lo) : 1;
      return [{ index: i - 1, weight: 1 - t }, { index: i, weight: t }];
    }
  }
  return [{ index: points.length - 1, weight: 1 }];
}

/**
 * 二维混合的权重（Unity 的自由笛卡尔，Johansen 的梯度带插值）：每个点的权重是它对每个别的点的"带"里最小的那个
 * clamp(1 − (p − pᵢ)·(pⱼ − pᵢ) / |pⱼ − pᵢ|²)，再归一；都是 0 时（不该发生）取最近的点。
 */
export function blend2d(value: readonly [number, number], points: readonly (readonly number[])[]): number[] {
  const weights = points.map((pi, i) => {
    let weight = 1;
    points.forEach((pj, j) => {
      if (j === i) return;
      const dx = pj[0]! - pi[0]!, dy = pj[1]! - pi[1]!;
      const length2 = dx * dx + dy * dy;
      if (length2 <= 1e-12) return;
      const h = 1 - ((value[0] - pi[0]!) * dx + (value[1] - pi[1]!) * dy) / length2;
      weight = Math.min(weight, Math.max(0, Math.min(1, h)));
    });
    return weight;
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum > 0) return weights.map((weight) => weight / sum);
  let nearest = 0;
  points.forEach((p, i) => {
    if (Math.hypot(p[0]! - value[0], p[1]! - value[1]) < Math.hypot(points[nearest]![0]! - value[0], points[nearest]![1]! - value[1])) nearest = i;
  });
  return points.map((_, i) => (i === nearest ? 1 : 0));
}
