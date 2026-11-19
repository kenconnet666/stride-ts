// CSharpIntermediate：按游戏设置启动（默认场景是 IntermediateTutorials：教程菜单，选一个教程把根场景换成它的场景）。
import { Game, type GameTime } from '@stride-ts/engine';

export const GAME_SETTINGS = 'CSharpIntermediate/GameSettings';
const STATS_INTERVAL = 0.25;

export class CSharpIntermediateGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
    // 教程的说明都是调试文字，正式版也要显示（默认只在开发版画）
    this.debugText.visible = true;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
