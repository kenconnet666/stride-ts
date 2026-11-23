import { describe, expect, test } from 'vitest';
import { AnimationClip, AnimationGraphInstance, blend1d, blend2d, type AnimationBlendStack } from '../../src';
import { ANIMATION_GRAPH, checkAnimationGraph, type AnimationGraphFile } from '../../src/content/formats/format';

const clip = (name: string, duration: number) => new AnimationClip(name, duration, 'loopInfinite', undefined);
const CLIPS = { Idle: clip('Idle', 2), Walk: clip('Walk', 1), Run: clip('Run', 0.6), JumpStart: clip('JumpStart', 0.3), JumpLoop: clip('JumpLoop', 0.8), JumpEnd: clip('JumpEnd', 0.4) };

/** TPP 的 AnimationController 写成状态机：走（按跑速在待机、走、跑之间插值）、起跳、空中、落地。 */
const TPP: AnimationGraphFile = {
  name: 'Mannequin',
  parameters: [{ name: 'runSpeed', type: 'number' }, { name: 'grounded', type: 'bool', default: 1 }],
  states: [
    { name: 'Walk', motion: { type: 'blend1d', parameter: 'runSpeed', points: [{ at: 0, clip: 'Idle' }, { at: 0.25, clip: 'Walk' }, { at: 1, clip: 'Run' }] } },
    { name: 'JumpStart', motion: { type: 'clip', clip: 'JumpStart' }, loop: false },
    { name: 'Airborne', motion: { type: 'clip', clip: 'JumpLoop' } },
    { name: 'Land', motion: { type: 'clip', clip: 'JumpEnd' }, loop: false },
  ],
  initial: 'Walk',
  transitions: [
    { from: 'Walk', to: 'JumpStart', when: [{ parameter: 'grounded', test: 'false' }], duration: 0 },
    { from: 'Land', to: 'JumpStart', when: [{ parameter: 'grounded', test: 'false' }], duration: 0 },
    { from: 'JumpStart', to: 'Land', when: [{ parameter: 'grounded', test: 'true' }], duration: 0 },
    { from: 'Airborne', to: 'Land', when: [{ parameter: 'grounded', test: 'true' }], duration: 0 },
    { from: 'JumpStart', to: 'Airborne', duration: 0 },
    { from: 'Land', to: 'Walk', duration: 0.1 },
  ],
};

function instance(file: AnimationGraphFile) {
  const data = checkAnimationGraph(ANIMATION_GRAPH.parse(file, 'test'), 'test');
  return new AnimationGraphInstance({ path: 'Test', data, clips: new Map(Object.entries(CLIPS)) });
}

/** 记下压进混合栈的操作。 */
function record(graph: AnimationGraphInstance): string[] {
  const ops: string[] = [];
  const stack: AnimationBlendStack = {
    push(clip, time) { ops.push(`${clip.name}@${time.toFixed(3)}`); return this; },
    blend(factor) { ops.push(`blend ${factor.toFixed(3)}`); return this; },
    add(factor) { ops.push(`add ${factor}`); return this; },
    subtract(factor) { ops.push(`subtract ${factor}`); return this; },
    blendMasked(factor, joints) { ops.push(`blendMasked ${factor.toFixed(3)} ${joints.join(',')}`); return this; },
    addMasked(factor, joints) { ops.push(`addMasked ${factor.toFixed(3)} ${joints.join(',')}`); return this; },
  };
  graph.buildBlendTree(stack);
  return ops;
}

