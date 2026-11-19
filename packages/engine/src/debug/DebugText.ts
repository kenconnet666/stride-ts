/**
 * 屏幕上的调试文字（Stride 的 DebugTextSystem，`game.debugText`）：脚本每帧调 `print` 写一行，下一帧开始时清掉；
 * 画在整个画面（包括 UI）的最上面，用 Stride 的 8x16 调试字体（DebugTextRenderer）。调试 CLI 用 `stride call debug-text` 读。
 *
 *   override update(): void { this.game.debugText.print(`Prefab count : ${this.count}`, [780, 25]); }
 */
export interface DebugTextLine {
  readonly text: string;
  /** 屏幕上的像素位置（左上角起），同 Stride 的 Int2。 */
  readonly position: readonly [number, number];
  /** 线性的颜色（Stride 的 Color4），没给时用 DebugText.color。 */
  readonly color?: readonly [number, number, number, number];
}

export class DebugText {
  /** 默认的文字颜色，线性（Stride 的 TextColor，Color.LightGreen 当 Color4 用）。 */
  color: readonly [number, number, number, number] = [144 / 255, 238 / 255, 144 / 255, 1];
  #current: DebugTextLine[] = [];
  #last: readonly DebugTextLine[] = [];

  print(text: string, position: readonly [number, number] = [0, 0], color?: readonly [number, number, number, number]): void {
    this.#current.push({ text, position, ...(color ? { color } : {}) });
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
