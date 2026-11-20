/**
 * 在游戏里放时间轴（过场）：每帧把时间往前走，场景摆成那一刻的样子（属性、主画面的相机、字幕、动画剪辑），经过的声音、
 * 事件在经过时触发。场景里加在一个实体上（实体文件里的 id 按这个实体所在的场景找）：
 *
 *   scripts: [{ type: 'TimelinePlayer', props: { timeline: { $asset: 'Cutscenes/Intro', kind: 'timeline' }, subtitleFont: { … } } }]
 *
 * 游戏的脚本接事件：`this.receive(player.events)`（值是事件的名字），或者 `await player.finished()`。
 */
import { prop, type EntityId } from '../data/prop';
import type { Entity } from '../engine/Entity';
import { EventKey } from '../engine/events';
import type { GameTime } from '../engine/GameTime';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { Canvas } from '../ui/panels/Canvas';
import { TextBlock } from '../ui/controls/TextBlock';
import { UIComponent } from '../ui/UIComponent';
import { UIPage } from '../ui/UIPage';
import type { SoundInstance } from '../audio/Sound';
import type { TimelineBinding } from './Timeline';

const WHITE = [1, 1, 1, 1] as const;

export class TimelinePlayer extends SyncScript.props('TimelinePlayer', {
  timeline: prop.asset('timeline'),
  /** 一开始就放；关掉时等脚本调 play()。 */
  autoplay: prop.bool().default(true),
  /** 放完从头再来。 */
  loop: prop.bool().default(false),
  speed: prop.number().default(1),
  /** 字幕用的字体；不给时不显示字幕（还能从 subtitle 读）。 */
  subtitleFont: prop.asset('font').optional(),
  subtitleSize: prop.number().min(1).default(40),
}) {
  /** 现在的时刻（秒）。 */
  time = 0;
  playing = false;
  /** 现在的字幕（没有时是空串）。 */
  subtitle = '';
  /** 放到事件轨道上的事件时广播它的名字。 */
  readonly events = new EventKey<string>();
  #subtitleText: TextBlock | undefined;
  #subtitleEntity: Entity | undefined;
  /** 这个播放器设的主画面相机（放完、移除时还回去，别人后来设的不动）。 */
  #camera: EntityId | undefined;
  #finished: (() => void)[] = [];
  /** 正在放的声音（放完的每帧去掉）。 */
  readonly #sounds: SoundInstance[] = [];

  override start(): void {
    if (this.subtitleFont) this.#createSubtitles();
    this.disposables.defer(() => {
      // 放过场时换过主画面的相机：还给场景
      this.#releaseCamera();
      this.#subtitleEntity?.destroy();
      for (const sound of this.#sounds) sound.dispose();
    });
    this.seek(0);
    if (this.autoplay) this.play();
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  /** 跳到 time 秒（不触发经过的声音、事件），场景摆成那一刻的样子。 */
  seek(time: number): void {
    this.time = Math.min(Math.max(time, 0), this.timeline.duration);
    this.#apply();
  }

  /** 放完（不循环时）的时候。 */
  finished(): Promise<void> {
    return new Promise((resolve) => this.#finished.push(resolve));
  }

  override update(time: GameTime): void {
    this.#releaseFinishedSounds();
    if (!this.playing) return;
    const { duration } = this.timeline;
    const from = this.time;
    let to = from + time.elapsed * this.speed;
    if (to >= duration) {
      if (this.loop && duration > 0) {
        this.#fire(from, duration);
        to %= duration;
        this.#fire(-1, to);
        this.time = to;
        this.#apply();
        return;
      }
      to = duration;
      this.playing = false;
    }
    this.#fire(from, to);
    this.time = to;
    this.#apply();
    if (!this.playing) this.#finish();
  }

  /** 放完（不循环）：主画面还给场景的相机，字幕收起（同 Unity Timeline 放完以后的默认行为），通知等着的。 */
  #finish(): void {
    this.#releaseCamera();
    this.subtitle = '';
    if (this.#subtitleText) this.#subtitleText.text = '';
    for (const resolve of this.#finished.splice(0)) resolve();
  }

  #releaseCamera(): void {
    const compositor = this.game.graphicsCompositor;
    if (compositor && this.#camera !== undefined && compositor.mainCamera === this.#camera) compositor.mainCamera = undefined;
    this.#camera = undefined;
  }

  #binding(): TimelineBinding {
    const scene = this.entity.scene;
    return {
      entity: (id) => scene?.entities?.get(id),
      component: (entity, name) => entity.manager.componentTypes(entity.id).find((type) => type.name === name),
    };
  }

  #apply(): void {
    const state = this.timeline.evaluate(this.time, this.#binding());
    if (state.camera && this.game.graphicsCompositor) this.game.graphicsCompositor.mainCamera = this.#camera = state.camera.id;
    this.subtitle = state.subtitle;
    if (this.#subtitleText) this.#subtitleText.text = state.subtitle;
  }

  /** from 到 to 之间开始的声音、事件。 */
  #fire(from: number, to: number): void {
    for (const cue of this.timeline.crossed(from, to)) {
      if (cue.type === 'sound') {
        const instance = this.timeline.sounds.get(cue.sound)?.createInstance();
        if (!instance) continue;
        instance.volume = cue.volume;
        instance.play();
        this.#sounds.push(instance);
      } else {
        this.events.broadcast(cue.name);
      }
    }
  }

  /** 同一个声音可以叠着放：每次一个实例，放完释放。 */
  #releaseFinishedSounds(): void {
    for (let i = this.#sounds.length - 1; i >= 0; i--) {
      if (this.#sounds[i]!.playState !== 'stopped') continue;
      this.#sounds[i]!.dispose();
      this.#sounds.splice(i, 1);
    }
  }

  /** 屏幕下方居中的一行字（全屏 UI，放在一个跟着这个实体的子实体上）。 */
  #createSubtitles(): void {
    const entity = (this.#subtitleEntity = this.game.entities.create({ name: `${this.entity.name} subtitles`, components: [Transform, UIComponent] }));
    entity.require(Transform).parent = this.entity;
    const text = (this.#subtitleText = Object.assign(new TextBlock(), {
      font: this.subtitleFont, textSize: this.subtitleSize, textColor: WHITE, text: '',
      canvasRelativePosition: [0.5, 0.92] as const, canvasPinOrigin: [0.5, 1] as const, textAlignment: 'center' as const,
    }));
    const root = new Canvas();
    root.children.add(text);
    entity.require(UIComponent).page = new UIPage('Subtitles', root);
  }
}
