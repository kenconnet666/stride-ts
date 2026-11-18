/**
 * 屏幕上的调试文字（Stride 的 DebugTextSystem，`game.debugText`）：脚本每帧调 `print` 写一行，下一帧开始时清掉。
 * 和 Stride 不同（暂时）：还不画出来（文字渲染在 P2 做），只记下上一帧完整的那组文字，调试 CLI 用 `stride call debug-text` 读。
 *
 *   override update(): void { this.game.debugText.print(`Prefab count : ${this.count}`, [780, 25]); }
 */
export interface DebugTextLine {
  readonly text: string;
  /** 屏幕上的像素位置（左上角起），同 Stride 的 Int2。 */
  readonly position: readonly [number, number];
}

export class DebugText {
  #current: DebugTextLine[] = [];
  #last: readonly DebugTextLine[] = [];

  print(text: string, position: readonly [number, number] = [0, 0]): void {
    this.#current.push({ text, position });
  }

  /** 上一帧打印的文字，按打印的顺序。 */
  get lines(): readonly DebugTextLine[] {
    return this.#last;
  }

  /** @internal 一帧的 update 之前（Game 的帧循环调用）。 */
  beginFrame(): void {
    this.#last = this.#current;
    this.#current = [];
  }
}
