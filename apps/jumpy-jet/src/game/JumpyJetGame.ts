// JumpyJet：按游戏设置启动（默认场景是 Scene，合成器的根相机下面是 JumpyJetRenderer：先画四层视差背景，再画场景的精灵）。
import { Game } from '@stride-ts/engine';
import { JumpyJetRenderer } from './JumpyJetRenderer';

export const GAME_SETTINGS = 'JumpyJet/Shared/GameSettings';

export class JumpyJetGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadGameSettings(GAME_SETTINGS, { renderers: { [JumpyJetRenderer.typeName]: (props) => JumpyJetRenderer.create(props) } });
  }
}
