// TopDownRPG 的 SceneStreaming（DynamicScene 里每个分块一个）：触发器里有东西时按陷进去最深的深度决定——超过 preLoadDepth
// 先预加载分块场景的资源，超过 loadDepth 加载（建实体），完全离开时卸载。触发器的接触处理器换成这里记深度的（同 Stride）。
// 和 Stride 不同：Stride 预加载时整个场景已经在内存里、加载只是挂到父场景下，而且 Content.Load 是同步的（那一帧整个游戏停住）；
// 我们预加载只取资源，加载时才建实体，是异步的，加载期间停住物理仿真，效果一样：比如一开始角色站在中央分块的触发器里、脚下
// 还没有地面，不会在地面出现之前掉下去。
import { prop, SyncScript, type ContactHandler, type EntityId, type SceneInstance } from '@stride-ts/engine';

/** 触发器里每个物体陷进去的深度（Stride 的 DepthTrigger）。 */
class DepthTrigger implements ContactHandler {
  readonly noContactResponse = true;
  readonly deepest = new Map<EntityId, number>();

  onTouching({ other, depth }: { other: EntityId; depth: number }): void {
    this.deepest.set(other, depth);
  }

  onStoppedTouching({ other }: { other: EntityId }): void {
    this.deepest.delete(other);
  }
}

export class SceneStreaming extends SyncScript.props({
  url: prop.asset('scene').optional(),
  trigger: prop.entity().optional(),
  preLoadDepth: prop.number().default(0.25),
  loadDepth: prop.number().default(0.5),
}) {
  /** 加载了的分块（Stride 的 Instance）。 */
  instance: SceneInstance | undefined;
  readonly #depths = new DepthTrigger();
  /** 正在进行的加载；完成前又离开时，完成后立刻卸载。 */
  #loading: Promise<void> | undefined;
  #preloading = false;
  /** 正在加载的分块数：有加载时物理仿真停住（见文件开头）。 */
  static #pausedBy = 0;
  #wanted = false;

  override start(): void {
    if (this.trigger !== undefined) this.game.simulation!.setContactHandler(this.trigger, this.#depths);
  }

  override cancel(): void {
    this.#wanted = false;
    if (this.instance) this.game.unloadScene(this.instance);
    this.instance = undefined;
  }

  override update(): void {
    if (this.trigger === undefined || !this.url) return;
    const deepest = Math.max(0, ...this.#depths.deepest.values());
    this.#wanted = deepest > 0;
    if (deepest > this.loadDepth) {
      if (!this.instance && !this.#loading) this.#load(this.url.path);
    } else if (deepest > this.preLoadDepth && !this.#preloading) {
      this.#preloading = true;
      void this.game.content.preloadScene(this.url.path).catch(() => (this.#preloading = false));
    }
    if (!this.#wanted && this.instance) {
      this.game.unloadScene(this.instance);
      this.instance = undefined;
    }
  }

  #load(path: string): void {
    const simulation = this.game.simulation!;
    if (SceneStreaming.#pausedBy++ === 0) simulation.enabled = false;
    this.#loading = this.game.loadScene(path).then((scene) => {
      if (this.#wanted && this.attached) this.instance = scene;
      else this.game.unloadScene(scene);
    }).finally(() => {
      this.#loading = undefined;
      if (--SceneStreaming.#pausedBy === 0) simulation.enabled = true;
    });
  }
}
