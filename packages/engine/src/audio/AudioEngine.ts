/**
 * 音频引擎（`game.audio`，Stride 的 AudioEngine）：一个 Web Audio 的 AudioContext，所有声音经过主音量接到扬声器。
 *
 * 浏览器的自动播放策略：页面上有过用户操作（点击、按键）之前 AudioContext 是挂起的，不出声。Game 启动时把画布所在的窗口交给
 * attach，第一次操作时恢复；之前开始放的声音（比如一开始就放的背景音乐）在恢复后接着放，播放状态一直是 Playing。
 * 和 Stride 不同（浏览器的限制）：桌面版一启动就有声音。
 */
import type { AudioRecorder } from './AudioRecorder';
import { SoundEventSystem } from './SoundEvents';

/** 建 AudioContext（测试里换成假的）。 */
export type AudioContextFactory = () => AudioContext;

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export class AudioEngine {
  /** 离线渲染时设上：放的声音记到这里（见 AudioRecorder）。 */
  recorder: AudioRecorder | undefined;
  /** 声音事件和发声管理（见 SoundEvents.ts）。 */
  readonly events = new SoundEventSystem(this);
  /** 听者的世界位置：AudioListenerComponent 每帧写（listenerFrame 记哪一帧写的）；没有听者时 Game 写主相机的。 */
  readonly listenerPosition: [number, number, number] = [0, 0, 0];
  listenerFrame = -1;
  /** 听者的世界矩阵（还没建 AudioContext 时先记着，建好时补上）。 */
  readonly #listenerWorld = new Float64Array(16);
  #hasListener = false;
  readonly #createContext: AudioContextFactory;
  #context: AudioContext | undefined;
  #master: GainNode | undefined;
  #masterVolume = 1;
  readonly #resumed = new Set<() => void>();
  #detach: (() => void) | undefined;

  constructor(createContext: AudioContextFactory = () => new AudioContext()) {
    this.#createContext = createContext;
  }

  /** Web Audio 的上下文，第一次用到时建（挂起着，直到 resume）。 */
  get context(): AudioContext {
    if (!this.#context) {
      this.#context = this.#createContext();
      this.#master = this.#context.createGain();
      this.#master.gain.value = this.#masterVolume;
      this.#master.connect(this.#context.destination);
      if (this.#hasListener) this.#applyListener(this.#context);
      this.#context.addEventListener('statechange', () => {
        if (this.#context?.state !== 'running') return;
        for (const callback of [...this.#resumed]) callback();
        this.#resumed.clear();
      });
    }
    return this.#context;
  }

  /** @internal 声音接到这里（主音量之前）。 */
  get output(): AudioNode {
    void this.context;
    return this.#master!;
  }

  /** 主音量（Stride 的 AudioEngine.MasterVolume），0 到 1。 */
  get masterVolume(): number {
    return this.#masterVolume;
  }

  set masterVolume(value: number) {
    this.#masterVolume = Math.min(Math.max(value, 0), 1);
    if (this.#master) this.#master.gain.value = this.#masterVolume;
  }

  /** 正在出声（AudioContext 在运行）；用户还没操作过页面时是 false。 */
  get isRunning(): boolean {
    return this.#context?.state === 'running';
  }

  /** 恢复出声（要在用户操作的事件里调用才有效）。 */
  resume(): Promise<void> {
    return this.context.resume();
  }

  /** @internal 恢复出声以后调用一次 callback（已经在出声时马上调用）。 */
  whenRunning(callback: () => void): void {
    if (this.isRunning) callback();
    else this.#resumed.add(callback);
  }

  /** @internal Game 启动时：target 上第一次点击、按键时恢复出声。 */
  attach(target: EventTarget): void {
    const resume = () => {
      if (this.isRunning) return;
      void this.resume().then(() => this.#detach?.());
    };
    for (const type of GESTURES) target.addEventListener(type, resume, { capture: true });
    this.#detach = () => {
      for (const type of GESTURES) target.removeEventListener(type, resume, { capture: true });
      this.#detach = undefined;
    };
  }

  /** 把音频文件整个解码（不流式的声音）。 */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    // decodeAudioData 会接管传进去的缓冲，所以拷一份
    return this.context.decodeAudioData(bytes.slice(0));
  }

  /** 生成的样本（合成的音效）做成单声道的 AudioBuffer。 */
  fromSamples(samples: Float32Array<ArrayBuffer>, sampleRate: number): AudioBuffer {
    const buffer = this.context.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  /**
   * 听者放在这个世界矩阵上（位置；朝 -Z，上方 +Y）：Web Audio 的听者和 listenerPosition 一起改。frame 是游戏的第几帧
   * （同一帧里后写的算数）。
   */
  placeListener(world: ArrayLike<number>, frame: number): void {
    this.listenerPosition[0] = world[12]!;
    this.listenerPosition[1] = world[13]!;
    this.listenerPosition[2] = world[14]!;
    this.listenerFrame = frame;
    // 相机不动时不重写（AudioParam 的 value 写一次要过一次浏览器内部的边界）
    let same = this.#hasListener;
    for (let i = 0; i < 16 && same; i++) same = this.#listenerWorld[i] === world[i];
    if (same) return;
    for (let i = 0; i < 16; i++) this.#listenerWorld[i] = world[i]!;
    this.#hasListener = true;
    // 还没出过声（没建 AudioContext）时只记着：不为了放听者去建上下文，建的时候补上
    if (this.#context) this.#applyListener(this.#context);
  }

  #applyListener(context: AudioContext): void {
    const world = this.#listenerWorld;
    // 直接写 value，不用 setValueAtTime（同 AudioEmitterComponent 的 setVector：挂起时事件会一直堆着）
    const { listener } = context;
    if ('positionX' in listener) {
      listener.positionX.value = world[12]!;
      listener.positionY.value = world[13]!;
      listener.positionZ.value = world[14]!;
      listener.forwardX.value = -world[8]!;
      listener.forwardY.value = -world[9]!;
      listener.forwardZ.value = -world[10]!;
      listener.upX.value = world[4]!;
      listener.upY.value = world[5]!;
      listener.upZ.value = world[6]!;
    } else {
      // 老的接口（Firefox）
      const legacy = listener as AudioListener & { setPosition(x: number, y: number, z: number): void; setOrientation(...values: number[]): void };
      legacy.setPosition(world[12]!, world[13]!, world[14]!);
      legacy.setOrientation(-world[8]!, -world[9]!, -world[10]!, world[4]!, world[5]!, world[6]!);
    }
  }

  destroy(): void {
    this.events.stopAll();
    this.#detach?.();
    void this.#context?.close();
    this.#context = undefined;
    this.#master = undefined;
    this.#resumed.clear();
  }
}
