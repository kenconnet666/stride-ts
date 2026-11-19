// CSharpBeginner：按游戏设置启动（默认场景是 MainScene：教程菜单，选一个教程把它的场景作为子场景加载进来）。
import { Game } from '@stride-ts/engine';

export const GAME_SETTINGS = 'CSharpBeginner/GameSettings';

export class CSharpBeginnerGame extends Game {
  constructor() {
    super();
    // 教程的说明都是调试文字，正式版也要显示（默认只在开发版画）
    this.debugText.visible = true;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }
}
