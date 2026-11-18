// Third Person Platformer：现在只加载导入的场景并画出来（相机停在 Stride 场景里的初始位置）。
// 角色控制、相机脚本、物理、动画在后面的里程碑移植。
import { Game, MeshRenderFeature, type GameTime } from '@stride-ts/engine';

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

  protected override async loadContent(): Promise<void> {
    const start = performance.now();
    await this.content.loadScene(SCENE, this.entities);
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
      `render: ${mesh?.instanceCount ?? 0} instances in ${mesh?.batches.filter((b) => b.count > 0).length ?? 0} draws  draw ${this.drawMilliseconds.toFixed(2)} ms`,
    ].join('\n');
  }
}
