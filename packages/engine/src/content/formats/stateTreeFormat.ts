/**
 * 状态树（`.statetree.json`，Stride 没有；照虚幻 5 的 StateTree）：角色、行人、店员这类东西"现在在干什么"的分层状态，按条件选、
 * 按任务的结果和事件换。运行时见 ai/StateTree.ts、ai/StateTreeRunner.ts。
 *
 * - 状态排成一棵树：文件里是一张平的表，parent 写父状态的名字（没写的是顶层），同一个父状态下的按表里的顺序。选状态时从顶层
 *   往下，按顺序取第一个进入条件（enter）都满足的；有子状态的状态要能选进某个子状态才算选上，最后停在一个叶子上。从根到这个叶子
 *   的一串状态同时是活的，它们的任务都在跑。
 * - 任务（tasks）：进入状态时开始、离开时停。一个状态的任何一个任务结束（成功或失败）这个状态就算完成（同虚幻）；没有任务的状态
 *   不会自己完成，只靠每帧（tick）、事件的过渡离开。
 * - 过渡（transitions）：on 是什么时候看（completed 完成时，succeeded、failed 只看成功、失败，tick 每帧，event 收到事件 event
 *   时），when 的条件都满足就去 to：一个状态的名字，或者 `$next`（这个状态的下一个兄弟）、`$root`（从顶层重新选）、
 *   `$succeeded`、`$failed`（整棵树结束）。从活的叶子往根挨个看，第一条能去的生效。一个状态完成了却没有过渡接住时整棵树按它的
 *   结果结束（StateTreeRunner 默认从头再来）。
 * - 参数（parameters）：数、开关、位置（三个数）；条件比参数，任务读写参数，游戏代码 `runner.set('alarm', true)`。
 * - 任务和条件除了内置的几种，还有 `call`：按名字调代码里登记的（`registerStateTreeTask`、`registerStateTreeCondition`），args 原样给它。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';
import { ENVIRONMENT_QUERY } from './environmentQueryFormat.ts';

export const STATE_TREE_PARAMETER = s.object({
  name: s.string(),
  type: s.oneOf('number', 'bool', 'vector').describe('number, bool (0 or 1) or vector (a position, x y z)'),
  default: s.number().default(0).describe('starting value of a number or bool'),
  defaultVector: s.vector(3).default([0, 0, 0]).describe('starting value of a vector'),
});

export const STATE_TREE_CONDITION = s.union('type', {
  /** 比一个数或开关的参数（开关按 0、1 比）。 */
  parameter: {
    parameter: s.string(),
    test: s.oneOf('>', '<', '>=', '<=', '==', '!=').default('=='),
    value: s.number({ step: 0.05 }).default(1),
  },
  /** 离一个位置参数的水平距离。 */
  distance: {
    parameter: s.string().describe('vector parameter'),
    test: s.oneOf('<', '>').default('<'),
    value: s.number({ min: 0, step: 0.5, unit: 'm' }).default(5),
  },
  /** 感知到（ai/Perception.ts：实体上要有 Perceiver）tag 那种东西。 */
  perceives: {
    tag: s.string().default('').describe('stimulus tag; empty matches any'),
    sense: s.oneOf('any', 'sight', 'hearing').default('any'),
    seeing: s.bool().default(false).describe('only while it is in sight right now (not remembered)'),
  },
  /** 按概率成立（每次看都重新掷）。 */
  chance: { probability: s.number({ min: 0, max: 1, step: 0.05 }).default(0.5) },
  /** 代码里登记的条件（registerStateTreeCondition）。 */
  call: { name: s.string(), args: s.record().default({}) },
}, { not: s.bool().default(false).describe('inverts the result') });

