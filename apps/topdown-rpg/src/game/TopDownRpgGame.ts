// TopDownRPG：点地面寻路走过去，打箱子掉金币，走到地图边上流式加载相邻的分块场景。场景里的脚本按类名对上 game/ 里
// 翻译过来的 TS 脚本。还没有的（P2）：粒子特效、音乐和音效。
import { Game, type GameTime } from '@stride-ts/engine';

export const MAIN_SCENE = 'TopDownRPG/MainScene';
/** 场景里不移植的 Stride 脚本：MusicScript 只放背景音乐（P2 的音频）。 */
export const SCENE_SCRIPTS = { 'TopDownRPG.Gameplay.MusicScript': null } as const;
const STATS_INTERVAL = 0.25;

export class TopDownRpgGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    // 页面地址 `?scene=DynamicScene` 选流式加载分块的版本
    const scene = new URLSearchParams(location.search).get('scene');
    await this.setRootScene(scene ? `TopDownRPG/${scene}` : MAIN_SCENE, { scripts: SCENE_SCRIPTS });
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
