/**
 * 时间轴（content/assetFormat.ts 的 TimelineFile）在运行时：某个时刻各条轨道是什么样。求值是无状态的——给一个时刻就能把
 * 场景摆成那一刻的样子（属性、相机、字幕），所以编辑器里拖时间、成片逐帧出、游戏里按帧播放都走同一个 `evaluate`；
 * 声音、事件、动画剪辑这些"经过某个时刻才发生"的由播放的一方按前后两个时刻比较（`crossed`）。
 *
 *   const timeline = await game.content.loadTimeline('Cutscenes/Intro');
 *   timeline.evaluate(2.5, binding);   // binding 把文件里的实体 id、组件名对上这个场景
 */
import type { ComponentType } from '../engine/component';
import type { Entity } from '../engine/Entity';
import { evaluateCurve, writeCurveValue, type PropertyCurve } from '../animation/curves';
import type { TimelineFile, TimelineTrackFile } from '../content/format';
import type { Sound } from '../audio/Sound';

/** 时间轴怎么找到场景里的东西。 */
export interface TimelineBinding {
  /** 场景文件里的实体 id 对应的实体（没有时 undefined：轨道跳过）。 */
  entity(id: string): Entity | undefined;
  /** 实体上名字是 name 的组件类型（运行时的名字：Transform、Light，游戏的按模块路径登记的名字）；没有时 undefined。 */
  component(entity: Entity, name: string): ComponentType<any, any> | undefined;
}

/** evaluate 的结果里要播放的一方处理的东西。 */
export interface TimelineState {
  /** 这一刻主画面用的相机（相机轨道最近的切点）；没有相机轨道时 undefined。 */
  readonly camera: Entity | undefined;
  /** 这一刻的字幕（多条同时有时用换行接起来）；没有时是空串。 */
  readonly subtitle: string;
}

type Track<T extends TimelineTrackFile['type']> = Extract<TimelineTrackFile, { type: T }>;

export class Timeline {
  readonly name: string;
  readonly duration: number;
  readonly frameRate: number;
  readonly file: TimelineFile;
  /** 声音轨道用到的声音，按内容路径（加载时间轴时一起加载好）。 */
  readonly sounds: ReadonlyMap<string, Sound>;
  /** 属性轨道的曲线（组件按第一次求值时的绑定找）。 */
  readonly #curves = new Map<Track<'property'>, PropertyCurve | null>();
  readonly #value = new Float32Array(4);

  constructor(file: TimelineFile, sounds: ReadonlyMap<string, Sound> = new Map()) {
    if (!(file.duration >= 0)) throw new Error(`timeline ${file.name}: duration must be a non-negative number`);
    this.name = file.name;
    this.duration = file.duration;
    this.frameRate = file.frameRate ?? 30;
    this.file = file;
    this.sounds = sounds;
  }

  /** 把 time 秒那一刻的属性写到实体上，返回相机和字幕。 */
  evaluate(time: number, binding: TimelineBinding): TimelineState {
    let camera: Entity | undefined;
    const subtitles: string[] = [];
    for (const track of this.file.tracks) {
      switch (track.type) {
        case 'property': {
          const entity = binding.entity(track.entity);
          const curve = entity && this.#curve(track, binding, entity);
          if (!entity || !curve) break;
          evaluateCurve(curve, time, this.#value);
          writeCurveValue(entity, curve, this.#value);
          break;
        }
        case 'camera': {
          // 最近的切点（切点不必按时刻排）
          let cut: (typeof track.cuts)[number] | undefined;
          for (const c of track.cuts) if (c.time <= time && (!cut || c.time >= cut.time)) cut = c;
          if (cut) camera = binding.entity(cut.camera) ?? camera;
          break;
        }
        case 'subtitle':
          for (const cue of track.cues) if (cue.start <= time && time < cue.end) subtitles.push(cue.text);
          break;
      }
    }
    return { camera, subtitle: subtitles.join('\n') };
  }

  /** 从 from 到 to（不含 from，含 to）之间开始的声音、事件、动画剪辑，按时刻排好。拖回去（to < from）时没有。 */
  crossed(from: number, to: number): TimelineCue[] {
    if (!(to > from)) return [];
    const cues: TimelineCue[] = [];
    const inside = (time: number) => time > from && time <= to;
    for (const track of this.file.tracks) {
      if (track.type === 'sound') for (const clip of track.clips) if (inside(clip.start)) cues.push({ type: 'sound', time: clip.start, sound: clip.sound, volume: clip.volume ?? 1 });
      if (track.type === 'event') for (const event of track.events) if (inside(event.time)) cues.push({ type: 'event', time: event.time, name: event.name });
      if (track.type === 'animation') {
        for (const clip of track.clips) if (inside(clip.start)) cues.push({ type: 'animation', time: clip.start, entity: track.entity, clip: clip.clip, speed: clip.speed ?? 1 });
      }
    }
    return cues.sort((a, b) => a.time - b.time);
  }

  #curve(track: Track<'property'>, binding: TimelineBinding, entity: Entity): PropertyCurve | null {
    let curve = this.#curves.get(track);
    if (curve !== undefined) return curve;
    const component = binding.component(entity, track.component);
    curve = component && track.keys.length > 0 ? propertyCurveOf(this.name, track, component) : null;
    this.#curves.set(track, curve);
    return curve;
  }
}

/** 播放经过的一件事。 */
export type TimelineCue =
  | { readonly type: 'sound'; readonly time: number; readonly sound: string; readonly volume: number }
  | { readonly type: 'event'; readonly time: number; readonly name: string }
  | { readonly type: 'animation'; readonly time: number; readonly entity: string; readonly clip: string; readonly speed: number };

/** 属性轨道换成动画模块的属性曲线（求值、写回和动画剪辑里的曲线共用）。 */
function propertyCurveOf(timeline: string, track: Track<'property'>, component: ComponentType<any, any>): PropertyCurve {
  const field = component.schema.fields.find((f) => f.name === track.property);
  if (!field) throw new Error(`timeline ${timeline}: ${component.name} has no property '${track.property}'`);
  const first = track.keys[0]!.value;
  const size = typeof first === 'number' ? 1 : first.length;
  const times = new Float32Array(track.keys.length), values = new Float32Array(track.keys.length * size);
  track.keys.forEach(({ time, value }, i) => {
    if (i > 0 && time < track.keys[i - 1]!.time) throw new Error(`timeline ${timeline}: the keys of ${component.name}.${track.property} are not sorted by time`);
    const components = typeof value === 'number' ? [value] : value;
    if (components.length !== size) throw new Error(`timeline ${timeline}: the keys of ${component.name}.${track.property} have different sizes`);
    times[i] = time;
    values.set(components, i * size);
  });
  return { component, property: track.property, interpolation: track.interpolation ?? 'linear', size, quaternion: field.options.kind === 'quat', times, values };
}
