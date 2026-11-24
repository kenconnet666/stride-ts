/**
 * 声音事件的运行时（`game.audio.events`，照 FMOD Studio、Wwise 的事件实例和发声管理；格式见 content/formats/soundEventFormat.ts）：
 *
 *   const step = await game.content.loadSoundEvent('Audio/Footstep');
 *   game.audio.events.play(step, { entity, parameters: { surface: 'grass', speed: 0.8 } });
 *   const engine = game.audio.events.play(motor, { entity: car });   // 循环的
 *   engine.setParameter('rpm', 3200);
 *
 * 每帧（update，Game 在脚本之后调）：
 * - 位置跟着实体走（或者放时给的点），按距离算衰减（自己算，不让 PannerNode 衰减：虚拟化要用同一个数）；PannerNode 只管方位；
 * - 发声管理：maxDistance 以外的听不见，虚拟化（不出声、记着在放）；能出声的按优先级、再按多响排，只留前 maxVoices 个，
 *   别的也虚拟化；虚拟的循环声回到能出声时从停下的地方接着放，一次性的放过了时长就结束；
 * - 遮挡：空间化、开了 occlusion 的出声的那些，隔 OCCLUSION_INTERVAL 秒（按编号错开）从听者往声源打一条射线
 *   （occlusionTest：Game 接物理的射线，发声的实体自己的碰撞体不算），挡住了声音变闷（低通）、变小，平滑地变过去。
 * 听者：最后一个更新的 AudioListenerComponent；没有时 Game 用主相机。
 */
import type { SoundEventData } from '../content/formats/soundEventFormat';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Vec3Like } from '../data/vectors';
import type { AudioEngine } from './AudioEngine';
import type { Sound, SoundInstance } from './Sound';

/** 加载好的声音事件：数据和变体用到的声音。 */
export interface SoundEvent {
  readonly path: string;
  readonly data: SoundEventData;
  readonly sounds: ReadonlyMap<string, Sound>;
}

export interface SoundEventPlayOptions {
  /** 跟着这个实体走（世界位置）。 */
  readonly entity?: Entity;
  /** 没有实体时固定在这一点（世界坐标）；都没有时在听者身上（不空间化地放）。 */
  readonly position?: Vec3Like;
  readonly parameters?: Readonly<Record<string, number | string>>;
  /** 再乘的音量（环境声区的淡入淡出用）。 */
  readonly volume?: number;
}

/** 全局同时出声的上限（浏览器混几十路没问题；多了听不清，费的是 CPU 的混音）。 */
const DEFAULT_MAX_VOICES = 48;
/** 隔多久测一次遮挡（秒）。 */
const OCCLUSION_INTERVAL = 0.1;
/** 挡住时的低通截止频率（赫兹）、音量。 */
const OCCLUDED_CUTOFF = 1200;
const OPEN_CUTOFF = 20000;
const OCCLUDED_GAIN = 0.5;
/** 遮挡的值往目标走得多快（每秒）：一下变闷听着像断了。 */
const OCCLUSION_SPEED = 6;

/** 一层放着的声音。 */
interface LayerVoice {
  readonly layer: string;
  readonly instance: SoundInstance;
  /** 变体自己的音量乘每次随机的那一点。 */
  readonly volume: number;
  readonly pitch: number;
  readonly duration: number;
}

/** 一次放的事件（play 返回）。 */
export class SoundEventInstance {
  readonly event: SoundEvent;
  readonly #system: SoundEventSystem;
  readonly #parameters = new Map<string, number | string>();
  /** @internal */ readonly voices: LayerVoice[] = [];
  /** @internal */ readonly entity: Entity | undefined;
  /** @internal */ readonly position: [number, number, number] | undefined;
  /** @internal */ readonly id: number;
  /** @internal 放了多久（游戏时间的秒，虚拟时也走）。 */ age = 0;
  /** @internal 这一帧离听者多远、按距离衰减以后的音量（0 到 1）。 */ distance = 0;
  /** @internal */ attenuation = 1;
  /** @internal 0 是没挡、1 是全挡；目标值和下次测的时刻。 */ occlusion = 0;
  /** @internal */ occluded = false;
  /** @internal */ nextOcclusionTest = 0;
  /** @internal 现在出声（不是虚拟的）。 */ real = false;
  /**
   * @internal 上次写给节点的位置、增益、截止频率：变了才写（AudioParam 的 value 读写都要过一次浏览器内部的边界，几十路声音每帧
   * 读写几百次要几毫秒）。
   */
  readonly applied = { x: NaN, y: NaN, z: NaN, gain: NaN, cutoff: NaN };
  /** @internal */ finished = false;
  /** @internal 这一路的节点：方位、低通、音量。 */ readonly chain: { panner: PannerNode | undefined; filter: BiquadFilterNode; gain: GainNode };
  #volume: number;

