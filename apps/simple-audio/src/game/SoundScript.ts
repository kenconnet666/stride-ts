// SimpleAudio 的 SoundScript：一开始循环放背景音乐；每次点击（任何指针按下）重放音效，左右两个波形图回到中间、变成不透明，
// 之后往两边移开、渐隐。和 Stride 不同：按时间走（Stride 按帧，120 Hz 的屏幕上快一倍）；60 帧每秒时和 Stride 一样。
import { AsyncScript, ImageElement, prop, type SoundInstance } from '@stride-ts/engine';

/** 波形图每秒移开的距离（相对 Canvas 的宽度；Stride 是每帧 0.0025）和每秒保留的不透明度（Stride 是每帧 0.93）。 */
const SPEED = 0.0025 * 60;
const FADE_PER_SECOND = 0.93 ** 60;

export class SoundScript extends AsyncScript.props({
  page: prop.asset('uiPage').optional(),
  soundMusic: prop.asset('sound'),
  soundEffect: prop.asset('sound'),
}) {
  music: SoundInstance | undefined;
  effect: SoundInstance | undefined;

  override async execute(): Promise<void> {
    const root = this.page?.rootElement;
    const left = root?.find(ImageElement, 'LeftWave') ?? null;
    const right = root?.find(ImageElement, 'RightWave') ?? null;
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
        const dt = this.game.updateTime.elapsed;
        left.canvasRelativePosition = [left.canvasRelativePosition[0] - SPEED * dt, left.canvasRelativePosition[1]];
        right.canvasRelativePosition = [right.canvasRelativePosition[0] + SPEED * dt, right.canvasRelativePosition[1]];
        fontColor *= FADE_PER_SECOND ** dt;
        left.opacity = fontColor;
        right.opacity = fontColor;
      }
      await this.nextFrame();
    }
  }
}
