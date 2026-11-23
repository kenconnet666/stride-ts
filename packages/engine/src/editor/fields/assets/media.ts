/** 时间轴、精灵表和声音（含音效生成器的参数）的字段。 */
import type { TimelineFile, SpriteSheetFile, SoundFile } from '../../../content/formats/format';
import { DEFAULT_SOUND_SYNTH, SYNTH_RANGES, type SoundSynth } from '../../../audio/soundSynth.ts';
import { fields, number, integer, bool, string, oneOf, vector, asset, entity, list, object, type Field, type FieldSpec } from '../../../content/schema/builders.ts';
import { textureRef } from './shared.ts';
import { INPUT_MAP } from '../../../content/formats/inputFormat.ts';
import { schemaFields } from '../../../content/schema/schema.ts';

/** 时间轴（TimelineFile）：轨道按种类分；关键帧的值是数或按分量的数组，按 JSON 改。 */
/** 输入映射（InputMapFile）：动作和绑定。字段由格式的模式给出（content/formats/inputFormat.ts）。 */
export const INPUT_MAP_FIELDS = schemaFields(INPUT_MAP);

export const TIMELINE_FIELDS = fields<TimelineFile>({
  name: string,
  duration: { type: number({ min: 0, unit: 's' }) },
  frameRate: { type: number({ min: 1 }), optional: true, default: 30, description: 'frames per second for snapping and display in the editor' },
  tracks: list({
    kind: 'union',
    tag: 'type',
    variants: {
      property: fields<{ entity: unknown; component: unknown; property: unknown; interpolation: unknown; keys: unknown }>({
        entity: { type: entity, description: 'id of the entity in the scene file' },
        component: { type: string, description: 'runtime component name (Transform, Light, or a game component registered by module path)' },
        property: string,
        interpolation: { type: oneOf('constant', 'linear', 'cubic'), optional: true, default: 'linear' },
        keys: list(object([
          { name: 'time', type: number({ min: 0, unit: 's' }) },
          { name: 'value', type: { kind: 'json' }, description: 'a number, or the components (xyz, xyzw, rgba)' },
          { name: 'in', type: { kind: 'json' }, optional: true, description: 'cubic only: slope (per second) arriving at the key, per component; unset is automatic' },
          { name: 'out', type: { kind: 'json' }, optional: true, description: 'cubic only: slope (per second) leaving the key, per component; unset is automatic' },
        ])),
      }),
      camera: fields<{ cuts: unknown }>({ cuts: list(object([{ name: 'time', type: number({ min: 0, unit: 's' }) }, { name: 'camera', type: entity, description: 'id of the camera entity in the scene file' }])) }),
      animation: fields<{ entity: unknown; clips: unknown }>({
        entity: { type: entity, description: 'id of the entity in the scene file' },
        clips: list(object([
          { name: 'start', type: number({ min: 0, unit: 's' }) },
          { name: 'clip', type: string, description: 'name of the clip in the AnimationComponent' },
          { name: 'speed', type: number(), optional: true, default: 1 },
          { name: 'blend', type: number({ min: 0, unit: 's' }), optional: true, description: 'seconds of crossfade from the previous clip' },
        ])),
      }),
      sound: fields<{ clips: unknown }>({
        clips: list(object([
          { name: 'start', type: number({ min: 0, unit: 's' }) },
          { name: 'sound', type: asset('sound') },
          { name: 'volume', type: number({ min: 0 }), optional: true, default: 1 },
        ])),
      }),
      subtitle: fields<{ cues: unknown }>({
        cues: list(object([{ name: 'start', type: number({ min: 0, unit: 's' }) }, { name: 'end', type: number({ min: 0, unit: 's' }) }, { name: 'text', type: string }])),
      }),
      event: fields<{ events: unknown }>({ events: list(object([{ name: 'time', type: number({ min: 0, unit: 's' }) }, { name: 'name', type: string }])) }),
    } satisfies Record<TimelineFile['tracks'][number]['type'], readonly Field[]>,
  }),
});

/**
 * 精灵表（SpriteSheetFile）：精灵的列表，每个精灵是贴图上的一块区域、原点、九宫格的边框。改了马上存，用到它的精灵热重载；
 * 区域、原点在编辑器底部的精灵表面板里拖（贴图上画出各个精灵的框），切图（按网格、自动找）也在那里。
 */
