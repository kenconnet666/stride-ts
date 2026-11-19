// FirstPersonShooter：第一人称走动、转视角、开枪推箱子、换弹。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 还没有的（P2）：枪口火焰、弹孔、受击拖尾这些粒子特效。
import { Game } from '@stride-ts/engine';

export const MAIN_SCENE = 'FirstPersonShooter/MainScene';

export class FirstPersonShooterGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(MAIN_SCENE);
  }
}
