import { describe, expect, test } from 'vitest';
import { decodeSplats, encodeSplats, type SplatSource } from '@stride-ts/engine/splats';
import { buildSplatLod, mergeIntoGrid, NODE_SPLATS, symmetricEigen } from '../src/splatLod.ts';

/** n 个泼溅撒在 size 米的立方体里（确定的伪随机），半轴 0.01 米、不透明度 0.8、颜色按 x。 */
function cloud(n: number, size: number): SplatSource {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const positions = new Float32Array(n * 3).map(() => random() * size);
  const colors = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) colors.set([positions[i * 3]! / size, 0.5, 0.5, 0.8], i * 4);
  return { count: n, positions, scales: new Float32Array(n * 3).fill(0.01), rotations: new Float32Array(n * 4).map((_, k) => (k % 4 === 3 ? 1 : 0)), colors };
}

describe('高斯泼溅的细节层次', () => {
  test('对称矩阵的特征分解：V Λ Vᵀ 还原原矩阵，V 是旋转', () => {
    const upper = [4, 1, 0.5, 3, -0.7, 2];
    const { axes, values } = symmetricEigen(upper);
    const full = [[4, 1, 0.5], [1, 3, -0.7], [0.5, -0.7, 2]];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += axes[r * 3 + k]! * values[k]! * axes[c * 3 + k]!;
        expect(sum).toBeCloseTo(full[r]![c]!, 8);
      }
    }
    const [a, b, c, d, e, f, g, h, i] = axes as [number, number, number, number, number, number, number, number, number];
    expect(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)).toBeCloseTo(1, 8);
  });

  test('一格里的两个高斯按矩匹配合成一个：均值按 α·面积加权、协方差含两者的分开、不透明度守恒质量', () => {
    const set = { count: 2, positions: new Float32Array([0.1, 0, 0, 0.3, 0, 0]), scales: new Float32Array([0.05, 0.05, 0.05, 0.05, 0.05, 0.05]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), colors: new Float32Array([1, 0, 0, 0.5, 0, 0, 1, 0.5]), sh: new Float32Array(0) };
    const merged = mergeIntoGrid([set], [0, -1, -1], 16, 0);
    expect(merged.count).toBe(1);
    expect(merged.positions[0]).toBeCloseTo(0.2, 6);
    // x 方向的方差 = 0.05² + 0.1²，其他两个方向 0.05²
    const scales = [...merged.scales].sort((p, q) => q - p);
    expect(scales[0]).toBeCloseTo(Math.hypot(0.05, 0.1), 5);
    expect(scales[1]).toBeCloseTo(0.05, 5);
    // 颜色平均；不透明度 = Σα·面积 / 合并后的面积（比 0.5 小：铺开了）
    expect(merged.colors[0]).toBeCloseTo(0.5, 6);
    expect(merged.colors[2]).toBeCloseTo(0.5, 6);
    const area = scales[0]! * scales[1]! * 2 + scales[1]! * scales[2]!;
    expect(merged.colors[3]).toBeCloseTo((2 * 0.5 * 3 * 0.05 ** 2) / area, 5);
  });

  test('建树：叶子是原样的泼溅（加起来是原来的个数），内部节点不超过 NODE_SPLATS 个，子节点排在父节点后面、粗的在前；编码后读回来一样', () => {
    const source = cloud(50_000, 10);
    const lod = buildSplatLod(source);
    const nodes = lod.nodes!;
    expect(nodes.length).toBeGreaterThan(8);
    const leaves = nodes.filter((node) => node.childCount === 0);
    expect(leaves.reduce((sum, node) => sum + node.count, 0)).toBe(source.count);
    expect(leaves.every((node) => node.detail === 0 && node.count <= NODE_SPLATS)).toBe(true);
    nodes.forEach((node, n) => {
      expect(node.count).toBeLessThanOrEqual(NODE_SPLATS);
      if (node.childCount > 0) expect(node.firstChild).toBeGreaterThan(n);
      if (node.childCount > 0) expect(node.detail).toBeGreaterThan(nodes[node.firstChild]!.detail);
      for (let k = 0; k < 3; k++) expect(node.max[k]).toBeGreaterThan(node.min[k]!);
    });
    expect(nodes[0]!.first).toBe(0);
    expect(lod.count).toBeGreaterThan(source.count);
    expect(lod.count).toBeLessThan(source.count * 1.3);
    // 根这一级（最粗）的颜色还是从左到右变红
    const root = nodes[0]!;
    let left = 0, right = 0;
    for (let i = root.first; i < root.first + root.count; i++) {
      if (lod.positions[i * 3]! < 5) left += lod.colors[i * 4]! - 0.5;
      else right += lod.colors[i * 4]! - 0.5;
    }
    expect(right).toBeGreaterThan(left);
    const bytes = encodeSplats(lod);
    const decoded = decodeSplats(bytes.buffer as ArrayBuffer, 'lod.splat');
    expect(decoded.count).toBe(lod.count);
    expect(decoded.nodes).toHaveLength(nodes.length);
    expect(decoded.nodes[3]!.firstChild).toBe(nodes[3]!.firstChild);
    expect(decoded.nodes[3]!.min[1]).toBeCloseTo(nodes[3]!.min[1], 5);
  });

  test('不多于一个节点的不建；没有节点的文件读成一个根节点', () => {
    const small = cloud(100, 1);
    expect(buildSplatLod(small)).toBe(small);
    const decoded = decodeSplats(encodeSplats(small).buffer as ArrayBuffer, 'small.splat');
    expect(decoded.nodes).toHaveLength(1);
    expect(decoded.nodes[0]).toMatchObject({ first: 0, count: 100, childCount: 0, detail: 0 });
    expect(decoded.nodes[0]!.min[0]).toBeLessThan(0);
  });
});
