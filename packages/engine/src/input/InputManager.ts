/**
 * 输入（Stride 的 InputManager 的常用部分）：键盘、鼠标、手柄。浏览器事件随时到达，Game 在每帧开头调用 update()，
 * 这一帧里读到的都是同一份状态：按住的键、这一帧刚按下或松开的键、这一帧的鼠标移动量。
 *
 * - 键用 KeyboardEvent.code 表示（'KeyW'、'ArrowLeft'、'Space'），和键盘布局无关；也认 Stride 的 Keys 名字（'W'、'Left'），见 keys.ts。
 * - 鼠标的位置和移动量按画布尺寸归一化（同 Stride：划过整个画布宽度，移动量的 x 是 1）。
 * - lockMousePosition() 用 Pointer Lock：浏览器要求在用户操作（点击）之后不久调用，脚本在按下鼠标的那一帧调用即可；
 *   用户按 Esc 时浏览器自己解除锁定。
 * - 手柄用 Gamepad API 的标准布局，摇杆的 y 向上为正（同 Stride）。
 * - 指针事件（Stride 的 PointerEvents）：鼠标、触摸、笔都走 Pointer Events，这一帧在画布上发生的按下、移动、松开按顺序
 *   列出，位置和移动量同样按画布尺寸归一化。鼠标不按键移动也有 moved（同 Stride 桌面版）。
 * - 占用（capture.ts）：UI 悬停时占着鼠标、输入框有焦点时占着键盘，maskCapturedInput 开着时脚本看不到被占的输入；
 *   UI 自己读不受占用影响的 raw* 版本。
 */

import type { VirtualButtonConfig } from './virtualButtons';
import { GestureCollection, type GestureEvent } from './gestures';
import { ButtonTracker, CaptureState, InputCapturePriority } from './capture';
import { keyCode } from './keys';

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

/** 一个指针事件（Stride 的 PointerEvent）。 */
export interface PointerEvent {
  /** 浏览器的 pointerId：鼠标一个，每根手指各一个。 */
  readonly pointerId: number;
  /** 来自鼠标还是触摸、笔（触摸和笔按指针单独占用，鼠标跟着鼠标设备）。 */
  readonly device: 'mouse' | 'touch' | 'pen';
  readonly eventType: 'pressed' | 'moved' | 'released' | 'canceled';
  /** 画布内归一化到 0..1。 */
  readonly position: readonly [number, number];
  /** 和这个指针上一个事件的位置差。 */
  readonly deltaPosition: readonly [number, number];
  /** 事件之后指针是否按着。 */
  readonly isDown: boolean;
}

const NO_GESTURES: readonly GestureEvent[] = [];
const POINTER_TYPES = { pointerdown: 'pressed', pointermove: 'moved', pointerup: 'released', pointercancel: 'canceled' } as const;

/** 能被占用的设备。 */
export type InputDevice = 'mouse' | 'keyboard';

export class InputManager {
  /** 这一帧鼠标的位置（画布内归一化到 0..1）。 */
  readonly mousePosition: [number, number] = [0, 0];
  /** 这一帧鼠标的移动量（按画布尺寸归一化；锁定时也有）。 */
  readonly mouseDelta: [number, number] = [0, 0];
  /** 连着的手柄，每帧开头刷新。 */
  readonly gamePads: GamePadState[] = [];
  /** 这一帧所有的指针事件（不管占用），按发生的顺序；UI 用它。 */
  rawPointerEvents: readonly PointerEvent[] = [];
  /** 这一帧鼠标滚轮转的格数，不管占用。 */
  rawMouseWheelDelta = 0;
  /** 虚拟按钮的配置（Stride 的 VirtualButtonConfigSet），getVirtualButton 按下标取。 */
  readonly virtualButtonConfigSet: VirtualButtonConfig[] = [];

