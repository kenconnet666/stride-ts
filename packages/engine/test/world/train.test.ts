import { describe, expect, test } from 'vitest';
import { trainSchedule, trainStateAt, type TrainScheduleOptions } from '../../src/world/Train';

// 1 公里的轨道，两站（200 米、800 米处），限速 20、加减速 1 米每秒²，开关门各 2 秒、停 20 秒
const line: TrainScheduleOptions = {
  length: 1000, closed: false, trainLength: 60, maxSpeed: 20, acceleration: 1, deceleration: 1, doorTime: 2, mode: 'pingpong',
  stops: [{ at: 800, dwell: 20, name: 'East' }, { at: 200, dwell: 20, name: 'West' }],
};

describe('列车的时刻表', () => {
  test('从第一站（按位置排）出发：停站时开门、等、关门，然后按梯形的速度曲线开到下一站', () => {
    const schedule = trainSchedule(line);
    expect(trainStateAt(schedule, 0)).toEqual({ distance: 200, speed: 0, stop: 0, station: 'West', doors: 0 });
    expect(trainStateAt(schedule, 1).doors).toBeCloseTo(0.5, 9);
    expect(trainStateAt(schedule, 10).doors).toBe(1);
    expect(trainStateAt(schedule, 19).doors).toBeCloseTo(0.5, 9);
    // 600 米：加速 20 秒（200 米）、匀速 10 秒（200 米）、减速 20 秒（200 米）
    const run = schedule.legs[1]!;
    expect(run.duration).toBeCloseTo(50, 9);
    expect(trainStateAt(schedule, 20 + 10)).toMatchObject({ distance: 250, speed: 10, stop: -1, doors: 0 });
    expect(trainStateAt(schedule, 20 + 25).distance).toBeCloseTo(500, 9);
    expect(trainStateAt(schedule, 20 + 50 + 1)).toMatchObject({ distance: 800, stop: 1, station: 'East' });
  });

  test('往返：到了另一头往回开（速度为负），一圈后回到起点；时刻是纯函数，重复', () => {
    const schedule = trainSchedule(line);
    expect(schedule.cycle).toBeCloseTo(2 * (20 + 50), 9);
    expect(trainStateAt(schedule, 70 + 20 + 10)).toMatchObject({ distance: 750, speed: -10 });
    expect(trainStateAt(schedule, 140 + 30)).toEqual(trainStateAt(schedule, 30));
  });

  test('距离短到加不到限速：加速到一半就减速；没有车站时在两头之间往返、不开门', () => {
    const short = trainSchedule({ ...line, stops: [{ at: 100, dwell: 0, name: '' }, { at: 150, dwell: 0, name: '' }] });
    // 50 米：加速 25 米、减速 25 米，峰值 √50
    expect((short.legs[1] as { peak: number }).peak).toBeCloseTo(Math.sqrt(50), 9);
    const none = trainSchedule({ ...line, stops: [] });
    expect(trainStateAt(none, 0)).toMatchObject({ distance: 30, doors: 0, stop: -1 });
    expect(Math.max(...Array.from({ length: 200 }, (_, i) => trainStateAt(none, i).distance))).toBeCloseTo(970, 6);
  });

  test('绕圈（首尾相连的轨道）：总往前开，过了终点从起点接着算；开放的轨道上按往返', () => {
    const loop = trainSchedule({ ...line, closed: true, mode: 'loop' });
    // 800 → 200：往前绕 400 米
    const back = loop.legs[3]!;
    expect(back.kind).toBe('run');
    const states = Array.from({ length: 400 }, (_, i) => trainStateAt(loop, 70 + 20 + i * 0.1));
    expect(states.every((state) => state.speed >= 0)).toBe(true);
    expect(states.some((state) => state.distance < 100)).toBe(true);
    expect(trainSchedule({ ...line, mode: 'loop' }).legs.filter((leg) => leg.kind === 'run').length).toBe(2);
  });
});
