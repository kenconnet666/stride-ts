// GameMenu：UI 的样例。启动页（SplashScene，点一下）进主菜单（MainScene）；两个场景各有一个全屏的 UIComponent，页面和
// 精灵表、字体随场景导入。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
import { Game, type GameTime } from '@stride-ts/engine';

export const SPLASH_SCENE = 'GameMenu/Shared/SplashScene';
export const MAIN_SCENE = 'GameMenu/Shared/MainScene';
const STATS_INTERVAL = 0.25;

export class GameMenuGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    const scene = new URLSearchParams(location.search).get('scene') === 'main' ? MAIN_SCENE : SPLASH_SCENE;
    await this.setRootScene(scene);
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
