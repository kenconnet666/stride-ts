/**
 * 输入（Stride 的 InputManager 的常用部分）：键盘、鼠标、手柄。浏览器事件随时到达，Game 在每帧开头调用 update()，
 * 这一帧里读到的都是同一份状态：按住的键、这一帧刚按下或松开的键、这一帧的鼠标移动量。
 *
 * - 键用 KeyboardEvent.code 表示（'KeyW'、'ArrowLeft'、'Space'），和键盘布局无关。
 * - 鼠标的位置和移动量按画布尺寸归一化（同 Stride：划过整个画布宽度，移动量的 x 是 1）。
 * - lockMousePosition() 用 Pointer Lock：浏览器要求在用户操作（点击）之后不久调用，脚本在按下鼠标的那一帧调用即可；
 *   用户按 Esc 时浏览器自己解除锁定。
 * - 手柄用 Gamepad API 的标准布局，摇杆的 y 向上为正（同 Stride）。
 */

/** 鼠标按键。 */
export type MouseButton = 'left' | 'middle' | 'right';

/** 手柄按键（Stride 的 GamePadButton，同样的位）。 */
export const GamePadButton = {
  padUp: 1 << 0,
  padDown: 1 << 1,
  padLeft: 1 << 2,
  padRight: 1 << 3,
  start: 1 << 4,
  back: 1 << 5,
  leftThumb: 1 << 6,
  rightThumb: 1 << 7,
  leftShoulder: 1 << 8,
  rightShoulder: 1 << 9,
  a: 1 << 12,
  b: 1 << 13,
  x: 1 << 14,
  y: 1 << 15,
} as const;

/** 标准布局（https://w3c.github.io/gamepad/#remapping）的按键下标对应的位；6、7 是扳机，按模拟量读。 */
const STANDARD_BUTTONS: readonly number[] = [
  GamePadButton.a, GamePadButton.b, GamePadButton.x, GamePadButton.y,
  GamePadButton.leftShoulder, GamePadButton.rightShoulder, 0, 0,
  GamePadButton.back, GamePadButton.start, GamePadButton.leftThumb, GamePadButton.rightThumb,
  GamePadButton.padUp, GamePadButton.padDown, GamePadButton.padLeft, GamePadButton.padRight,
];

export interface GamePadState {
  /** GamePadButton 的位或。 */
  buttons: number;
  /** 左摇杆，x 向右、y 向上，-1..1。 */
  readonly leftThumb: [number, number];
  readonly rightThumb: [number, number];
  leftTrigger: number;
  rightTrigger: number;
}

const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right'];

export class InputManager {
  /** 这一帧鼠标的位置（画布内归一化到 0..1）。 */
  readonly mousePosition: [number, number] = [0, 0];
  /** 这一帧鼠标的移动量（按画布尺寸归一化；锁定时也有）。 */
  readonly mouseDelta: [number, number] = [0, 0];
  /** 连着的手柄，每帧开头刷新。 */
  readonly gamePads: GamePadState[] = [];

