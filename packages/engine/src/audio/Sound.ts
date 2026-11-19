/**
 * 声音（Stride 的 Sound）和它的播放实例（SoundInstance）。不流式的声音先整个解码成 AudioBuffer（音效：开始得快，可以同时放
 * 很多个）；流式的（StreamFromDisk，音乐）每个实例一个 `<audio>` 元素边下边放，经过 Web Audio 接到主音量。
 *
 * SoundInstance 照 Stride：Play 在已经在放时什么也不做，Pause 只在放的时候有效，Stop 回到开头；没循环的放完以后 PlayState
 * 变回 Stopped。Volume 是增益，Pan 是左右声道（-1 到 1），Pitch 是播放速度（同 Stride，音高跟着变）。
 */
import type { AudioEngine } from './AudioEngine';

export type PlayState = 'playing' | 'paused' | 'stopped';

/** 声音的数据：解码好的，或者流式的地址。 */
export type SoundSource = { readonly buffer: AudioBuffer } | { readonly url: string };

export class Sound {
  readonly name: string;
  /** 可以按 AudioEmitter 的位置空间化（Stride 的 Spatialized）。 */
  readonly spatialized: boolean;
  readonly #engine: AudioEngine;
  readonly #source: SoundSource;
  readonly #instances = new Set<SoundInstance>();

  constructor(engine: AudioEngine, name: string, source: SoundSource, spatialized = false) {
    this.#engine = engine;
    this.name = name;
    this.#source = source;
    this.spatialized = spatialized;
  }

  /** 流式播放（Stride 的 StreamFromDisk）。 */
  get streamFromDisk(): boolean {
    return 'url' in this.#source;
  }

  /** 总时长，秒；流式的不知道时是 NaN（实例开始加载后看 SoundInstance.duration）。 */
  get totalLength(): number {
    return 'buffer' in this.#source ? this.#source.buffer.duration : NaN;
  }

