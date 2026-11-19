// SpriteFonts：没有场景，按游戏设置启动——合成器的根是 FontRenderer（只用 SpriteBatch 画字），属性里的字体和背景图随游戏设置
// 导入、加载。
import { Game } from '@stride-ts/engine';
import { FontRenderer } from './FontRenderer';

export const GAME_SETTINGS = 'SpriteFonts/Shared/GameSettings';

export class SpriteFontsGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [FontRenderer.typeName]: (props) => FontRenderer.create(props) } });
  }
}
