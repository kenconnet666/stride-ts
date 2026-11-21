// 游戏：加载一个世界（地址里的 ?world=…，默认测试世界 Worlds/Test；常驻场景是 MainScene：相机、太阳、天空），格子按相机附近流式加载。
import { Game } from '@stride-ts/engine';

export class OpenWorldGame extends Game {
  protected override async loadContent(): Promise<void> {
    const world = new URLSearchParams(location.search).get('world') ?? 'Worlds/Test';
    await this.world.load(world);
  }
}