  /** @internal SoundEventSystem.play 建。 */
  constructor(system: SoundEventSystem, event: SoundEvent, id: number, options: SoundEventPlayOptions, chain: SoundEventInstance['chain']) {
    this.#system = system;
    this.event = event;
    this.id = id;
    this.entity = options.entity;
    this.position = options.position ? [options.position.x, options.position.y, options.position.z] : undefined;
    this.#volume = options.volume ?? 1;
    this.chain = chain;
    for (const parameter of event.data.parameters) {
      this.#parameters.set(parameter.name, (options.parameters?.[parameter.name] ?? parameter.default ?? (parameter.type === 'label' ? (parameter.values?.[0] ?? '') : 0)) as number | string);
    }
  }

  /** 还在放（没停、一次性的没放完）。 */
  get playing(): boolean {
    return !this.finished;
  }

  /** 现在是虚拟的（太远、发声满了）：不出声、还记着在放。 */
  get virtual(): boolean {
    return !this.finished && !this.real;
  }

  /** 再乘的音量（环境声区按听者离多远淡入淡出）。 */
  get volume(): number {
    return this.#volume;
  }

  set volume(value: number) {
    this.#volume = Math.max(0, value);
  }

  parameter(name: string): number | string {
    const value = this.#parameters.get(name);
    if (value === undefined) throw new Error(`sound event '${this.event.path}' has no parameter '${name}'`);
    return value;
  }

  /** 改参数：层的音量、音高曲线马上跟着变（挑哪个变体是放的时候定的）。 */
  setParameter(name: string, value: number | string): void {
    this.parameter(name);
    this.#parameters.set(name, value);
    this.#system.applyLayers(this);
  }

  /** 停下（放完、停下以后这个实例不再用）。 */
  stop(): void {
    this.#system.finish(this);
  }
}

/** `game.audio.events`：放声音事件、管理发声。 */
export class SoundEventSystem {
  /** 全局同时出声的上限。 */
  maxVoices = DEFAULT_MAX_VOICES;
  /** 测遮挡：从 from 到 to 之间有没有挡着的东西（emitter 的碰撞体不算）；Game 接物理，没有时不测。 */
  occlusionTest: ((from: readonly number[], to: readonly number[], emitter: Entity | undefined) => boolean) | undefined;
  /** 每个事件上次挑的变体（同一层不连着挑同一个）。 */
  readonly #lastPick = new Map<string, number>();
  readonly #instances: SoundEventInstance[] = [];
  readonly #engine: AudioEngine;
  #nextId = 1;
  #now = 0;
  /** 上一帧的听者位置。 */
  #listener: readonly [number, number, number] = [0, 0, 0];
  /** 随机数（测试里换成固定的）。 */
  random: () => number = Math.random;
  /** 上一帧的统计（调试命令 audio）。 */
  stats = { instances: 0, real: 0, virtual: 0, occluded: 0 };

  constructor(engine: AudioEngine) {
    this.#engine = engine;
  }

  /** 放的事件（没放完的），按开始的先后。 */
  get instances(): readonly SoundEventInstance[] {
    return this.#instances;
  }

