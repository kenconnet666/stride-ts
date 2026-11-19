// CSharpIntermediate 的 LoadMusic：背景音乐（流式的声音）。空格播放或暂停，上下键调音量（0 到 2），左右键调左右声道（-1 到 1）。
// 和 Stride 不同：不用等 ReadyToPlay（流式的声音边下边放，play 之后浏览器自己缓冲）；脚本移除时把实例放掉、音乐停下
// （Stride 的脚本没管，换场景后音乐还在响）。
import { AsyncScript, prop } from '@stride-ts/engine';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
/** C# 枚举的名字：首字母大写。 */
const pascal = (name: string) => name[0]!.toUpperCase() + name.slice(1);

export class LoadMusic extends AsyncScript.props({
  backgroundMusic: prop.asset('sound').optional(),
}) {
  override async execute(): Promise<void> {
    if (!this.backgroundMusic) return;
    const music = this.backgroundMusic.createInstance();
    this.disposables.defer(() => music.dispose());
    const input = this.game.input;
    const print = (text: string, y: number) => this.game.debugText.print(text, [800, y]);
    for (;;) {
      print(`Space to play/pause. Currently: ${pascal(music.playState)}`, 580);
      if (input.isKeyPressed('Space')) {
        if (music.playState === 'playing') music.pause();
        else music.play();
      }
      print(`Up/Down to change volume: ${music.volume.toFixed(1)}`, 600);
      if (input.isKeyPressed('Up')) music.volume = clamp(Math.fround(music.volume + 0.1), 0, 2);
      if (input.isKeyPressed('Down')) music.volume = clamp(Math.fround(music.volume - 0.1), 0, 2);
      print(`Left/Right to change panning: ${music.pan.toFixed(1)}`, 620);
      if (input.isKeyPressed('Left')) music.pan = clamp(Math.fround(music.pan - 0.1), -1, 1);
      if (input.isKeyPressed('Right')) music.pan = clamp(Math.fround(music.pan + 0.1), -1, 1);
      await this.nextFrame();
    }
  }
}