  /** 新的播放实例（Stride 的 CreateInstance）。 */
  createInstance(): SoundInstance {
    const instance = new SoundInstance(this.#engine, this, this.#source);
    this.#instances.add(instance);
    return instance;
  }

  /** @internal PlayExclusive：停掉这个声音的其他实例。 */
  stopConcurrentInstances(except: SoundInstance): void {
    for (const instance of this.#instances) if (instance !== except) instance.stop();
  }

  /** @internal */
  unregister(instance: SoundInstance): void {
    this.#instances.delete(instance);
  }
}

/** 实际出声的部分：解码好的用 AudioBufferSourceNode（每次播放一个新的），流式的用 `<audio>` 元素。 */
interface Voice {
  /** 从 offset 秒开始放。 */
  start(offset: number): void;
  /** 停下，返回停在第几秒。 */
  halt(): number;
  /** 放完了（没循环时）。 */
  readonly ended: boolean;
  /** 现在放到第几秒。 */
  readonly position: number;
  readonly duration: number;
  loop: boolean;
  rate: number;
  dispose(): void;
}

class BufferVoice implements Voice {
  readonly #context: BaseAudioContext;
  readonly #buffer: AudioBuffer;
  readonly #output: AudioNode;
  #node: AudioBufferSourceNode | undefined;
  /** 现在的片段从上下文的哪个时刻、从声音的第几秒开始。 */
  #startTime = 0;
  #startOffset = 0;
  #ended = false;
  #loop = false;
  #rate = 1;

  constructor(context: BaseAudioContext, buffer: AudioBuffer, output: AudioNode) {
    this.#context = context;
    this.#buffer = buffer;
    this.#output = output;
  }

  get ended(): boolean { return this.#ended; }
  get duration(): number { return this.#buffer.duration; }
  get loop(): boolean { return this.#loop; }
  set loop(value: boolean) {
    this.#loop = value;
    if (this.#node) this.#node.loop = value;
  }
  get rate(): number { return this.#rate; }
  set rate(value: number) {
    // 换速度时把已经放过的部分记下来，后面按新速度算位置
    if (this.#node) {
      this.#startOffset = this.position;
      this.#startTime = this.#context.currentTime;
      this.#node.playbackRate.value = value;
    }
    this.#rate = value;
  }

  get position(): number {
    if (!this.#node) return this.#startOffset;
    const played = this.#startOffset + (this.#context.currentTime - this.#startTime) * this.#rate;
    return this.#loop ? played % this.duration : Math.min(played, this.duration);
  }

  start(offset: number): void {
    const node = this.#context.createBufferSource();
    node.buffer = this.#buffer;
    node.loop = this.#loop;
    node.playbackRate.value = this.#rate;
    node.connect(this.#output);
    node.onended = () => {
      if (this.#node === node) this.#ended = true;
    };
    this.#node = node;
    this.#ended = false;
    this.#startTime = this.#context.currentTime;
    this.#startOffset = offset;
    node.start(0, offset);
  }

  halt(): number {
    const position = this.position;
    const node = this.#node;
    this.#node = undefined;
    if (node) {
      node.onended = null;
      node.stop();
      node.disconnect();
    }
    return position;
  }

  dispose(): void {
    this.halt();
  }
}

class StreamVoice implements Voice {
  readonly #element: HTMLAudioElement;
  readonly #node: MediaElementAudioSourceNode;
  readonly #engine: AudioEngine;
  #wantPlaying = false;

  constructor(engine: AudioEngine, url: string, output: AudioNode) {
    this.#engine = engine;
    this.#element = new Audio(url);
    this.#element.preload = 'auto';
    // 和 Stride 一样，速度变了音高跟着变
    this.#element.preservesPitch = false;
    this.#node = engine.context.createMediaElementSource(this.#element);
    this.#node.connect(output);
  }

  get ended(): boolean { return this.#element.ended; }
  get duration(): number { return this.#element.duration; }
  get position(): number { return this.#element.currentTime; }
  get loop(): boolean { return this.#element.loop; }
  set loop(value: boolean) { this.#element.loop = value; }
  get rate(): number { return this.#element.playbackRate; }
  set rate(value: number) { this.#element.playbackRate = value; }

  start(offset: number): void {
    this.#wantPlaying = true;
    this.#element.currentTime = offset;
    // 浏览器还不让出声时 play() 会被拒绝：恢复出声以后再放
    this.#element.play().catch(() => this.#engine.whenRunning(() => {
      if (this.#wantPlaying) void this.#element.play();
    }));
  }

  halt(): number {
    this.#wantPlaying = false;
    this.#element.pause();
    return this.#element.currentTime;
  }

  dispose(): void {
    this.halt();
    this.#node.disconnect();
    this.#element.removeAttribute('src');
    this.#element.load();
  }
}

export class SoundInstance {
  readonly sound: Sound;
  readonly #voice: Voice;
  readonly #gain: GainNode;
  readonly #panner: StereoPannerNode;
  #state: PlayState = 'stopped';
  #pausedAt = 0;
  #volume = 1;
  #pan = 0;
  #pitch = 1;
  #disposed = false;

  /** @internal Sound.createInstance 建。 */
  constructor(engine: AudioEngine, sound: Sound, source: SoundSource) {
    this.sound = sound;
    const context = engine.context;
    this.#gain = context.createGain();
    this.#panner = context.createStereoPanner();
    this.#panner.connect(this.#gain);
    this.#gain.connect(engine.output);
    this.#voice = 'buffer' in source ? new BufferVoice(context, source.buffer, this.#panner) : new StreamVoice(engine, source.url, this.#panner);
  }

  /** 播放状态；没循环的放完以后是 stopped。 */
  get playState(): PlayState {
    if (this.#state === 'playing' && this.#voice.ended) this.stop();
    return this.#state;
  }

  get isLooping(): boolean { return this.#voice.loop; }
  set isLooping(value: boolean) { this.#voice.loop = value; }

  /** 音量（增益），0 是静音。 */
  get volume(): number { return this.#volume; }
  set volume(value: number) {
    this.#volume = value;
    this.#gain.gain.value = value;
  }

  /** 左右声道，-1 全在左边，1 全在右边。 */
  get pan(): number { return this.#pan; }
  set pan(value: number) {
    this.#pan = value;
    this.#panner.pan.value = Math.min(Math.max(value, -1), 1);
  }

  /** 播放速度，音高跟着变（Stride 的 Pitch）。 */
  get pitch(): number { return this.#pitch; }
  set pitch(value: number) {
    this.#pitch = value;
    this.#voice.rate = value;
  }

  /** 放到第几秒（停止时是 0）。 */
  get position(): number {
    const state = this.playState;
    return state === 'stopped' ? 0 : state === 'paused' ? this.#pausedAt : this.#voice.position;
  }

  /** 声音的时长，秒（流式的加载出元数据之前是 NaN）。 */
  get duration(): number {
    return this.#voice.duration;
  }

  /** 播放；已经在放时什么也不做，暂停的从停下的地方接着放。 */
  play(): void {
    if (this.#disposed || this.playState === 'playing') return;
    this.#voice.start(this.#state === 'paused' ? this.#pausedAt : 0);
    this.#state = 'playing';
  }

  /** 播放，并停掉这个声音的其他实例（Stride 的 PlayExclusive）。 */
  playExclusive(): void {
    this.sound.stopConcurrentInstances(this);
    this.play();
  }

  pause(): void {
    if (this.playState !== 'playing') return;
    this.#pausedAt = this.#voice.halt();
    this.#state = 'paused';
  }

  /** 停下，下次从头放。 */
  stop(): void {
    if (this.#state === 'stopped') return;
    this.#voice.halt();
    this.#pausedAt = 0;
    this.#state = 'stopped';
  }

  /** 不再用：停下、断开（Stride 的 Dispose）。 */
  dispose(): void {
    if (this.#disposed) return;
    this.stop();
    this.#voice.dispose();
    this.#gain.disconnect();
    this.sound.unregister(this);
    this.#disposed = true;
  }
}
