import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Game, Material, Matrix, Mesh, MeshRenderFeature, Model, Transform, transformSlot } from '../src/index';
import { VERTEX_FLOATS } from '../src/rendering/Mesh';

/** 交错顶点里第 v 个顶点从 offset 起的 size 个 float。 */
const attribute = (vertices: Float32Array, v: number, offset: number, size: number) => [...vertices.subarray(v * VERTEX_FLOATS + offset, v * VERTEX_FLOATS + offset + size)];

// 渲染里不碰 GPU 的部分：矩阵、程序化网格、按批提取。真正画出来在 Chrome 里看（apps/sandbox）。

describe('Matrix', () => {
  test('逆矩阵乘回来是单位矩阵', () => {
    const m = Matrix.identity();
    m.set([2, 0, 0, 0, 0, 0, 3, 0, 0, -1, 0, 0, 5, 6, 7, 1]);
    const inverse = new Float32Array(16);
    expect(Matrix.invert(inverse, m)).toBe(true);
    const product = Matrix.multiply(new Float32Array(16), m, inverse);
    [...product].forEach((v, i) => expect(v).toBeCloseTo(Matrix.identity()[i]!, 6));
    expect(Matrix.invert(inverse, new Float32Array(16))).toBe(false);
  });

  test('rotationOf 取旋转部分：去掉缩放和平移', () => {
    // 绕 Y 转 90°，缩放 2，平移 (5, 6, 7)
    const world = new Float32Array([0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 5, 6, 7, 1]);
    const padded = new Float32Array(32);
    padded.set(world, 16);
    expect([...Matrix.rotationOf(new Float32Array(16), padded, 16)]).toEqual([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
  });

  test('透视投影和 Stride 的 PerspectiveFovRH 一样：看向 -Z，近处深度 0、远处 1', () => {
    const p = Matrix.perspectiveFovRH(new Float32Array(16), Math.PI / 4, 16 / 9, 0.1, 1000);
    expect(Matrix.transformPoint(p, 0, 0, -0.1)[2]).toBeCloseTo(0, 6);
    expect(Matrix.transformPoint(p, 0, 0, -1000)[2]).toBeCloseTo(1, 6);
    // 视角上沿：y = z * tan(fov / 2) 落在裁剪空间的 y = 1
    expect(Matrix.transformPoint(p, 0, Math.tan(Math.PI / 8) * 10, -10)[1]).toBeCloseTo(1, 5);
  });
});

describe('Mesh', () => {
  test('立方体每个面 4 个顶点，三角形从外面看是逆时针（正面朝外）', () => {
    const cube = Mesh.cube(2);
    const { vertices, indices } = cube.data;
    expect([cube.vertexCount, indices.length]).toEqual([24, 36]);
    expect(cube.bounds).toEqual({ min: [-1, -1, -1], max: [1, 1, 1] });
    const at = (i: number) => attribute(vertices, i, 0, 3);
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [at(indices[t]!), at(indices[t + 1]!), at(indices[t + 2]!)];
      const e1 = b.map((v, k) => v - a[k]!), e2 = c.map((v, k) => v - a[k]!);
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = attribute(vertices, indices[t]!, 3, 3);
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });

  test('平面在 y = 0 上，法线朝 +Y，UV 铺满 0..1', () => {
    const plane = Mesh.plane(4, 2);
    expect(attribute(plane.data.vertices, 0, 3, 3)).toEqual([0, 1, 0]);
    expect(plane.bounds).toEqual({ min: [-2, 0, -1], max: [2, 0, 1] });
    expect([0, 1, 2, 3].map((v) => attribute(plane.data.vertices, v, 6, 2))).toEqual([[0, 1], [1, 1], [1, 0], [0, 0]]);
  });
});

describe('MeshRenderFeature', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  test('Extract 按（网格，材质）分批，记下实体的变换槽位', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    const cube = Mesh.cube();
    const [red, blue] = [new Material('red', { baseColor: [1, 0, 0] }), new Material('blue', { baseColor: [0, 0, 1] })];
    const reds = Array.from({ length: 3 }, () => game.entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: red.id })] }));
    const blues = Array.from({ length: 2 }, () => game.entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: blue.id })] }));
    game.entities.create({ components: [Model.with({ mesh: cube.id, material: red.id })] }); // 没有 Transform，不画

    const feature = new MeshRenderFeature();
    feature.extract({ game, time: game.updateTime });
    const summary = feature.batches.map((b) => ({ material: b.material.name, slots: [...b.slots.subarray(0, b.count)] }));
    expect(summary).toEqual([
      { material: 'red', slots: reds.map(transformSlot) },
      { material: 'blue', slots: blues.map(transformSlot) },
    ]);

    // 下一帧重新提取：批次复用，数量重新算
    blues[0]!.destroy();
    feature.extract({ game, time: game.updateTime });
    expect(feature.batches.map((b) => b.count)).toEqual([3, 1]);

    game.entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: 999 as never })] });
    expect(() => feature.extract({ game, time: game.updateTime })).toThrow('material 999, which does not exist');
  });
});
