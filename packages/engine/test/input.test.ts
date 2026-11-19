import { describe, expect, it } from 'vitest';
import { InputCapturePriority, InputManager, keyCode, VirtualButton, VirtualButtonBinding, VirtualButtonConfig } from '../src/index';

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

describe('占用（Stride 的 Input Capture）', () => {
  const setup = () => {
    const canvas = Object.assign(new EventTarget(), {
      clientWidth: 200,
      clientHeight: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });
    const win = new EventTarget();
    (globalThis as { window?: EventTarget }).window = win;
    (globalThis as { document?: object }).document = { pointerLockElement: null };
    const input = new InputManager(canvas as unknown as HTMLCanvasElement);
    const key = (type: 'keydown' | 'keyup', code: string) => win.dispatchEvent(Object.assign(new Event(type), { code, repeat: false }));
    const pointer = (type: string, pointerType: string, pointerId: number) =>
      (type === 'pointerup' ? win : canvas).dispatchEvent(Object.assign(new Event(type), { clientX: 10, clientY: 10, pointerType, pointerId }));
    return { canvas, input, key, pointer };
  };
  const ui = {};
  const game = {};

  it('键盘被占着时脚本看不到；开始占用时还按着的键给一个松开，结束占用时还按着的键松开之前继续藏着', () => {
    const { input, key } = setup();
    key('keydown', 'KeyA');
    input.update();
    expect([input.isKeyPressed('A'), input.isKeyDown('A'), input.downKeys]).toEqual([true, true, ['KeyA']]);
    // 脚本读过这一帧之后被占用：A 给一个松开
    expect(input.tryCapture('keyboard', ui, InputCapturePriority.focus)).toBe(true);
    expect([input.isKeyDown('A'), input.isKeyReleased('A'), input.downKeys]).toEqual([false, true, []]);
    key('keydown', 'KeyB');
    input.update();
    expect([input.isKeyPressed('B'), input.isKeyReleased('A')]).toEqual([false, false]);
    // 优先级不高于现在的占用者时抢不走
    expect(input.tryCapture('keyboard', game, InputCapturePriority.hover)).toBe(false);
    input.release('keyboard', ui);
    // A、B 还按着：继续藏着，松开时也不报
    expect([input.isKeyDown('A'), input.isKeyDown('B'), input.downKeys]).toEqual([false, false, []]);
    key('keyup', 'KeyA');
    input.update();
    expect([input.isKeyReleased('A'), input.isKeyDown('B')]).toEqual([false, false]);
    key('keydown', 'KeyA');
    input.update();
    expect([input.isKeyPressed('A'), input.isKeyDown('A')]).toEqual([true, true]);
    input.destroy();
  });

  it('在 update 里（脚本读之前）占用时，这一帧刚按下的键不补松开', () => {
    const { input, key } = setup();
    const stop = input.onResolvingCapture(() => input.tryCapture('keyboard', ui, InputCapturePriority.focus));
    key('keydown', 'KeyA');
    input.update();
    expect([input.isKeyPressed('A'), input.isKeyReleased('A')]).toEqual([false, false]);
    stop();
    input.destroy();
  });

  it('关掉屏蔽后脚本看到全部；鼠标被占着时鼠标的指针事件和滚轮藏起来，触摸的指针按指针占用', () => {
    const { input, pointer } = setup();
    input.tryCapture('mouse', ui);
    pointer('pointerdown', 'mouse', 1);
    pointer('pointerdown', 'touch', 7);
    pointer('pointerdown', 'touch', 8);
    input.capturePointer(8, ui);
    input.update();
    expect(input.rawPointerEvents).toHaveLength(3);
    expect(input.pointerEvents.map((e) => e.pointerId)).toEqual([7]);
    input.maskCapturedInput = false;
    expect(input.pointerEvents).toHaveLength(3);
    input.maskCapturedInput = true;
    input.releaseAll(ui);
    expect([input.captureOwner('mouse'), input.pointerEvents.length]).toEqual([null, 3]);
    input.destroy();
  });
});

describe('虚拟按钮（Stride 的 VirtualButtonConfigSet）', () => {
  it('取同名绑定里绝对值最大的值：键按着是 1，扳机是它的值；没有这组配置或这个名字时是 0', () => {
    const canvas = Object.assign(new EventTarget(), {
      width: 400,
      height: 200,
      clientWidth: 200,
      clientHeight: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    });
    const win = new EventTarget();
    (globalThis as { window?: EventTarget }).window = win;
    (globalThis as { document?: object }).document = { pointerLockElement: null };
    const input = new InputManager(canvas as unknown as HTMLCanvasElement);
    input.virtualButtonConfigSet.push(new VirtualButtonConfig(
      new VirtualButtonBinding('Forward', VirtualButton.keyboard('W')),
      new VirtualButtonBinding('Forward', VirtualButton.gamePad('leftTrigger')),
      new VirtualButtonBinding('Fire', VirtualButton.mouse('left')),
    ));
    input.update();
    input.gamePads[0] = { buttons: 0, leftThumb: [0, 0], rightThumb: [0, 0], leftTrigger: 0.25, rightTrigger: 0 };
    expect(input.getVirtualButton(0, 'Forward')).toBe(0.25);
    win.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyW', repeat: false }));
    input.update();
    expect(input.getVirtualButton(0, 'Forward')).toBe(1);
    expect([input.getVirtualButton(0, 'Fire'), input.getVirtualButton(0, 'Back'), input.getVirtualButton(1, 'Forward')]).toEqual([0, 0, 0]);
    // 绝对位置按 CSS 像素算（画布显示成 200×100，后备缓冲 400×200，鼠标在中间）
    win.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 100, clientY: 50, movementX: 0, movementY: 0 }));
    input.update();
    expect(input.absoluteMousePosition).toEqual([100, 50]);
    input.destroy();
  });
});