  /** 放一个事件；同时放的个数满了、抢不到时返回 undefined。 */
  play(event: SoundEvent, options: SoundEventPlayOptions = {}): SoundEventInstance | undefined {
    const data = event.data;
    if (data.maxInstances > 0) {
      const same = this.#instances.filter((instance) => instance.event === event);
      if (same.length >= data.maxInstances) {
        if (data.steal === 'none') return undefined;
        const victim = data.steal === 'oldest' ? same[0]! : same.reduce((a, b) => (b.distance > a.distance ? b : a));
        this.finish(victim);
      }
    }
    const context = this.#engine.context;
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = OPEN_CUTOFF;
    filter.connect(gain);
    gain.connect(this.#engine.output);
    let panner: PannerNode | undefined;
    if (data.spatial && (options.entity || options.position)) {
      panner = context.createPanner();
      panner.panningModel = 'equalpower';
      // 距离的衰减自己算（虚拟化用同一个数）：PannerNode 只管方位
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;
      panner.connect(filter);
    }
    const instance = new SoundEventInstance(this, event, this.#nextId++, options, { panner, filter, gain });
    this.#pickVoices(instance, panner ?? filter);
    this.#instances.push(instance);
    this.#place(instance);
    this.#attenuate(instance);
    gain.gain.value = instance.applied.gain = 0;
    return instance;
  }

  /** 按参数挑每一层的变体，建好播放实例（还没出声：update 决定谁出声）。 */
  #pickVoices(instance: SoundEventInstance, output: AudioNode): void {
    const data = instance.event.data;
    const layers = [...new Set(data.variants.map((variant) => variant.layer))];
    for (const layer of layers) {
      const candidates = data.variants.map((variant, index) => ({ variant, index })).filter(({ variant }) => variant.layer === layer && this.#matches(instance, variant.when));
      if (candidates.length === 0) continue;
      const key = `${instance.event.path}|${layer}`;
      const last = this.#lastPick.get(key);
      const pool = candidates.length > 1 ? candidates.filter(({ index }) => index !== last) : candidates;
      const total = pool.reduce((sum, { variant }) => sum + variant.weight, 0);
      let roll = this.random() * total;
      let chosen = pool[pool.length - 1]!;
      for (const candidate of pool) {
        roll -= candidate.variant.weight;
        if (roll < 0) {
          chosen = candidate;
          break;
        }
      }
      this.#lastPick.set(key, chosen.index);
      const sound = instance.event.sounds.get(chosen.variant.sound);
      if (!sound) throw new Error(`sound event '${instance.event.path}': sound '${chosen.variant.sound}' was not loaded`);
      const decibels = (this.random() * 2 - 1) * data.volumeRandom;
      const semitones = (this.random() * 2 - 1) * data.pitchRandom;
      const voice = sound.createInstance(output);
      voice.isLooping = data.loop;
      instance.voices.push({ layer, instance: voice, volume: chosen.variant.volume * 10 ** (decibels / 20), pitch: 2 ** (semitones / 12), duration: sound.totalLength });
    }
    this.applyLayers(instance);
  }

  #matches(instance: SoundEventInstance, when: Readonly<Record<string, unknown>> | undefined): boolean {
    for (const [name, condition] of Object.entries(when ?? {})) {
      const value = instance.parameter(name);
      if (typeof condition === 'string' ? value !== condition : !(typeof value === 'number' && value >= (condition as number[])[0]! && value <= (condition as number[])[1]!)) return false;
    }
    return true;
  }

  /** @internal 层的音量、音高按参数的曲线。 */
  applyLayers(instance: SoundEventInstance): void {
    const data = instance.event.data;
    for (const voice of instance.voices) {
      const layer = data.layers.find((entry) => entry.name === voice.layer);
      const volume = layer?.volume ? piecewiseLinear(layer.volume.points, Number(instance.parameter(layer.volume.parameter))) : 1;
      const pitch = layer?.pitch ? piecewiseLinear(layer.pitch.points, Number(instance.parameter(layer.pitch.parameter))) : 1;
      voice.instance.volume = voice.volume * volume;
      voice.instance.pitch = voice.pitch * pitch;
    }
  }

  /** @internal 停下、断开、从列表里去掉。 */
  finish(instance: SoundEventInstance): void {
    if (instance.finished) return;
    instance.finished = true;
    for (const voice of instance.voices) voice.instance.dispose();
    const { panner, filter, gain } = instance.chain;
    for (const node of [panner, filter, gain]) node?.disconnect();
    const index = this.#instances.indexOf(instance);
    if (index >= 0) this.#instances.splice(index, 1);
  }

  /** 停下所有的（换场景）。 */
  stopAll(): void {
    for (const instance of [...this.#instances]) this.finish(instance);
  }

  /** 每帧一次：listener 是听者的世界位置；elapsed 是这一帧的游戏时间（秒）。 */
  update(listener: readonly [number, number, number], elapsed: number): void {
    this.#listener = listener;
    this.#now += elapsed;
    const instances = this.#instances;
    for (const instance of [...instances]) {
      instance.age += elapsed;
      // 一次性的放完了：出声的看播放状态，虚拟的按时长算
      const done = !instance.event.data.loop && (instance.real
        ? instance.voices.every((voice) => voice.instance.playState === 'stopped')
        : instance.voices.every((voice) => instance.age >= voice.duration / voice.pitch));
      if (done || (instance.entity && !instance.entity.manager.isAlive(instance.entity.id))) {
        this.finish(instance);
        continue;
      }
      this.#place(instance);
      this.#attenuate(instance);
    }
    // 能出声的（听得见）按优先级、多响排，前 maxVoices 个出声
    const audible = instances.filter((instance) => instance.attenuation * instance.volume > 0);
    audible.sort((a, b) => b.event.data.priority - a.event.data.priority || b.attenuation * b.volume - a.attenuation * a.volume);
    const real = new Set(audible.slice(0, this.maxVoices));
    let occluded = 0;
    for (const instance of instances) {
      const wanted = real.has(instance);
      if (wanted !== instance.real) this.#setReal(instance, wanted);
      if (!wanted) continue;
      this.#occlude(instance, elapsed);
      if (instance.occluded) occluded++;
      const { filter, gain } = instance.chain;
      const muffle = instance.occlusion, applied = instance.applied;
      const cutoff = OPEN_CUTOFF * (OCCLUDED_CUTOFF / OPEN_CUTOFF) ** muffle;
      const level = instance.event.data.volume * instance.volume * instance.attenuation * (1 - (1 - OCCLUDED_GAIN) * muffle);
      if (applied.cutoff !== cutoff) filter.frequency.value = applied.cutoff = cutoff;
      if (applied.gain !== level) gain.gain.value = applied.gain = level;
    }
    this.stats = { instances: instances.length, real: real.size, virtual: instances.length - real.size, occluded };
  }

  /** 位置给方位（PannerNode）；记离听者多远。 */
  #place(instance: SoundEventInstance): void {
    const point = this.#positionOf(instance);
    const listener = this.#listener;
    instance.distance = point ? Math.hypot(point[0] - listener[0], point[1] - listener[1], point[2] - listener[2]) : 0;
    const panner = instance.chain.panner;
    // 方位只给出声的；直接写 value（setValueAtTime 在 AudioContext 挂起时事件一直堆着，几百个声音一帧十几毫秒）
    if (!panner || !point || !instance.real) return;
    const applied = instance.applied;
    if (applied.x !== point[0]) panner.positionX.value = applied.x = point[0];
    if (applied.y !== point[1]) panner.positionY.value = applied.y = point[1];
    if (applied.z !== point[2]) panner.positionZ.value = applied.z = point[2];
  }

  #positionOf(instance: SoundEventInstance): readonly [number, number, number] | undefined {
    if (instance.entity) {
      const world = instance.entity.get(Transform)?.world;
      if (world) return [world[12]!, world[13]!, world[14]!];
    }
    return instance.position;
  }

  /** 按距离衰减（0 到 1）：空间化的到 maxDistance 是 0。 */
  #attenuate(instance: SoundEventInstance): void {
    const spatial = instance.event.data.spatial;
    instance.attenuation = spatial && instance.chain.panner ? distanceGain(instance.distance, spatial.minDistance, spatial.maxDistance, spatial.rolloff) : 1;
  }

