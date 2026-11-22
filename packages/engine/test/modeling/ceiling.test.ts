import { describe, expect, test } from 'vitest';
import type { CeilingFile } from '../../src/content/formats/ceilingFormat';
import { ceilingLights, ceilingModel } from '../../src/modeling/ceiling';

const open: CeilingFile = { name: 'Hall', size: [20, 14], height: 3.3, lights: { rows: 4, spacing: 2.2, length: 1.4, drop: 0.55 } };

describe('天花板', () => {
  test('灯：几排、每排按间距排满、开放式吊在楼板下 drop，格栅嵌在吊顶里', () => {
    const lights = ceilingLights(open);
    expect(lights).toHaveLength(4 * 9);
    expect(lights[0]!.center[1]).toBeCloseTo(3.3 - 0.55, 9);
    for (const light of lights) {
      expect(Math.abs(light.center[0]) + light.length / 2).toBeLessThanOrEqual(10);
      expect(Math.abs(light.center[2])).toBeLessThan(7);
    }
    const grid = ceilingLights({ ...open, style: 'grid' });
    expect(grid[0]!.center[1]).toBeCloseTo(3.3 - 0.01, 9);
    expect(grid[0]!.width).toBe(0.6);
  });

  test('开放式：楼板以下有管线和灯，灯发光；全在楼板以下、范围以内', () => {
    const model = ceilingModel(open);
    expect(model.emissive).toBeGreaterThan(0);
    let lowest = Infinity;
    for (let i = 0; i < model.vertices.length; i += 8) {
      lowest = Math.min(lowest, model.vertices[i + 1]!);
      expect(Math.abs(model.vertices[i]!)).toBeLessThanOrEqual(10 + 1e-6);
      expect(Math.abs(model.vertices[i + 2]!)).toBeLessThanOrEqual(7 + 1e-6);
    }
    // 最低的是灯管的底
    expect(lowest).toBeCloseTo(3.3 - 0.55 - 0.012, 6);
    expect(() => ceilingModel({ ...open, height: 0 })).toThrow(/height/);
  });
});
