import { describe, expect, test } from 'vitest';
import { GestureCollection, Gestures, type GestureEvent } from '../../src/input/gestures';
import type { PointerEvent } from '../../src/input/InputManager';

const pointer = (eventType: PointerEvent['eventType'], x: number, y: number, pointerId = 1): PointerEvent =>
  ({ pointerId, device: 'touch', eventType, position: [x, y], deltaPosition: [0, 0], isDown: eventType === 'pressed' || eventType === 'moved' });
const down = (x: number, y: number, id = 1) => pointer('pressed', x, y, id);
const move = (x: number, y: number, id = 1) => pointer('moved', x, y, id);
const up = (x: number, y: number, id = 1) => pointer('released', x, y, id);

/** 一种手势，按帧喂事件（每帧 dt 秒），收集识别到的手势事件。 */
function recognize(config: Parameters<GestureCollection['add']>[0], frames: readonly (readonly PointerEvent[])[], dt = 1 / 60, screenRatio = 1): GestureEvent[] {
  const gestures = new GestureCollection();
  gestures.add(config);
  return frames.flatMap((events) => gestures.process(dt, events, screenRatio));
}
const idle = (count: number): PointerEvent[][] => Array.from({ length: count }, () => []);

describe('手势识别（照 Stride 的 GestureRecognizer）', () => {
  test('点：按下很快抬起，过了"两次点的间隔"才报；按久了不算', () => {
    const tap = recognize(Gestures.tap(), [[down(0.3, 0.4)], [up(0.3, 0.4)], ...idle(30)]);
    expect(tap).toHaveLength(1);
    expect(tap[0]).toMatchObject({ type: 'tap', state: 'occurred', numberOfTaps: 1, numberOfFingers: 1 });
    expect((tap[0] as Extract<GestureEvent, { type: 'tap' }>).tapPosition).toEqual([expect.closeTo(0.3, 5), expect.closeTo(0.4, 5)]);
    // 按了 0.2 秒（超过 maximumPressTime 0.1）
    expect(recognize(Gestures.tap(), [[down(0.3, 0.4)], ...idle(12), [up(0.3, 0.4)], ...idle(30)])).toEqual([]);
  });

  test('双击要点两下、位置离得近；只点一下不报', () => {
    const config = Gestures.tap({ requiredNumberOfTaps: 2 });
    const twice = recognize(config, [[down(0.5, 0.5)], [up(0.5, 0.5)], ...idle(6), [down(0.51, 0.5)], [up(0.51, 0.5)], ...idle(30)]);
    expect(twice.map((e) => [e.type, (e as { numberOfTaps: number }).numberOfTaps])).toEqual([['tap', 2]]);
    expect(recognize(config, [[down(0.5, 0.5)], [up(0.5, 0.5)], ...idle(40)])).toEqual([]);
    // 第二下离得远：算新的一组
    expect(recognize(config, [[down(0.5, 0.5)], [up(0.5, 0.5)], ...idle(6), [down(0.8, 0.5)], [up(0.8, 0.5)], ...idle(30)])).toEqual([]);
  });

  test('长按：按住 0.75 秒报一次；中途挪远了或者抬起就不报', () => {
    const held = recognize(Gestures.longPress(), [[down(0.2, 0.6)], ...idle(50)]);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ type: 'longPress', state: 'occurred' });
    expect(held[0]!.totalTime).toBeGreaterThanOrEqual(0.75);
    expect(recognize(Gestures.longPress(), [[down(0.2, 0.6)], ...idle(20), [move(0.3, 0.6)], ...idle(40)])).toEqual([]);
    expect(recognize(Gestures.longPress(), [[down(0.2, 0.6)], ...idle(20), [up(0.2, 0.6)], ...idle(40)])).toEqual([]);
  });

  test('拖动：拖过最小距离才开始，之后每次移动报 changed，抬起报 ended；位移是归一化的', () => {
    const events = recognize(Gestures.drag(), [[down(0.5, 0.5)], [move(0.505, 0.5)], [move(0.54, 0.5)], [move(0.6, 0.52)], [up(0.6, 0.52)]]);
    expect(events.map((e) => e.state)).toEqual(['began', 'changed', 'changed', 'ended']);
    const last = events.at(-1) as Extract<GestureEvent, { type: 'drag' }>;
    expect(last.startPosition).toEqual([0.5, 0.5]);
    expect(last.totalTranslation[0]).toBeCloseTo(0.1, 5);
    expect(last.totalTranslation[1]).toBeCloseTo(0.02, 5);
    const began = events[0] as Extract<GestureEvent, { type: 'drag' }>;
    expect(began.totalTranslation[0]).toBeCloseTo(0.04, 5);
  });

  test('横向的拖动：竖着偏出容许的范围就结束', () => {
    const events = recognize(Gestures.drag('horizontal'), [[down(0.5, 0.5)], [move(0.56, 0.5)], [move(0.6, 0.6)], [move(0.7, 0.6)]]);
    expect(events.map((e) => e.state)).toEqual(['began', 'changed', 'ended']);
  });

  test('宽屏上量距离按长边的尺度：竖着拖同样的归一化距离，实际只有横着的一半（宽高比 2）', () => {
    const config = Gestures.drag('free', { minimumDragDistance: 0.03 });
    expect(recognize(config, [[down(0.5, 0.5)], [move(0.54, 0.5)]], 1 / 60, 2).map((e) => e.state)).toEqual(['began', 'changed']);
    expect(recognize(config, [[down(0.5, 0.5)], [move(0.5, 0.54)]], 1 / 60, 2)).toEqual([]);
    const tall = recognize(config, [[down(0.5, 0.5)], [move(0.5, 0.58)]], 1 / 60, 2) as Extract<GestureEvent, { type: 'drag' }>[];
    expect(tall[0]!.totalTranslation[1]).toBeCloseTo(0.08, 5);
  });

  test('轻扫：够远、够快才报一次', () => {
    const fast = recognize(Gestures.flick(), [[down(0.2, 0.5)], [move(0.25, 0.5)], [move(0.32, 0.5)]]);
    expect(fast.map((e) => [e.type, e.state])).toEqual([['flick', 'occurred']]);
    // 同样的距离走了一秒多：平均速度不到 0.4
    expect(recognize(Gestures.flick(), [[down(0.2, 0.5)], ...idle(70), [move(0.32, 0.5)]])).toEqual([]);
  });

  test('组合：两指张开报缩放，转动报旋转，一起挪报平移；抬起一指结束', () => {
    const pinch = recognize(Gestures.composite(), [[down(0.4, 0.5, 1)], [down(0.6, 0.5, 2)], [move(0.3, 0.5, 1), move(0.7, 0.5, 2)], [up(0.7, 0.5, 2)]]);
    expect(pinch.map((e) => e.state)).toEqual(['began', 'changed', 'ended']);
    const scaled = pinch[0] as Extract<GestureEvent, { type: 'composite' }>;
    expect(scaled.totalScale).toBeCloseTo(2, 5);
    expect(scaled.totalRotation).toBeCloseTo(0, 5);
    const turn = recognize(Gestures.composite(), [[down(0.4, 0.5, 1)], [down(0.6, 0.5, 2)], [move(0.5, 0.4, 1), move(0.5, 0.6, 2)]]) as Extract<GestureEvent, { type: 'composite' }>[];
    expect(Math.abs(turn[0]!.totalRotation)).toBeCloseTo(Math.PI / 2, 5);
    expect(turn[0]!.totalScale).toBeCloseTo(1, 5);
    const pan = recognize(Gestures.composite(), [[down(0.4, 0.5, 1)], [down(0.6, 0.5, 2)], [move(0.45, 0.6, 1), move(0.65, 0.6, 2)]]) as Extract<GestureEvent, { type: 'composite' }>[];
    expect(pan[0]!.totalTranslation).toEqual([expect.closeTo(0.05, 5), expect.closeTo(0.1, 5)]);
  });

  test('配置：默认值同 Stride，不合法的值报错；集合里同一个配置只算一次，移除后不再识别', () => {
    expect(Gestures.tap()).toEqual({ type: 'tap', requiredNumberOfFingers: 1, requiredNumberOfTaps: 1, maximumTimeBetweenTaps: 0.4, maximumPressTime: 0.1, maximumDistanceTaps: 0.04 });
    expect(Gestures.composite().requiredNumberOfFingers).toBe(2);
    expect(() => Gestures.tap({ requiredNumberOfTaps: 0 })).toThrow();
    expect(() => Gestures.composite({ minimumScaleValue: 1 })).toThrow();
    const gestures = new GestureCollection();
    const drag = gestures.add(Gestures.drag());
    gestures.add(drag);
    expect(gestures.size).toBe(1);
    expect(gestures.remove(drag)).toBe(true);
    expect(gestures.process(1 / 60, [down(0.5, 0.5)], 1)).toEqual([]);
  });
});
