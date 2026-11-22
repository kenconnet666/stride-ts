/**
 * 合成的音效（编辑器的音效生成器、声音资源的 `synth`）：sfxr 的算法（DrPetter 的 sfxr，jsfxr、bfxr 同一套），几十个字节的
 * 参数在加载时生成波形，不用音频文件。
 *
 * 参数沿用 sfxr 的范围（多数 0..1，带方向的 -1..1），sfxr、jsfxr 的预设能对着改过来；字段名按意思起。和 sfxr 不同：
 * - 噪声按 seed 的伪随机数生成，同样的参数每次出一样的波形（可比较、离线出片可复现）；
 * - 多一种三角波；
 * - 输出按 volume 定峰值（sfxr 的总音量很小，还和波形有关），不同音效之间响度一致。
 *
 * 用法：`synthesizeSound(params)` 出 44100 Hz 的单声道样本；`SOUND_PRESETS.pickup(random)` 按类别随机出一组参数，
 * `mutateSound(params, random)` 在一组参数附近随机变一点。
 */
import { seededRandom } from '../data/hash.ts';

export type SynthWave = 'square' | 'sawtooth' | 'sine' | 'noise' | 'triangle';

/** 一个合成音效的全部参数（文件里没写的用 DEFAULT_SOUND_SYNTH）。 */
export interface SoundSynth {
  readonly wave: SynthWave;
  /** 起音的时长，0..1（sfxr 的 attack：平方后乘 100000 个样本，1 约 2.3 秒）。 */
  readonly attack: number;
  /** 持续的时长，0..1（同上）。 */
  readonly sustain: number;
  /** 持续段开头冲上去多少，0..1（1 是三倍音量，往下落）。 */
  readonly punch: number;
  /** 衰减的时长，0..1（同 attack）。 */
  readonly decay: number;
  /** 起始音高，0..1（平方关系：0.3 约 330 Hz，0.5 约 880 Hz）。 */
  readonly frequency: number;
  /** 音高往下滑到这里就停，0..1（0 是不停；大于 0 时滑到了整个音效就结束）。 */
  readonly minFrequency: number;
  /** 音高滑动，-1..1（正的往上滑，负的往下，同 sfxr）。 */
  readonly slide: number;
  /** 滑动的加速度，-1..1。 */
  readonly deltaSlide: number;
  /** 颤音的深度，0..1。 */
  readonly vibratoDepth: number;
  /** 颤音的快慢，0..1。 */
  readonly vibratoSpeed: number;
  /** 琶音：过 arpeggioSpeed 那么久以后音高跳一下，-1..1（正的往上跳，负的往下）。 */
  readonly arpeggio: number;
  /** 琶音跳之前等多久，0..1（越大越快，1 是不跳）。 */
  readonly arpeggioSpeed: number;
  /** 方波的占空比，0..1（0 是一半一半，越大越窄、越"薄"）。 */
  readonly duty: number;
  /** 占空比的变化，-1..1。 */
  readonly dutySweep: number;
  /** 重复：隔一段把音高、琶音重新来一遍（不重来包络），0..1（0 是不重复，越大越快）。 */
  readonly repeatSpeed: number;
  /** 镶边（和自己延迟一点的叠加）的延迟，-1..1。 */
  readonly phaserOffset: number;
  /** 镶边延迟的变化，-1..1。 */
  readonly phaserSweep: number;
  /** 低通的截止，0..1（1 是不滤）。 */
  readonly lowPassCutoff: number;
  /** 低通截止的变化，-1..1。 */
  readonly lowPassSweep: number;
  /** 低通的共振，0..1。 */
  readonly lowPassResonance: number;
  /** 高通的截止，0..1（0 是不滤）。 */
  readonly highPassCutoff: number;
  /** 高通截止的变化，-1..1。 */
  readonly highPassSweep: number;
  /** 峰值，0..1。 */
  readonly volume: number;
  /** 噪声的随机种子。 */
  readonly seed: number;
}

