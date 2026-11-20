/**
 * 离线渲染（成片导出）时的录音：游戏照常放声音，这里按游戏时间记下放了什么（从第几秒、音量、左右、速度、循环，什么时候停、
 * 中途音量和左右怎么变），导出时用 OfflineAudioContext 一次混成（mixRecording），和画面严格对齐——实时的 AudioContext
 * 跟墙上的时钟走，离线渲染一帧可能花好几帧的时间，录实时的输出对不上。
 *
 * 只记 SoundInstance 自己的音量和左右；接在空间化发射器（AudioEmitterComponent）上的声音按发射器算的衰减、方位不在里面。
 */
import type { SoundSource } from './Sound';

/** 录下的一次播放（时刻都是相对开始录的游戏时间，秒）。 */
export interface RecordedSound {
  readonly source: SoundSource;
  readonly start: number;
  /** 从声音的第几秒开始放。 */
  readonly offset: number;
  readonly loop: boolean;
  readonly rate: number;
  /** 什么时候停（停了、暂停了）；一直放到录完的是 undefined。 */
  end: number | undefined;
  /** 音量、左右的变化（第一项是开始时的）。 */
  readonly levels: { readonly time: number; readonly volume: number; readonly pan: number }[];
}

export class AudioRecorder {
  /** 现在的游戏时刻（相对开始录，秒）：离线渲染每步之前设成这一步的时刻。 */
  time = 0;
  readonly sounds: RecordedSound[] = [];
  readonly #playing = new Map<object, RecordedSound>();

  /** @internal SoundInstance 开始放（key 是实例）。 */
  started(key: object, source: SoundSource, offset: number, loop: boolean, rate: number, volume: number, pan: number): void {
    this.stopped(key);
    const sound: RecordedSound = { source, start: this.time, offset, loop, rate, end: undefined, levels: [{ time: this.time, volume, pan }] };
    this.sounds.push(sound);
    this.#playing.set(key, sound);
  }

  /** @internal 正在放的实例改了音量或左右。 */
  changed(key: object, volume: number, pan: number): void {
    this.#playing.get(key)?.levels.push({ time: this.time, volume, pan });
  }

  /** @internal 实例停了、暂停了。 */
  stopped(key: object): void {
    const sound = this.#playing.get(key);
    if (!sound) return;
    sound.end = this.time;
    this.#playing.delete(key);
  }
}

/** 把录下的声音混成 duration 秒的立体声（采样率 sampleRate）。流式的声音（只有地址）在这里下载、解码。 */
export async function mixRecording(sounds: readonly RecordedSound[], duration: number, sampleRate = 48000): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  const streamed = new Map<string, Promise<AudioBuffer>>();
  const bufferOf = (source: SoundSource): Promise<AudioBuffer> => {
    if ('buffer' in source) return Promise.resolve(source.buffer);
    let decoded = streamed.get(source.url);
    if (!decoded) {
      decoded = fetch(source.url).then((response) => {
        if (!response.ok) throw new Error(`mixRecording: ${source.url}: HTTP ${response.status}`);
        return response.arrayBuffer();
      }).then((bytes) => context.decodeAudioData(bytes));
      streamed.set(source.url, decoded);
    }
    return decoded;
  };
  for (const sound of sounds) {
    if (sound.start >= duration) continue;
    const node = context.createBufferSource();
    node.buffer = await bufferOf(sound.source);
    node.loop = sound.loop;
    node.playbackRate.value = sound.rate;
    const gain = context.createGain(), panner = context.createStereoPanner();
    for (const { time, volume, pan } of sound.levels) {
      gain.gain.setValueAtTime(volume, time);
      panner.pan.setValueAtTime(Math.min(Math.max(pan, -1), 1), time);
    }
    node.connect(panner).connect(gain).connect(context.destination);
    node.start(sound.start, sound.offset);
    if (sound.end !== undefined) node.stop(sound.end);
  }
  return context.startRendering();
}
