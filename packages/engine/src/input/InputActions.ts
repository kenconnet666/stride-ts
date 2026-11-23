/**
 * 输入的动作（`game.input.actions`，格式见 content/formats/inputFormat.ts）：脚本问动作，不问具体的键。
 *
 *   const actions = this.game.input.actions;
 *   this.disposables.use(actions.add(await this.game.content.loadInputMap('Input/OnFoot')));
 *   if (actions.pressed('jump')) …;  const [x, y] = actions.vector('move');
 *
 * - 几张映射可以同时开（走路一张、开车一张），按 priority 高的优先：同名的动作用 priority 最高（同级里后加的）那张的绑定。
 *   上车时 `add(driving, 10)`，下车时把返回的 Disposable 释放掉。
 * - 改键：`rebind('jump', [{ type: 'control', control: 'key:KeyJ' }])` 盖掉映射文件里的绑定，`overrides` 是可以存下来的 JSON
 *   （玩家的设置，游戏自己存），下次开游戏 `overrides = 存的`；`listen()` 等玩家按下一个键、鼠标键或手柄键（改键界面用）。
 * - 输入被 UI 占着时键盘、鼠标键读不到（同 InputManager 的 isKeyDown），手柄不受影响。
 *
 * 每帧在 InputManager.update 的最后算一遍所有开着的动作，脚本这一帧读到的都是同一个值。
 */
import type { InputAction, InputBinding, InputBindingFile, InputMap } from '../content/formats/inputFormat';
import { INPUT_BINDING } from '../content/formats/inputFormat';
import { GamePadButton, type GamePadState } from './gamePad';
import type { MouseButton } from './InputManager';

/** 读物理输入要的（InputManager 的一部分）。 */
export interface InputSource {
  isKeyDown(key: string): boolean;
  isMouseButtonDown(button: MouseButton): boolean;
  readonly mouseDelta: readonly [number, number];
  readonly mouseWheelDelta: number;
  readonly gamePads: readonly GamePadState[];
  /** 按着的键（KeyboardEvent.code），listen 用。 */
  readonly downKeys: readonly string[];
}

/** button 动作的值超过它算按着。 */
const PRESS_THRESHOLD = 0.5;
const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right'];
const PAD_BUTTONS = Object.keys(GamePadButton) as (keyof typeof GamePadButton)[];

interface Layer {
  readonly map: InputMap;
  readonly priority: number;
  readonly order: number;
}

interface ActionState {
  readonly action: InputAction;
  value: [number, number];
  down: boolean;
  wasDown: boolean;
}

export class InputActions {
  readonly #source: InputSource;
  readonly #layers: Layer[] = [];
  #order = 0;
  /** 动作名 → 现在用哪张映射的那个动作。 */
  #actions = new Map<string, ActionState>();
  readonly #overrides = new Map<string, readonly InputBinding[]>();
  #listeners: ((control: string) => void)[] = [];
  #listenBaseline: Set<string> | undefined;

  constructor(source: InputSource) {
    this.#source = source;
  }

