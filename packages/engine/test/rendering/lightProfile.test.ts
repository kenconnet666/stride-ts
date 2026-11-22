import { describe, expect, test } from 'vitest';
import { HORIZONTAL_SAMPLES, VERTICAL_SAMPLES, parseIes } from '../../src/rendering/lighting/LightProfile';

/** 一个绕轴对称的筒灯：正下方最亮，60° 以外没光。 */
const DOWNLIGHT = `IESNA:LM-63-2002
[TEST] stride-ts
[MANUFAC] test
TILT=NONE
1 1000 2 5 1 1 2 0.1 0.1 0
1 1 10
0 30 60 90 180
0
500 400, 100
0 0
`;

/** 只量了 0..90° 的水平角（四个象限对称）：0° 方向亮、90° 方向暗。 */
const QUADRANT = `IESNA:LM-63-1995
TILT=INCLUDE
1
2
0 90
1 1
1 1000 1 3 2 1 2 0 0 0
1 1 10
0 45 90
0 90
100 50 0
20 10 0
`;

describe('配光曲线（IES）', () => {
  test('绕轴对称的筒灯：水平 1 格，垂直按角度插值、归一到最大值', () => {
    const table = parseIes(DOWNLIGHT, 'downlight');
    expect(table.horizontal).toBe(1);
    expect(table.vertical).toBe(VERTICAL_SAMPLES);
    // 倍数 2：最大 1000 坎德拉
    expect(table.maxCandela).toBe(1000);
    const at = (degrees: number) => table.values[Math.round((degrees / 180) * (VERTICAL_SAMPLES - 1))]!;
    expect(at(0)).toBeCloseTo(1, 5);
    expect(at(30)).toBeCloseTo(0.8, 1);
    expect(at(60)).toBeCloseTo(0.2, 1);
    expect(at(120)).toBe(0);
  });

  test('四象限对称的灯按 0..90° 展开成一圈；TILT=INCLUDE 的倾斜数据跳过', () => {
    const table = parseIes(QUADRANT, 'quadrant');
    expect(table.horizontal).toBe(HORIZONTAL_SAMPLES);
    const at = (phi: number) => table.values[Math.round((phi / 360) * HORIZONTAL_SAMPLES) * VERTICAL_SAMPLES]!;
    // 正下方 0° 和 180° 是 100（最亮），90° 和 270° 是 20
    expect(at(0)).toBeCloseTo(1, 5);
    expect(at(180)).toBeCloseTo(1, 5);
    expect(at(90)).toBeCloseTo(0.2, 5);
    expect(at(270)).toBeCloseTo(0.2, 5);
  });

  test('不是 IES、不是 C 型配光时报错', () => {
    expect(() => parseIes('hello', 'x')).toThrow(/no TILT=/);
    expect(() => parseIes(DOWNLIGHT.replace('1 1000 2 5 1 1 2', '1 1000 2 5 1 2 2'), 'b')).toThrow(/only type C/);
  });
});
