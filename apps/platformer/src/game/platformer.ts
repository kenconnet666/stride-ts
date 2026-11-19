// Third Person Platformer：加载导入的场景。物理碰撞体、角色和脚本都由场景带来：场景里的 Stride 脚本按类名对上
// game/ 里翻译过来的 TS 脚本（PlayerController、PlayerInput、ThirdPersonCamera、AnimationController），属性值来自场景。
// WASD 或方向键移动，空格跳，点画布锁定鼠标转镜头，Esc 解锁；手柄也能玩。
import { Game, MeshRenderFeature, type GameTime, type SceneInstance } from '@stride-ts/engine';

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
    this.scene = await this.setRootScene(SCENE);
    this.loadMilliseconds = performance.now() - start;
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