  /** 开一张映射；返回的 Disposable 关掉它。同一张再加一次是两层，各自关。 */
  add(map: InputMap, priority = 0): Disposable {
    const layer: Layer = { map, priority, order: this.#order++ };
    this.#layers.push(layer);
    this.#resolve();
    return {
      [Symbol.dispose]: () => {
        const at = this.#layers.indexOf(layer);
        if (at < 0) return;
        this.#layers.splice(at, 1);
        this.#resolve();
      },
    };
  }

  /** 开着的映射的名字，优先的在前。 */
  get maps(): readonly string[] {
    return this.#sorted().map((layer) => layer.map.name);
  }

  /** 这个动作现在按着（button；axis、axis2 是用了力）。没有这个动作时是假。 */
  down(name: string): boolean {
    return this.#actions.get(name)?.down ?? false;
  }

  /** 这一帧刚按下。 */
  pressed(name: string): boolean {
    const state = this.#actions.get(name);
    return state !== undefined && state.down && !state.wasDown;
  }

  /** 这一帧刚松开。 */
  released(name: string): boolean {
    const state = this.#actions.get(name);
    return state !== undefined && !state.down && state.wasDown;
  }

  /** button、axis 的值（axis2 是 x）。 */
  value(name: string): number {
    return this.#actions.get(name)?.value[0] ?? 0;
  }

  /** axis2 的值 [x, y]（y 向上）；别的种类 y 是 0。 */
  vector(name: string): readonly [number, number] {
    return this.#actions.get(name)?.value ?? [0, 0];
  }

  /** 动作现在的绑定：改过键的是改的，否则是映射文件里的。 */
  bindings(name: string): readonly InputBinding[] {
    return this.#overrides.get(name) ?? this.#actions.get(name)?.action.bindings ?? [];
  }

  /** 改键：这个动作换成这些绑定（不管在哪张映射里）。写错的绑定（种类、字段）报错。 */
  rebind(name: string, bindings: readonly InputBindingFile[]): void {
    this.#overrides.set(name, bindings.map((binding, i) => {
      const parsed = INPUT_BINDING.parse(binding, `rebind('${name}') binding ${i}`);
      for (const control of controlsOf(parsed)) checkControl(control, `rebind('${name}')`);
      return parsed;
    }));
  }

  /** 去掉改键（不给名字是全部），回到映射文件里的绑定。 */
  resetBindings(name?: string): void {
    if (name === undefined) this.#overrides.clear();
    else this.#overrides.delete(name);
  }

  /** 改过的键（动作名 → 绑定），可以存成 JSON；赋值是整个换掉。 */
  get overrides(): Readonly<Record<string, readonly InputBinding[]>> {
    return Object.fromEntries(this.#overrides);
  }

  set overrides(value: Readonly<Record<string, readonly InputBindingFile[]>>) {
    this.#overrides.clear();
    for (const [name, bindings] of Object.entries(value)) this.rebind(name, bindings);
  }

  /** 等玩家按下一个键、鼠标键或手柄键，给出它的写法（`key:KeyJ`、`mouse:right`、`pad:a`）；改键界面用。signal 中止时拒绝。 */
  listen(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      // 开始等的时候已经按着的不算（点"改键"按钮的那下鼠标）
      this.#listenBaseline ??= new Set(this.#pressedControls());
      const listener = (control: string) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(control);
      };
      const onAbort = () => {
        this.#listeners = this.#listeners.filter((other) => other !== listener);
        reject(signal!.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#listeners.push(listener);
    });
  }

  /** @internal InputManager.update 的最后调：算这一帧所有动作的值。 */
  update(): void {
    for (const state of this.#actions.values()) {
      state.wasDown = state.down;
      const value = this.#evaluate(state.action, this.bindings(state.action.name));
      state.value = value;
      state.down = Math.hypot(value[0], value[1]) > (state.action.type === 'button' ? PRESS_THRESHOLD : 0);
    }
    if (this.#listeners.length > 0) this.#serveListeners();
  }

  #serveListeners(): void {
    const pressed = this.#pressedControls();
    const baseline = this.#listenBaseline ?? new Set();
    const fresh = pressed.find((control) => !baseline.has(control));
    // 一直按着的（开始等时就按着）松开以后再按才算
    this.#listenBaseline = new Set(pressed.filter((control) => baseline.has(control)));
    if (fresh === undefined) return;
    const listeners = this.#listeners;
    this.#listeners = [];
    this.#listenBaseline = undefined;
    for (const listener of listeners) listener(fresh);
  }

  /** 现在按着的键、鼠标键、手柄键（写成绑定里的字符串）。 */
  #pressedControls(): string[] {
    const source = this.#source;
    return [
      ...source.downKeys.map((code) => `key:${code}`),
      ...MOUSE_BUTTONS.filter((button) => source.isMouseButtonDown(button)).map((button) => `mouse:${button}`),
      ...PAD_BUTTONS.filter((button) => source.gamePads.some((pad) => (pad.buttons & GamePadButton[button]) !== 0)).map((button) => `pad:${button}`),
      ...(['leftTrigger', 'rightTrigger'] as const).filter((trigger) => source.gamePads.some((pad) => pad[trigger] > PRESS_THRESHOLD)).map((trigger) => `pad:${trigger}`),
    ];
  }

  #sorted(): Layer[] {
    return [...this.#layers].sort((a, b) => b.priority - a.priority || b.order - a.order);
  }

  /** 每个动作名用优先的那张映射；保留按着的状态（换了映射也不会凭空"刚按下"）。 */
  #resolve(): void {
    const next = new Map<string, ActionState>();
    for (const layer of this.#sorted()) {
      for (const action of layer.map.actions) {
        if (next.has(action.name)) continue;
        for (const binding of action.bindings) for (const control of controlsOf(binding)) checkControl(control, `input map '${layer.map.name}' action '${action.name}'`);
        const previous = this.#actions.get(action.name);
        next.set(action.name, { action, value: previous?.value ?? [0, 0], down: previous?.down ?? false, wasDown: previous?.wasDown ?? false });
      }
    }
    this.#actions = next;
  }

  #evaluate(action: InputAction, bindings: readonly InputBinding[]): [number, number] {
    let best: [number, number] = [0, 0], strength = 0;
    for (const binding of bindings) {
      const raw = this.#binding(binding);
      const value = applyDeadZone(raw, binding.deadZone);
      value[0] *= binding.scale;
      value[1] *= binding.scale;
      if (action.type !== 'axis2') value[1] = 0;
      const length = Math.hypot(value[0], value[1]);
      if (length > strength) [best, strength] = [value, length];
    }
    return best;
  }

  #binding(binding: InputBinding): [number, number] {
    switch (binding.type) {
      case 'control':
        return this.#read(binding.control);
      case 'axis':
        return [this.#read(binding.positive)[0] - this.#read(binding.negative)[0], 0];
      case 'dpad': {
        const x = this.#read(binding.right)[0] - this.#read(binding.left)[0], y = this.#read(binding.up)[0] - this.#read(binding.down)[0];
        const length = Math.hypot(x, y);
        return length > 1 ? [x / length, y / length] : [x, y];
      }
    }
  }

  /** 一个物理输入的值：按钮是 [0 或 1, 0]，扳机是 [0..1, 0]，摇杆和鼠标移动是二维。几个手柄取用力最大的。 */
  #read(control: string): [number, number] {
    const source = this.#source;
    const [device, name] = splitControl(control);
    if (device === 'key') return [source.isKeyDown(name) ? 1 : 0, 0];
    if (device === 'mouse') {
      if (name === 'delta') return [source.mouseDelta[0], -source.mouseDelta[1]];
      if (name === 'wheel') return [source.mouseWheelDelta, 0];
      return [source.isMouseButtonDown(name as MouseButton) ? 1 : 0, 0];
    }
    let best: [number, number] = [0, 0];
    for (const pad of source.gamePads) {
      const value: [number, number] = name === 'leftStick' ? [...pad.leftThumb] : name === 'rightStick' ? [...pad.rightThumb]
        : name === 'leftTrigger' || name === 'rightTrigger' ? [pad[name], 0]
        : [(pad.buttons & GamePadButton[name as keyof typeof GamePadButton]) !== 0 ? 1 : 0, 0];
      if (Math.hypot(value[0], value[1]) > Math.hypot(best[0], best[1])) best = value;
    }
    return best;
  }
}

