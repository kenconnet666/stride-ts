// CSharpIntermediate：按游戏设置启动（默认场景是 IntermediateTutorials：教程菜单，选一个教程把根场景换成它的场景）。
import { Game } from '@stride-ts/engine';

export const GAME_SETTINGS = 'CSharpIntermediate/GameSettings';

export class CSharpIntermediateGame extends Game {
  constructor() {
    super();
    // 教程的说明都是调试文字，正式版也要显示（默认只在开发版画）
    this.debugText.visible = true;
  }

  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }
}
