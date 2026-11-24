import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { Sound } from '../../src/audio/Sound';
import { distanceGain, piecewiseLinear, type SoundEvent } from '../../src/audio/SoundEvents';
import { SOUND_EVENT, checkSoundEvent, type SoundEventFile } from '../../src/content/formats/soundEventFormat';
import { AmbientSound, Game, Transform } from '../../src';
import { FakeContext } from '../fakeAudio';

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1 });
});

afterAll(() => native?.shutdown());

function setup() {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context as unknown as AudioContext);
  void engine.resume();
  // 固定的随机数：按顺序给
  let roll = 0;
  engine.events.random = () => [0.1, 0.9, 0.5][roll++ % 3]!;
  const sounds = new Map(['A', 'B', 'Grass', 'Stone', 'Cloth', 'Loop'].map((name) => [name, new Sound(engine, name, { buffer: { duration: 1 } as AudioBuffer })] as const));
  const event = (file: Omit<SoundEventFile, 'name'>): SoundEvent => ({ path: 'Test', data: checkSoundEvent(SOUND_EVENT.parse({ name: 'Test', ...file }), 'test'), sounds });
  return { context, engine, event };
}

/** 一个实例放着的声音的名字（层的顺序）。 */
const names = (instance: { voices: readonly { instance: { sound: { name: string } } }[] } | undefined) => instance!.voices.map((voice) => voice.instance.sound.name);

describe('声音事件的格式', () => {
  test('条件、曲线引用的参数要声明，标签的值要在 values 里', () => {
    const parse = (file: object) => checkSoundEvent(SOUND_EVENT.parse({ name: 'X', ...file }), 'x');
    expect(() => parse({ variants: [{ sound: 'A', when: { surface: 'grass' } }] })).toThrow(/not declared/);
    expect(() => parse({ parameters: [{ name: 'surface', type: 'label', values: ['grass'] }], variants: [{ sound: 'A', when: { surface: 'mud' } }] })).toThrow(/not one of/);
    expect(() => parse({ parameters: [{ name: 'speed' }], variants: [{ sound: 'A', when: { speed: 'fast' } }] })).toThrow(/as a label/);
    expect(() => parse({ variants: [] })).toThrow(/at least one variant/);
    expect(() => parse({ variants: [{ sound: 'A' }], spatial: { minDistance: 10, maxDistance: 5 } })).toThrow(/maxDistance/);
  });

  test('距离的衰减和分段线性的曲线', () => {
    expect([0.5, 2, 4, 50].map((d) => distanceGain(d, 1, 50, 'inverse'))).toEqual([1, 0.5, 0.25, 0]);
    expect(distanceGain(25.5, 1, 50, 'linear')).toBeCloseTo(0.5, 5);
    [-1, 0.5, 2, 9].map((x) => piecewiseLinear([[0, 0.2], [1, 1], [3, 1.5]], x)).forEach((value, i) => expect(value).toBeCloseTo([0.2, 0.6, 1.25, 1.5][i]!, 9));
  });
});

