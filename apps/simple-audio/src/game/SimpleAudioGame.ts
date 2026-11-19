// SimpleAudio：循环放背景音乐，点一下重放音效、两边的波形图散开。场景里的脚本按类名对上 game/ 里的 TS 脚本。
import { Game, type GameTime } from '@stride-ts/engine';

const STATS_INTERVAL = 0.25;

export class SimpleAudioGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.setRootScene('SimpleAudio/Shared/Scene');
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
