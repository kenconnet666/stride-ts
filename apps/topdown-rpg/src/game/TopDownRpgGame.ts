// TopDownRPG：点地面寻路走过去，打箱子掉金币，走到地图边上流式加载相邻的分块场景。场景里的脚本按类名对上 game/ 里
// 翻译过来的 TS 脚本。
import { Game } from '@stride-ts/engine';

export const MAIN_SCENE = 'TopDownRPG/MainScene';
export class TopDownRpgGame extends Game {
  protected override async loadContent(): Promise<void> {
    // 页面地址 `?scene=DynamicScene` 选流式加载分块的版本
    const scene = new URLSearchParams(location.search).get('scene');
    await this.setRootScene(scene ? `TopDownRPG/${scene}` : MAIN_SCENE);
  }
}
