// MaterialShader：按游戏设置启动（默认场景是 Scene：一块平面上的水面材质，材质用游戏自己的着色器类）。
import { Game, type GameTime } from '@stride-ts/engine';

export const GAME_SETTINGS = 'MaterialShader/Shared/GameSettings';
const STATS_INTERVAL = 0.25;

export class MaterialShaderGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
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
