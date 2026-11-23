/**
 * 状态树的内置任务（content/formats/stateTreeFormat.ts 的 STATE_TREE_TASK）：等、走到、闲逛、站着、设参数、设 Animator 的参数、
 * 发事件。走路的任务用实体上的 CrowdAgent（导航网格上的人群）。
 */
import { Animator } from '../animation/Animator';
import { Transform } from '../engine/transform';
import { CrowdAgent } from '../physics/CrowdAgent';
import { runEnvironmentQuery } from './EnvironmentQuery';
import { perceivedBy, registerBuiltInTask, type StateTreeContext, type StateTreeStatus, type StateTreeTaskRun } from './StateTree';

const done: StateTreeTaskRun = { update: () => 'succeeded' };

function agentOf(context: StateTreeContext, task: string): CrowdAgent | undefined {
  const agent = context.entity?.get(CrowdAgent);
  if (!agent) console.warn(`state tree '${context.tree.tree.path}': ${task} needs a CrowdAgent on '${context.entity?.name ?? '(no entity)'}'`);
  return agent;
}

/** 走向 point，到了成功，超过 timeout 秒没到失败；离开状态时站住。 */
function walk(agent: CrowdAgent, point: { x: number; y: number; z: number }, tolerance: number, timeout: number): StateTreeTaskRun {
  agent.moveTo(point);
  let time = 0;
  return {
    update(elapsed): StateTreeStatus {
      time += elapsed;
      if (agent.arrived(tolerance)) return 'succeeded';
      return timeout > 0 && time > timeout ? 'failed' : 'running';
    },
    exit() {
      if (!agent.arrived(tolerance)) agent.stop();
    },
  };
}

registerBuiltInTask('wait', (_context, task) => {
  const seconds = task.seconds + Math.random() * task.random;
  let time = 0;
  return { update: (elapsed) => ((time += elapsed) >= seconds ? 'succeeded' : 'running') };
});

registerBuiltInTask('moveTo', (context, task) => {
  const agent = agentOf(context, 'moveTo');
  if (!agent) return { update: () => 'failed' };
  const point = task.parameter !== undefined ? context.tree.vector(task.parameter) : { x: task.point![0], y: task.point![1], z: task.point![2] };
  return walk(agent, { x: point.x, y: point.y, z: point.z }, task.tolerance, task.timeout);
});

registerBuiltInTask('wander', (context, task) => {
  const agent = agentOf(context, 'wander');
  const world = context.entity?.get(Transform)?.world;
  const navigation = context.game?.navigation;
  if (!agent || !world || !navigation) return { update: () => 'failed' };
  // 附近随便挑一个点，取导航网格上走得到的那一头（路走不通时是最近能到的地方）；挑几次都找不到路时失败
  const from = { x: world[12]!, y: world[13]!, z: world[14]! };
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * Math.PI * 2, distance = task.radius * Math.sqrt(Math.random());
    const end = navigation.findPath(from, { x: from.x + Math.cos(angle) * distance, y: from.y, z: from.z + Math.sin(angle) * distance })?.at(-1);
    if (end && Math.hypot(end.x - from.x, end.z - from.z) > task.tolerance) return walk(agent, end, task.tolerance, task.timeout);
  }
  return { update: () => 'failed' };
});

registerBuiltInTask('flee', (context, task) => {
  const agent = agentOf(context, 'flee');
  const world = context.entity?.get(Transform)?.world;
  const navigation = context.game?.navigation;
  if (!agent || !world || !navigation) return { update: () => 'failed' };
  // 背对着它跑；正后方走不通时左右偏一点再试
  const from = { x: world[12]!, y: world[13]!, z: world[14]! };
  const threat = context.tree.vector(task.parameter);
  const away = Math.atan2(from.z - threat.z, from.x - threat.x);
  for (const turn of [0, 0.5, -0.5, 1, -1]) {
    const angle = away + turn;
    const end = navigation.findPath(from, { x: from.x + Math.cos(angle) * task.distance, y: from.y, z: from.z + Math.sin(angle) * task.distance })?.at(-1);
    if (end && Math.hypot(end.x - from.x, end.z - from.z) > task.distance * 0.3) return walk(agent, end, task.tolerance, task.timeout);
  }
  return { update: () => 'failed' };
});

registerBuiltInTask('findSpot', (context, task) => {
  const world = context.entity?.get(Transform)?.world;
  const game = context.game;
  if (!world || !game) return { update: () => 'failed' };
  const result = runEnvironmentQuery(task.query, { game, querier: { x: world[12]!, y: world[13]!, z: world[14]! }, parameter: (name) => context.tree.vector(name) });
  if (result.point) context.tree.set(task.store, result.point);
  const status = result.point ? 'succeeded' : 'failed';
  return { update: () => status };
});

registerBuiltInTask('sense', (context, task) => ({
  update() {
    const found = perceivedBy(context, task.tag, task.sense);
    if (task.flag !== undefined) context.tree.set(task.flag, found !== undefined);
    if (found && task.store !== undefined) context.tree.set(task.store, found.position);
    return 'running';
  },
}));

registerBuiltInTask('stand', (context) => {
  context.entity?.get(CrowdAgent)?.stop();
  return {};
});

registerBuiltInTask('set', (context, task) => {
  context.tree.set(task.parameter, task.value);
  return done;
});

registerBuiltInTask('animator', (context, task) => {
  const animator = context.entity?.get(Animator);
  if (!animator) {
    console.warn(`state tree '${context.tree.tree.path}': animator needs an Animator on '${context.entity?.name ?? '(no entity)'}'`);
    return { update: () => 'failed' };
  }
  animator.set(task.parameter, task.value);
  return done;
});

registerBuiltInTask('emit', (context, task) => {
  context.game?.events.emitUnchecked(task.event, context.entity);
  return done;
});
