// CustomEffect：没有场景，按游戏设置启动——合成器的根是 CustomEffectRenderer（用带自定义效果的 SpriteBatch 画背景和标志），
// 属性里的两张贴图随游戏设置导入、加载。
import { Game } from '@stride-ts/engine';
import { CustomEffectRenderer } from './CustomEffectRenderer';

export const GAME_SETTINGS = 'CustomEffect/Shared/GameSettings';

export class CustomEffectGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [CustomEffectRenderer.typeName]: (props) => new CustomEffectRenderer(props as unknown as CustomEffectAssets) } });
  }
}

type CustomEffectAssets = ConstructorParameters<typeof CustomEffectRenderer>[0];
