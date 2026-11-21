/**
 * 给着色器的时间按这么多秒取模（同 Godot 的 time_rollover_secs）：游戏时间在 JS 里是双精度（一年后还是纳秒级），着色器里是
 * 单精度——不取模的话开几小时以后按时间动的效果（涟漪、闪烁、流动）一卡一卡（一天后单精度的刻度是 8 毫秒）。一小时内刻度不到
 * 0.25 毫秒，代价是每小时按时间动的图案可能跳一下。
 */
export const SHADER_TIME_ROLLOVER = 3600;

/** 传给 GPU 的时间：游戏时间按 SHADER_TIME_ROLLOVER 取模。 */
export const shaderTime = (total: number): number => total % SHADER_TIME_ROLLOVER;

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
