/**
 * 屏幕上的调试文字（Stride 的 DebugTextSystem，`game.debugText`）：脚本每帧调 `print` 写一行，下一帧开始时清掉；
 * 画在整个画面（包括 UI）的最上面，用 Stride 的 8x16 调试字体（DebugTextRenderer）。调试 CLI 用 `stride call debug-text` 读。
 *
 *   override update(): void { this.game.debugText.print(`Prefab count : ${this.count}`, [780, 25]); }
 *
 * 和 Stride 不同（Stride 按后备缓冲的真实像素摆，窗口换个大小、换块高分屏，字就变小、和画面对不上）：
 * - 位置的单位是 CSS 像素，字按设备像素比放大整数倍，高分屏上一样大、一样清楚；
 * - 设了 virtualResolution 时，位置按那么大的画面给：画面按高度缩放、水平居中（竖直视场角固定的 3D 画面就是这么随窗口变的），
 *   所以摆在 3D 物体旁边的字在任何大小的画布上都还在物体旁边。Game.loadGameSettings 把它设成游戏设置里的后备缓冲大小，
 *   Stride 的样例照搬位置就行。
 */
export interface DebugTextLine {
  readonly text: string;
  /** print 时给的位置（左上角起），见 DebugText.toCanvas。 */
  readonly position: readonly [number, number];
  /** 线性的颜色（Stride 的 Color4），没给时用 DebugText.color。 */
  readonly color?: readonly [number, number, number, number];
}

/** 开发版（Vite 的 DEV，测试里也算）。 */
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ?? true;

export class DebugText {
  /**
   * 画不画（Stride 的 DebugTextSystem.Visible）：默认只在开发版画，同 Stride 只在调试版显示；拿调试文字当内容的游戏
   * （教程的说明）自己设成 true。不画的时候 print 的文字照样记在 lines 里。
   */
  visible = DEV;
  /** 默认的文字颜色，线性（Stride 的 TextColor，Color.LightGreen 当 Color4 用）。 */
  color: readonly [number, number, number, number] = [144 / 255, 238 / 255, 144 / 255, 1];
  /** print 的位置按这么大的画面给（见文件开头）；没设时就是画布上的 CSS 像素。 */
  virtualResolution: readonly [number, number] | undefined;
  #current: DebugTextLine[] = [];
  #last: readonly DebugTextLine[] = [];
  readonly #canvasSize: () => readonly [number, number];

  /** canvasSize：画布的大小，CSS 像素。 */
  constructor(canvasSize: () => readonly [number, number] = () => [0, 0]) {
    this.#canvasSize = canvasSize;
  }

  /** print 的一个单位在画布上是几个 CSS 像素。 */
  get scale(): number {
    return this.virtualResolution ? this.#canvasSize()[1] / this.virtualResolution[1] : 1;
  }

  /** print 的位置落在画布上的哪里（CSS 像素）。 */
  toCanvas([x, y]: readonly [number, number]): [number, number] {
    const virtual = this.virtualResolution;
    if (!virtual) return [x, y];
    const scale = this.scale;
    return [this.#canvasSize()[0] / 2 + (x - virtual[0] / 2) * scale, y * scale];
  }

  /** 画面上按 0..1 归一化的点（input.mousePosition、worldToScreen 的结果）换成 print 用的位置。 */
  fromScreen([x, y]: readonly [number, number]): [number, number] {
    const [width, height] = this.#canvasSize();
    return this.fromCanvas([x * width, y * height]);
  }

  /** toCanvas 反过来：画布上的位置（比如 input.absoluteMousePosition）换成 print 用的位置。 */
  fromCanvas([x, y]: readonly [number, number]): [number, number] {
    const virtual = this.virtualResolution;
    if (!virtual) return [x, y];
    const scale = this.scale;
    return [(x - this.#canvasSize()[0] / 2) / scale + virtual[0] / 2, y / scale];
  }

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
