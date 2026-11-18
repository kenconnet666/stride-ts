// Third Person Platformer：加载导入的场景（物理碰撞体和角色由场景带来），给玩家和相机挂上移植的脚本。
// WASD 或方向键移动，空格跳，点画布锁定鼠标转镜头，Esc 解锁；手柄也能玩。动画在后面的里程碑移植。
import { Game, MeshRenderFeature, type Entity, type GameTime, type SceneInstance } from '@stride-ts/engine';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { PlayerController } from './player/PlayerController';
import { PlayerInput } from './player/PlayerInput';

const SCENE = 'ThirdPersonPlatformer/MainScene';
const STATS_INTERVAL = 0.25;

export class PlatformerGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;
  private drawMilliseconds = 0;
  private loadMilliseconds = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  /** 加载好的场景；按场景文件里的实体 id 找实体。 */
  scene: SceneInstance | undefined;

  protected override async loadContent(): Promise<void> {
    const start = performance.now();
    this.scene = await this.loadScene(SCENE);
    this.loadMilliseconds = performance.now() - start;
    // 脚本挂在 Stride 场景里的同一批实体上（场景里的脚本组件还不随场景导入）
    const player = this.#named('PlayerCharacter');
    const camera = this.#named('Camera');
    player.add(PlayerController);
    player.add(PlayerInput.with({ camera: camera.id }));
    camera.add(ThirdPersonCamera);
  }

  #named(name: string): Entity {
    const entity = [...this.scene!.entities.values()].find((e) => e.name === name);
    if (!entity) throw new Error(`${SCENE} has no entity named '${name}'`);
    return entity;
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime >= STATS_INTERVAL) {
      this.statsTime = time.total;
      this.showStats(time);
    }
  }

  protected override draw(time: GameTime): void {
    const start = performance.now();
    super.draw(time);
    this.drawMilliseconds = performance.now() - start;
  }

  private showStats(time: GameTime): void {
    const mesh = this.renderSystem.features.find((f): f is MeshRenderFeature => f instanceof MeshRenderFeature);
    this.stats.textContent = [
      `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`,
      `${SCENE}: ${this.entities.count} entities, loaded in ${this.loadMilliseconds.toFixed(0)} ms`,
      `render: ${mesh?.instanceCount ?? 0} instances, ${mesh?.drawnInstances ?? 0} drawn in ${mesh?.drawCalls ?? 0} draws (all views)  draw ${this.drawMilliseconds.toFixed(2)} ms`,
    ].join('\n');
  }
}
