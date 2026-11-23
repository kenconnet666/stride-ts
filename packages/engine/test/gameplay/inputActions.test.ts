import { describe, expect, test } from 'vitest';
import { INPUT_MAP, type InputMapFile } from '../../src/content/formats/inputFormat';
import { InputActions, type InputSource } from '../../src/input/InputActions';
import type { GamePadState } from '../../src/input/gamePad';
import type { MouseButton } from '../../src/input/InputManager';

/** 手动摆的输入：按着的键、鼠标键、手柄。 */
class FakeInput implements InputSource {
  keys = new Set<string>();
  mouse = new Set<MouseButton>();
  mouseDelta: [number, number] = [0, 0];
  mouseWheelDelta = 0;
  gamePads: GamePadState[] = [];
  isKeyDown(key: string): boolean {
    return this.keys.has(key);
  }
  isMouseButtonDown(button: MouseButton): boolean {
    return this.mouse.has(button);
  }
  get downKeys(): readonly string[] {
    return [...this.keys];
  }
}

const pad = (patch: Partial<GamePadState> = {}): GamePadState => ({ buttons: 0, pressedButtons: 0, leftThumb: [0, 0], rightThumb: [0, 0], leftTrigger: 0, rightTrigger: 0, ...patch });

const ON_FOOT: InputMapFile = {
  name: 'OnFoot',
  actions: [
    { name: 'move', type: 'axis2', bindings: [{ type: 'dpad', up: 'key:KeyW', down: 'key:KeyS', left: 'key:KeyA', right: 'key:KeyD' }, { type: 'control', control: 'pad:leftStick', deadZone: 0.2 }] },
    { name: 'jump', type: 'button', bindings: [{ type: 'control', control: 'key:Space' }, { type: 'control', control: 'pad:a' }] },
    { name: 'zoom', type: 'axis', bindings: [{ type: 'axis', negative: 'key:KeyQ', positive: 'key:KeyE', scale: 2 }] },
  ],
};

describe('输入的动作', () => {
  test('dpad 斜着按长度是 1；摇杆去死区后按长度从 0 起；几个绑定取用力最大的；按下、松开只在那一帧', () => {
    const input = new FakeInput();
    const actions = new InputActions(input);
    actions.add(INPUT_MAP.parse(ON_FOOT));
    input.keys.add('KeyW').add('KeyD');
    actions.update();
    const [x, y] = actions.vector('move');
    expect(Math.hypot(x, y)).toBeCloseTo(1, 9);
    expect(x).toBeCloseTo(y, 9);
    input.keys.clear();
    input.gamePads = [pad({ leftThumb: [0.1, 0.1] })];
    actions.update();
    expect(actions.vector('move')).toEqual([0, 0]);
    input.gamePads = [pad({ leftThumb: [0, 0.6] })];
    actions.update();
    expect(actions.vector('move')[1]).toBeCloseTo(0.5, 9);
    // 跳：空格按下的那一帧 pressed，按着不再 pressed，松开那一帧 released
    input.keys.add('Space');
    actions.update();
    expect([actions.down('jump'), actions.pressed('jump'), actions.released('jump')]).toEqual([true, true, false]);
    actions.update();
    expect(actions.pressed('jump')).toBe(false);
    input.keys.delete('Space');
    actions.update();
    expect([actions.down('jump'), actions.released('jump')]).toEqual([false, true]);
    input.keys.add('KeyQ');
    actions.update();
    expect(actions.value('zoom')).toBe(-2);
  });

  test('几张映射按 priority 取同名动作，关掉就回到下一层；改键盖掉文件里的绑定，overrides 能存能恢复；写错的控件报错', () => {
    const input = new FakeInput();
    const actions = new InputActions(input);
    actions.add(INPUT_MAP.parse(ON_FOOT));
    const driving = actions.add(INPUT_MAP.parse({ name: 'Driving', actions: [{ name: 'jump', type: 'button', bindings: [{ type: 'control', control: 'key:KeyH' }] }] }), 10);
    expect(actions.maps).toEqual(['Driving', 'OnFoot']);
    input.keys.add('Space');
    actions.update();
    expect(actions.down('jump')).toBe(false);
    driving[Symbol.dispose]();
    actions.update();
    expect(actions.down('jump')).toBe(true);
    actions.rebind('jump', [{ type: 'control', control: 'key:KeyJ' }]);
    actions.update();
    expect(actions.down('jump')).toBe(false);
    const saved = JSON.parse(JSON.stringify(actions.overrides)) as typeof actions.overrides;
    actions.resetBindings();
    actions.overrides = saved;
    expect(actions.bindings('jump')).toEqual([{ type: 'control', control: 'key:KeyJ', scale: 1, deadZone: 0 }]);
    expect(() => actions.rebind('jump', [{ type: 'control', control: 'pad:turbo' }])).toThrow("unknown control 'pad:turbo'");
    expect(() => actions.add(INPUT_MAP.parse({ name: 'Bad', actions: [{ name: 'x', type: 'button', bindings: [{ type: 'control', control: 'joystick:1' }] }] }))).toThrow("input map 'Bad' action 'x'");
  });

  test('listen：开始等时已经按着的不算，等下一个新按下的键、鼠标键或手柄键', async () => {
    const input = new FakeInput();
    const actions = new InputActions(input);
    input.mouse.add('left');
    const next = actions.listen();
    actions.update();
    input.gamePads = [pad({ buttons: 1 << 12 })];
    actions.update();
    await expect(next).resolves.toBe('pad:a');
  });
});