export const SPRITE_SHEET_FIELDS = fields<SpriteSheetFile>({
  name: string,
  sprites: {
    type: list(object(fields<SpriteSheetFile['sprites'][number]>({
      name: string,
      texture: object(textureRef),
      region: { type: vector(4), description: 'area on the texture in pixels: x, y (top left), width, height' },
      pixelsPerUnit: { type: number({ min: 0.001, step: 1 }), description: 'texture pixels per world unit (meter)' },
      center: { type: vector(2), description: 'origin in pixels: from the region center when centerFromMiddle, otherwise from its top left' },
      centerFromMiddle: bool,
      borders: { type: vector(4), optional: true, default: [0, 0, 0, 0], description: '9-slice borders in pixels: left, top, right, bottom (0: the whole sprite stretches)' },
    }))),
    description: 'the sprites, in order (a sprite component picks one by index)',
  },
});

/** 合成音效的一个数值参数：范围照 SYNTH_RANGES，默认值照 DEFAULT_SOUND_SYNTH，group 是面板上的分组。 */
export const synthNumber = (key: keyof typeof SYNTH_RANGES, group: string, description: string): FieldSpec => {
  const [min, max] = SYNTH_RANGES[key];
  return { type: number({ min, max, step: 0.01 }), optional: true, default: DEFAULT_SOUND_SYNTH[key], group, description };
};

/** 合成音效（audio/soundSynth.ts，sfxr 的算法和参数范围）。 */
export const SOUND_SYNTH_FIELDS = fields<SoundSynth>({
  wave: { type: oneOf('square', 'sawtooth', 'sine', 'triangle', 'noise'), optional: true, default: DEFAULT_SOUND_SYNTH.wave, group: 'tone', description: 'waveform' },
  attack: synthNumber('attack', 'envelope', 'rise time (squared: 1 is about 2.3 seconds)'),
  sustain: synthNumber('sustain', 'envelope', 'hold time (squared, like attack)'),
  punch: synthNumber('punch', 'envelope', 'extra loudness at the start of the hold, falling off'),
  decay: synthNumber('decay', 'envelope', 'fade-out time (squared, like attack)'),
  frequency: synthNumber('frequency', 'pitch', 'start pitch (squared: 0.3 is about 330 Hz, 0.5 about 880 Hz)'),
  minFrequency: synthNumber('minFrequency', 'pitch', 'the sound ends when a falling pitch reaches this (0: never)'),
  slide: synthNumber('slide', 'pitch', 'pitch slide: positive goes up, negative goes down'),
  deltaSlide: synthNumber('deltaSlide', 'pitch', 'change of the slide over time'),
  vibratoDepth: synthNumber('vibratoDepth', 'pitch', 'vibrato depth'),
  vibratoSpeed: synthNumber('vibratoSpeed', 'pitch', 'vibrato speed'),
  arpeggio: synthNumber('arpeggio', 'pitch', 'pitch jump after a while: positive up, negative down'),
  arpeggioSpeed: synthNumber('arpeggioSpeed', 'pitch', 'how soon the pitch jumps (1: never)'),
  repeatSpeed: synthNumber('repeatSpeed', 'pitch', 'restart the pitch (not the envelope) this often (0: never)'),
  duty: synthNumber('duty', 'tone', 'square wave: 0 is half and half, higher is thinner'),
  dutySweep: synthNumber('dutySweep', 'tone', 'change of the duty over time'),
  phaserOffset: synthNumber('phaserOffset', 'tone', 'phaser: delay of the copy mixed in'),
  phaserSweep: synthNumber('phaserSweep', 'tone', 'change of the phaser delay over time'),
  lowPassCutoff: synthNumber('lowPassCutoff', 'filter', 'low-pass cutoff (1: no filtering)'),
  lowPassSweep: synthNumber('lowPassSweep', 'filter', 'change of the low-pass cutoff over time'),
  lowPassResonance: synthNumber('lowPassResonance', 'filter', 'low-pass resonance'),
  highPassCutoff: synthNumber('highPassCutoff', 'filter', 'high-pass cutoff (0: no filtering)'),
  highPassSweep: synthNumber('highPassSweep', 'filter', 'change of the high-pass cutoff over time'),
  volume: synthNumber('volume', 'output', 'peak level'),
  seed: { type: integer(0), optional: true, default: DEFAULT_SOUND_SYNTH.seed, group: 'output', description: 'random seed of the noise (the same parameters always give the same sound)' },
});

/** 声音资源：音频文件的格式和播放方式，合成的音效的参数。 */
export const SOUND_FIELDS = fields<SoundFile>({
  name: string,
  encoding: { type: oneOf('wav', 'mp3', 'ogg', 'flac', 'aac', 'synth'), description: "format of the audio file next to it; 'synth' is a generated sound effect with no audio file" },
  streamFromDisk: { type: bool, description: 'play while downloading (music) instead of decoding it whole first; generated sounds are never streamed' },
  spatialized: { type: bool, description: 'can be positioned in 3D by an audio emitter' },
  synth: { type: object(SOUND_SYNTH_FIELDS), optional: true, description: "sound effect generator parameters (sfxr's), used when the encoding is 'synth'" },
});
