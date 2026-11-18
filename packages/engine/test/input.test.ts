import { describe, expect, it } from 'vitest';
import { keyCode } from '../src/index';

describe('按键名', () => {
  it('Stride 的 Keys 名字换成 KeyboardEvent.code，已经是 code 的原样返回', () => {
    expect(['A', 'D7', 'NumPad3', 'Left', 'Back', 'LeftShift', 'OemTilde', 'F5', 'Space'].map(keyCode))
      .toEqual(['KeyA', 'Digit7', 'Numpad3', 'ArrowLeft', 'Backspace', 'ShiftLeft', 'Backquote', 'F5', 'Space']);
    expect(['KeyW', 'ArrowUp', 'ShiftRight'].map(keyCode)).toEqual(['KeyW', 'ArrowUp', 'ShiftRight']);
  });
});