  readonly #canvas: HTMLCanvasElement;
  /** 要识别的手势（Stride 的 Input.Gestures）：`gestures.add(Gestures.drag())`，见 gestures.ts。 */
  readonly gestures = new GestureCollection();
  /** 这一帧识别到的手势事件（Stride 的 Input.GestureEvents）；被 UI 占用的指针不算。 */
  gestureEvents: readonly GestureEvent[] = NO_GESTURES;
  readonly #capture: Readonly<Record<InputDevice, CaptureState>> = { mouse: new CaptureState(), keyboard: new CaptureState() };
  readonly #keyboard = new ButtonTracker(this.#capture.keyboard);
  readonly #mouseButtons = new ButtonTracker(this.#capture.mouse);
  /** 触摸、笔的指针被谁占着（鼠标的指针跟着鼠标设备）。 */
  readonly #pointerOwners = new Map<number, object>();
  #maskCapturedInput = true;
  /** 正在处理占用（update 里、脚本读这一帧之前）。 */
  #resolving = false;
  readonly #resolvers = new Set<() => void>();
  // 事件到达时先记在这里，update() 时交给这一帧
  #pendingDelta: [number, number] = [0, 0];
  #pendingPosition: [number, number] = [0, 0];
  #pendingWheel = 0;
  #pendingPointerEvents: PointerEvent[] = [];
  /** 每个指针上一个事件的位置和是否按着。 */
  readonly #pointers = new Map<number, { x: number; y: number; down: boolean }>();
  readonly #abort = new AbortController();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const options = { signal: this.#abort.signal };
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      this.#keyboard.press(event.code);
    }, options);
    window.addEventListener('keyup', (event) => this.#keyboard.release(event.code), options);
    canvas.addEventListener('mousedown', (event) => this.#mouseButtons.press(mouseKey(event.button)), options);
    window.addEventListener('mouseup', (event) => this.#mouseButtons.release(mouseKey(event.button)), options);
    window.addEventListener('mousemove', (event) => {
      const width = canvas.clientWidth || 1, height = canvas.clientHeight || 1;
      this.#pendingDelta[0] += event.movementX / width;
      this.#pendingDelta[1] += event.movementY / height;
      const rect = canvas.getBoundingClientRect();
      this.#pendingPosition[0] = (event.clientX - rect.left) / width;
      this.#pendingPosition[1] = (event.clientY - rect.top) / height;
    }, options);
    for (const type of Object.keys(POINTER_TYPES) as (keyof typeof POINTER_TYPES)[]) {
      // 松开和取消可能发生在画布外（按着拖出去），挂在 window 上
      const target: EventTarget = type === 'pointerup' || type === 'pointercancel' ? window : canvas;
      target.addEventListener(type, (event) => this.#pointer(POINTER_TYPES[type], event as globalThis.PointerEvent), options);
    }
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
    // 浏览器的 deltaY 向下为正，按模式换成格：像素模式一格约 100 像素，行模式一格 3 行
    canvas.addEventListener('wheel', (event) => {
      const notches = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY / 100 : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY / 3 : event.deltaY;
      this.#pendingWheel -= notches;
      event.preventDefault();
    }, { ...options, passive: false });
    // 失去焦点时按着的键收不到 keyup：全部当作松开
    window.addEventListener('blur', () => {
      this.#keyboard.releaseAll();
      this.#mouseButtons.releaseAll();
    }, options);
  }

  /**
   * @internal 每帧开头由 Game 调用：换上这一帧的输入，再让占用方（UI）按这一帧的输入决定占用（Stride 的 ResolvingCapture），
   * 最后按没被占用的指针事件识别手势。elapsed 是这一帧的秒数（手势的计时用）。
   */
  update(elapsed = 0): void {
    this.#keyboard.update();
    this.#mouseButtons.update();
    [this.mouseDelta[0], this.mouseDelta[1]] = this.#pendingDelta;
    this.#pendingDelta = [0, 0];
    [this.mousePosition[0], this.mousePosition[1]] = this.#pendingPosition;
    this.rawMouseWheelDelta = this.#pendingWheel;
    this.#pendingWheel = 0;
    this.rawPointerEvents = this.#pendingPointerEvents;
    this.#pendingPointerEvents = [];
    this.#pollGamePads();
    this.#resolving = true;
    try {
      for (const resolve of this.#resolvers) resolve();
    } finally {
      this.#resolving = false;
    }
    const { clientWidth, clientHeight } = this.#canvas;
    this.gestureEvents = this.gestures.size > 0 ? this.gestures.process(elapsed, this.pointerEvents, (clientWidth || 1) / (clientHeight || 1)) : NO_GESTURES;
  }

  /** @internal 每帧 update 时、脚本读输入之前调用 resolve（UI 在这里按指针决定占用）；返回取消登记的函数。 */
  onResolvingCapture(resolve: () => void): () => void {
    this.#resolvers.add(resolve);
    return () => this.#resolvers.delete(resolve);
  }

  /** 被占用的输入对脚本和系统藏起来（Stride 的 MaskCapturedInput，默认开）；关掉后脚本看到全部输入。 */
  get maskCapturedInput(): boolean {
    return this.#maskCapturedInput;
  }

  set maskCapturedInput(value: boolean) {
    if (value === this.#maskCapturedInput) return;
    this.#maskCapturedInput = value;
    for (const device of ['mouse', 'keyboard'] as const) this.#updateMask(device);
  }

  /** 占着设备的对象，没有时是 null。 */
  captureOwner(device: InputDevice): object | null {
    return this.#capture[device].owner;
  }

  /** 占用设备；已经被别人以不低的优先级占着时返回 false。 */
  tryCapture(device: InputDevice, owner: object, priority: number = InputCapturePriority.hover): boolean {
    const state = this.#capture[device];
    if (state.owner && state.owner !== owner && priority <= state.priority) return false;
    state.owner = owner;
    state.priority = priority;
    this.#updateMask(device);
    return true;
  }

  /** owner 占着设备时放开。 */
  release(device: InputDevice, owner: object): void {
    const state = this.#capture[device];
    if (state.owner !== owner) return;
    state.owner = null;
    state.priority = 0;
    this.#updateMask(device);
  }

  /** 占用一个触摸、笔的指针（UI 在指针按下时占着它，松开后放开）。 */
  capturePointer(pointerId: number, owner: object): void {
    this.#pointerOwners.set(pointerId, owner);
  }

  releasePointer(pointerId: number, owner: object): void {
    if (this.#pointerOwners.get(pointerId) === owner) this.#pointerOwners.delete(pointerId);
  }

  /** 放开 owner 占着的所有设备和指针。 */
  releaseAll(owner: object): void {
    this.release('mouse', owner);
    this.release('keyboard', owner);
    for (const [pointerId, pointerOwner] of this.#pointerOwners) if (pointerOwner === owner) this.#pointerOwners.delete(pointerId);
  }

  #updateMask(device: InputDevice): void {
    const state = this.#capture[device];
    const masked = this.#maskCapturedInput && state.owner !== null;
    if (masked === state.masked) return;
    state.masked = masked;
    (device === 'keyboard' ? this.#keyboard : this.#mouseButtons).maskChanged(masked, this.#resolving);
  }

  /** 这一帧给脚本看的指针事件：被占用的鼠标、指针的事件藏起来。 */
  get pointerEvents(): readonly PointerEvent[] {
    if (!this.#maskCapturedInput) return this.rawPointerEvents;
    const mouseMasked = this.#capture.mouse.masked;
    return this.rawPointerEvents.filter((event) => (event.device === 'mouse' ? !mouseMasked : !this.#pointerOwners.has(event.pointerId)));
  }

  /** 这一帧鼠标滚轮转了多少格，向前（远离用户）是正（Stride 的 MouseWheelDelta）；鼠标被占用时是 0。 */
  get mouseWheelDelta(): number {
    return this.#capture.mouse.masked ? 0 : this.rawMouseWheelDelta;
  }

  /** 按着的键（KeyboardEvent.code，Stride 的 DownKeys）。 */
  get downKeys(): readonly string[] {
    return this.#keyboard.downKeys();
  }

  isKeyDown(key: string): boolean {
    return this.#keyboard.isDown(keyCode(key));
  }

  /** 这一帧刚按下。 */
  isKeyPressed(key: string): boolean {
    return this.#keyboard.isPressed(keyCode(key));
  }

  /** 这一帧刚松开。 */
  isKeyReleased(key: string): boolean {
    return this.#keyboard.isReleased(keyCode(key));
  }

  /** 不管占用：键盘上这个键按着（UI 自己用）。 */
  isRawKeyDown(key: string): boolean {
    return this.#keyboard.down.has(keyCode(key));
  }

  isMouseButtonDown(button: MouseButton): boolean {
    return this.#mouseButtons.isDown(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  isMouseButtonPressed(button: MouseButton): boolean {
    return this.#mouseButtons.isPressed(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  isMouseButtonReleased(button: MouseButton): boolean {
    return this.#mouseButtons.isReleased(mouseKey(MOUSE_BUTTONS.indexOf(button)));
  }

  /** 不管占用：鼠标有键按着或这一帧刚松开（UI 判断游戏里的拖动）。 */
  get rawMouseButtonsActive(): boolean {
    return this.#mouseButtons.down.size > 0 || this.#mouseButtons.released.size > 0;
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

  /**
   * 鼠标在画布里的位置，左上角是原点（Stride 的 AbsoluteMousePosition）。和 Stride 不同：单位是 CSS 像素，不是后备缓冲的
   * 真实像素，高分屏上数值不变；`game.debugText.fromCanvas` 把它换成 print 用的位置。
   */
  get absoluteMousePosition(): [number, number] {
    return [this.mousePosition[0] * this.#canvas.clientWidth, this.mousePosition[1] * this.#canvas.clientHeight];
  }

  /** 第 configIndex 组虚拟按钮里名字是 name 的值（Stride 的 GetVirtualButton）；没有这组时是 0。 */
  getVirtualButton(configIndex: number, name: string): number {
    return this.virtualButtonConfigSet[configIndex]?.value(this, name) ?? 0;
  }

  /** 至少一个手柄按着这个键（TPP 的 IsGamePadButtonDownAny）。 */
  isGamePadButtonDownAny(button: number): boolean {
    return this.gamePads.some((pad) => (pad.buttons & button) === button);
  }

  /** 超过死区的摇杆取平均（Stride 模板的 InputManagerExtensions.GetLeftThumbAny、GetRightThumbAny）。 */
  thumbAny(thumb: 'leftThumb' | 'rightThumb', deadZone: number): [number, number] {
    let count = 0, x = 0, y = 0;
    for (const pad of this.gamePads) {
      const [px, py] = pad[thumb];
      if (Math.hypot(px, py) < deadZone) continue;
      count++;
      x += px;
      y += py;
    }
    return count > 1 ? [x / count, y / count] : [x, y];
  }

  /** 超过死区的扳机取平均（Stride 模板的 InputManagerExtensions.GetLeftTriggerAny、GetRightTriggerAny）。 */
  triggerAny(trigger: 'leftTrigger' | 'rightTrigger', deadZone: number): number {
    const pressed = this.gamePads.map((pad) => pad[trigger]).filter((value) => value >= deadZone);
    const total = pressed.reduce((sum, value) => sum + value, 0);
    return pressed.length > 1 ? total / pressed.length : total;
  }

  destroy(): void {
    this.#abort.abort();
    this.unlockMousePosition();
  }

  #pointer(eventType: PointerEvent['eventType'], event: globalThis.PointerEvent): void {
    const rect = this.#canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / (rect.width || 1), y = (event.clientY - rect.top) / (rect.height || 1);
    const last = this.#pointers.get(event.pointerId);
    // 画布外松开的、从没在画布上出现过的指针不算
    if (!last && eventType !== 'pressed' && eventType !== 'moved') return;
    const down = eventType === 'pressed' || (eventType === 'moved' && (last?.down ?? false));
    const device = event.pointerType === 'touch' || event.pointerType === 'pen' ? event.pointerType : 'mouse';
    this.#pendingPointerEvents.push({ pointerId: event.pointerId, device, eventType, position: [x, y], deltaPosition: last ? [x - last.x, y - last.y] : [0, 0], isDown: down });
    // 手指抬起就没了；鼠标一直在，下次移动的差值接着这次算
    if ((eventType === 'released' || eventType === 'canceled') && event.pointerType !== 'mouse') this.#pointers.delete(event.pointerId);
    else this.#pointers.set(event.pointerId, { x, y, down });
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
