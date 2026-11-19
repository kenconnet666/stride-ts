// BepuSample：主场景只有相机和场景选择器（SceneSelectorComponent），各演示场景作为子场景加载进来；场景里的脚本按类名
// 对上 game/ 里翻译过来的 TS 脚本。选场景：页面地址 `?scene=Colliders`，或调试命令 `stride call scene '"Ropes"'`。
// 还没有的（P2）：选场景的 UI 页面。
import { Game, type GameTime } from '@stride-ts/engine';

export const MAIN_SCENE = 'BepuSample/Scenes/MainScene';
const STATS_INTERVAL = 0.25;

/**
 * 场景里不挂的 Stride 脚本：GameProfilerComponent 打开 Stride 的性能叠加层（我们用 `stride perf`）。
 * 加载子场景时也要传（SceneSelectorComponent 用它）。
 */
export const SCENE_SCRIPTS = { 'BepuSample.Game.Components.GameProfilerComponent': null } as const;

export class BepuSampleGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    await this.setRootScene(MAIN_SCENE, { scripts: SCENE_SCRIPTS });
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
