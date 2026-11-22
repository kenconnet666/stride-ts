import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AudioEmitterComponent, AudioListenerComponent } from '../../src/audio/AudioEmitterComponent';
import { AudioEngine } from '../../src/audio/AudioEngine';
import { Sound } from '../../src/audio/Sound';
import { Game, Transform } from '../../src';

/** 只够 SoundInstance 和发射器用的假 AudioContext：时间手动走，记下开始的播放节点和建出来的空间化节点。 */
class FakeContext extends EventTarget {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly sampleRate = 1000;
  readonly destination = node();
  readonly started: { offset: number; node: ReturnType<FakeContext['createBufferSource']> }[] = [];
  readonly panners: ReturnType<typeof fakePanner>[] = [];
  readonly convolvers: ReturnType<typeof fakeConvolver>[] = [];
  readonly listener = { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() };

  createGain() { return node({ gain: { value: 1 } }); }
  createStereoPanner() { return node({ pan: { value: 0 } }); }
  createPanner() {
    const panner = fakePanner();
    this.panners.push(panner);
    return panner;
  }
  createConvolver() {
    const convolver = fakeConvolver();
    this.convolvers.push(convolver);
    return convolver;
  }
  createBuffer(_channels: number, length: number) { return { length, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() {
    const source = node({
      buffer: null as unknown, loop: false, playbackRate: { value: 1 }, onended: null as (() => void) | null, stopped: false,
      start: (_when: number, offset: number): void => void this.started.push({ offset, node: source }),
      stop: (): void => { source.stopped = true; },
    });
    return source;
  }
  async resume() {
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  }
  async close() {}
}

/** 假的音频节点：connect 返回目标（能连着写），disconnect 之后 connected 是 false。 */
function node<T extends object>(extra: T = {} as T) {
  const self = { connected: true, connect: <N>(target: N) => target, disconnect: () => void (self.connected = false), ...extra };
  return self;
}

function fakePanner() {
  return node({
    panningModel: '', distanceModel: '', refDistance: 0, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
    positionX: param(), positionY: param(), positionZ: param(), orientationX: param(), orientationY: param(), orientationZ: param(),
  });
}

function fakeConvolver() {
  return node({ buffer: null as { length: number } | null });
}

function param() {
  const self = { value: 0, setValueAtTime: (value: number) => void (self.value = value) };
  return self;
}

function setup(duration = 2) {
  const context = new FakeContext();
  const engine = new AudioEngine(() => context as unknown as AudioContext);
  const sound = new Sound(engine, 'beep', { buffer: { duration } as AudioBuffer });
  return { context, engine, sound };
}

describe('声音的播放（照 Stride 的 SoundInstance）', () => {
  test('Play、Pause、接着放、Stop 从头放；在放的时候 Play 什么也不做', () => {
    const { context, sound } = setup();
    const instance = sound.createInstance();
    expect(instance.playState).toBe('stopped');
    instance.play();
    instance.play();
    expect(context.started).toHaveLength(1);
    context.currentTime = 0.5;
    expect(instance.position).toBeCloseTo(0.5);
    instance.pause();
    expect(instance.playState).toBe('paused');
    expect(context.started[0]!.node.stopped).toBe(true);
    context.currentTime = 3;
    expect(instance.position).toBeCloseTo(0.5);
    instance.play();
    expect(context.started[1]!.offset).toBeCloseTo(0.5);
    instance.stop();
    expect(instance.position).toBe(0);
    instance.play();
    expect(context.started[2]!.offset).toBe(0);
  });

  test('没循环的放完以后 PlayState 是 Stopped；Pitch 是播放速度', () => {
    const { context, sound } = setup();
    const instance = sound.createInstance();
    instance.pitch = 2;
    instance.play();
    expect(context.started[0]!.node.playbackRate.value).toBe(2);
    context.currentTime = 0.5;
    expect(instance.position).toBeCloseTo(1);
    context.started[0]!.node.onended?.();
    expect(instance.playState).toBe('stopped');
  });

  test('循环时位置绕回开头；PlayExclusive 停掉同一个声音的其他实例', () => {
    const { context, sound } = setup(2);
    const music = sound.createInstance();
    music.isLooping = true;
    music.play();
    expect(context.started[0]!.node.loop).toBe(true);
    context.currentTime = 5;
    expect(music.position).toBeCloseTo(1);
    const other = sound.createInstance();
    other.playExclusive();
    expect(music.playState).toBe('stopped');
    expect(other.playState).toBe('playing');
  });

  test('用户操作页面以后才出声：第一次点击时恢复，等着的回调这时调用', async () => {
    const { context, engine } = setup();
    const target = new EventTarget();
    engine.attach(target);
    let resumed = 0;
    engine.whenRunning(() => resumed++);
    expect(engine.isRunning).toBe(false);
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(context.state).toBe('running');
    expect(resumed).toBe(1);
    engine.whenRunning(() => resumed++);
    expect(resumed).toBe(2);
  });
});

describe('发射器和听者（Stride 的 AudioEmitterComponent、AudioListenerComponent）', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  /** 带变换存储和假声音上下文的游戏；frame() 跑一帧脚本再算世界矩阵。 */
  function createGame() {
    const context = new FakeContext();
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    Object.assign(game, { audio: new AudioEngine(() => context as unknown as AudioContext) });
    const frame = () => {
      game.updateTime.advance(1 / 60);
      game.entities.update(game.updateTime);
      game.transforms.update();
    };
    const sound = (name: string, spatialized: boolean) => new Sound(game.audio, name, { buffer: { duration: 1 } as AudioBuffer }, spatialized);
    return { context, game, frame, sound };
  }
  const values = (...params: { value: number }[]) => params.map((p) => p.value);

  test('空间化的声音经过发射器的 PannerNode：位置和朝向跟着实体，指向性是背面的音量；没标空间化的直接出声', () => {
    const { context, game, frame, sound } = createGame();
    const emitter = game.entities.create({
      components: [Transform.with({ position: [3, 0, 0] }), AudioEmitterComponent.with({ sounds: [{ name: 'Gun', sound: sound('gun', true) }, { name: 'Voice', sound: sound('voice', false) }], directionalFactor: 0.25 })],
    }).require(AudioEmitterComponent);
    frame();
    emitter.controller('Voice').play();
    expect(context.panners).toHaveLength(0);

    const gun = emitter.controller('Gun');
    expect(emitter.controller('Gun')).toBe(gun);
    gun.play();
    gun.play();
    expect([gun.playState, context.started.length]).toEqual(['playing', 2]);
    const [panner] = context.panners;
    expect([panner!.panningModel, panner!.distanceModel, panner!.refDistance, panner!.coneInnerAngle, panner!.coneOuterAngle, panner!.coneOuterGain]).toEqual(['equalpower', 'inverse', 1, 0, 360, 0.75]);
    expect(values(panner!.positionX, panner!.positionY, panner!.positionZ, panner!.orientationX, panner!.orientationY, panner!.orientationZ)).toEqual([3, 0, 0, 0, 0, 1]);
    expect(context.convolvers).toHaveLength(0);

    emitter.entity.require(Transform).position = { x: 0, y: 2, z: -1 };
    frame();
    frame();
    expect(values(panner!.positionX, panner!.positionY, panner!.positionZ)).toEqual([0, 2, -1]);
    expect(() => emitter.controller('Horn')).toThrow("has no sound named 'Horn' on its AudioEmitterComponent (it has 'Gun', 'Voice')");

    emitter.entity.destroy();
    expect([panner!.connected, gun.playState]).toEqual([false, 'stopped']);
  });

  test('useHRTF 时用 HRTF 的空间化，再分一路混响（冲激响应的长度是房间的混响时间）；outdoors 没有混响', () => {
    const { context, game, frame, sound } = createGame();
    const create = (environment: 'large' | 'outdoors') =>
      game.entities.create({ components: [Transform, AudioEmitterComponent.with({ sounds: [{ name: 'Gun', sound: sound('gun', true) }], useHRTF: true, environment })] }).require(AudioEmitterComponent);
    const hall = create('large'), field = create('outdoors');
    frame();
    hall.controller('Gun');
    expect(context.panners[0]!.panningModel).toBe('HRTF');
    expect(context.convolvers.map((c) => c.buffer?.length)).toEqual([1600]);
    field.controller('Gun');
    expect([context.panners.length, context.convolvers.length]).toEqual([2, 1]);
    hall.entity.destroy();
    expect(context.convolvers[0]!.connected).toBe(false);
  });

  test('听者把实体的位置、-Z（前）、+Y（上）写给 Web Audio 的听者', () => {
    const { context, game, frame } = createGame();
    // 绕 Y 转 180°：-Z 转到世界的 +Z
    game.entities.create({ components: [Transform.with({ position: [1, 2, 3], rotation: [0, 1, 0, 0] }), AudioListenerComponent] });
    frame();
    frame();
    const l = context.listener;
    values(l.positionX, l.positionY, l.positionZ, l.forwardX, l.forwardY, l.forwardZ, l.upX, l.upY, l.upZ).forEach((value, i) => expect(value).toBeCloseTo([1, 2, 3, 0, 0, 1, 0, 1, 0][i]!, 5));
  });
});
