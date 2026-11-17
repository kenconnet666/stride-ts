/** Timing of the current frame, in seconds (Stride's GameTime, which uses TimeSpan). */
export class GameTime {
  /** Time since the game started running. */
  total = 0;
  /** Time since the previous frame; 0 on the first frame. */
  elapsed = 0;
  frameCount = 0;

  advance(elapsed: number): void {
    this.elapsed = elapsed;
    this.total += elapsed;
    this.frameCount++;
  }
}
