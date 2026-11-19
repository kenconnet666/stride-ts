// CustomEffect：没有场景，按游戏设置启动——合成器的根是 CustomEffectRenderer（用带自定义效果的 SpriteBatch 画背景和标志），
// 属性里的两张贴图随游戏设置导入、加载。
import { Game, type GameTime } from '@stride-ts/engine';
import { CustomEffectRenderer } from './CustomEffectRenderer';

export const GAME_SETTINGS = 'CustomEffect/Shared/GameSettings';
const STATS_INTERVAL = 0.25;

export class CustomEffectGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [CustomEffectRenderer.typeName]: (props) => new CustomEffectRenderer(props as unknown as CustomEffectAssets) } });
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}

type CustomEffectAssets = ConstructorParameters<typeof CustomEffectRenderer>[0];
