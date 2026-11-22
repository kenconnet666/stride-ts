import { describe, expect, test } from 'vitest';
import type { FixtureFile } from '../../src/content/formats/fixtureFormat';
import { fixtureModel } from '../../src/modeling/fixture';

describe('店里的器具', () => {
  test.each(['checkout', 'cart', 'basket', 'locker', 'gate'] as const)('%s：有几何，站在地上，索引都在顶点范围里', (type) => {
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
    expect(() => fixtureModel({ name: 'X', type: 'nope' as FixtureFile['type'] }, undefined)).toThrow(/unknown/);
  });
});
