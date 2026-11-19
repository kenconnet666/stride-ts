// Platformer2D：横版平台跳跃，精灵（精灵表切帧）加 Z=0 平面上的 3D 物理。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 还没有的（P2）：拿金币的音效（CollectCoin.soundEffect 导入成 null）。
import { Game } from '@stride-ts/engine';

export const MAIN_SCENE = 'Platformer2D/MainScene';

export class Platformer2DGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(MAIN_SCENE);
  }
}
