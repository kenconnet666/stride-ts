// SimpleAudio 的 SoundScript：一开始循环放背景音乐；每次点击（任何指针按下）重放音效，左右两个波形图回到中间、变成不透明，
// 之后每帧往两边移开、渐隐（按帧，不按时间，同 Stride）。
import { AsyncScript, ImageElement, prop, type SoundInstance } from '@stride-ts/engine';

/** 每帧波形图移开的距离（相对 Canvas 的宽度）和保留的不透明度。 */
const STEP = 0.0025;
const FADE = 0.93;

export class SoundScript extends AsyncScript.props({
  page: prop.asset('uiPage').optional(),
  soundMusic: prop.asset('sound').optional(),
  soundEffect: prop.asset('sound').optional(),
}) {
  music: SoundInstance | undefined;
  effect: SoundInstance | undefined;

  override async execute(): Promise<void> {
    const root = this.page?.rootElement;
    const left = root?.find(ImageElement, 'LeftWave') ?? null;
    const right = root?.find(ImageElement, 'RightWave') ?? null;
    if (!this.soundMusic || !this.soundEffect) throw new Error('SimpleAudio: SoundScript needs SoundMusic and SoundEffect');
    const music = (this.music = this.soundMusic.createInstance());
    const effect = (this.effect = this.soundEffect.createInstance());
    this.disposables.defer(() => {
      music.dispose();
      effect.dispose();
    });
    music.isLooping = true;
    music.play();
    let fontColor = 0;
    const originalX = right ? right.canvasRelativePosition[0] : 0.65;

    while (this.attached) {
      if (this.game.input.pointerEvents.some((event) => event.eventType === 'pressed')) {
        if (left && right) {
          left.canvasRelativePosition = [1 - originalX, 0.5];
          left.opacity = 0;
          right.canvasRelativePosition = [originalX, 0.5];
          right.opacity = 0;
        }
        fontColor = 1;
        effect.stop();
        effect.play();
      } else if (left && right) {
        left.canvasRelativePosition = [left.canvasRelativePosition[0] - STEP, left.canvasRelativePosition[1]];
        right.canvasRelativePosition = [right.canvasRelativePosition[0] + STEP, right.canvasRelativePosition[1]];
        fontColor *= FADE;
        left.opacity = fontColor;
        right.opacity = fontColor;
      }
      await this.nextFrame();
    }
  }
}
