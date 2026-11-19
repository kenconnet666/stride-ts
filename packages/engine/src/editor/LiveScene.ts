/**
 * 编辑状态下的场景：场景文档（SceneDocument）是真相，这里让游戏里的实体跟着它。
 *
 *   const document = new SceneDocument(sceneFile);
 *   const live = await LiveScene.open(game, document);
 *   undo.apply({ type: 'set', entity: id, path: ['position'], value: [0, 2, 0] });
 *   await live.sync();
 *
 * 场景按文档建成根场景，不挂场景文件里的脚本（编辑状态脚本不跑；要试玩时另按文档建一份带脚本的）。文档改了以后调 sync：
 * 只有变了的实体会动（ContentManager.updateScene），实体还是原来的实体，选中的东西、别处对它的引用都不用换。
 * 仿真要不要停（`game.simulation.enabled`）、用什么相机看由编辑器定，不在这里管。
 */
import type { LoadSceneOptions, SceneInstance } from '../content/ContentManager';
import type { SceneFile } from '../content/format';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Game } from '../games/Game';

/** 场景文档里 LiveScene 要的那一点：现在的场景文件。编辑器的界面在另一个页面里时，文档也在那边，这边只读它的文件。 */
export interface SceneSource {
  readonly file: SceneFile;
}

export class LiveScene {
  readonly document: SceneSource;
  readonly instance: SceneInstance;
  readonly #game: Game;
  readonly #options: LoadSceneOptions;
  /** 实体现在是照着文档的哪个版本建的。 */
  #synced: SceneFile;
  #syncing: Promise<void> = Promise.resolve();
  /** 实体 → 文档里的 id；用到时才建，文档每跟上一次就丢掉（实体可能加了、删了）。 */
  #ids: Map<Entity, string> | undefined;

  private constructor(game: Game, document: SceneSource, instance: SceneInstance, synced: SceneFile, options: LoadSceneOptions) {
    this.#game = game;
    this.document = document;
    this.instance = instance;
    this.#synced = synced;
    this.#options = options;
  }

  /** 按文档现在的样子建场景、换成根场景（原来的根场景卸载）。 */
  static async open(game: Game, document: SceneSource, options: LoadSceneOptions = {}): Promise<LiveScene> {
    const file = document.file;
    const editing = { ...options, attachScripts: false };
    return new LiveScene(game, document, await game.setRootScene(file, editing), file, editing);
  }

  /** 文档里的实体在游戏里的那个实体。 */
  entity(id: string): Entity | undefined {
    return this.instance.entities.get(id);
  }

  /** 游戏里的实体是文档里的哪个；引擎另建的子实体（模型多出来的网格）算它挂着的那个文档实体。不在这个场景里时是 undefined。 */
  idOf(entity: Entity): string | undefined {
    this.#ids ??= new Map([...this.instance.entities].map(([id, live]) => [live, id]));
    for (let current: Entity | undefined = entity; current?.alive; current = current.get(Transform)?.parent) {
      const id = this.#ids.get(current);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /**
   * 让实体跟上文档现在的样子。连着调用会排队；排到的时候文档又改过了就直接跟到最新的。返回的 Promise 在这一次跟上以后完成，
   * 出错（比如新引用的资源加载不了）时拒绝，实体停在上一次跟上的样子。
   */
  sync(): Promise<void> {
    const run = this.#syncing.then(async () => {
      const target = this.document.file;
      if (target === this.#synced) return;
      await this.#game.content.updateScene(this.instance, this.#synced, target, this.#game.entities, this.#options);
      this.#synced = target;
      this.#ids = undefined;
    });
    this.#syncing = run.catch(() => undefined);
    return run;
  }
}
