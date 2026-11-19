// JumpyJet 的 BackgroundScript：游戏结束时视差背景停住，重新开始时接着滚（背景由合成器里的 JumpyJetRenderer 画）。
import { AsyncScript } from '@stride-ts/engine';
import { GameOverEventKey, GameResetEventKey } from './GameGlobals';
import { JumpyJetRenderer } from './JumpyJetRenderer';

export class BackgroundScript extends AsyncScript {
  override async execute(): Promise<void> {
    const renderer = this.game.rootRenderer;
    if (!(renderer instanceof JumpyJetRenderer)) return;
    const gameOver = this.receive(GameOverEventKey), gameReset = this.receive(GameResetEventKey);
    while (this.attached) {
      await gameOver.receive(this.signal);
      renderer.stopScrolling();
      await gameReset.receive(this.signal);
      renderer.startScrolling();
    }
  }
}
