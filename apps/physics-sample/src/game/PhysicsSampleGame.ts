// PhysicsSample：三个物理演示场景（Raycasting、VolumeTrigger、Constraints），场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 现在先是 Raycasting：点击箱子把它往上推，空格让有 ImpulseOnSpaceScript 的箱子往上跳。
// 还没有的（P2）：各场景的 UI 文字和切换场景的按钮。
import { Game, type GameTime } from '@stride-ts/engine';

const SCENE = 'PhysicsSample/Raycasting';
const STATS_INTERVAL = 0.25;

export class PhysicsSampleGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadScene(new URLSearchParams(location.search).get('scene') ?? SCENE);
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
