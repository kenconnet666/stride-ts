/**
 * 输入的占用（Stride 的 Input Capture）：一个设备（鼠标、键盘）或一个触摸指针可以被一个对象占着（UI 悬停时占鼠标，有焦点的
 * 输入框占键盘），优先级高的才能抢走。InputManager.maskCapturedInput 开着时（默认），被占着的设备对脚本和系统看起来什么都没有。
 *
 * 按键的屏蔽照 Stride 的 ButtonCaptureTracker：开始被占时还按着的键给脚本一个"松开"，被占期间什么都看不到；占用结束时还按着的
 * 键继续藏着，直到松开（或重新按下），脚本不会看到没有按下的松开、没有松开的按下。
 */

/** 占用的优先级（Stride 的 InputCapturePriority）。 */
export const InputCapturePriority = { hover: 0, focus: 100, modal: 1000 } as const;

/** 一个设备的占用状态。 */
export class CaptureState {
  owner: object | null = null;
  priority = 0;
  /** 被占着并且开着屏蔽（脚本看不到）。 */
  masked = false;
}

/** 一组按键这一帧的原始状态，不管占用（InputManager.rawKeys）。 */
export interface RawKeys {
  readonly down: ReadonlySet<string>;
  readonly pressed: ReadonlySet<string>;
  readonly released: ReadonlySet<string>;
}

/**
 * 一组按键（键盘的键或鼠标的键）：原始的按着、刚按下、刚松开，和按占用屏蔽之后给脚本看的。
 */
export class ButtonTracker {
  readonly down = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();
  #pendingPressed = new Set<string>();
  #pendingReleased = new Set<string>();
  /** 开始屏蔽时还按着（或这一帧刚松开）的键：屏蔽后给脚本一个松开。 */
  readonly #releasedOnCapture = new Set<string>();
  /** 屏蔽结束时还按着的键：松开之前继续藏着。 */
  readonly #suppressed = new Set<string>();
  /** 藏着期间松开的键：这一帧的松开不给脚本看。 */
  readonly #releasedWhileSuppressed = new Set<string>();
  readonly #state: CaptureState;

  constructor(state: CaptureState) {
    this.#state = state;
  }

  press(key: string): void {
    if (this.down.has(key)) return;
    this.down.add(key);
    this.#pendingPressed.add(key);
  }

  release(key: string): void {
    if (!this.down.delete(key)) return;
    this.#pendingReleased.add(key);
  }

  /** 失去焦点：按着的全部当作松开。 */
  releaseAll(): void {
    for (const key of [...this.down]) this.release(key);
  }

  /** 新的一帧：刚按下、刚松开换成这一帧的，再更新藏着的键（Stride 的 AfterDeviceUpdate）。 */
  update(): void {
    this.pressed = this.#pendingPressed;
    this.released = this.#pendingReleased;
    this.#pendingPressed = new Set();
    this.#pendingReleased = new Set();
    this.#releasedOnCapture.clear();
    this.#releasedWhileSuppressed.clear();
    for (const key of [...this.#suppressed]) {
      if (this.pressed.has(key)) this.#suppressed.delete(key);
      else if (!this.down.has(key)) {
        this.#suppressed.delete(key);
        if (this.released.has(key)) this.#releasedWhileSuppressed.add(key);
      }
    }
  }

  /**
   * 屏蔽开关变了（Stride 的 OnMaskChanged）。unseenPresses：变化发生在脚本读这一帧之前（UI 在这一帧的输入里决定占用），这一帧
   * 刚按下的键脚本从没看到过，不给它们补松开、也不藏。
   */
  maskChanged(masked: boolean, unseenPresses: boolean): void {
    const unseen = (key: string) => unseenPresses && this.pressed.has(key);
    this.#releasedOnCapture.clear();
    if (masked) {
      for (const key of this.down) if (!this.#suppressed.has(key) && !unseen(key)) this.#releasedOnCapture.add(key);
      for (const key of this.released) if (!this.#releasedWhileSuppressed.has(key) && !unseen(key)) this.#releasedOnCapture.add(key);
      this.#suppressed.clear();
    } else {
      this.#suppressed.clear();
      for (const key of this.down) if (!unseen(key)) this.#suppressed.add(key);
      for (const key of this.released) if (!this.pressed.has(key) || this.#suppressed.has(key)) this.#releasedWhileSuppressed.add(key);
    }
  }

  /** 给脚本看的：按着。 */
  isDown(key: string): boolean {
    return !this.#state.masked && this.down.has(key) && !this.#suppressed.has(key);
  }

  isPressed(key: string): boolean {
    return !this.#state.masked && this.pressed.has(key) && !this.#suppressed.has(key);
  }

  isReleased(key: string): boolean {
    return this.#state.masked ? this.#releasedOnCapture.has(key) : this.released.has(key) && !this.#releasedWhileSuppressed.has(key);
  }

  /** 给脚本看的按着的键。 */
  downKeys(): string[] {
    return this.#state.masked ? [] : [...this.down].filter((key) => !this.#suppressed.has(key));
  }
}
