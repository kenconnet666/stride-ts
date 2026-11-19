/**
 * 声音的发射器和听者（Stride 的 AudioEmitterComponent、AudioListenerComponent）：发射器上按名字挂着几个声音，
 * `emitter.controller('Gun').play()` 放出来的声音按发射器实体相对听者实体的位置空间化（Web Audio 的 PannerNode：离开 1 米以后
 * 音量按 1/距离 衰减，同 Stride 用的 X3DAudio 的默认曲线；偏左偏右跟着方位）。两个都是引擎自带的脚本组件，场景里的同名组件导入成它们。
 *
 *   const gun = this.entity.require(AudioEmitterComponent).controller('Gun');
 *   if (input.isMouseButtonPressed('right')) gun.play();
 *
 * 位置每帧按实体上一帧的世界矩阵更新。听者的朝向是实体的 -Z（相机看的方向）、上方是 +Y；有几个听者时最后更新的那个算数，
 * 没有听者时 Web Audio 的听者留在原点朝 -Z。
 * 和 Stride 不同：
 * - 没标 Spatialized 的声音挂在发射器上也能放，只是不做空间化（Stride 要求标了才行）；
 * - directionalFactor 起作用：正面是实体的 +Z，背面的音量是 1 - directionalFactor，中间按角度过渡（Stride 把指向类型写死成全向，
 *   这个值没有效果）；
 * - environment 的混响是合成的（衰减的噪声做冲激响应），各档的混响时间是我们自己定的；Stride 用的是 Windows 的 HRTF 自带的房间模型，
 *   只在 Windows 上有。和 Stride 一样只在 useHRTF 时有混响；
 * - 没有多普勒和按距离的低通（X3DAudio 的默认行为；Stride 传的速度是每帧的位移，多普勒本来就几乎听不出）。
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { PlayState, Sound, SoundInstance } from './Sound';

type AudioVector = readonly [AudioParam, AudioParam, AudioParam];

function setVector(target: AudioVector, x: number, y: number, z: number, time: number): void {
  target[0].setValueAtTime(x, time);
  target[1].setValueAtTime(y, time);
  target[2].setValueAtTime(z, time);
}

export class AudioListenerComponent extends SyncScript.props('AudioListenerComponent', {}) {
  override update(): void {
    const transform = this.entity.get(Transform);
    if (!transform) return;
    const m = transform.world;
    const { listener, currentTime } = this.game.audio.context;
    if ('positionX' in listener) {
      setVector([listener.positionX, listener.positionY, listener.positionZ], m[12]!, m[13]!, m[14]!, currentTime);
      setVector([listener.forwardX, listener.forwardY, listener.forwardZ], -m[8]!, -m[9]!, -m[10]!, currentTime);
      setVector([listener.upX, listener.upY, listener.upZ], m[4]!, m[5]!, m[6]!, currentTime);
    } else {
      // 老的接口（Firefox）
      const legacy = listener as AudioListener & { setPosition(x: number, y: number, z: number): void; setOrientation(...values: number[]): void };
      legacy.setPosition(m[12]!, m[13]!, m[14]!);
      legacy.setOrientation(-m[8]!, -m[9]!, -m[10]!, m[4]!, m[5]!, m[6]!);
    }
  }
}

/** 混响的房间（Stride 的 HrtfEnvironment）→ 混响时间（声音衰减 60 dB 要的秒数）；outdoors 没有混响。 */
const REVERB_SECONDS = { small: 0.4, medium: 0.8, large: 1.6, outdoors: 0 } as const;
/** 混响那一路相对直达声的音量。 */
const REVERB_GAIN = 0.25;
const impulses = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/** 合成的冲激响应：左右声道各一段指数衰减的白噪声，seconds 秒衰减 60 dB。同一个上下文里同样的时间只建一次。 */
function reverbImpulse(context: BaseAudioContext, seconds: number): AudioBuffer {
  let cache = impulses.get(context);
  if (!cache) impulses.set(context, (cache = new Map()));
  let impulse = cache.get(seconds);
  if (!impulse) {
    const length = Math.ceil(seconds * context.sampleRate);
    impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const samples = impulse.getChannelData(channel);
      // 10^(-3 t / seconds)：t = seconds 时是 -60 dB
      for (let i = 0; i < length; i++) samples[i] = (Math.random() * 2 - 1) * 10 ** ((-3 * i) / length);
    }
    cache.set(seconds, impulse);
  }
  return impulse;
}

