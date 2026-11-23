import { describe, expect, test } from 'vitest';
import type { FixtureFile } from '../../src/content/formats/fixtureFormat';
import { fixtureModel, trackSpots } from '../../src/modeling/fixture';

describe('店里的器具', () => {
  test.each(['checkout', 'cart', 'basket', 'locker', 'gate', 'selfCheckout'] as const)('%s：有几何，站在地上，索引都在顶点范围里', (type) => {
    const model = fixtureModel({ name: type, type }, undefined);
    expect(model.indices.length).toBeGreaterThan(0);
    let lowest = Infinity, maxIndex = 0;
    for (let i = 0; i < model.vertices.length; i += 8) lowest = Math.min(lowest, model.vertices[i + 1]!);
    for (const index of model.indices) maxIndex = Math.max(maxIndex, index);
    expect(lowest).toBeGreaterThanOrEqual(-1e-6);
    expect(lowest).toBeLessThan(0.02);
    expect(maxIndex).toBeLessThan(model.vertices.length / 8);
  });

  test('收银台的号码灯箱、寄存柜的指示灯发光；寄存柜按列行变宽变高', () => {
    expect(fixtureModel({ name: 'C', type: 'checkout' }, undefined).emissive).toBeGreaterThan(0);
    const small: FixtureFile = { name: 'L', type: 'locker', columns: 2, rows: 2 }, big: FixtureFile = { ...small, columns: 6, rows: 4 };
    const width = (file: FixtureFile) => {
      const v = fixtureModel(file, undefined).vertices;
      let max = 0;
      for (let i = 0; i < v.length; i += 8) max = Math.max(max, Math.abs(v[i]!));
      return max;
    };
    expect(width(big)).toBeGreaterThan(width(small) * 2);
    expect(() => fixtureModel({ name: 'X', type: 'nope' as FixtureFile['type'] }, undefined)).toThrow(/X\.type: expected one of checkout/);
  });

  test('自助收银机：屏和指示灯发光，图集里有界面（蓝标题栏、绿按钮）和号码牌两格；购物袋架的挂臂往顾客那边伸', () => {
    const model = fixtureModel({ name: 'S', type: 'selfCheckout' }, undefined);
    expect(model.emissive).toBeGreaterThan(0);
    expect(model.colorSvg).toContain('fill="#1e64c8"');
    expect(model.colorSvg).toContain('fill="#2f9e44"');
    // 最前面的是挂臂的头、袋子（顾客在 +Z），比柜体（0.2）伸得更前
    let front = -Infinity;
    for (let i = 0; i < model.vertices.length; i += 8) if (model.vertices[i]! > 0.1) front = Math.max(front, model.vertices[i + 2]!);
    expect(front).toBeGreaterThan(0.2 - 0.1);
    expect(front).toBeLessThan(0.25);
  });

  test('轨道射灯：灯头等距排在轨道下面，往下、往正面斜着照，灯口发光', () => {
    const spots = trackSpots({ name: 'Track', type: 'track', length: 2.4, heads: 4, tilt: 30 });
    expect(spots).toHaveLength(4);
    expect(spots.map((spot) => +spot.position[0].toFixed(3))).toEqual([-0.9, -0.3, 0.3, 0.9]);
    for (const { position, direction } of spots) {
      expect(Math.hypot(...direction)).toBeCloseTo(1, 6);
      expect(direction[1]).toBeCloseTo(-Math.cos(Math.PI / 6), 6);
      expect(direction[2]).toBeGreaterThan(0);
      expect(position[1]).toBeLessThan(-0.1);
    }
    expect(fixtureModel({ name: 'Track', type: 'track' }, undefined).emissive).toBeGreaterThan(0);
  });
});