describe('声音事件的运行时', () => {
  test('按标签选变体、几层一起放、层的音量跟着数的参数；同一层不连着挑同一个', () => {
    const { engine, event } = setup();
    const step = event({
      parameters: [{ name: 'surface', type: 'label', values: ['grass', 'stone'] }, { name: 'speed' }],
      variants: [
        { sound: 'Grass', when: { surface: 'grass' } },
        { sound: 'Stone', when: { surface: 'stone' } },
        { sound: 'Cloth', layer: 'cloth', when: { speed: [0.5, 2] } },
      ],
      layers: [{ name: 'cloth', volume: { parameter: 'speed', points: [[0.5, 0.2], [2, 1]] } }],
    });
    const events = engine.events;
    expect(names(events.play(step, { parameters: { surface: 'grass', speed: 0.2 } }))).toEqual(['Grass']);
    const running = events.play(step, { parameters: { surface: 'stone', speed: 1.25 } });
    expect(names(running)).toEqual(['Stone', 'Cloth']);
    const cloth = running!.voices[1]!.instance;
    expect(cloth.volume).toBeCloseTo(0.6, 5);
    running!.setParameter('speed', 2);
    expect(cloth.volume).toBeCloseTo(1, 5);

    const random = event({ variants: [{ sound: 'A' }, { sound: 'B' }] });
    const picks = Array.from({ length: 6 }, () => names(events.play(random))[0]);
    // 不连着两次一样
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
  });

  test('发声满了按优先级、远近留：远的、太远的虚拟化；一次性的虚拟着放过了时长就结束', () => {
    const { engine, event } = setup();
    const events = engine.events;
    events.maxVoices = 2;
    const spatial = { minDistance: 1, maxDistance: 50 };
    const quiet = event({ variants: [{ sound: 'A' }], spatial, priority: 10 });
    const loud = event({ variants: [{ sound: 'B' }], spatial, priority: 80 });
    const near = events.play(quiet, { position: { x: 2, y: 0, z: 0 } })!;
    const important = events.play(loud, { position: { x: 30, y: 0, z: 0 } })!;
    const far = events.play(quiet, { position: { x: 20, y: 0, z: 0 } })!;
    const outOfRange = events.play(quiet, { position: { x: 80, y: 0, z: 0 } })!;
    events.update([0, 0, 0], 0.1);
    expect([near.real, important.real, far.virtual, outOfRange.virtual]).toEqual([true, true, true, true]);
    expect(events.stats).toMatchObject({ instances: 4, real: 2, virtual: 2 });
    // 出声的那路按距离衰减：2 米的是 1/2
    expect(near.chain.gain.gain.value).toBeCloseTo(0.5, 5);
    expect(outOfRange.chain.gain.gain.value).toBe(0);
    // 一秒多以后虚拟的一次性声音放过了时长：结束
    events.update([0, 0, 0], 1.2);
    expect(far.playing).toBe(false);
    expect(outOfRange.playing).toBe(false);
  });

  test('每个事件同时最多几个：抢最早的，或者不放新的', () => {
    const { engine, event } = setup();
    const events = engine.events;
    const oldest = event({ variants: [{ sound: 'A' }], maxInstances: 2, steal: 'oldest' });
    const first = events.play(oldest)!;
    events.play(oldest);
    events.play(oldest);
    expect(first.playing).toBe(false);
    expect(events.instances.filter((instance) => instance.event === oldest)).toHaveLength(2);
    const none = event({ variants: [{ sound: 'B' }], maxInstances: 1, steal: 'none' });
    expect(events.play(none)).toBeDefined();
    expect(events.play(none)).toBeUndefined();
  });

  test('挡住了：慢慢变闷、变小；挪开以后回来', () => {
    const { engine, event } = setup();
    const events = engine.events;
    let blocked = true;
    events.occlusionTest = () => blocked;
    const loop = event({ variants: [{ sound: 'Loop' }], loop: true, spatial: { minDistance: 5, maxDistance: 50 } });
    const motor = events.play(loop, { position: { x: 3, y: 0, z: 0 } })!;
    for (let i = 0; i < 10; i++) events.update([0, 0, 0], 0.05);
    expect(motor.occlusion).toBeCloseTo(1, 5);
    expect(motor.chain.filter.frequency.value).toBeCloseTo(1200, 0);
    expect(motor.chain.gain.gain.value).toBeCloseTo(0.5, 5);
    blocked = false;
    for (let i = 0; i < 10; i++) events.update([0, 0, 0], 0.05);
    expect(motor.occlusion).toBe(0);
    expect(motor.chain.gain.gain.value).toBeCloseTo(1, 5);
  });

  test('环境声区：区域里是 1，出了区域按淡出的距离降到 0（长方体跟着实体转）', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const zone = game.entities.create({ components: [Transform.with({ position: [10, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] })] });
    // 绕 Y 转 90°：本地 x（长 20）沿世界的 z，本地 z（长 4）沿世界的 x
    zone.add({ script: AmbientSound, init: { event: setup().event({ variants: [{ sound: 'Loop' }], loop: true }), shape: 'box', size: [20, 10, 4], fade: 10 } });
    const ambient = zone.require(AmbientSound);
    game.transforms.update();
    expect(ambient.weightAt([10, 0, 9])).toBe(1);
    expect(ambient.weightAt([10, 0, 15])).toBeCloseTo(0.5, 5);
    expect(ambient.weightAt([17, 0, 0])).toBeCloseTo(0.5, 5);
    expect(ambient.weightAt([40, 0, 0])).toBe(0);
  });
});
