import { describe, expect, test } from 'vitest';
import type { SplatSource } from '../../src/content/splatFile';
import { splatProxyMesh } from '../../src/content/splatProxy';

/** 一堆泼溅：给的中心、统一的半轴长和不透明度。 */
function splats(centers: readonly number[][], scale: number, opacity = 1): SplatSource {
  return {
    count: centers.length,
    positions: Float32Array.from(centers.flat()),
    scales: new Float32Array(centers.length * 3).fill(scale),
    rotations: Float32Array.from(centers.flatMap(() => [0, 0, 0, 1])),
    colors: Float32Array.from(centers.flatMap(() => [0.5, 0.5, 0.5, opacity])),
  };
}

/** 网格的有向体积（外面逆时针时是正的）和包围盒。 */
function measure({ positions, indices }: { positions: Float32Array; indices: Uint32Array }) {
  let volume = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!].map((i) => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]) as [number[], number[], number[]];
    volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    for (const p of [a, b, c]) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  }
  return { volume, min, max };
}

/** 每条边正好被两个三角形用、方向相反：封闭、朝向一致。 */
function closed(indices: Uint32Array): boolean {
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) {
    const key = `${indices[t + e]},${indices[t + ((e + 1) % 3)]}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(',');
    if (count !== edges.get(`${b},${a}`)) return false;
  }
  return true;
}

/** 实心的球：半径 r 里按 step 排满泼溅。 */
function ball(r: number, step: number, at = [0, 0, 0]): number[][] {
  const out: number[][] = [];
  for (let x = -r; x <= r; x += step) for (let y = -r; y <= r; y += step) for (let z = -r; z <= r; z += step) {
    if (x * x + y * y + z * z <= r * r) out.push([at[0]! + x, at[1]! + y, at[2]! + z]);
  }
  return out;
}

describe('扫描的代理网格', () => {
  test('实心的一团抽出封闭、朝外的网格，大小对得上', () => {
    const mesh = splatProxyMesh(splats(ball(0.5, 0.03), 0.02), { cell: 0.05 });
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(closed(mesh.indices)).toBe(true);
    const { volume, min, max } = measure(mesh);
    // 球的体积 0.52，格子抽出来的差一点
    expect(volume).toBeGreaterThan(0.4);
    expect(volume).toBeLessThan(0.65);
    for (let k = 0; k < 3; k++) {
      expect(min[k]).toBeCloseTo(-0.5, 0);
      expect(max[k]).toBeCloseTo(0.5, 0);
    }
  });

  test('墙这种薄的、泼溅是扁的大片：撒点盖住整面，抽出来是一片封闭的板', () => {
    // 一面 2×2 米的墙：间隔 0.2 米的扁泼溅（面上 0.15 米、厚 1 厘米），比格子还稀
    const centers: number[][] = [];
    for (let x = -1; x <= 1.001; x += 0.2) for (let y = 0; y <= 2.001; y += 0.2) centers.push([x, y, 0]);
    const source = splats(centers, 0.15);
    for (let i = 0; i < source.count; i++) source.scales[i * 3 + 2] = 0.01;
    const mesh = splatProxyMesh(source, { cell: 0.1, density: 1 });
    expect(closed(mesh.indices)).toBe(true);
    const { min, max } = measure(mesh);
    expect(max[0]! - min[0]!).toBeGreaterThan(2);
    expect(max[1]! - min[1]!).toBeGreaterThan(2);
    expect(max[2]! - min[2]!).toBeLessThan(0.3);
  });

  test('飘着的零星几个、透明的不算', () => {
    const body = ball(0.5, 0.03);
    // 远处一个孤零零的小团（不到 8 格），一团透明的
    const lonely = ball(0.04, 0.02, [3, 0, 0]);
    const faint = splats(ball(0.3, 0.03, [0, 3, 0]), 0.02, 0.1);
    const source = splats([...body, ...lonely], 0.02);
    const merged: SplatSource = {
      count: source.count + faint.count,
      positions: Float32Array.from([...source.positions, ...faint.positions]),
      scales: Float32Array.from([...source.scales, ...faint.scales]),
      rotations: Float32Array.from([...source.rotations, ...faint.rotations]),
      colors: Float32Array.from([...source.colors, ...faint.colors]),
    };
    const { max } = measure(splatProxyMesh(merged, { cell: 0.05 }));
    expect(max[0]).toBeLessThan(1);
    expect(max[1]).toBeLessThan(1);
  });

  test('扫描太大时格子自动放大', () => {
    const mesh = splatProxyMesh(splats([[0, 0, 0], [0, 0, 0], [400, 400, 400], [400, 400, 400]], 0.01), { cell: 0.1, minIsland: 1, density: 1 });
    expect(mesh.cell).toBeGreaterThan(1);
  });

  test('没有不透明的泼溅时是空的', () => {
    expect(splatProxyMesh(splats([[0, 0, 0]], 0.1, 0.05)).indices.length).toBe(0);
  });
});