/** 绑定里用到的物理输入。 */
function controlsOf(binding: InputBinding): string[] {
  switch (binding.type) {
    case 'control':
      return [binding.control];
    case 'axis':
      return [binding.negative, binding.positive];
    case 'dpad':
      return [binding.up, binding.down, binding.left, binding.right];
  }
}

function splitControl(control: string): [string, string] {
  const at = control.indexOf(':');
  return [control.slice(0, at), control.slice(at + 1)];
}

const MOUSE_CONTROLS = new Set<string>([...MOUSE_BUTTONS, 'delta', 'wheel']);
const PAD_CONTROLS = new Set<string>([...PAD_BUTTONS, 'leftTrigger', 'rightTrigger', 'leftStick', 'rightStick']);

/** 物理输入的写法对不对（加映射、改键时查一次，写错的在那时报出来，不是每帧默默读成 0）。 */
function checkControl(control: string, where: string): void {
  const [device, name] = splitControl(control);
  const ok = device === 'key' ? name.length > 0 : device === 'mouse' ? MOUSE_CONTROLS.has(name) : device === 'pad' ? PAD_CONTROLS.has(name) : false;
  if (!ok) throw new Error(`${where}: unknown control '${control}' (key:<key>, mouse:${[...MOUSE_CONTROLS].join('|')}, pad:${[...PAD_CONTROLS].join('|')})`);
}

/** 按长度去掉死区，剩下的一段拉回从 0 起（摇杆推到底仍是 1）。 */
function applyDeadZone([x, y]: [number, number], deadZone: number): [number, number] {
  if (deadZone <= 0) return [x, y];
  const length = Math.hypot(x, y);
  if (length <= deadZone) return [0, 0];
  const scaled = (length - deadZone) / (1 - deadZone) / length;
  return [x * scaled, y * scaled];
}
