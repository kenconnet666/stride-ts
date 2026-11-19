// CSharpBeginner 的 LerpDemo：在 AnimationTimer 秒里把实体从当前位置插值到一个随机的整数位置，到了就换下一个目标。
import { formatFloat, formatVector, prop, SyncScript, Transform, Vector3 } from '@stride-ts/engine';

/** C# 的 Random.Next(min, max)：[min, max) 里的整数。 */
const nextInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

export class LerpDemo extends SyncScript.props({
  animationTimer: prop.f32().default(5),
}) {
  #elapsedTime = 0;
  #start = new Vector3();
  #target = new Vector3();

  override start(): void {
    this.#setNewLerpTargetAndResetTimer();
  }

  override update(): void {
    this.#elapsedTime = Math.fround(this.#elapsedTime + this.game.updateTime.elapsed);
    const lerpValue = Math.fround(this.#elapsedTime / this.animationTimer);
    this.entity.require(Transform).position = this.#start.clone().lerp(this.#target, lerpValue);
    if (this.#elapsedTime > this.animationTimer) this.#setNewLerpTargetAndResetTimer();
    const print = (text: string, y: number) => this.game.debugText.print(text, [480, y]);
    print(`Elapsed time: ${formatFloat(this.#elapsedTime)}`, 120);
    print(`Lerp value: ${formatFloat(lerpValue)}`, 140);
    print(`Start position: ${formatVector(this.#start)}`, 160);
    print(`Target position: ${formatVector(this.#target)}`, 180);
  }

  #setNewLerpTargetAndResetTimer(): void {
    this.#elapsedTime = 0;
    this.#start.copy(this.entity.require(Transform).position);
    this.#target.set(nextInt(-2, 2), nextInt(0, 3), nextInt(-1, 1));
  }
}
