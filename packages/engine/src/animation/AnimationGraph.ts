/**
 * 动画状态机的运行（content/formats/animationGraphFormat.ts 的 `.animgraph.json`）：一个实例记着参数、当前状态和它的相位、正在
 * 淡出的上一个状态，每帧 update 推进时间、按过渡换状态，buildBlendTree 把要混的剪辑压进动画系统的混合栈。不依赖实体，测试里
 * 直接用；挂到实体上用 Animator 脚本。
 */
import type { AnimationGraphData, AnimationMotionData, AnimationStateData } from '../content/formats/animationGraphFormat';
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

export class AnimationGraphInstance implements BlendTreeBuilder {
  readonly graph: AnimationGraph;
  readonly #parameters = new Map<string, number>();
  #current: Playing;
  /** 淡出中的上一个状态和淡入淡出走了多久、一共多久。 */
  #fading: { readonly from: Playing; elapsed: number; readonly duration: number } | undefined;

  constructor(graph: AnimationGraph) {
    this.graph = graph;
    for (const parameter of graph.data.parameters) this.#parameters.set(parameter.name, parameter.default);
    this.#current = { state: this.#state(graph.data.initial), phase: 0 };
  }

  /** 现在的状态名。 */
  get state(): string {
    return this.#current.state.name;
  }

  /** 现在状态的相位（0..1）。 */
  get phase(): number {
    return this.#current.phase;
  }

  /** 正在从哪个状态淡过来；不在淡入淡出时是 undefined。 */
  get fadingFrom(): string | undefined {
    return this.#fading?.from.state.name;
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

  /** 直接跳到某个状态（不淡入淡出），相位从 0 开始。 */
  jump(state: string): void {
    this.#current = { state: this.#state(state), phase: 0 };
    this.#fading = undefined;
  }

  /** 推进 elapsed 秒：先按过渡换状态，再推进相位。 */
  update(elapsed: number): void {
    this.#takeTransition();
    this.#advance(this.#current, elapsed);
    const fading = this.#fading;
    if (fading) {
      this.#advance(fading.from, elapsed);
      fading.elapsed += elapsed;
      if (fading.elapsed >= fading.duration) this.#fading = undefined;
    }
  }

  buildBlendTree(stack: AnimationBlendStack): void {
    const fading = this.#fading;
    if (fading) this.#push(stack, fading.from);
    this.#push(stack, this.#current);
    if (fading) stack.blend(Math.min(1, fading.elapsed / fading.duration));
  }

  #takeTransition(): void {
    const current = this.#current;
    for (const transition of this.graph.data.transitions) {
      if (transition.from !== '*' && transition.from !== current.state.name) continue;
      if (transition.from === '*' && transition.to === current.state.name) continue;
      const exitTime = transition.exitTime ?? (transition.when.length === 0 ? 1 : undefined);
      if (exitTime !== undefined && current.phase < exitTime) continue;
      if (!transition.when.every((condition) => {
        const value = this.#parameters.get(condition.parameter)!;
        switch (condition.test) {
          case '>': return value > condition.value;
          case '<': return value < condition.value;
          case 'true': case 'trigger': return value !== 0;
          case 'false': return value === 0;
        }
      })) continue;
      for (const condition of transition.when) if (condition.test === 'trigger') this.#parameters.set(condition.parameter, 0);
      const next = { state: this.#state(transition.to), phase: 0 };
      this.#fading = transition.duration > 0 ? { from: current, elapsed: 0, duration: transition.duration } : undefined;
      this.#current = next;
      return;
    }
  }

  #advance(playing: Playing, elapsed: number): void {
    const duration = this.#duration(playing.state.motion);
    if (duration <= 0) return;
    const phase = playing.phase + (elapsed * playing.state.speed) / duration;
    playing.phase = playing.state.loop ? phase - Math.floor(phase) : Math.min(1, phase);
  }

  /** 一维混合的两个点和插值系数：参数在两点之间时按位置，两头之外取最近的一个（系数 0）。 */
  #segment(motion: Extract<AnimationMotionData, { type: 'blend1d' }>): { a: AnimationClip; b: AnimationClip; factor: number } {
    const value = this.#parameters.get(motion.parameter)!;
    const points = motion.points;
    if (value <= points[0]!.at) return { a: this.#clip(points[0]!.clip), b: this.#clip(points[0]!.clip), factor: 0 };
    for (let i = 1; i < points.length; i++) {
      const lo = points[i - 1]!, hi = points[i]!;
      if (value <= hi.at) return { a: this.#clip(lo.clip), b: this.#clip(hi.clip), factor: hi.at > lo.at ? (value - lo.at) / (hi.at - lo.at) : 1 };
    }
    const last = this.#clip(points[points.length - 1]!.clip);
    return { a: last, b: last, factor: 0 };
  }

  /** 动作的时长：一维混合按插值系数在两个剪辑的时长之间插值（相位同步）。 */
  #duration(motion: AnimationMotionData): number {
    if (motion.type === 'clip') return this.#clip(motion.clip).duration;
    const { a, b, factor } = this.#segment(motion);
    return a.duration + (b.duration - a.duration) * factor;
  }

  #push(stack: AnimationBlendStack, { state, phase }: Playing): void {
    const motion = state.motion;
    if (motion.type === 'clip') {
      const clip = this.#clip(motion.clip);
      stack.push(clip, phase * clip.duration);
      return;
    }
    const { a, b, factor } = this.#segment(motion);
    stack.push(a, phase * a.duration);
    if (a !== b) stack.push(b, phase * b.duration).blend(factor);
  }

  #state(name: string): AnimationStateData {
    const state = this.graph.data.states.find((candidate) => candidate.name === name);
    if (!state) throw new Error(`animation graph '${this.graph.path}' has no state '${name}'`);
    return state;
  }

  #clip(path: string): AnimationClip {
    const clip = this.graph.clips.get(path);
    if (!clip) throw new Error(`animation graph '${this.graph.path}': clip '${path}' is not loaded`);
    return clip;
  }
}
