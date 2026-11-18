// TopDownRPG 的 EnableDynamicNavigation：分块场景加载、卸载后重建导航网格（Stride 里听场景的 Children 变化）。
import { StartupScript } from '@stride-ts/engine';

export class EnableDynamicNavigation extends StartupScript {
  override start(): void {
    this.on(this.game.scenesChanged, () => void this.game.navigation!.rebuild());
  }
}