describe('动画状态机', () => {
  test('一维混合：按参数在相邻的两个剪辑之间插值，时间按相位同步（时长按插值出的时长推进）', () => {
    const graph = instance(TPP);
    expect(record(graph)).toEqual(['Idle@0.000']);
    graph.set('runSpeed', 0.625);
    // 走（1 秒）和跑（0.6 秒）各一半：时长 0.8 秒，推进 0.2 秒是相位 0.25
    graph.update(0.2);
    expect(graph.phase).toBeCloseTo(0.25, 9);
    expect(record(graph)).toEqual(['Walk@0.250', 'Run@0.150', 'blend 0.500']);
    graph.set('runSpeed', 2);
    expect(record(graph)).toEqual(['Run@0.150']);
  });

  test('跳起、空中、落地、走：离地就起跳，起跳放完进空中，着地就落地，落地放完淡回走', () => {
    const graph = instance(TPP);
    graph.set('grounded', false);
    graph.update(0.1);
    expect(graph.state).toBe('JumpStart');
    graph.update(0.29);
    expect(graph.state).toBe('JumpStart');
    graph.update(0.05);
    expect(graph.state).toBe('Airborne');
    graph.set('grounded', true);
    graph.update(0.1);
    expect(graph.state).toBe('Land');
    graph.update(0.5);
    graph.update(0.05);
    expect(graph.state).toBe('Walk');
    expect(graph.fadingFrom).toBe('Land');
    // 淡入淡出：落地停在最后一帧，和走按淡入的进度混
    expect(record(graph)).toEqual(['JumpEnd@0.400', 'Idle@0.050', 'blend 0.500']);
    graph.update(0.06);
    expect(graph.fadingFrom).toBeUndefined();
  });

  test('触发：用到它的过渡生效时清掉；* 从任何状态过去（除了自己）；exitTime', () => {
    const graph = instance({
      name: 'Trigger',
      parameters: [{ name: 'hit', type: 'trigger' }, { name: 'speed', type: 'number' }],
      states: [{ name: 'Idle', motion: { type: 'clip', clip: 'Idle' } }, { name: 'Flinch', motion: { type: 'clip', clip: 'JumpEnd' }, loop: false }, { name: 'Run', motion: { type: 'clip', clip: 'Run' } }],
      initial: 'Idle',
      transitions: [
        { from: '*', to: 'Flinch', when: [{ parameter: 'hit', test: 'trigger' }], duration: 0 },
        { from: 'Flinch', to: 'Idle', duration: 0 },
        { from: 'Idle', to: 'Run', when: [{ parameter: 'speed', test: '>', value: 1 }], exitTime: 0.5, duration: 0 },
      ],
    });
    graph.trigger('hit');
    graph.update(0.01);
    expect(graph.state).toBe('Flinch');
    expect(graph.get('hit')).toBe(0);
    graph.update(0.45);
    graph.update(0.01);
    expect(graph.state).toBe('Idle');
    graph.set('speed', 3);
    graph.update(0.5);
    expect(graph.state).toBe('Idle');
    graph.update(0.6);
    graph.update(0.01);
    expect(graph.state).toBe('Run');
  });

  test('二维混合：在点上只取那一个，在两点中间各一半，四个方向的中心是待机；权重加起来是 1', () => {
    const points: [number, number][] = [[0, 0], [0, 1], [1, 0], [0, -1], [-1, 0]];
    expect(blend2d([0, 1], points).map((w) => +w.toFixed(6))).toEqual([0, 1, 0, 0, 0]);
    expect(blend2d([0, 0], points).map((w) => +w.toFixed(6))).toEqual([1, 0, 0, 0, 0]);
    const diagonal = blend2d([0.5, 0.5], points);
    expect(diagonal.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(diagonal[1]).toBeCloseTo(diagonal[2]!, 9);
    expect(diagonal[3]).toBe(0);
    expect(blend1d(0.5, [{ at: 0 }, { at: 1 }, { at: 2 }])).toEqual([{ index: 0, weight: 0.5 }, { index: 1, weight: 0.5 }]);
  });

  test('分层：基础层之后压上层的动作、按遮罩盖上去，权重乘上权重参数；参数为 0 时不压', () => {
    const graph = instance({
      ...TPP,
      parameters: [...TPP.parameters!, { name: 'aim', type: 'number', default: 0.5 }],
      layers: [{ name: 'Upper', mask: ['spine'], weightParameter: 'aim', states: [{ name: 'Wave', motion: { type: 'clip', clip: 'JumpLoop' } }], initial: 'Wave' }],
    });
    expect(graph.layerState('Upper')).toBe('Wave');
    expect(record(graph)).toEqual(['Idle@0.000', 'JumpLoop@0.000', 'blendMasked 0.500 spine']);
    graph.set('aim', 0);
    expect(record(graph)).toEqual(['Idle@0.000']);
  });

  test('名字对不上时报错', () => {
    const check = (file: AnimationGraphFile) => () => checkAnimationGraph(ANIMATION_GRAPH.parse(file, 'g'), 'g');
    expect(check({ ...TPP, initial: 'Swim' })).toThrow(/initial state 'Swim'/);
    expect(check({ ...TPP, transitions: [{ from: 'Walk', to: 'Fly' }] })).toThrow(/goes to state 'Fly'/);
    expect(check({ ...TPP, transitions: [{ from: 'Walk', to: 'Land', when: [{ parameter: 'runSpeed', test: 'true' }] }] })).toThrow(/needs a bool parameter/);
    expect(check({ ...TPP, layers: [{ name: 'Upper', mask: [], states: [{ name: 'A', motion: { type: 'clip', clip: 'Idle' } }], initial: 'A' }] })).toThrow(/layer 'Upper' has an empty mask/);
    expect(check({ ...TPP, layers: [{ name: 'Upper', mask: ['spine'], states: [{ name: 'A', motion: { type: 'clip', clip: 'Idle' } }], initial: 'B' }] })).toThrow(/layer 'Upper': initial state 'B'/);
  });
});
