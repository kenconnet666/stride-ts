import { describe, expect, test } from 'vitest';
import { AudioEngine } from '../src/audio/AudioEngine';
import { Sound } from '../src/audio/Sound';

/** 只够 SoundInstance 用的假 AudioContext：时间手动走，记下开始的播放节点。 */
class FakeContext extends EventTarget {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly destination = node();
  readonly started: { offset: number; node: ReturnType<FakeContext['createBufferSource']> }[] = [];

  createGain() { return { ...node(), gain: { value: 1 } }; }
  createStereoPanner() { return { ...node(), pan: { value: 0 } }; }
  createBufferSource() {
    const source = {
      ...node(), buffer: null as unknown, loop: false, playbackRate: { value: 1 }, onended: null as (() => void) | null, stopped: false,
      start: (_when: number, offset: number) => this.started.push({ offset, node: source }),
      stop: () => { source.stopped = true; },
    };
    return source;
  }
  async resume() {
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  }
  async close() {}
}

function node() {
  return { connect() {}, disconnect() {} };
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
