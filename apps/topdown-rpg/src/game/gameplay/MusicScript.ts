// TopDownRPG 的 MusicScript：循环放背景音乐。
import { prop, StartupScript, type SoundInstance } from '@stride-ts/engine';

export class MusicScript extends StartupScript.props({
  soundMusic: prop.asset('sound'),
}) {
  music!: SoundInstance;

  override start(): void {
    this.music = this.soundMusic.createInstance();
    this.music.isLooping = true;
    this.music.play();
  }

  override cancel(): void {
    this.music.stop();
  }
}