export const STATE_TREE_TASK = s.union('type', {
  /** 等一会儿：seconds 加上 0..random 之间的随机秒数，到了成功。 */
  wait: { seconds: s.number({ min: 0, step: 0.1, unit: 's' }).default(1), random: s.number({ min: 0, step: 0.1, unit: 's' }).default(0) },
  /** 走到一个位置（point，或 parameter 那个位置参数），用实体上的 CrowdAgent；到了成功，超过 timeout 还没到失败。 */
  moveTo: {
    parameter: s.string().optional().describe('vector parameter with the destination'),
    point: s.vector(3, 'm').optional().describe('destination when no parameter is given'),
    tolerance: s.number({ min: 0.1, step: 0.1, unit: 'm' }).default(0.6),
    timeout: s.number({ min: 0, step: 1, unit: 's' }).default(60).describe('fails when not there after this long (0: never)'),
  },
  /** 在进入状态时站的地方附近随便走到一个点（导航网格上找得到路的），到了成功。 */
  wander: {
    radius: s.number({ min: 1, step: 1, unit: 'm' }).default(15),
    tolerance: s.number({ min: 0.1, step: 0.1, unit: 'm' }).default(0.8),
    timeout: s.number({ min: 0, step: 1, unit: 's' }).default(60),
  },
  /** 从一个位置参数那里跑开 distance 米（导航网格上走得到的那一头），到了成功。 */
  flee: {
    parameter: s.string().describe('vector parameter with what to run from'),
    distance: s.number({ min: 1, step: 1, unit: 'm' }).default(25),
    tolerance: s.number({ min: 0.1, step: 0.1, unit: 'm' }).default(0.8),
    timeout: s.number({ min: 0, step: 1, unit: 's' }).default(30),
  },
  /** 环境查询（content/formats/environmentQueryFormat.ts）找一个点写进位置参数 store：找到了成功，一个都没留下失败。 */
  findSpot: {
    query: ENVIRONMENT_QUERY,
    store: s.string().describe('vector parameter that gets the spot'),
  },
  /**
   * 用一个智能物体（ai/SmartObjects.ts）：附近 radius 米以内找能干 activity 的空槽占上，走过去、转向槽的朝向，用的时候
   * Animator 的 animator 参数是 1，待 seconds（加 0..random）秒后放开、成功；找不到空槽、走不到失败。
   */
  useSmartObject: {
    activity: s.string().default('sit'),
    radius: s.number({ min: 1, step: 1, unit: 'm' }).default(20),
    seconds: s.number({ min: 0, step: 0.5, unit: 's' }).default(8),
    random: s.number({ min: 0, step: 0.5, unit: 's' }).default(4),
    animator: s.string().optional().describe('Animator parameter set to 1 while using'),
    tolerance: s.number({ min: 0.1, step: 0.1, unit: 'm' }).default(0.5),
    timeout: s.number({ min: 0, step: 1, unit: 's' }).default(40),
  },
  /** 设一个参数（数、开关），马上成功。 */
  set: { parameter: s.string(), value: s.number({ step: 0.05 }).default(1) },
  /** 设实体上 Animator 的参数，马上成功。 */
  animator: { parameter: s.string(), value: s.number({ step: 0.05 }).default(1) },
  /** 发一个全局的命名事件（game.events），马上成功。 */
  emit: { event: s.string() },
  /** 一直在跑：每帧把感知到的 tag 那种东西里最近的一次写进参数（store 是它的位置，flag 是有没有），给过渡的条件用。 */
  sense: {
    tag: s.string().default('').describe('stimulus tag; empty matches any'),
    sense: s.oneOf('any', 'sight', 'hearing').default('any'),
    store: s.string().optional().describe('vector parameter that gets the last known position'),
    flag: s.string().optional().describe('bool parameter set while something is perceived'),
  },
  /** 停在原地（CrowdAgent），一直在跑（靠过渡离开）。 */
  stand: {},
  /** 代码里登记的任务（registerStateTreeTask）。 */
  call: { name: s.string(), args: s.record().default({}) },
});

export const STATE_TREE_TRANSITION = s.object({
  on: s.oneOf('completed', 'succeeded', 'failed', 'tick', 'event').default('completed'),
  event: s.string().optional().describe('event name when on is event'),
  when: s.list(STATE_TREE_CONDITION).default([]).describe('all must hold'),
  to: s.string().label('Target state').describe('a state, or $next, $root, $succeeded, $failed'),
});

export const STATE_TREE_STATE = s.object({
  name: s.string(),
  parent: s.string().optional().describe('parent state; top level when empty'),
  enter: s.list(STATE_TREE_CONDITION).default([]).describe('all must hold for the state to be selected'),
  tasks: s.list(STATE_TREE_TASK).default([]),
  transitions: s.list(STATE_TREE_TRANSITION).default([]),
});

export const STATE_TREE = s.object({
  name: s.string(),
  parameters: s.list(STATE_TREE_PARAMETER).default([]),
  states: s.list(STATE_TREE_STATE).describe('flat list; parent links make the tree, list order is the order among siblings'),
});

