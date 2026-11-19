// SimpleAudio：循环放背景音乐，点一下重放音效、两边的波形图散开。场景里的脚本按类名对上 game/ 里的 TS 脚本。
import { Game } from '@stride-ts/engine';

export class SimpleAudioGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene('SimpleAudio/Shared/Scene');
  }
}
