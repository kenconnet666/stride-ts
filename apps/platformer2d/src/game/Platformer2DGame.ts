// Platformer2D：横版平台跳跃，精灵（精灵表切帧）加 Z=0 平面上的 3D 物理。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 还没有的（P2）：拿金币的音效（CollectCoin.soundEffect 导入成 null）。
import { Game, type GameTime } from '@stride-ts/engine';

export const MAIN_SCENE = 'Platformer2D/MainScene';
const STATS_INTERVAL = 0.25;

export class Platformer2DGame extends Game {
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
