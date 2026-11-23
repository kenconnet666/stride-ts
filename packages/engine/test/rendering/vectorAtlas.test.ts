import { describe, expect, test } from 'vitest';
import { svgShapes } from '../../src/modeling/svgShapes';
import { buildVectorAtlas, readVectorAtlas, VECTOR_MAGIC, VECTOR_SHAPE_WORDS } from '../../src/rendering/mesh/vectorAtlas';

/** 照着色器读数据：形状 s 的横带里、过点 (x, y) 的那条带的曲线，向 +X 数带符号的穿越次数。 */
function bandWinding(data: Uint32Array, s: number, x: number, y: number): number {
  const f = new Float32Array(data.buffer);
  const o = data[6]! + s * VECTOR_SHAPE_WORDS;
  const [sx, sy, ox, oy] = [f[o + 2]!, f[o + 3]!, f[o + 4]!, f[o + 5]!];
  const hBands = data[o + 8]!, vBands = data[o + 9]!;
  const band = Math.min(hBands - 1, Math.max(0, Math.floor(y * sy + oy)));
  expect(Math.min(vBands - 1, Math.max(0, Math.floor(x * sx + ox)))).toBeGreaterThanOrEqual(0);
  const bandBase = data[8]! + data[o + 7]!;
  const count = data[bandBase + band * 2]!, list = bandBase + data[bandBase + band * 2 + 1]!;
  const point = (i: number) => [f[data[7]! + i * 2]!, f[data[7]! + i * 2 + 1]!] as const;
  let total = 0;
  for (let k = 0; k < count; k++) {
    const p = data[list + k]!;
    const [x0, y0] = point(p), [cx, cy] = point(p + 1), [x1, y1] = point(p + 2);
    const a = y0 - 2 * cy + y1, b = 2 * (cy - y0), c = y0 - y;
    const roots = Math.abs(a) < 1e-9 ? (Math.abs(b) > 1e-9 ? [-c / b] : []) : (() => {
      const d = b * b - 4 * a * c;
      return d < 0 ? [] : [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)];
    })();
    for (const t of roots) {
      if (t < 0 || t >= 1) continue;
      const u = 1 - t;
      if (u * u * x0 + 2 * u * t * cx + t * t * x1 <= x) continue;
      total += Math.sign(2 * a * t + b);
    }
  }
  return total;
}

describe('矢量贴图的数据', () => {
  const svg = '<svg viewBox="0 0 128 128"><rect width="128" height="128" fill="#ffffff"/><circle cx="40" cy="40" r="20" fill="#ff0000"/><path d="M70 70h40v40h-40zM80 80L100 80L100 100L80 100Z" fill="#000" fill-rule="evenodd"/></svg>';
  const data = buildVectorAtlas(svgShapes(svg));

  test('头：魔数、尺寸、格子、各段的起点按顺序；字节读回来一样', () => {
    const f = new Float32Array(data.buffer);
    expect(data[0]).toBe(VECTOR_MAGIC);
    expect([f[2], f[3]]).toEqual([128, 128]);
    expect([data[4], data[5], data[9]]).toEqual([4, 4, 3]);
    expect(data[6]).toBeLessThan(data[7]!);
    expect(data[7]).toBeLessThan(data[8]!);
    expect(data[10]).toBeLessThan(data[11]!);
    expect(readVectorAtlas(new Uint8Array(data.buffer), 'test')).toEqual(data);
    expect(() => readVectorAtlas(new Uint8Array(64), 'test')).toThrow(/vector atlas/);
  });

  test('按带取曲线数出来的绕数和用全部曲线一样：圆里外、evenodd 框的洞', () => {
    expect(bandWinding(data, 1, 40, 40)).not.toBe(0);
    expect(bandWinding(data, 1, 40, 70)).toBe(0);
    expect(Math.abs(bandWinding(data, 2, 75, 90)) % 2).toBe(1);
    expect(Math.abs(bandWinding(data, 2, 90, 90)) % 2).toBe(0);
  });

  test('格子里按从前往后列出盖到它的形状', () => {
    const cell = (cx: number, cy: number) => {
      const head = data[10]! + (cy * data[4]! + cx) * 2, count = data[head]!, list = data[11]! + data[head + 1]!;
      return [...data.subarray(list, list + count)];
    };
    expect(cell(1, 1)).toEqual([1, 0]);
    expect(cell(3, 3)).toEqual([2, 0]);
    expect(cell(0, 3)).toEqual([0]);
  });
});
