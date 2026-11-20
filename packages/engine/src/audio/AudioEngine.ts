/**
 * 音频引擎（`game.audio`，Stride 的 AudioEngine）：一个 Web Audio 的 AudioContext，所有声音经过主音量接到扬声器。
 *
 * 浏览器的自动播放策略：页面上有过用户操作（点击、按键）之前 AudioContext 是挂起的，不出声。Game 启动时把画布所在的窗口交给
 * attach，第一次操作时恢复；之前开始放的声音（比如一开始就放的背景音乐）在恢复后接着放，播放状态一直是 Playing。
 * 和 Stride 不同（浏览器的限制）：桌面版一启动就有声音。
 */
import type { AudioRecorder } from './AudioRecorder';

/** 建 AudioContext（测试里换成假的）。 */
export type AudioContextFactory = () => AudioContext;

const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

export class AudioEngine {
  /** 离线渲染时设上：放的声音记到这里（见 AudioRecorder）。 */
  recorder: AudioRecorder | undefined;
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

  destroy(): void {
    this.#detach?.();
    void this.#context?.close();
    this.#context = undefined;
    this.#master = undefined;
    this.#resumed.clear();
  }
}
