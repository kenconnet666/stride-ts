// MorphTargets：按游戏设置启动（默认场景是 MainScene：三个带形变目标的模型，各自播放形变权重的动画）。
import { Game } from '@stride-ts/engine';

export const GAME_SETTINGS = 'MorphTargets/Shared/GameSettings';

export class MorphTargetsGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }
}
