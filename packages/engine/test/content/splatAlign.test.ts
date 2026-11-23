import { describe, expect, test } from 'vitest';
import type { SplatSource } from '../../src/content/splatFile';
import { alignSplats, concatSplats, rotationMatrix, shRotation, similarity, transformSplats } from '../../src/content/splatAlign';

/** 同渲染器的 shColor 的基（1..3 阶，15 个）。 */
function basis([x, y, z]: readonly number[]): number[] {
  const xx = x! * x!, yy = y! * y!, zz = z! * z!;
  return [
    -0.4886025 * y!, 0.4886025 * z!, -0.4886025 * x!,
    1.0925484 * x! * y!, -1.0925484 * y! * z!, 0.3153916 * (2 * zz - xx - yy), -1.0925484 * x! * z!, 0.5462742 * (xx - yy),
    -0.5900436 * y! * (3 * xx - yy), 2.8906114 * x! * y! * z!, -0.4570458 * y! * (4 * zz - xx - yy), 0.3731763 * z! * (2 * zz - 3 * xx - 3 * yy),
    -0.4570458 * x! * (4 * zz - xx - yy), 1.4453057 * z! * (xx - yy), -0.5900436 * x! * (xx - 3 * yy),
  ];
}

const turn = (axis: readonly number[], angle: number): [number, number, number, number] => {
  const l = Math.hypot(...axis), s = Math.sin(angle / 2);
  return [(axis[0]! / l) * s, (axis[1]! / l) * s, (axis[2]! / l) * s, Math.cos(angle / 2)];
};

/**
 * 一个房间样子的点云（确定的伪随机）：地面、两面墙，加几根柱子、几张桌子摆在不同的地方——ICP 要有起伏才对得准（全是平面时
 * 点能顺着平面滑，比例和平移会互相抵；真的扫描里东西多）。
 */
function room(n: number, seed = 5): SplatSource {
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pillars = [[-1.2, -0.8], [0.9, -1.3], [1.4, 0.9], [-0.3, 1.2]];
  const tables = [[0.2, 0.1, 0.8, 0.6], [-1.3, 0.6, 0.5, 0.9]];
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const kind = i % 5, u = random() * 4 - 2, v = random() * 2.5;
    let p: number[];
    if (kind === 0) p = [u, 0, random() * 4 - 2];
    else if (kind === 1) p = random() < 0.5 ? [u, v, -2] : [-2, v, u];
    else if (kind === 2 || kind === 3) {
      // 柱子：0.3 米见方，点在四个侧面上
      const [cx, cz] = pillars[Math.floor(random() * pillars.length)]!, side = Math.floor(random() * 4), along = random() * 0.3 - 0.15;
      p = [cx! + (side === 0 ? 0.15 : side === 1 ? -0.15 : along), random() * 2.5, cz! + (side === 2 ? 0.15 : side === 3 ? -0.15 : along)];
    } else {
      const [x, z, w, d] = tables[Math.floor(random() * tables.length)]!;
      p = [x! + random() * w!, 0.75, z! + random() * d!];
    }
    positions.set(p, i * 3);
  }
  return { count: n, positions, scales: new Float32Array(n * 3).fill(0.01), rotations: new Float32Array(n * 4).map((_, k) => (k % 4 === 3 ? 1 : 0)), colors: new Float32Array(n * 4).fill(0.9) };
}

