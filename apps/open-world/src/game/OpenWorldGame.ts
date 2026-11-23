// 游戏：加载一个世界（地址里的 ?world=…，默认测试世界 Worlds/Test；常驻场景是 MainScene：相机、太阳、天空），格子按相机附近流式加载。
// 导航网格按块流式地建：人群里的人、挂 NavigationInvoker 的实体周围才有（没有人时不建）。
import { DEFAULT_NAVIGATION_STREAMING, Game } from '@stride-ts/engine';

export class OpenWorldGame extends Game {
  protected override async loadContent(): Promise<void> {
    const world = new URLSearchParams(location.search).get('world') ?? 'Worlds/Test';
    await this.world.load(world);
    if (this.navigation) this.navigation.settings = { ...this.navigation.settings, streaming: DEFAULT_NAVIGATION_STREAMING };
  }
}
