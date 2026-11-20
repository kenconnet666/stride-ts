import { describe, expect, test } from 'vitest';
import { EARTH_ATMOSPHERE, mediumDensity, sunTransmittance } from '../src/rendering/sky/Atmosphere';

describe('物理天空（Atmosphere）', () => {
  const ground: [number, number, number] = [0, EARTH_ATMOSPHERE.planetRadius + 0.001, 0];
  const toward = (elevationDegrees: number): [number, number, number] => {
    const e = (elevationDegrees * Math.PI) / 180;
    return [Math.cos(e), Math.sin(e), 0];
  };

  test('介质的密度：地面上都是 1（臭氧是 0.135），越高越稀，臭氧在 25 km 附近最浓', () => {
    const [rayleigh, mie, ozone] = mediumDensity(0, 100);
    expect([rayleigh, mie, ozone]).toEqual([1, 1, 0.135]);
    expect(mediumDensity(8, 100)[0]).toBeCloseTo(Math.exp(-1), 5);
    expect(mediumDensity(25, 100)[2]).toBeCloseTo(1, 5);
    expect(mediumDensity(10, 100)[2]).toBeLessThan(mediumDensity(25, 100)[2]);
    expect(mediumDensity(200, 100)[0]).toBeCloseTo(Math.exp(-12.5), 8);
  });

  test('太阳在天顶时的透射率：瑞利散射让蓝光少得多，接近解析的光学厚度（8 km 的标高）', () => {
    const [r, g, b] = sunTransmittance(EARTH_ATMOSPHERE, ground, [0, 1, 0], 200);
    // 光学厚度 ≈ 标高 · 系数（大气厚 100 km 远大于标高，截断可以忽略）
    const expected = (k: number, extra: number) => Math.exp(-(8 * k + extra));
    const mie = 1.2 * (EARTH_ATMOSPHERE.mieScattering + EARTH_ATMOSPHERE.mieAbsorption);
    expect(r).toBeCloseTo(expected(EARTH_ATMOSPHERE.rayleighScattering[0], mie), 1);
    expect(b).toBeCloseTo(expected(EARTH_ATMOSPHERE.rayleighScattering[2], mie), 1);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  test('太阳越低透射率越小、越红；落到地平线以下是 0', () => {
    const high = sunTransmittance(EARTH_ATMOSPHERE, ground, toward(60));
    const low = sunTransmittance(EARTH_ATMOSPHERE, ground, toward(5));
    for (let c = 0; c < 3; c++) expect(low[c]!).toBeLessThan(high[c]!);
    expect(low[0]! / low[2]!).toBeGreaterThan(high[0]! / high[2]!);
    expect(sunTransmittance(EARTH_ATMOSPHERE, ground, toward(-5))).toEqual([0, 0, 0]);
  });

  test('在大气层外朝外看：透射率是 1', () => {
    const outside: [number, number, number] = [0, EARTH_ATMOSPHERE.planetRadius + 200, 0];
    expect(sunTransmittance(EARTH_ATMOSPHERE, outside, [0, 1, 0])).toEqual([1, 1, 1]);
  });
});
