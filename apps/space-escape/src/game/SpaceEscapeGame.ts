// SpaceEscape：按游戏设置启动（默认场景是 Scene；合成器是前向渲染器，渲染特性里有游戏自己的 BendFogRenderFeature）。
import { Game } from '@stride-ts/engine';

export const GAME_SETTINGS = 'SpaceEscape/Shared/GameSettings';

export class SpaceEscapeGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }
}
