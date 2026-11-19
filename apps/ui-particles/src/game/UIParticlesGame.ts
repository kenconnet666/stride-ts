// UIParticles：全屏的 UI（SplashScript 用代码建），点按钮在按钮上放命中特效；场景里的粒子系统画在 UI 上面。场景里的脚本按
// 类名对上 game/ 里的 TS 脚本。
import { Game } from '@stride-ts/engine';

export class UIParticlesGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene('UIParticles/Shared/SplashScene');
  }
}
