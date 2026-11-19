// UIParticles：全屏的 UI（SplashScript 用代码建），点按钮在按钮上放命中特效；场景里的粒子系统画在 UI 上面。场景里的脚本按
// 类名对上 game/ 里的 TS 脚本。
import { Game, type GameTime } from '@stride-ts/engine';

const STATS_INTERVAL = 0.25;

export class UIParticlesGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.setRootScene('UIParticles/Shared/SplashScene');
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
