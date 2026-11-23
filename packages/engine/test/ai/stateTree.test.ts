import { describe, expect, test } from 'vitest';
import { registerStateTreeCondition, registerStateTreeTask, StateTreeInstance, type StateTreeTaskRun } from '../../src';
import { STATE_TREE, checkStateTree, type StateTreeFile } from '../../src/content/formats/format';
import '../../src/ai/stateTreeTasks';

function instance(file: StateTreeFile) {
  return new StateTreeInstance({ path: 'Test', data: checkStateTree(STATE_TREE.parse(file, 'test'), 'test') });
}

/** 跑 seconds 秒（每步 0.1 秒），记下每一步活的路径变成了什么。 */
function run(tree: StateTreeInstance, seconds: number): string[] {
  const seen: string[] = [];
  for (let t = 0; t < seconds - 1e-9; t += 0.1) {
    tree.update(0.1);
    const path = tree.status === 'running' ? tree.activePath.join('/') : tree.status;
    if (seen.at(-1) !== path) seen.push(path);
  }
  return seen;
}

/** 行人：平时等一会儿、再等一会儿（$next），alarm 开着时选不进 Calm、进 Panic；Calm 收到 scare 事件去 Panic。 */
const PEDESTRIAN: StateTreeFile = {
  name: 'Pedestrian',
  parameters: [{ name: 'alarm', type: 'bool' }, { name: 'calls', type: 'number' }],
  states: [
    { name: 'Calm', enter: [{ type: 'parameter', parameter: 'alarm', value: 0 }], transitions: [{ on: 'event', event: 'scare', to: 'Panic' }] },
    { name: 'Idle', parent: 'Calm', tasks: [{ type: 'wait', seconds: 1 }], transitions: [{ to: '$next' }] },
    { name: 'Look', parent: 'Calm', tasks: [{ type: 'wait', seconds: 0.5 }, { type: 'set', parameter: 'calls', value: 3 }], transitions: [{ on: 'tick', when: [{ type: 'parameter', parameter: 'calls', test: '>=', value: 3 }], to: 'Rest' }] },
    { name: 'Rest', parent: 'Calm', tasks: [{ type: 'wait', seconds: 0.5 }] },
    { name: 'Panic', tasks: [{ type: 'wait', seconds: 1 }], transitions: [{ to: '$root' }] },
  ],
};

describe('状态树', () => {
  test('按进入条件选到叶子；完成了按过渡换（$next、条件、去别的状态）；没有过渡接住的完成结束整棵树', () => {
    const tree = instance(PEDESTRIAN);
    // Look 的 set 任务马上成功，状态完成，但没有完成时的过渡——tick 过渡先接住（calls 已经是 3）去 Rest；Rest 完成时没有过渡，
    // 往上看 Calm 也没有完成的过渡：整棵树成功结束
    expect(run(tree, 3)).toEqual(['Calm/Idle', 'Calm/Look', 'Calm/Rest', 'succeeded']);
    tree.restart();
    expect(tree.activePath).toEqual(['Calm', 'Idle']);
  });

  test('参数让选择换路；事件在父状态的过渡上接住；$root 重新从顶层选', () => {
    const tree = instance(PEDESTRIAN);
    tree.set('alarm', true);
    tree.update(0.1);
    expect(tree.activePath).toEqual(['Panic']);
    tree.set('alarm', false);
    expect(run(tree, 1.1)).toEqual(['Panic', 'Calm/Idle']);
    tree.send('scare');
    tree.update(0.1);
    expect(tree.activePath).toEqual(['Panic']);
    expect(tree.transitions).toBe(2);
    // 事件用过就清掉
    tree.update(0.1);
    expect(tree.activePath).toEqual(['Panic']);
  });

  test('代码登记的任务和条件：进入、每帧、离开都调到；去自己时重新进入；not 取反', () => {
    const log: string[] = [];
    registerStateTreeTask('count', (_context, args) => {
      let n = 0;
      log.push(`enter ${String(args['label'])}`);
      const run: StateTreeTaskRun = {
        update: () => (++n >= 3 ? 'failed' : 'running'),
        exit: () => log.push(`exit after ${n}`),
      };
      return run;
    });
    registerStateTreeCondition('even', (context) => context.tree.get('n') % 2 === 0);
    const tree = instance({
      name: 'Custom',
      parameters: [{ name: 'n', type: 'number', default: 1 }],
      states: [
        { name: 'Odd', enter: [{ type: 'call', name: 'even', not: true }], tasks: [{ type: 'call', name: 'count', args: { label: 'odd' } }], transitions: [{ on: 'failed', to: 'Odd' }] },
        { name: 'Even', tasks: [{ type: 'stand' }] },
      ],
    });
    for (let i = 0; i < 7; i++) tree.update(0.1);
    expect(tree.activePath).toEqual(['Odd']);
    expect(log).toEqual(['enter odd', 'exit after 3', 'enter odd', 'exit after 3', 'enter odd']);
    tree.set('n', 2);
    tree.restart();
    expect(tree.activePath).toEqual(['Even']);
    expect(log.at(-1)).toBe('exit after 1');
  });

  test('文件里名字对不上、有环、目标不存在、参数种类不对时报错', () => {
    const bad = (states: StateTreeFile['states'], parameters: StateTreeFile['parameters'] = []) => () => checkStateTree(STATE_TREE.parse({ name: 'Bad', parameters, states }, 'bad'), 'bad');
    expect(bad([{ name: 'A' }, { name: 'A' }])).toThrow(/same name/);
    expect(bad([{ name: 'A', parent: 'B' }, { name: 'B', parent: 'A' }])).toThrow(/its own ancestor/);
    expect(bad([{ name: 'A', transitions: [{ to: 'Nowhere' }] }])).toThrow(/neither a state/);
    expect(bad([{ name: '$A' }])).toThrow(/cannot start with \$/);
    expect(bad([{ name: 'A', enter: [{ type: 'distance', parameter: 'n' }] }], [{ name: 'n', type: 'number' }])).toThrow(/needs a vector parameter/);
    expect(bad([{ name: 'A', tasks: [{ type: 'moveTo' }] }])).toThrow(/needs a point or a vector parameter/);
    expect(bad([{ name: 'A', transitions: [{ on: 'event', to: 'A' }] }])).toThrow(/names none/);
  });
});