export class AudioEmitterComponent extends SyncScript.props('AudioEmitterComponent', {
  /** 按名字挂的声音（Stride 的 Sounds 字典）。 */
  sounds: prop.list(prop.object({ name: prop.string(), sound: prop.asset('sound') })).default([]),
  /** 用 HRTF（头部相关传递函数）做空间化，耳机里方位更准，也更费。 */
  useHRTF: prop.bool().default(false),
  /** 指向性：0 是各个方向一样响，1 是背面（实体的 -Z）完全听不到。建第一个控制器时生效。 */
  directionalFactor: prop.f32().default(0).min(0).max(1),
  /** 混响的房间，只在 useHRTF 时有。建第一个控制器时生效。 */
  environment: prop.enum(['small', 'medium', 'large', 'outdoors']).default('small'),
}) {
  readonly #controllers = new Map<string, AudioEmitterSoundController>();
  #panner: PannerNode | undefined;
  #reverb: AudioNode[] = [];

  /** 这个名字的声音的控制器（Stride 的 `emitter["Gun"]`），同一个名字总是同一个。 */
  controller(name: string): AudioEmitterSoundController {
    let controller = this.#controllers.get(name);
    if (!controller) {
      const sound = this.sounds.find((entry) => entry.name === name)?.sound;
      if (!sound) throw new Error(`entity '${this.entity.name}' has no sound named '${name}' on its AudioEmitterComponent (it has ${this.sounds.map((s) => `'${s.name}'`).join(', ') || 'none'})`);
      controller = new AudioEmitterSoundController(sound, sound.spatialized ? this.#spatialOutput() : undefined);
      this.#controllers.set(name, controller);
    }
    return controller;
  }

  override update(): void {
    if (this.#panner) this.#place(this.#panner);
  }

  override cancel(): void {
    for (const controller of this.#controllers.values()) controller.dispose();
    this.#controllers.clear();
    for (const node of [this.#panner, ...this.#reverb]) node?.disconnect();
    this.#panner = undefined;
    this.#reverb = [];
  }

  /** 空间化的声音都经过这一个 PannerNode（位置和朝向是实体的）；有混响时再分一路经过卷积。 */
  #spatialOutput(): PannerNode {
    if (this.#panner) return this.#panner;
    const { context, output } = this.game.audio;
    const panner = (this.#panner = context.createPanner());
    panner.panningModel = this.useHRTF ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    // 锥形从正前方一直张到正后方：音量从 1 按角度线性降到背面的 1 - directionalFactor，接近心形指向
    panner.coneInnerAngle = 0;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1 - this.directionalFactor;
    panner.connect(output);
    this.#place(panner);

    const seconds = this.useHRTF ? REVERB_SECONDS[this.environment] : 0;
    if (seconds > 0) {
      const convolver = context.createConvolver(), gain = context.createGain();
      convolver.buffer = reverbImpulse(context, seconds);
      gain.gain.value = REVERB_GAIN;
      panner.connect(convolver).connect(gain).connect(output);
      this.#reverb = [convolver, gain];
    }
    return panner;
  }

  #place(panner: PannerNode): void {
    const m = this.entity.get(Transform)?.world;
    if (!m) return;
    const time = this.game.audio.context.currentTime;
    setVector([panner.positionX, panner.positionY, panner.positionZ], m[12]!, m[13]!, m[14]!, time);
    setVector([panner.orientationX, panner.orientationY, panner.orientationZ], m[8]!, m[9]!, m[10]!, time);
  }
}

/** 发射器上一个声音的播放控制（Stride 的 AudioEmitterSoundController）。 */
export class AudioEmitterSoundController {
  readonly #instance: SoundInstance;

  /** @internal AudioEmitterComponent.controller 建。 */
  constructor(sound: Sound, output: AudioNode | undefined) {
    this.#instance = sound.createInstance(output);
  }

  get playState(): PlayState { return this.#instance.playState; }
  get isLooping(): boolean { return this.#instance.isLooping; }
  set isLooping(value: boolean) { this.#instance.isLooping = value; }
  get volume(): number { return this.#instance.volume; }
  set volume(value: number) { this.#instance.volume = value; }
  get pitch(): number { return this.#instance.pitch; }
  set pitch(value: number) { this.#instance.pitch = value; }

  /** 播放；已经在放时什么也不做（同 Stride：控制器只在没在放的时候才开始）。 */
  play(): void {
    this.#instance.play();
  }

  pause(): void {
    this.#instance.pause();
  }

  stop(): void {
    this.#instance.stop();
  }

  /** @internal 发射器移除时。 */
  dispose(): void {
    this.#instance.dispose();
  }
}