/** 文件里的状态树（有默认值的可以不写）。 */
export type StateTreeFile = InputOf<typeof STATE_TREE>;
/** 解析过的状态树（默认值补齐）。 */
export type StateTreeData = Infer<typeof STATE_TREE>;
export type StateTreeStateData = Infer<typeof STATE_TREE_STATE>;
export type StateTreeTaskData = Infer<typeof STATE_TREE_TASK>;
export type StateTreeConditionData = Infer<typeof STATE_TREE_CONDITION>;
export type StateTreeTransitionData = Infer<typeof STATE_TREE_TRANSITION>;

/** 过渡的特殊目标。 */
export const STATE_TREE_TARGETS = ['$next', '$root', '$succeeded', '$failed'] as const;

/** 名字都对得上：状态不重名、不用 $ 开头，父状态存在、没有环，过渡的目标、条件和任务用的参数存在且种类对；不对时报错，消息以 where 开头。 */
export function checkStateTree(tree: StateTreeData, where: string): StateTreeData {
  const states = new Map(tree.states.map((state) => [state.name, state]));
  if (states.size !== tree.states.length) throw new Error(`${where}: two states have the same name`);
  if (tree.states.length === 0) throw new Error(`${where}: the tree has no states`);
  const parameters = new Map(tree.parameters.map((parameter) => [parameter.name, parameter.type]));
  if (parameters.size !== tree.parameters.length) throw new Error(`${where}: two parameters have the same name`);
  const parameter = (at: string, name: string, kinds: readonly string[]) => {
    const kind = parameters.get(name);
    if (!kind) throw new Error(`${at} uses parameter '${name}', which does not exist`);
    if (!kinds.includes(kind)) throw new Error(`${at} uses '${name}' (${kind}), which needs a ${kinds.join(' or ')} parameter`);
  };
  const condition = (at: string, c: StateTreeConditionData) => {
    if (c.type === 'parameter') parameter(at, c.parameter, ['number', 'bool']);
    if (c.type === 'distance') parameter(at, c.parameter, ['vector']);
  };
  for (const state of tree.states) {
    const at = `${where}: state '${state.name}'`;
    if (state.name.startsWith('$')) throw new Error(`${at}: state names cannot start with $`);
    if (state.parent !== undefined) {
      if (!states.has(state.parent)) throw new Error(`${at} has parent '${state.parent}', which does not exist`);
      for (let up: string | undefined = state.parent, steps = 0; up !== undefined; up = states.get(up)?.parent, steps++) {
        if (up === state.name || steps > tree.states.length) throw new Error(`${at} is its own ancestor`);
      }
    }
    state.enter.forEach((c) => condition(`${at} (enter)`, c));
    state.tasks.forEach((task, i) => {
      const atTask = `${at} task ${i} (${task.type})`;
      if (task.type === 'set') parameter(atTask, task.parameter, ['number', 'bool']);
      if (task.type === 'flee') parameter(atTask, task.parameter, ['vector']);
      if (task.type === 'findSpot') {
        parameter(atTask, task.store, ['vector']);
        const vectors = [task.query.generator.around, ...task.query.tests.flatMap((test) => (test.type === 'distance' ? [test.to] : test.type === 'visible' ? [test.from] : []))];
        for (const name of vectors) if (name !== '') parameter(atTask, name, ['vector']);
      }
      if (task.type === 'sense') {
        if (task.store !== undefined) parameter(atTask, task.store, ['vector']);
        if (task.flag !== undefined) parameter(atTask, task.flag, ['number', 'bool']);
      }
      if (task.type === 'moveTo') {
        if (task.parameter !== undefined) parameter(atTask, task.parameter, ['vector']);
        else if (task.point === undefined) throw new Error(`${atTask} needs a point or a vector parameter`);
      }
    });
    state.transitions.forEach((transition, i) => {
      const atTransition = `${at} transition ${i}`;
      if (!states.has(transition.to) && !(STATE_TREE_TARGETS as readonly string[]).includes(transition.to)) {
        throw new Error(`${atTransition} goes to '${transition.to}', which is neither a state nor one of ${STATE_TREE_TARGETS.join(', ')}`);
      }
      if (transition.on === 'event' && !transition.event) throw new Error(`${atTransition} waits for an event but names none`);
      transition.when.forEach((c) => condition(atTransition, c));
    });
  }
  return tree;
}
