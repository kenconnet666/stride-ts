// FirstPersonShooter：第一人称走动、转视角、开枪推箱子、换弹。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 还没有的（P2）：枪口火焰、弹孔、受击拖尾这些粒子特效。
import { Game, type GameTime } from '@stride-ts/engine';

export const MAIN_SCENE = 'FirstPersonShooter/MainScene';
const STATS_INTERVAL = 0.25;

export class FirstPersonShooterGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.setRootScene(MAIN_SCENE);
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