/** sfxr 新建时的参数（一声短的方波）。 */
export const DEFAULT_SOUND_SYNTH: SoundSynth = {
  wave: 'square', attack: 0, sustain: 0.3, punch: 0, decay: 0.4,
  frequency: 0.3, minFrequency: 0, slide: 0, deltaSlide: 0, vibratoDepth: 0, vibratoSpeed: 0, arpeggio: 0, arpeggioSpeed: 0,
  duty: 0, dutySweep: 0, repeatSpeed: 0, phaserOffset: 0, phaserSweep: 0,
  lowPassCutoff: 1, lowPassSweep: 0, lowPassResonance: 0, highPassCutoff: 0, highPassSweep: 0, volume: 0.5, seed: 1,
};

/** 合成的采样率（sfxr 的各个常数是按它定的）。 */
export const SOUND_SYNTH_RATE = 44100;

/** 最长 10 秒（参数再怎么拉也就 7 秒左右，防一下）。 */
const MAX_SAMPLES = SOUND_SYNTH_RATE * 10;

/** 文件里的参数补上默认值。 */
export function soundSynth(partial: Partial<SoundSynth>): SoundSynth {
  return { ...DEFAULT_SOUND_SYNTH, ...partial };
}

/** 生成波形：44100 Hz 的单声道样本，-volume..volume。 */
export function synthesizeSound(partial: Partial<SoundSynth>): Float32Array<ArrayBuffer> {
  const p = soundSynth(partial);
  const random = seededRandom(p.seed);
  const out = new Float32Array(MAX_SAMPLES);

  // 音高和琶音的状态，重复时重来（sfxr 的 ResetSample(restart)）
  let period = 0, maxPeriod = 0, slide = 0, deltaSlide = 0, duty = 0, dutySlide = 0, arpeggio = 0, arpeggioTime = 0, arpeggioLimit = 0;
  const resetPitch = () => {
    period = 100 / (p.frequency * p.frequency + 0.001);
    maxPeriod = 100 / (p.minFrequency * p.minFrequency + 0.001);
    slide = 1 - p.slide ** 3 * 0.01;
    deltaSlide = -(p.deltaSlide ** 3) * 0.000001;
    duty = 0.5 - p.duty * 0.5;
    dutySlide = -p.dutySweep * 0.00005;
    arpeggio = p.arpeggio >= 0 ? 1 - p.arpeggio ** 2 * 0.9 : 1 + p.arpeggio ** 2 * 10;
    arpeggioTime = 0;
    arpeggioLimit = p.arpeggioSpeed === 1 ? 0 : Math.floor((1 - p.arpeggioSpeed) ** 2 * 20000 + 32);
  };
  resetPitch();

  let lowPass = 0, lowPassDelta = 0, lowPassWidth = p.lowPassCutoff ** 3 * 0.1;
  const lowPassWidthChange = 1 + p.lowPassSweep * 0.0001;
  const lowPassDamping = Math.min(0.8, (5 / (1 + p.lowPassResonance ** 2 * 20)) * (0.01 + lowPassWidth));
  let highPass = 0, highPassCutoff = p.highPassCutoff ** 2 * 0.1;
  const highPassChange = 1 + p.highPassSweep * 0.0003;
  let vibratoPhase = 0;
  const vibratoSpeed = p.vibratoSpeed ** 2 * 0.01, vibratoDepth = p.vibratoDepth * 0.5;
  const envelope = [p.attack, p.sustain, p.decay].map((length) => Math.floor(length * length * 100000));
  let stage = 0, stageTime = 0, volume = 0;
  let phaserOffset = Math.sign(p.phaserOffset) * p.phaserOffset ** 2 * 1020;
  const phaserChange = Math.sign(p.phaserSweep) * p.phaserSweep ** 2;
  const phaser = new Float32Array(1024);
  let phaserIndex = 0;
  const noise = new Float32Array(32);
  const refillNoise = () => {
    for (let i = 0; i < 32; i++) noise[i] = random() * 2 - 1;
  };
  refillNoise();
  let repeatTime = 0;
  const repeatLimit = p.repeatSpeed === 0 ? 0 : Math.floor((1 - p.repeatSpeed) ** 2 * 20000 + 32);
  let phase = 0;

  let length = 0;
  for (; length < MAX_SAMPLES; length++) {
    if (repeatLimit !== 0 && ++repeatTime >= repeatLimit) {
      repeatTime = 0;
      resetPitch();
    }
    if (arpeggioLimit !== 0 && ++arpeggioTime >= arpeggioLimit) {
      arpeggioLimit = 0;
      period *= arpeggio;
    }
    slide += deltaSlide;
    period *= slide;
    if (period > maxPeriod) {
      period = maxPeriod;
      if (p.minFrequency > 0) break;
    }
    let currentPeriod = period;
    if (vibratoDepth > 0) {
      vibratoPhase += vibratoSpeed;
      currentPeriod = period * (1 + Math.sin(vibratoPhase) * vibratoDepth);
    }
    const wavePeriod = Math.max(8, Math.floor(currentPeriod));
    duty = Math.min(0.5, Math.max(0, duty + dutySlide));
    if (++stageTime > envelope[stage]!) {
      stageTime = 0;
      if (++stage === 3) break;
    }
    // 长度是 0 的一段刚进来时算作走完了（sfxr 在这里是 0/0）
    const progress = envelope[stage]! > 0 ? stageTime / envelope[stage]! : 1;
    if (stage === 0) volume = progress;
    else if (stage === 1) volume = 1 + (1 - progress) * 2 * p.punch;
    else volume = 1 - progress;
    phaserOffset += phaserChange;
    const phaserDelay = Math.min(1023, Math.abs(Math.trunc(phaserOffset)));
    if (highPassChange !== 0) highPassCutoff = Math.min(0.1, Math.max(0.00001, highPassCutoff * highPassChange));

    // 8 倍超采样
    let sum = 0;
    for (let sub = 0; sub < 8; sub++) {
      if (++phase >= wavePeriod) {
        phase %= wavePeriod;
        if (p.wave === 'noise') refillNoise();
      }
      const t = phase / wavePeriod;
      let sample: number;
      switch (p.wave) {
        case 'square': sample = t < duty ? 0.5 : -0.5; break;
        case 'sawtooth': sample = 1 - t * 2; break;
        case 'sine': sample = Math.sin(t * 2 * Math.PI); break;
        case 'triangle': sample = Math.abs(t - 0.5) * 4 - 1; break;
        case 'noise': sample = noise[Math.floor((phase * 32) / wavePeriod)]!; break;
      }
      const previous = lowPass;
      lowPassWidth = Math.min(0.1, Math.max(0, lowPassWidth * lowPassWidthChange));
      if (p.lowPassCutoff !== 1) {
        lowPassDelta += (sample - lowPass) * lowPassWidth;
        lowPassDelta -= lowPassDelta * lowPassDamping;
      } else {
        lowPass = sample;
        lowPassDelta = 0;
      }
      lowPass += lowPassDelta;
      highPass += lowPass - previous;
      highPass -= highPass * highPassCutoff;
      sample = highPass;
      phaser[phaserIndex & 1023] = sample;
      sample += phaser[(phaserIndex - phaserDelay + 1024) & 1023]!;
      phaserIndex = (phaserIndex + 1) & 1023;
      sum += sample * volume;
    }
    out[length] = sum / 8;
  }

  const samples = out.slice(0, length);
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! / peak) * p.volume;
  return samples;
}

