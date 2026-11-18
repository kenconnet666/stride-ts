import { describe, expect, it } from 'vitest';
import { InputManager, keyCode } from '../src/index';

describe('按键名', () => {
  it('Stride 的 Keys 名字换成 KeyboardEvent.code，已经是 code 的原样返回', () => {
    expect(['A', 'D7', 'NumPad3', 'Left', 'Back', 'LeftShift', 'OemTilde', 'F5', 'Space'].map(keyCode))
      .toEqual(['KeyA', 'Digit7', 'Numpad3', 'ArrowLeft', 'Backspace', 'ShiftLeft', 'Backquote', 'F5', 'Space']);
    expect(['KeyW', 'ArrowUp', 'ShiftRight'].map(keyCode)).toEqual(['KeyW', 'ArrowUp', 'ShiftRight']);
  });
});

describe('指针事件（Stride 的 PointerEvents）', () => {
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  /** Node 里没有 DOM：画布和 window 用 EventTarget 冒充，事件带上 InputManager 读的字段。 */
  const setup = () => {
    const canvas = Object.assign(new EventTarget(), {
      clientWidth: 200,
      clientHeight: 100,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }),
    });
    const win = new EventTarget();
    (globalThis as { window?: EventTarget }).window = win;
    (globalThis as { document?: object }).document = { pointerLockElement: null };
    const input = new InputManager(canvas as unknown as HTMLCanvasElement);
    const pointer = (target: EventTarget, type: string, clientX: number, clientY: number, pointerType = 'mouse', pointerId = 1) =>
      target.dispatchEvent(Object.assign(new Event(type), { clientX, clientY, pointerType, pointerId }));
    return { canvas, win, input, pointer };
  };

  it('按帧收集，位置和移动量按画布归一化；鼠标不按键移动也算', () => {
    const { canvas, win, input, pointer } = setup();
    pointer(canvas, 'pointermove', 110, 70);
    pointer(canvas, 'pointermove', 130, 70);
    pointer(canvas, 'pointerdown', 130, 70);
    input.update();
    expect(input.pointerEvents.map((e) => [e.eventType, ...[...e.position, ...e.deltaPosition].map(round), e.isDown])).toEqual([
      ['moved', 0.5, 0.5, 0, 0, false],
      ['moved', 0.6, 0.5, 0.1, 0, false],
      ['pressed', 0.6, 0.5, 0, 0, true],
    ]);
    // 松开在画布外也收得到；下一帧的列表是新的
    pointer(win, 'pointerup', 230, 70);
    input.update();
    expect(input.pointerEvents.map((e) => [e.eventType, round(e.deltaPosition[0]), e.isDown])).toEqual([['released', 0.5, false]]);
    input.update();
    expect(input.pointerEvents).toEqual([]);
    input.destroy();
  });

  it('手指抬起后就忘掉；没在画布上出现过的指针的松开不算', () => {
    const { canvas, win, input, pointer } = setup();
    pointer(win, 'pointerup', 50, 50, 'touch', 7);
    pointer(canvas, 'pointerdown', 10, 20, 'touch', 7);
    pointer(win, 'pointerup', 10, 20, 'touch', 7);
    pointer(canvas, 'pointermove', 30, 20, 'touch', 7);
    input.update();
    expect(input.pointerEvents.map((e) => [e.eventType, e.deltaPosition[0]])).toEqual([['pressed', 0], ['released', 0], ['moved', 0]]);
    input.destroy();
  });
});
