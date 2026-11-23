/**
 * 动画状态机（`.animgraph.json`，Stride 只有代码里的 IBlendTreeBuilder；照 Unity 的 Animator Controller、虚幻的动画蓝图状态机、
 * Godot 的 AnimationTree）：参数（数、开关、触发）、状态（一个剪辑，或按一个参数在几个剪辑之间插值的一维混合）、状态之间的过渡
 * （条件都满足、到了退出时间时淡入淡出过去）。脚本只设参数（`animator.set('speed', 3)`、`animator.trigger('jump')`），动作怎么
 * 接、怎么混在文件里改。运行时见 animation/AnimationGraph.ts、Animator.ts。
 *
 * - 一维混合的点按 at 从小到大排；参数在两点之间时两个剪辑按位置插值，在两头之外时取最近的一个。几个剪辑的时间按"相位"（0..1）
 *   同步：走和跑插值时步子不会错开（TPP 的 AnimationController 就是这么做的）。
 * - 过渡的 from 是 `*` 时从任何状态都能过去（除了 to 自己）；按文件里的顺序，第一条满足的生效。条件都满足、并且没写 exitTime 或者
 *   来源状态的相位到了 exitTime 时过去；一个条件都没有的过渡相当于 exitTime 1（不循环的状态放完了就过去）。
 * - 触发参数被一条生效的过渡用到时清掉（同 Unity）。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const ANIMATION_PARAMETER = s.object({
  name: s.string(),
  type: s.oneOf('number', 'bool', 'trigger').describe('number, bool (0 or 1) or trigger (set by trigger(), cleared when a transition uses it)'),
  default: s.number().default(0).describe('starting value (bool: 0 or 1)'),
});

export const ANIMATION_MOTION = s.union('type', {
  /** 一个剪辑。 */
  clip: { clip: s.asset('animation') },
  /** 按一个数的参数在几个剪辑之间插值。 */
  blend1d: {
    parameter: s.string().describe('number parameter that picks the position'),
    points: s.list(s.object({ at: s.number({ step: 0.05 }), clip: s.asset('animation') })).describe('clips at parameter values, in increasing order'),
  },
});

export const ANIMATION_STATE = s.object({
  name: s.string(),
  motion: ANIMATION_MOTION,
  speed: s.number({ min: 0, step: 0.05 }).default(1).describe('playback speed'),
  loop: s.bool().default(true).describe('loops; when off it holds the last pose and transitions without conditions fire at the end'),
});

export const ANIMATION_CONDITION = s.object({
  parameter: s.string(),
  test: s.oneOf('>', '<', 'true', 'false', 'trigger').describe('> and < compare with value; true and false test a bool; trigger waits for trigger()'),
  value: s.number({ step: 0.05 }).default(0),
});

export const ANIMATION_TRANSITION = s.object({
  from: s.string().describe('source state, or * for any state'),
  to: s.string(),
  when: s.list(ANIMATION_CONDITION).default([]).describe('all must hold'),
  exitTime: s.number({ min: 0, max: 1, step: 0.05 }).optional().describe('only after the source state has played this much (0..1 of its length)'),
  duration: s.number({ min: 0, step: 0.05, unit: 's' }).default(0.15).describe('crossfade time'),
});

export const ANIMATION_GRAPH = s.object({
  name: s.string(),
  parameters: s.list(ANIMATION_PARAMETER).default([]),
  states: s.list(ANIMATION_STATE),
  initial: s.string().describe('state to start in'),
  transitions: s.list(ANIMATION_TRANSITION).default([]),
});

export type AnimationGraphFile = InputOf<typeof ANIMATION_GRAPH>;
/** 解析过的状态机（默认值补齐）。 */
export type AnimationGraphData = Infer<typeof ANIMATION_GRAPH>;
export type AnimationStateData = Infer<typeof ANIMATION_STATE>;
export type AnimationMotionData = Infer<typeof ANIMATION_MOTION>;
export type AnimationTransitionData = Infer<typeof ANIMATION_TRANSITION>;

/** 文件里的名字都对得上：状态、初始状态、过渡两头、条件和一维混合用的参数；不对时报错，消息以 where 开头。 */
export function checkAnimationGraph(graph: AnimationGraphData, where: string): AnimationGraphData {
  const states = new Set(graph.states.map((state) => state.name));
  const parameters = new Map(graph.parameters.map((parameter) => [parameter.name, parameter.type]));
  if (states.size !== graph.states.length) throw new Error(`${where}: two states have the same name`);
  if (!states.has(graph.initial)) throw new Error(`${where}: initial state '${graph.initial}' does not exist`);
  for (const state of graph.states) {
    if (state.motion.type !== 'blend1d') continue;
    if (parameters.get(state.motion.parameter) !== 'number') throw new Error(`${where}: state '${state.name}' blends by '${state.motion.parameter}', which is not a number parameter`);
    const points = state.motion.points;
    if (points.length === 0) throw new Error(`${where}: state '${state.name}' has no blend points`);
    if (points.some((point, i) => i > 0 && point.at < points[i - 1]!.at)) throw new Error(`${where}: blend points of state '${state.name}' must be in increasing order`);
  }
  graph.transitions.forEach((transition, i) => {
    if (transition.from !== '*' && !states.has(transition.from)) throw new Error(`${where}: transition ${i} comes from state '${transition.from}', which does not exist`);
    if (!states.has(transition.to)) throw new Error(`${where}: transition ${i} goes to state '${transition.to}', which does not exist`);
    for (const condition of transition.when) {
      const type = parameters.get(condition.parameter);
      if (!type) throw new Error(`${where}: transition ${i} tests parameter '${condition.parameter}', which does not exist`);
      const wants = condition.test === 'trigger' ? 'trigger' : condition.test === 'true' || condition.test === 'false' ? 'bool' : 'number';
      if (type !== wants) throw new Error(`${where}: transition ${i} tests '${condition.parameter}' (${type}) with '${condition.test}', which needs a ${wants} parameter`);
    }
  });
  return graph;
}
