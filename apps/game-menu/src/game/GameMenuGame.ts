// GameMenu：UI 的样例。启动页（SplashScene，点一下）进主菜单（MainScene）；两个场景各有一个全屏的 UIComponent，页面和
// 精灵表、字体随场景导入。场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
import { Game } from '@stride-ts/engine';

export const SPLASH_SCENE = 'GameMenu/Shared/SplashScene';
export const MAIN_SCENE = 'GameMenu/Shared/MainScene';

export class GameMenuGame extends Game {
  protected override async loadContent(): Promise<void> {
    const scene = new URLSearchParams(location.search).get('scene') === 'main' ? MAIN_SCENE : SPLASH_SCENE;
    await this.setRootScene(scene);
  }
}
