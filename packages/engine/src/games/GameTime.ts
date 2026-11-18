/** 当前帧的时间，单位秒（对应 Stride 的 GameTime，那边用 TimeSpan）。 */
export class GameTime {
  /** 游戏开始运行以来的时间。 */
  total = 0;
  /** 距上一帧的时间；第一帧是 0。 */
  elapsed = 0;
  frameCount = 0;

  advance(elapsed: number): void {
    this.elapsed = elapsed;
    this.total += elapsed;
    this.frameCount++;
  }
}
