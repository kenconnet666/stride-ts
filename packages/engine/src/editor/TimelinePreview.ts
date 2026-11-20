/**
 * 编辑器里拖时间轴预览：把视口里的场景摆成时间轴某一刻的样子（属性、可选的"从镜头里看"），只改运行时的实体，不改场景文档；
 * 第一次改某个属性前记下它原来的值，结束预览时（或者时间轴不再有这条轨道时）写回去，场景回到文档的样子。
 *
 *   const preview = new TimelinePreview(game, (id) => live.entity(id));
 *   preview.show(file, 2.5, { throughCamera: true });
 *   preview.end();
 */
import type { TimelineFile } from '../content/format';
import type { ComponentType } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { Timeline, type TimelineBinding } from '../timeline/Timeline';

/** 预览的这一刻：相机（场景文件里的实体 id）和字幕。 */
export interface TimelinePreviewState {
  readonly camera: string | undefined;
  readonly subtitle: string;
}

export class TimelinePreview {
  readonly #game: Game;
  readonly #entity: (id: string) => Entity | undefined;
  /** 同一份文件（编辑器每次改都是新对象）只建一次 Timeline。 */
  #file: TimelineFile | undefined;
  #timeline: Timeline | undefined;
  /** 改过的属性原来的值：实体、组件、属性名 → 值的拷贝。 */
  readonly #saved = new Map<string, { readonly entity: Entity; readonly component: ComponentType<any, any>; readonly property: string; readonly value: unknown }>();
  #cameraSet = false;

  constructor(game: Game, entity: (id: string) => Entity | undefined) {
    this.#game = game;
    this.#entity = entity;
  }

  /** 摆成 file 在 time 秒的样子；throughCamera 时主画面换成时间轴那一刻的相机。 */
  show(file: TimelineFile, time: number, { throughCamera = false }: { readonly throughCamera?: boolean } = {}): TimelinePreviewState {
    if (file !== this.#file) {
      // 文件改了：先把这次不再碰的属性还原，再按新文件摆
      this.#restore();
      this.#file = file;
      this.#timeline = new Timeline(file);
    }
    const binding: TimelineBinding = {
      entity: (id) => this.#entity(id),
      component: (entity, name) => {
        const component = entity.manager.componentTypes(entity.id).find((type) => type.name === name);
        if (component) this.#remember(entity, component, file, name);
        return component;
      },
    };
    const state = this.#timeline!.evaluate(time, binding);
    const compositor = this.#game.graphicsCompositor;
    if (compositor) {
      compositor.mainCamera = throughCamera ? state.camera?.id : undefined;
      this.#cameraSet = throughCamera;
    }
    let camera: string | undefined;
    for (const track of file.tracks) {
      if (track.type !== 'camera') continue;
      for (const cut of track.cuts) if (state.camera && this.#entity(cut.camera) === state.camera) camera = cut.camera;
    }
    return { camera, subtitle: state.subtitle };
  }

  /** 结束预览：属性写回原来的值，主画面还给编辑相机。 */
  end(): void {
    this.#restore();
    this.#file = undefined;
    this.#timeline = undefined;
    if (this.#cameraSet && this.#game.graphicsCompositor) this.#game.graphicsCompositor.mainCamera = undefined;
    this.#cameraSet = false;
  }

  /** 第一次碰这个实体上的这个组件时，记下文件里写到的属性原来的值。 */
  #remember(entity: Entity, component: ComponentType<any, any>, file: TimelineFile, name: string): void {
    for (const track of file.tracks) {
      if (track.type !== 'property' || track.component !== name || this.#entity(track.entity) !== entity) continue;
      const key = `${entity.id}:${component.name}:${track.property}`;
      if (this.#saved.has(key)) continue;
      const view = entity.get(component) as Record<string, unknown> | undefined;
      if (!view) continue;
      const value = view[track.property];
      this.#saved.set(key, { entity, component, property: track.property, value: value !== null && typeof value === 'object' ? { ...value } : value });
    }
  }

  #restore(): void {
    for (const { entity, component, property, value } of this.#saved.values()) {
      // 场景文档改了，实体可能已经重建过（新的实体本来就是文档的样子）
      if (!this.#game.entities.isAlive(entity.id)) continue;
      const view = entity.get(component) as Record<string, unknown> | undefined;
      if (view) view[property] = value;
    }
    this.#saved.clear();
  }
}
