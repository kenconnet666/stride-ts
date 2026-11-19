// CSharpBeginner 的 DeltaTimeDemo：按每帧的时间转实体，每 5 秒倒计时到头就反向；打印总时间和倒计时（float，同 C#）。
import { formatFloat, SyncScript } from '@stride-ts/engine';
import { rotateY } from './rotate';

const COUNTDOWN_START = 5;

export class DeltaTimeDemo extends SyncScript {
  #rotationSpeed = 0.6;
  #totalTime = 0;
  #countdownTime = COUNTDOWN_START;

  override update(): void {
    // Stride 的 WarpElapsed：乘过时间缩放的这一帧
    const deltaTime = Math.fround(this.game.updateTime.elapsed);
    this.#totalTime = Math.fround(this.#totalTime + deltaTime);
    this.#countdownTime = Math.fround(this.#countdownTime - deltaTime);
    if (this.#countdownTime < 0) {
      this.#countdownTime = COUNTDOWN_START;
      this.#rotationSpeed *= -1;
    }
    rotateY(this.entity, deltaTime * this.#rotationSpeed);
    this.game.debugText.print(`Total time: ${formatFloat(this.#totalTime)}`, [480, 540]);
    this.game.debugText.print(`Countdown time: ${formatFloat(this.#countdownTime)}`, [480, 560]);
  }
}
