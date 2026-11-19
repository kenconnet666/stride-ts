// GameMenu 的 SplashScript：启动页，点一下（任何指针按下）换到下一个场景。
import { prop } from '@stride-ts/engine';
import { UISceneBase } from './UISceneBase';

export class SplashScript extends UISceneBase.props({
  nextSceneUrl: prop.asset('scene').optional(),
}) {
  protected override loadScene(): void {}

  protected override updateScene(): void {
    const next = this.nextSceneUrl;
    if (next && this.game.input.pointerEvents.some((event) => event.eventType === 'pressed')) void this.game.setRootScene(next.path);
  }
}
