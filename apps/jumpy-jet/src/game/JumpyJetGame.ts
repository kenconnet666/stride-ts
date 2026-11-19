// JumpyJet：按游戏设置启动（默认场景是 Scene，合成器的根相机下面是 JumpyJetRenderer：先画四层视差背景，再画场景的精灵）。
import { Game, type GameTime } from '@stride-ts/engine';
import { JumpyJetRenderer } from './JumpyJetRenderer';

export const GAME_SETTINGS = 'JumpyJet/Shared/GameSettings';
const STATS_INTERVAL = 0.25;

export class JumpyJetGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [JumpyJetRenderer.typeName]: (props) => JumpyJetRenderer.create(props) } });
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
