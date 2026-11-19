// MaterialShader：按游戏设置启动（默认场景是 Scene：一块平面上的水面材质，材质用游戏自己的着色器类）。
import { Game } from '@stride-ts/engine';

export const GAME_SETTINGS = 'MaterialShader/Shared/GameSettings';

export class MaterialShaderGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS);
  }
}
