import { describe, expect, test } from 'vitest';
import { WorldClock } from '../../src/world/WorldClock';

describe('世界时钟', () => {
  test('日历：第几天、时刻、一年里的第几天、第几年、星期；set 只改给的项', () => {
    const clock = new WorldClock();
    expect(clock.isSet).toBe(false);
    clock.set({ year: 2, dayOfYear: 172, hours: 6.5 });
    expect([clock.isSet, clock.year, clock.dayOfYear, clock.day, clock.weekday]).toEqual([true, 2, 172, 2 * 365 + 171, (2 * 365 + 171) % 7]);
    expect(clock.timeOfDay).toBeCloseTo(6.5, 9);
    clock.set({ hours: 20 });
    expect([clock.dayOfYear, clock.timeOfDay]).toEqual([172, 20]);
    // 停着（rate 0）不走；倍速 720 是两分钟一天
    clock.advance(10);
    expect(clock.timeOfDay).toBe(20);
    clock.set({ rate: 720 });
    clock.advance(30);
    expect(clock.timeOfDay).toBeCloseTo(26 - 24, 9);
    expect(clock.dayOfYear).toBe(173);
    expect(clock.state()).toEqual({ time: clock.time, rate: 720 });
  });

  test('定时：at 每天到点调一次（一帧走过几天也只调一次），after 调一次；取消的不调；拨钟以后每天的定时排到新时间之后', () => {
    const clock = new WorldClock();
    clock.set({ dayOfYear: 1, hours: 7, rate: 3600 });
    const calls: string[] = [];
    const open = clock.at(8, (c) => calls.push(`open d${c.dayOfYear} ${c.timeOfDay.toFixed(1)}`));
    clock.after(1800, () => calls.push('after'));
    const cancelled = clock.at(7.5, () => calls.push('cancelled'));
    cancelled[Symbol.dispose]();
    clock.advance(0.4);
    expect(calls).toEqual([]);
    clock.advance(0.7);
    expect(calls).toEqual(['after', 'open d1 8.1']);
    // 一帧走三天：8 点的定时只调一次，下一次排到之后的 8 点
    clock.advance(72);
    expect(calls.filter((call) => call.startsWith('open'))).toHaveLength(2);
    // 拨回当天 6 点：8 点的定时排到两小时以后
    clock.set({ hours: 6 });
    clock.advance(2.1);
    expect(calls.filter((call) => call.startsWith('open'))).toHaveLength(3);
    open[Symbol.dispose]();
    clock.advance(48);
    expect(calls.filter((call) => call.startsWith('open'))).toHaveLength(3);
  });
});
