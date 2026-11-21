// 游戏：加载世界 Worlds/Test（常驻场景是 MainScene：相机、太阳、天空），格子按相机附近流式加载。
import { Game } from '@stride-ts/engine';

export class OpenWorldGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.world.load('Worlds/Test');
  }
}