describe('几段扫描的合并、对齐', () => {
  test('球谐跟着转：转过的系数在 d 方向的颜色等于原来的在 Rᵀd 方向的', () => {
    const q = turn([0.3, 1, -0.4], 1.1), r = rotationMatrix(q);
    const coefficients = Array.from({ length: 15 }, (_, k) => Math.sin(k * 1.7 + 0.3));
    const matrices = shRotation(r, 3);
    const rotated: number[] = [];
    let offset = 0;
    for (const m of matrices) {
      const size = Math.sqrt(m.length);
      for (let row = 0; row < size; row++) rotated.push(Array.from({ length: size }, (_, col) => m[row * size + col]! * coefficients[offset + col]!).reduce((a, b) => a + b, 0));
      offset += size;
    }
    for (const d of [[1, 0, 0], [0, 0.6, 0.8], [-0.48, 0.6, -0.64]]) {
      const back = [r[0]! * d[0]! + r[3]! * d[1]! + r[6]! * d[2]!, r[1]! * d[0]! + r[4]! * d[1]! + r[7]! * d[2]!, r[2]! * d[0]! + r[5]! * d[1]! + r[8]! * d[2]!];
      const after = basis(d).reduce((sum, y, k) => sum + y * rotated[k]!, 0), before = basis(back).reduce((sum, y, k) => sum + y * coefficients[k]!, 0);
      expect(after).toBeCloseTo(before, 4);
    }
  });

  test('变换：位置、半轴长按缩放，朝向乘上旋转；连接时球谐取最少的阶数', () => {
    const one: SplatSource = { count: 1, positions: Float32Array.of(1, 0, 0), scales: Float32Array.of(0.1, 0.2, 0.3), rotations: Float32Array.of(0, 0, 0, 1), colors: Float32Array.of(1, 1, 1, 1), shBands: 1, sh: new Float32Array(9) };
    const moved = transformSplats(one, { position: [0, 1, 0], rotation: turn([0, 1, 0], Math.PI / 2), scale: 2 });
    expect(Array.from(moved.positions).map((v) => Math.round(v * 1e5) / 1e5)).toEqual([0, 1, -2]);
    expect(Array.from(moved.scales)).toEqual([0.2, 0.4, 0.6].map((v) => Math.fround(v)));
    expect(moved.rotations[1]).toBeCloseTo(Math.SQRT1_2, 5);
    const joined = concatSplats([one, { ...one, shBands: 0, sh: undefined } as unknown as SplatSource]);
    expect(joined.count).toBe(2);
    expect(joined.sh).toBeUndefined();
  });

  test('点对的相似变换：还原出旋转、缩放、平移', () => {
    const truth = { position: [0.4, -0.2, 1.5] as const, rotation: turn([1, 2, 0.5], 0.7), scale: 1.3 };
    const r = rotationMatrix(truth.rotation), from: number[] = [], to: number[] = [];
    for (let i = 0; i < 50; i++) {
      const p = [Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7) * 2];
      from.push(...p);
      to.push(...[0, 1, 2].map((k) => truth.scale * (r[k * 3]! * p[0]! + r[k * 3 + 1]! * p[1]! + r[k * 3 + 2]! * p[2]!) + truth.position[k]!));
    }
    const found = similarity(from, to);
    expect(found.scale).toBeCloseTo(1.3, 5);
    found.position.forEach((v, k) => expect(v).toBeCloseTo(truth.position[k]!, 4));
    found.rotation.forEach((v, k) => expect(v).toBeCloseTo(truth.rotation[k]!, 4));
  });

  test('ICP：同一个房间扫了两段（各扫到一部分、比例不同），从摆得差一点的位置对准', () => {
    const target = room(30000, 5), scan = room(30000, 9);
    // 第二段只扫到 x > -1 的部分，比例小了 10%，转了 12°、挪了 0.3 米：它自己的坐标是真实的逆变换
    const truth = { position: [0.3, 0.05, -0.2] as const, rotation: turn([0, 1, 0.1], 0.21), scale: 0.9 };
    const kept = Array.from({ length: scan.count }, (_, i) => i).filter((i) => scan.positions[i * 3]! > -1);
    const partial: SplatSource = { ...scan, count: kept.length, positions: Float32Array.from(kept.flatMap((i) => [scan.positions[i * 3]!, scan.positions[i * 3 + 1]!, scan.positions[i * 3 + 2]!])), colors: new Float32Array(kept.length * 4).fill(0.9), scales: new Float32Array(kept.length * 3).fill(0.01), rotations: new Float32Array(kept.length * 4).map((_, k) => (k % 4 === 3 ? 1 : 0)) };
    // 真实的变换是 truth：把 partial 摆到房间里；partial 自己的坐标 = truth 的逆作用在房间的点上
    const inverseScale = 1 / truth.scale, back = [-truth.rotation[0], -truth.rotation[1], -truth.rotation[2], truth.rotation[3]] as const;
    const local = transformSplats({ ...partial, positions: Float32Array.from(Array.from(partial.positions, (v, i) => v - truth.position[i % 3]!)) }, { position: [0, 0, 0], rotation: back, scale: inverseScale });
    // 手摆的初值：差 5°、0.1 米、比例 5%
    const start = { position: [0.4, 0.05, -0.15] as const, rotation: turn([0, 1, 0.1], 0.13), scale: 0.95 };
    const { transform, matched, error } = alignSplats(target, local, start, { maxDistance: 0.5, minDistance: 0.02, samples: 4000 });
    expect(matched).toBeGreaterThan(500);
    expect(error).toBeLessThan(0.03);
    // 两段是各自随机撒的点（没有一一对应），点到点的 ICP 有采样带来的一点偏差；比例和平移是连着的（比例差一点，原点就挪），
    // 所以比的是这一段的点按找到的、真实的变换各放到哪，平均差不到 3 厘米
    expect(Math.abs(transform.scale - truth.scale)).toBeLessThan(0.02);
    const found = transformSplats(local, transform), real = transformSplats(local, truth);
    let sum = 0;
    for (let i = 0; i < local.count; i++) sum += Math.hypot(...[0, 1, 2].map((k) => found.positions[i * 3 + k]! - real.positions[i * 3 + k]!));
    expect(sum / local.count).toBeLessThan(0.03);
  });
});