/** 0..1 的伪随机数（mulberry32，data/hash.ts 的 seededRandom）。 */
export type SynthRandom = () => number;
export { seededRandom };

export type SoundPreset = 'pickup' | 'laser' | 'explosion' | 'powerUp' | 'hit' | 'jump' | 'blip' | 'random';

/**
 * 按类别随机出一组参数（sfxr 的那几个按钮：拾取、激光、爆炸、升级、受击、跳跃、点选、随机）。
 * random 决定出哪一个，同一个种子出同一组；噪声的 seed 也从它取。
 */
export const SOUND_PRESETS: Readonly<Record<SoundPreset, (random: SynthRandom) => SoundSynth>> = {
  pickup: (random) => {
    const r = tools(random);
    const arpeggio = r.chance() ? { arpeggioSpeed: 0.5 + r.up(0.2), arpeggio: 0.2 + r.up(0.4) } : {};
    return r.done({ frequency: 0.4 + r.up(0.5), sustain: r.up(0.1), decay: 0.1 + r.up(0.4), punch: 0.3 + r.up(0.3), ...arpeggio });
  },
  laser: (random) => {
    const r = tools(random);
    let wave = r.pick<SynthWave>('square', 'sawtooth', 'sine');
    if (wave === 'sine' && r.chance()) wave = r.pick('square', 'sawtooth');
    let frequency = 0.5 + r.up(0.5), minFrequency = Math.max(0.2, frequency - 0.2 - r.up(0.6)), slide = -0.15 - r.up(0.2);
    if (r.oneIn(3)) [frequency, minFrequency, slide] = [0.3 + r.up(0.6), r.up(0.1), -0.35 - r.up(0.3)];
    const duty = r.chance() ? { duty: r.up(0.5), dutySweep: r.up(0.2) } : { duty: 0.4 + r.up(0.5), dutySweep: -r.up(0.7) };
    const punch = r.chance() ? { punch: r.up(0.3) } : {};
    const phaser = r.oneIn(3) ? { phaserOffset: r.up(0.2), phaserSweep: -r.up(0.2) } : {};
    const highPass = r.chance() ? { highPassCutoff: r.up(0.3) } : {};
    return r.done({ wave, frequency, minFrequency, slide, sustain: 0.1 + r.up(0.2), decay: r.up(0.4), ...duty, ...punch, ...phaser, ...highPass });
  },
  explosion: (random) => {
    const r = tools(random);
    let frequency: number, slide: number;
    if (r.chance()) [frequency, slide] = [0.1 + r.up(0.4), -0.1 + r.up(0.4)];
    else [frequency, slide] = [0.2 + r.up(0.7), -0.2 - r.up(0.2)];
    frequency *= frequency;
    if (r.oneIn(5)) slide = 0;
    const repeat = r.oneIn(3) ? { repeatSpeed: 0.3 + r.up(0.5) } : {};
    const phaser = r.chance() ? {} : { phaserOffset: -0.3 + r.up(0.9), phaserSweep: -r.up(0.3) };
    const vibrato = r.chance() ? { vibratoDepth: r.up(0.7), vibratoSpeed: r.up(0.6) } : {};
    const arpeggio = r.oneIn(3) ? { arpeggioSpeed: 0.6 + r.up(0.3), arpeggio: 0.8 - r.up(1.6) } : {};
    return r.done({ wave: 'noise', frequency, slide, sustain: 0.1 + r.up(0.3), decay: r.up(0.5), punch: 0.2 + r.up(0.6), ...repeat, ...phaser, ...vibrato, ...arpeggio });
  },
  powerUp: (random) => {
    const r = tools(random);
    const wave = r.chance() ? { wave: 'sawtooth' as const } : { duty: r.up(0.6) };
    const pitch = r.chance()
      ? { frequency: 0.2 + r.up(0.3), slide: 0.1 + r.up(0.4), repeatSpeed: 0.4 + r.up(0.4) }
      : { frequency: 0.2 + r.up(0.3), slide: 0.05 + r.up(0.2), ...(r.chance() ? { vibratoDepth: r.up(0.7), vibratoSpeed: r.up(0.6) } : {}) };
    return r.done({ ...wave, ...pitch, sustain: r.up(0.4), decay: 0.1 + r.up(0.4) });
  },
  hit: (random) => {
    const r = tools(random);
    const wave = r.pick<SynthWave>('square', 'sawtooth', 'noise');
    const highPass = r.chance() ? { highPassCutoff: r.up(0.3) } : {};
    return r.done({ wave, ...(wave === 'square' ? { duty: r.up(0.6) } : {}), frequency: 0.2 + r.up(0.6), slide: -0.3 - r.up(0.4), sustain: r.up(0.1), decay: 0.1 + r.up(0.2), ...highPass });
  },
  jump: (random) => {
    const r = tools(random);
    const highPass = r.chance() ? { highPassCutoff: r.up(0.3) } : {};
    const lowPass = r.chance() ? { lowPassCutoff: 1 - r.up(0.6) } : {};
    return r.done({ duty: r.up(0.6), frequency: 0.3 + r.up(0.3), slide: 0.1 + r.up(0.2), sustain: 0.1 + r.up(0.3), decay: 0.1 + r.up(0.2), ...highPass, ...lowPass });
  },
  blip: (random) => {
    const r = tools(random);
    const wave = r.pick<SynthWave>('square', 'sawtooth');
    return r.done({ wave, ...(wave === 'square' ? { duty: r.up(0.6) } : {}), frequency: 0.2 + r.up(0.4), sustain: 0.1 + r.up(0.1), decay: r.up(0.2), highPassCutoff: 0.1 });
  },
  random: (random) => {
    const r = tools(random);
    let frequency = r.up(1) ** 2;
    if (r.chance()) frequency = r.up(0.5) ** 3 + 0.5;
    let slide = (r.up(2) - 1) ** 5;
    if (frequency > 0.7 && slide > 0.2) slide = -slide;
    if (frequency < 0.2 && slide < -0.05) slide = -slide;
    let [attack, sustain, decay] = [(r.up(2) - 1) ** 3, (r.up(2) - 1) ** 2, r.up(2) - 1];
    if (attack + sustain + decay < 0.2) [sustain, decay] = [sustain + 0.2 + r.up(0.3), decay + 0.2 + r.up(0.3)];
    const lowPassCutoff = 1 - r.up(1) ** 3;
    return r.done({
      wave: r.pick('square', 'sawtooth', 'sine', 'noise', 'triangle'),
      frequency, minFrequency: 0, slide, deltaSlide: (r.up(2) - 1) ** 3,
      duty: r.up(2) - 1, dutySweep: (r.up(2) - 1) ** 3,
      vibratoDepth: (r.up(2) - 1) ** 3, vibratoSpeed: r.up(2) - 1,
      attack: Math.abs(attack), sustain: Math.abs(sustain), decay: Math.abs(decay), punch: r.up(0.8) ** 2,
      lowPassResonance: r.up(2) - 1, lowPassCutoff, lowPassSweep: (r.up(2) - 1) ** 3,
      highPassCutoff: r.up(1) ** 5, highPassSweep: (r.up(2) - 1) ** 5,
      phaserOffset: (r.up(2) - 1) ** 3, phaserSweep: (r.up(2) - 1) ** 3,
      repeatSpeed: r.up(2) - 1, arpeggioSpeed: r.up(2) - 1, arpeggio: r.up(2) - 1,
    });
  },
};

