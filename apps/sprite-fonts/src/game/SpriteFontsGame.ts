// SpriteFonts：没有场景，按游戏设置启动——合成器的根是 FontRenderer（只用 SpriteBatch 画字），属性里的字体和背景图随游戏设置
// 导入、加载。
import { Game, type GameTime } from '@stride-ts/engine';
import { FontRenderer } from './FontRenderer';

export const GAME_SETTINGS = 'SpriteFonts/Shared/GameSettings';
const STATS_INTERVAL = 0.25;

export class SpriteFontsGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [FontRenderer.typeName]: (props) => FontRenderer.create(props) } });
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
