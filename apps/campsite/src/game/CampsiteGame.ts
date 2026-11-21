// 游戏：加载主场景。场景里的脚本按登记的名字对上 game/ 里的 TS 脚本。
import { Game } from '@stride-ts/engine';

export class CampsiteGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene('MainScene');
  }
}