  readonly #canvas: HTMLCanvasElement;
  readonly #down = new Set<string>();
  #pressed = new Set<string>();
  #released = new Set<string>();
  // 事件到达时先记在这里，update() 时交给这一帧
  #pendingPressed = new Set<string>();
  #pendingReleased = new Set<string>();
  #pendingDelta: [number, number] = [0, 0];
  #pendingPosition: [number, number] = [0, 0];
  readonly #abort = new AbortController();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const options = { signal: this.#abort.signal };
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      this.#press(event.code);
    }, options);
    window.addEventListener('keyup', (event) => this.#release(event.code), options);
    canvas.addEventListener('mousedown', (event) => this.#press(mouseKey(event.button)), options);
    window.addEventListener('mouseup', (event) => this.#release(mouseKey(event.button)), options);
    window.addEventListener('mousemove', (event) => {
      const width = canvas.clientWidth || 1, height = canvas.clientHeight || 1;
      this.#pendingDelta[0] += event.movementX / width;
      this.#pendingDelta[1] += event.movementY / height;
      const rect = canvas.getBoundingClientRect();
      this.#pendingPosition[0] = (event.clientX - rect.left) / width;
      this.#pendingPosition[1] = (event.clientY - rect.top) / height;
    }, options);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
    // 失去焦点时按着的键收不到 keyup：全部当作松开
    window.addEventListener('blur', () => {
      for (const key of this.#down) this.#pendingReleased.add(key);
      this.#down.clear();
    }, options);
  }

  /** @internal 每帧开头由 Game 调用。 */
  update(): void {
    this.#pressed = this.#pendingPressed;
    this.#released = this.#pendingReleased;
    this.#pendingPressed = new Set();
    this.#pendingReleased = new Set();
    [this.mouseDelta[0], this.mouseDelta[1]] = this.#pendingDelta;
    this.#pendingDelta = [0, 0];
    [this.mousePosition[0], this.mousePosition[1]] = this.#pendingPosition;
    this.#pollGamePads();
  }

  isKeyDown(code: string): boolean {
    return this.#down.has(code);
  }

  /** 这一帧刚按下。 */
  isKeyPressed(code: string): boolean {
    return this.#pressed.has(code);
  }

  /** 这一帧刚松开。 */
  isKeyReleased(code: string): boolean {
    return this.#released.has(code);
  }

  isMouseButtonDown(button: MouseButton): boolean {
    return this.#down.has(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  isMouseButtonPressed(button: MouseButton): boolean {
    return this.#pressed.has(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  isMouseButtonReleased(button: MouseButton): boolean {
    return this.#released.has(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  get isMousePositionLocked(): boolean {
    return document.pointerLockElement === this.#canvas;
  }

  /** 锁定鼠标并隐藏指针（Stride 的 LockMousePosition 加 Game.IsMouseVisible = false）。 */
  lockMousePosition(): void {
    if (this.isMousePositionLocked) return;
    // 没有用户操作时浏览器会拒绝；拒绝不算错误，下次点击再试
    void Promise.resolve(this.#canvas.requestPointerLock()).catch(() => {});
  }

  unlockMousePosition(): void {
    if (this.isMousePositionLocked) document.exitPointerLock();
  }

  /** 至少一个手柄按着这个键（TPP 的 IsGamePadButtonDownAny）。 */
  isGamePadButtonDownAny(button: number): boolean {
    return this.gamePads.some((pad) => (pad.buttons & button) === button);
  }

  destroy(): void {
    this.#abort.abort();
    this.unlockMousePosition();
  }

  #press(key: string): void {
    if (this.#down.has(key)) return;
    this.#down.add(key);
    this.#pendingPressed.add(key);
  }

  #release(key: string): void {
    if (!this.#down.delete(key)) return;
    this.#pendingReleased.add(key);
  }

  #pollGamePads(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let count = 0;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const state = (this.gamePads[count++] ??= { buttons: 0, leftThumb: [0, 0], rightThumb: [0, 0], leftTrigger: 0, rightTrigger: 0 });
      state.buttons = 0;
      pad.buttons.forEach((button, i) => {
        if (button.pressed) state.buttons |= STANDARD_BUTTONS[i] ?? 0;
      });
      // 浏览器的摇杆 y 向下为正，Stride 向上为正
      state.leftThumb[0] = pad.axes[0] ?? 0;
      state.leftThumb[1] = -(pad.axes[1] ?? 0);
      state.rightThumb[0] = pad.axes[2] ?? 0;
      state.rightThumb[1] = -(pad.axes[3] ?? 0);
      state.leftTrigger = pad.buttons[6]?.value ?? 0;
      state.rightTrigger = pad.buttons[7]?.value ?? 0;
    }
    this.gamePads.length = count;
  }
}

/** 鼠标按键在按键集合里的名字（和键盘的 code 不会重名）。 */
function mouseKey(button: number): string {
  return `Mouse${button}`;
}
