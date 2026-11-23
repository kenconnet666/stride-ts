/**
 * 动画状态机（`.animgraph.json`，Stride 只有代码里的 IBlendTreeBuilder；照 Unity 的 Animator Controller、虚幻的动画蓝图状态机、
 * Godot 的 AnimationTree）：参数（数、开关、触发）、状态（一个剪辑，或按一个参数在几个剪辑之间插值的一维混合）、状态之间的过渡
 * （条件都满足、到了退出时间时淡入淡出过去）。脚本只设参数（`animator.set('speed', 3)`、`animator.trigger('jump')`），动作怎么
 * 接、怎么混在文件里改。运行时见 animation/AnimationGraph.ts、Animator.ts。
 *
 * - 一维混合的点按 at 从小到大排；参数在两点之间时两个剪辑按位置插值，在两头之外时取最近的一个。二维混合（两个参数，比如
 *   移动方向的 x、z）按 Unity 的自由笛卡尔（梯度带）算每个点的权重。几个剪辑的时间按"相位"（0..1）同步：走和跑插值时步子不会错开
 *   （TPP 的 AnimationController 就是这么做的）。
 * - 层（layers）：每层是自己的一套状态和过渡，按遮罩（mask 列的关节和它们的子关节）盖在下面的层上（override）或叠上去（additive），
 *   乘 weight 和 weightParameter（数的参数，比如举枪的程度）：下半身跑、上半身举枪、挥手。
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
  /** 按两个数的参数（x、y）在几个剪辑之间插值（自由笛卡尔）。 */
  blend2d: {
    parameterX: s.string().describe('number parameter for x (strafe)'),
    parameterY: s.string().describe('number parameter for y (forward)'),
    points: s.list(s.object({ at: s.vector(2), clip: s.asset('animation') })).describe('clips at positions in the parameter plane'),
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
  to: s.string().label('Target state'),
  when: s.list(ANIMATION_CONDITION).default([]).describe('all must hold'),
  exitTime: s.number({ min: 0, max: 1, step: 0.05 }).optional().describe('only after the source state has played this much (0..1 of its length)'),
  duration: s.number({ min: 0, step: 0.05, unit: 's' }).default(0.15).describe('crossfade time'),
});

export const ANIMATION_LAYER = s.object({
  name: s.string(),
  mask: s.list(s.string()).describe('joints this layer drives, each with all its children (spine for the upper body)'),
  mode: s.oneOf('override', 'additive').default('override').describe('override replaces the masked joints; additive adds on top'),
  weight: s.number({ min: 0, max: 1, step: 0.05 }).default(1),
  weightParameter: s.string().optional().describe('number parameter that multiplies weight (how far the gun is raised)'),
  states: s.list(ANIMATION_STATE),
  initial: s.string().describe('state to start in'),
  transitions: s.list(ANIMATION_TRANSITION).default([]),
});

export const ANIMATION_GRAPH = s.object({
  name: s.string(),
  parameters: s.list(ANIMATION_PARAMETER).default([]),
  states: s.list(ANIMATION_STATE),
  initial: s.string().describe('state to start in'),
  transitions: s.list(ANIMATION_TRANSITION).default([]),
  layers: s.list(ANIMATION_LAYER).default([]).describe('state machines on top of the base one, each masked to some joints'),
});

export type AnimationGraphFile = InputOf<typeof ANIMATION_GRAPH>;
/** 解析过的状态机（默认值补齐）。 */
export type AnimationGraphData = Infer<typeof ANIMATION_GRAPH>;
export type AnimationStateData = Infer<typeof ANIMATION_STATE>;
export type AnimationMotionData = Infer<typeof ANIMATION_MOTION>;
export type AnimationTransitionData = Infer<typeof ANIMATION_TRANSITION>;
export type AnimationLayerData = Infer<typeof ANIMATION_LAYER>;

/** 一套状态和过渡（基础层或一层）。 */
export interface AnimationMachineData {
  readonly states: readonly AnimationStateData[];
  readonly initial: string;
  readonly transitions: readonly AnimationTransitionData[];
}

/** 文件里的名字都对得上：状态、初始状态、过渡两头、条件和混合用的参数（基础层和每一层）；不对时报错，消息以 where 开头。 */
export function checkAnimationGraph(graph: AnimationGraphData, where: string): AnimationGraphData {
  const parameters = new Map(graph.parameters.map((parameter) => [parameter.name, parameter.type]));
  checkMachine(graph, parameters, where);
  graph.layers.forEach((layer) => {
    const at = `${where}: layer '${layer.name}'`;
    if (layer.mask.length === 0) throw new Error(`${at} has an empty mask`);
    if (layer.weightParameter !== undefined && parameters.get(layer.weightParameter) !== 'number') throw new Error(`${at}: weightParameter '${layer.weightParameter}' is not a number parameter`);
    checkMachine(layer, parameters, at);
  });
  return graph;
}

function checkMachine(machine: AnimationMachineData, parameters: ReadonlyMap<string, string>, where: string): void {
  const states = new Set(machine.states.map((state) => state.name));
  if (states.size !== machine.states.length) throw new Error(`${where}: two states have the same name`);
  if (!states.has(machine.initial)) throw new Error(`${where}: initial state '${machine.initial}' does not exist`);
  const number = (state: string, name: string) => {
    if (parameters.get(name) !== 'number') throw new Error(`${where}: state '${state}' blends by '${name}', which is not a number parameter`);
  };
  for (const state of machine.states) {
    const motion = state.motion;
    if (motion.type === 'clip') continue;
    if (motion.points.length === 0) throw new Error(`${where}: state '${state.name}' has no blend points`);
    if (motion.type === 'blend1d') {
      number(state.name, motion.parameter);
      if (motion.points.some((point, i) => i > 0 && point.at < motion.points[i - 1]!.at)) throw new Error(`${where}: blend points of state '${state.name}' must be in increasing order`);
    } else {
      number(state.name, motion.parameterX);
      number(state.name, motion.parameterY);
    }
  }
  machine.transitions.forEach((transition, i) => {
    if (transition.from !== '*' && !states.has(transition.from)) throw new Error(`${where}: transition ${i} comes from state '${transition.from}', which does not exist`);
    if (!states.has(transition.to)) throw new Error(`${where}: transition ${i} goes to state '${transition.to}', which does not exist`);
    for (const condition of transition.when) {
      const type = parameters.get(condition.parameter);
      if (!type) throw new Error(`${where}: transition ${i} tests parameter '${condition.parameter}', which does not exist`);
      const wants = condition.test === 'trigger' ? 'trigger' : condition.test === 'true' || condition.test === 'false' ? 'bool' : 'number';
      if (type !== wants) throw new Error(`${where}: transition ${i} tests '${condition.parameter}' (${type}) with '${condition.test}', which needs a ${wants} parameter`);
    }
  });
}