/** 在一组参数附近随机变一点（sfxr 的 Mutate：每个参数一半的机会挪 ±0.05）。 */
export function mutateSound(params: SoundSynth, random: SynthRandom, amount = 0.05): SoundSynth {
  const next: Record<string, unknown> = { ...params, seed: Math.floor(random() * 0x7fffffff) };
  for (const [key, [min, max]] of Object.entries(SYNTH_RANGES)) {
    if (random() < 0.5) continue;
    next[key] = round(clamp((params[key as keyof typeof SYNTH_RANGES] as number) + (random() * 2 - 1) * amount, min, max));
  }
  return next as unknown as SoundSynth;
}

/** 数值参数的范围（字段描述、变异、预设都按它夹）。 */
export const SYNTH_RANGES: Readonly<Record<Exclude<keyof SoundSynth, 'wave' | 'seed'>, readonly [number, number]>> = {
  attack: [0, 1], sustain: [0, 1], punch: [0, 1], decay: [0, 1],
  frequency: [0, 1], minFrequency: [0, 1], slide: [-1, 1], deltaSlide: [-1, 1],
  vibratoDepth: [0, 1], vibratoSpeed: [0, 1], arpeggio: [-1, 1], arpeggioSpeed: [0, 1],
  duty: [0, 1], dutySweep: [-1, 1], repeatSpeed: [0, 1], phaserOffset: [-1, 1], phaserSweep: [-1, 1],
  lowPassCutoff: [0, 1], lowPassSweep: [-1, 1], lowPassResonance: [0, 1], highPassCutoff: [0, 1], highPassSweep: [-1, 1], volume: [0, 1],
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** 文件里的参数留 3 位小数（听不出差别，文件好读、好比较）。 */
const round = (value: number) => Math.round(value * 1000) / 1000;

/** 预设里用的随机小工具；done 补上默认值、夹进范围、带上噪声的种子。 */
function tools(random: SynthRandom) {
  return {
    up: (max: number) => random() * max,
    chance: () => random() < 0.5,
    oneIn: (n: number) => random() * n < 1,
    pick: <T>(...values: T[]) => values[Math.floor(random() * values.length)]!,
    done: (params: Partial<SoundSynth>): SoundSynth => {
      const result: Record<string, unknown> = { ...DEFAULT_SOUND_SYNTH, ...params, seed: Math.floor(random() * 0x7fffffff) };
      for (const [key, [min, max]] of Object.entries(SYNTH_RANGES)) result[key] = round(clamp(result[key] as number, min, max));
      return result as unknown as SoundSynth;
    },
  };
}
