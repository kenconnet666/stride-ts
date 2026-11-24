/**
 * 声音事件（`.soundevent.json`，Stride 没有；照 FMOD、Wwise 的事件，虚幻的 Sound Cue / MetaSound）：脚本发"脚步"，带上地面、
 * 速度这样的参数，放哪个声音、几层、多响由资源定，不在代码里写死文件名：
 *
 *   game.audio.events.play(step, { entity: this.entity, parameters: { surface: 'grass', speed: 0.8 } });
 *
 * - variants：可选的声音。同一层（layer）的按条件（when：标签参数等于某值、数值参数落在某范围）筛出来，按权重随机挑一个，不和
 *   上一次挑的重复（只剩一个时除外）；几层同时放（脚步加衣服的窸窣、引擎的低转加高转）。
 * - layers：层的音量、音高随一个数值参数的曲线变（速度越快跑步声越响）。
 * - 每次放随机变一点音量、音高，同一个声音连着放不机械。
 * - spatial：按发声的位置相对听者空间化，按距离衰减到 maxDistance；null 是不空间化的（界面音、音乐）。
 * - maxInstances、steal：这个事件同时最多几个，满了抢谁；priority：全局发声满了先留谁。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

const curve = s.object({
  parameter: s.string().describe('number parameter that drives it'),
  points: s.list(s.vector(2)).describe('[parameter value, multiplier] pairs, sorted by the value; linear in between, flat outside'),
});

export const SOUND_EVENT = s.object({
  name: s.string(),
  parameters: s.list(s.object({
    name: s.string(),
    type: s.oneOf('number', 'label').default('number').describe('number: a value (speed, rpm); label: one of a set of words (surface: grass, concrete)'),
    default: s.json().optional().describe('value when the caller does not give one (0 or the first label when missing)'),
    values: s.list(s.string()).optional().describe('the labels a label parameter can take'),
  })).default([]).describe('parameters the caller sets when playing (and can change while it plays)'),
  variants: s.list(s.object({
    sound: s.asset('sound'),
    layer: s.string().default('main').describe('variants of one layer are alternatives (one is picked); layers play together'),
    when: s.record().optional().describe('conditions on parameters: a label ({ "surface": "grass" }) or a number range ({ "speed": [0.5, 1] }); all must hold'),
    weight: s.number({ min: 0, step: 0.1 }).default(1).describe('relative chance among the variants that pass'),
    volume: s.number({ min: 0, step: 0.05 }).default(1),
  })).describe('the sounds it can play'),
  layers: s.list(s.object({
    name: s.string(),
    volume: curve.optional().describe('volume multiplier by a number parameter'),
    pitch: curve.optional().describe('playback rate multiplier by a number parameter'),
  })).default([]).describe('per-layer curves (layers without an entry play at full volume)'),
  volume: s.number({ min: 0, step: 0.05 }).default(1).describe('linear gain'),
  /** 每次放音量随机变多少（分贝，正负）、音高随机变多少（半音，正负）。 */
  volumeRandom: s.number({ min: 0, max: 24, step: 0.5, unit: 'dB' }).default(0).describe('random volume change per play (plus or minus, decibels)'),
  pitchRandom: s.number({ min: 0, max: 12, step: 0.1 }).default(0).describe('random pitch change per play (plus or minus, semitones)'),
  loop: s.bool().default(false).describe('loops until stopped (engines, ambience)'),
  spatial: s.object({
    minDistance: s.number({ min: 0.01, step: 0.5, unit: 'm' }).default(1).describe('full volume up to here'),
    maxDistance: s.number({ min: 0.1, step: 1, unit: 'm' }).default(50).describe('silent from here on (the voice is virtual)'),
    rolloff: s.oneOf('inverse', 'linear').default('inverse').describe('inverse: natural 1/distance falloff (cut at maxDistance); linear: straight down to 0 at maxDistance'),
    occlusion: s.bool().default(true).describe('walls between it and the listener muffle it (low-pass and quieter)'),
  }).nullable().default(null).describe('positional sound; null plays it flat (UI, music)'),
  maxInstances: s.integer(0, 256).default(0).describe('how many of this event can play at once (0: no limit)'),
  steal: s.oneOf('oldest', 'farthest', 'none').default('oldest').describe('when the limit is hit: stop the oldest or the farthest one, or do not start the new one'),
  priority: s.integer(0, 100).default(50).describe('higher keeps its voice when too many sounds play at once'),
});

/** 声音事件文件的样子（有默认值的可以不写）。 */
export type SoundEventFile = InputOf<typeof SOUND_EVENT>;
/** 解析以后的声音事件（默认值补齐）。 */
export type SoundEventData = Infer<typeof SOUND_EVENT>;

/** 查名字对不对得上：参数不重名、条件和曲线引用的参数存在、标签参数的条件值在 values 里、至少有一个变体。返回 data。 */
export function checkSoundEvent(data: SoundEventData, where: string): SoundEventData {
  const parameters = new Map<string, SoundEventData['parameters'][number]>();
  for (const parameter of data.parameters) {
    if (parameters.has(parameter.name)) throw new Error(`${where}: parameter '${parameter.name}' is declared twice`);
    parameters.set(parameter.name, parameter);
  }
  if (data.variants.length === 0) throw new Error(`${where}: a sound event needs at least one variant`);
  const need = (name: string, type: 'number' | 'label', context: string) => {
    const parameter = parameters.get(name);
    if (!parameter) throw new Error(`${where}: ${context} uses parameter '${name}', which is not declared`);
    if (parameter.type !== type) throw new Error(`${where}: ${context} uses parameter '${name}' as a ${type}, but it is a ${parameter.type}`);
    return parameter;
  };
  data.variants.forEach((variant, i) => {
    for (const [name, condition] of Object.entries(variant.when ?? {})) {
      if (typeof condition === 'string') {
        const parameter = need(name, 'label', `variant ${i}`);
        if (parameter.values && !parameter.values.includes(condition)) throw new Error(`${where}: variant ${i} wants ${name} = '${condition}', which is not one of ${parameter.values.join(', ')}`);
      } else if (Array.isArray(condition) && condition.length === 2 && condition.every((v) => typeof v === 'number')) {
        need(name, 'number', `variant ${i}`);
      } else {
        throw new Error(`${where}: variant ${i}: the condition on '${name}' must be a label or a [min, max] range`);
      }
    }
  });
  for (const layer of data.layers) {
    if (!data.variants.some((variant) => variant.layer === layer.name)) throw new Error(`${where}: layer '${layer.name}' has no variants`);
    for (const curve of [layer.volume, layer.pitch]) if (curve) need(curve.parameter, 'number', `layer '${layer.name}'`);
  }
  if (data.spatial && data.spatial.maxDistance <= data.spatial.minDistance) throw new Error(`${where}: spatial.maxDistance must be larger than minDistance`);
  return data;
}
