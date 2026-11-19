/**
 * 虚拟按钮（Stride 的 VirtualButton、VirtualButtonBinding、VirtualButtonConfig、VirtualButtonConfigSet）：给一个名字绑上几个
 * 物理按钮（键盘的键、鼠标键、手柄的扳机），`input.getVirtualButton(0, 'Forward')` 取它们里绝对值最大的值（按下的键是 1）。
 *
 *   input.virtualButtonConfigSet.push(new VirtualButtonConfig(
 *     new VirtualButtonBinding('Forward', VirtualButton.keyboard('W')),
 *     new VirtualButtonBinding('Forward', VirtualButton.mouse('left')),
 *   ));
 */
import type { MouseButton } from './InputManager';

/** 能读成一个值的物理按钮（Stride 的 IVirtualButton）。 */
export interface VirtualButton {
  readonly name: string;
  value(input: VirtualButtonInput): number;
}

/** 虚拟按钮读值要的输入。 */
export interface VirtualButtonInput {
  isKeyDown(key: string): boolean;
  isMouseButtonDown(button: MouseButton): boolean;
  readonly gamePads: readonly { readonly leftTrigger: number; readonly rightTrigger: number }[];
}

export const VirtualButton = {
  /** 键盘的键（Stride 的键名，同 InputManager.isKeyDown），按着是 1。 */
  keyboard: (key: string): VirtualButton => ({ name: `Keyboard.${key}`, value: (input) => (input.isKeyDown(key) ? 1 : 0) }),
  /** 鼠标键，按着是 1。 */
  mouse: (button: MouseButton): VirtualButton => ({ name: `Mouse.${button}`, value: (input) => (input.isMouseButtonDown(button) ? 1 : 0) }),
  /** 第一个手柄的扳机（0 到 1，Stride 的 VirtualButton.GamePad.LeftTrigger）。 */
  gamePad: (trigger: 'leftTrigger' | 'rightTrigger'): VirtualButton => ({ name: `GamePad.${trigger}`, value: (input) => input.gamePads[0]?.[trigger] ?? 0 }),
};

export class VirtualButtonBinding {
  readonly name: string;
  readonly button: VirtualButton;

  constructor(name: string, button: VirtualButton) {
    this.name = name;
    this.button = button;
  }
}

/** 一组绑定（Stride 的 VirtualButtonConfig）。 */
export class VirtualButtonConfig {
  readonly bindings: VirtualButtonBinding[];

  constructor(...bindings: VirtualButtonBinding[]) {
    this.bindings = bindings;
  }

  /** 名字是 name 的绑定里绝对值最大的值（Stride 的 GetValue）；没有这个名字时是 0。 */
  value(input: VirtualButtonInput, name: string): number {
    let value = 0;
    for (const binding of this.bindings) {
      if (binding.name !== name) continue;
      const next = binding.button.value(input);
      if (Math.abs(next) > Math.abs(value)) value = next;
    }
    return value;
  }
}