  #setReal(instance: SoundEventInstance, real: boolean): void {
    instance.real = real;
    if (real) this.#place(instance);
    for (const voice of instance.voices) {
      if (real) {
        // 一次性的放过了时长：不再出声（update 下一帧按时长结束它）
        if (!instance.event.data.loop && instance.age >= voice.duration / voice.pitch) continue;
        voice.instance.play();
      } else {
        voice.instance.pause();
      }
    }
    if (!real) instance.chain.gain.gain.value = instance.applied.gain = 0;
  }

  #occlude(instance: SoundEventInstance, elapsed: number): void {
    const spatial = instance.event.data.spatial;
    const test = this.occlusionTest;
    if (!spatial?.occlusion || !instance.chain.panner || !test) {
      instance.occlusion = 0;
      instance.occluded = false;
      return;
    }
    if (this.#now >= instance.nextOcclusionTest) {
      // 按编号错开：一大群声音不在同一帧一起打射线
      instance.nextOcclusionTest = this.#now + OCCLUSION_INTERVAL * (instance.nextOcclusionTest === 0 ? (instance.id * 0.618034) % 1 : 1);
      const point = this.#positionOf(instance);
      instance.occluded = point !== undefined && instance.distance > 0.5 && test(this.#listener, point, instance.entity);
    }
    const target = instance.occluded ? 1 : 0;
    const step = OCCLUSION_SPEED * elapsed;
    instance.occlusion += Math.max(-step, Math.min(step, target - instance.occlusion));
  }
}

/** 按距离的音量：minDistance 以内是 1；inverse 是 minDistance / distance，到 maxDistance 截成 0；linear 直线降到 0。 */
export function distanceGain(distance: number, minDistance: number, maxDistance: number, rolloff: 'inverse' | 'linear'): number {
  if (distance >= maxDistance) return 0;
  if (distance <= minDistance) return 1;
  return rolloff === 'linear' ? 1 - (distance - minDistance) / (maxDistance - minDistance) : minDistance / distance;
}

/** 分段线性的曲线（点按 x 排好）：两头以外取端点的值；没有点时是 1。 */
export function piecewiseLinear(points: readonly (readonly number[])[], x: number): number {
  if (points.length === 0) return 1;
  if (x <= points[0]![0]!) return points[0]![1]!;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!, [x0, y0] = points[i - 1]!;
    if (x <= x1!) return y0! + ((y1! - y0!) * (x - x0!)) / Math.max(x1! - x0!, 1e-9);
  }
  return points[points.length - 1]![1]!;
}
