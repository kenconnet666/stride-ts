/**
 * 编辑状态下的场景：场景文档（SceneDocument）是真相，这里让游戏里的实体跟着它。
 *
 *   const document = new SceneDocument(sceneFile);
 *   const live = await LiveScene.open(game, document);
 *   undo.apply({ type: 'set', entity: id, path: ['position'], value: [0, 2, 0] });
 *   await live.sync();
 *
 * 场景按文档建成根场景，不挂场景文件里的脚本（编辑状态脚本不跑；要试玩时另按文档建一份带脚本的）。文档改了以后调 sync：
 * 只有变了的实体会动（ContentManager.updateScene），实体还是原来的实体，选中的东西、别处对它的引用都不用换。场景自己的设置里
 * 编辑时看得见的也跟着变：合成器（清屏色、后处理……）重新配置，偏移直接改；物理、导航在编辑状态不起作用（仿真不走），
 * 试玩时重新打开页面才用上。
 * 仿真要不要停（`game.simulation.enabled`）、用什么相机看由编辑器定，不在这里管。
 */
import type { CompositorSettings, LoadSceneOptions, SceneInstance } from '../content/ContentManager';
import type { SceneFile } from '../content/formats/format';
import { entityAssetReferences } from '../content/references';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';
import { colorLutAt } from '../rendering/postfx/tonemap/ColorLut';

/** 场景文件没写合成器时的设置（同前向渲染器建好时的默认值）：去掉了合成器的场景配回它。 */
const DEFAULT_COMPOSITOR: CompositorSettings = { clearColor: [0.01, 0.0134, 0.022, 1], postEffects: null, transparent: true, textureCameras: [] };

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

  /** 场景自己的设置里编辑时看得见的那些跟上：合成器、偏移（比对象是不是同一个，文档的修改只换改了的那一支）。 */
  #syncSettings(before: SceneFile, after: SceneFile): void {
    if (after.compositor !== before.compositor) {
      // 去掉了合成器：照没写合成器的场景，用引擎的默认值
      this.#game.configureCompositor(this.#game.content.compositorSettings(after) ?? DEFAULT_COMPOSITOR, after.name);
      // 新引用的查找表：加载好再配一次（第一次配的时候还没有，先不带它画）
      const lut = after.compositor?.postEffects?.colorGrading?.lut;
      if (lut && !colorLutAt(lut)) {
        void this.#game.content.loadColorLut(lut).then(
          () => this.#game.configureCompositor(this.#game.content.compositorSettings(after) ?? DEFAULT_COMPOSITOR, after.name),
          (error: unknown) => console.warn(`[stride] ${after.name}: cannot load the LUT ${lut}`, error),
        );
      }
    }
    if (after.offset !== before.offset) {
      const [x, y, z] = after.offset ?? [0, 0, 0];
      Object.assign(this.instance.offset, { x, y, z });
    }
  }

  /**
   * 资源热重载：paths 里的资源（内容路径）的文件改了。忘掉它们加载过的结果，引用它们的实体重建（只重建这些）。编辑器给的
   * 是改了的资源加上间接用到它们的（材质改了，用这个材质的模型也算），所以这里只看实体直接引用的。
   */
  reloadAssets(paths: readonly string[]): Promise<void> {
    const changed = new Set(paths);
    const marked = this.#syncing.then(() => {
      this.#game.content.evict(changed);
      // 重建：把这些实体在"已经跟上的版本"里换成拷贝（组件也拷一层：updateScene 按组件对象是不是同一个决定重载哪些），
      // 下一次 sync 比较时它们的组件就算变了，资源重新加载
      const synced = this.#synced;
      const stale = (entity: SceneFile['entities'][number]) => entityAssetReferences([entity]).some((ref) => changed.has(ref.path));
      if (!synced.entities.some(stale)) return;
      const copy = (value: unknown) => (Array.isArray(value) ? [...value] : value !== null && typeof value === 'object' ? { ...value } : value);
      this.#synced = {
        ...synced,
        entities: synced.entities.map((entity) => (stale(entity) ? { ...entity, components: Object.fromEntries(Object.entries(entity.components).map(([key, value]) => [key, copy(value)])) } : entity)),
      };
    });
    this.#syncing = marked.catch(() => undefined);
    return marked.then(() => this.sync());
  }

  /**
   * 让实体跟上文档现在的样子。连着调用会排队；排到的时候文档又改过了就直接跟到最新的。返回的 Promise 在这一次跟上以后完成。
   * 引用的资源加载不了时用到它的组件先不建（记警告，见 ContentManager.updateScene），别的照样跟上；别的错误（比如脚本建不出来）
   * 时拒绝，实体停在上一次跟上的样子。
   */
  sync(): Promise<void> {
    const run = this.#syncing.then(async () => {
      const target = this.document.file;
      if (target === this.#synced) return;
      await this.#game.content.updateScene(this.instance, this.#synced, target, this.#game.entities, this.#options);
      this.#syncSettings(this.#synced, target);
      this.#synced = target;
      this.#ids = undefined;
    });
    this.#syncing = run.catch(() => undefined);
    return run;
  }
}
