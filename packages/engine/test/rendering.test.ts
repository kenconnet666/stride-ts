import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  DirectionalShadowCascades, Game, Material, Matrix, Mesh, MeshRenderFeature, Model, RenderView, Transform, Vector3, transformSlot,
  type DirectionalShadowSettings, type ShadowReceiver,
} from '../src/index';
import { VERTEX_FLOATS } from '../src/rendering/Mesh';

/** 交错顶点里第 v 个顶点从 offset 起的 size 个 float。 */
const attribute = (vertices: Float32Array | Uint8Array, v: number, offset: number, size: number) => [...(vertices as Float32Array).subarray(v * VERTEX_FLOATS + offset, v * VERTEX_FLOATS + offset + size)];

/** 取 6 位小数，-0 变成 0：比较浮点结果用。 */
const rounded = (values: ArrayLike<number>) => Array.from(values, (v) => +v.toFixed(6) + 0);

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

  test('LookAtRH 把目标放到视图空间的 -Z 上，OrthoOffCenterRH 把盒子映射到裁剪空间，深度 0..1', () => {
    const view = Matrix.lookAtRH(new Float32Array(16), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
    expect(Matrix.transformPoint(view, 0, 0, 0)).toEqual([0, 0, -5]);
    expect(Matrix.transformPoint(view, 1, 0, 5)).toEqual([1, 0, 0]);
    const ortho = Matrix.orthoOffCenterRH(new Float32Array(16), -2, 4, -1, 3, 0, 10);
    expect(rounded(Matrix.transformPoint(ortho, -2, -1, 0))).toEqual([-1, -1, 0]);
    expect(rounded(Matrix.transformPoint(ortho, 4, 3, -10))).toEqual([1, 1, 1]);
  });

  test('视锥平面朝内：视野里的点在所有平面的正面，近平面后面、视野外的点在某个平面的背面', () => {
    const view = new RenderView();
    Matrix.perspectiveFovRH(view.projection, Math.PI / 2, 1, 0.1, 100);
    view.update();
    const side = (p: readonly number[]) => Array.from({ length: 6 }, (_, i) => {
      const plane = view.frustumPlanes.subarray(i * 4, i * 4 + 4);
      return plane[0]! * p[0]! + plane[1]! * p[1]! + plane[2]! * p[2]! + plane[3]!;
    });
    expect(side([0, 0, -10]).every((d) => d > 0)).toBe(true);
    expect(side([0, 0, 1])[4]).toBeLessThan(0); // 近平面
    expect(side([0, 0, -200])[5]).toBeLessThan(0); // 远平面
    expect(side([20, 0, -10])[1]).toBeLessThan(0); // 右边：90° 视角，x > |z| 在外面
    // 法线归一化：到左平面的距离按米算
    expect(side([0, 0, -10])[0]).toBeCloseTo(10 * Math.SQRT1_2, 4);
    // 近平面：看向 -Z，w 是近平面上一点在前方的投影
    expect(rounded(view.nearPlane)).toEqual([0, 0, -1, 0.1]);
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

  test('投不投阴影分成不同的批次；Cull 用网格的包围盒在原生模块里剔除，并量出主视图里可见物体的距离范围', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    const cube = Mesh.cube();
    const gray = new Material('gray', {});
    // 相机在原点看向 -Z：z = -5 和 -20 的看得见，z = +5 的在后面，x = 100 的在右边外面
    const at = [[0, 0, -5], [0, 0, -20], [0, 0, 5], [100, 0, -5]] as const;
    const entities = at.map((position, i) => game.entities.create({ components: [Transform.with({ position: [...position] }), Model.with({ mesh: cube.id, material: gray.id, isShadowCaster: i !== 1 })] }));
    game.transforms.update();

    const feature = new MeshRenderFeature();
    const context = { game, time: game.updateTime };
    feature.extract(context);
    expect(feature.batches.map((b) => [b.isShadowCaster, b.count])).toEqual([[true, 3], [false, 1]]);

    const view = new RenderView();
    Matrix.perspectiveFovRH(view.projection, Math.PI / 2, 1, 0.1, 100);
    view.update();
    const shadowView = Object.assign(new RenderView(), { ignoreDepthPlanes: true });
    Matrix.perspectiveFovRH(shadowView.projection, Math.PI / 2, 1, 0.1, 100);
    shadowView.update();
    feature.cull(context, [view]);
    feature.cull(context, [shadowView]);
    // 单位立方体半长 0.5：最近的那个前表面在 4.5 - 0.1（近平面）处，最远的后表面在 20.5 - 0.1
    expect(view.minimumDistance).toBeCloseTo(4.4, 5);
    expect(view.maximumDistance).toBeCloseTo(20.4, 5);
    // 阴影视图忽略近平面：相机后面的那个也算可见，但不量距离
    expect(shadowView.minimumDistance).toBe(Infinity);
    feature.destroy();
    for (const entity of entities) entity.destroy();
  });
});

describe('DirectionalShadowCascades', () => {
  const settings: DirectionalShadowSettings = {
    size: 'xlarge', filter: 'pcf5x5', cascadeCount: 4, depthBias: 0.0015, normalOffsetScale: 10, stabilization: 'projectionSnapping',
    pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 50, blendCascades: true,
  };
  const receiver = (): ShadowReceiver => ({
    atlas: undefined as never, cascadeCount: 0, worldToShadow: new Float32Array(64), splits: new Float32Array(4),
    depthBias: 0, normalOffsetScale: 0, filterSize: 0, blendCascades: true, depthRangeAutomatic: true,
  });
  const camera = () => {
    const view = new RenderView();
    Matrix.lookAtRH(view.view, [0, 4, 10], [0, 0, 0], [0, 1, 0]);
    Matrix.perspectiveFovRH(view.projection, Math.PI / 4, 16 / 9, 0.1, 1000);
    view.update();
    view.minimumDistance = 2;
    view.maximumDistance = 30;
    return view;
  };
  const rectangles = [{ x: 0, y: 0 }, { x: 2048, y: 0 }, { x: 0, y: 2048 }, { x: 2048, y: 2048 }];

  test('级联按对数和均匀分布的平均切分，深度范围按 1.1 / 2 倍的滞后调整，每个级联把视锥段映射进图集里自己的一块', () => {
    const cascades = new DirectionalShadowCascades();
    const shadow = receiver();
    const view = camera();
    cascades.collect(view, new Vector3(-0.3, -1, -0.2), settings, 2048, rectangles, 4096, shadow);
    expect(shadow.cascadeCount).toBe(4);
    // 最远距离从 2 起按 1.1 的幂长到不小于 30：2 · 1.1^29 ≈ 31.73；最近的是 max(30 - 1.1^k · 1, 0.1) 里的近平面
    const max = 2 * 1.1 ** 29;
    expect(shadow.splits[3]).toBeCloseTo(max, 3);
    const splits = [...shadow.splits];
    expect(splits).toEqual([...splits].sort((a, b) => a - b));
    // 第一个级联的视锥段中心（在相机前方 splits[0] / 2 附近）映射到图集左上角那一块里，深度在 0..1
    const forward = [0, -4, -10].map((v) => v / Math.hypot(4, 10));
    const d = shadow.splits[0]! / 2;
    const m = shadow.worldToShadow.subarray(0, 16);
    const [u, v, z] = Matrix.transformPoint(m, forward[0]! * d, 4 + forward[1]! * d, 10 + forward[2]! * d);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(0.5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.5);
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(1);
    // 投影对齐到阴影图的整像素
    const vp = cascades.views[0]!.viewProjection;
    expect(Math.abs(vp[12]! * 1024 - Math.round(vp[12]! * 1024))).toBeLessThan(1e-3);
    expect(cascades.views[0]!.viewport).toEqual({ x: 0, y: 0, width: 2048, height: 2048 });

    // 下一帧可见范围略小（不到一半）：深度范围不收缩
    view.maximumDistance = 20;
    cascades.collect(view, new Vector3(-0.3, -1, -0.2), settings, 2048, rectangles, 4096, shadow);
    expect(shadow.splits[3]).toBeCloseTo(max, 3);
    // 小到一半以下才收缩，按 2 的幂
    view.maximumDistance = 10;
    cascades.collect(view, new Vector3(-0.3, -1, -0.2), settings, 2048, rectangles, 4096, shadow);
    expect(shadow.splits[3]).toBeCloseTo(max / 2, 3);
  });

  test('手动深度范围从相机近平面算起；正交相机只用一个级联', () => {
    const cascades = new DirectionalShadowCascades();
    const shadow = receiver();
    const view = camera();
    cascades.collect(view, new Vector3(0, -1, 0), { ...settings, depthRange: 'manual', minDistance: 0, maxDistance: 40, pssmFactor: 1 }, 1024, rectangles, 4096, shadow);
    // pssmFactor 1 是均匀划分
    expect([...shadow.splits].map((s) => +s.toFixed(3))).toEqual([10.1, 20.1, 30.1, 40.1].map((s) => +s.toFixed(3)));
    Matrix.orthoOffCenterRH(view.projection, -10, 10, -10, 10, 0.1, 100);
    view.update();
    cascades.collect(view, new Vector3(0, -1, 0), settings, 1024, rectangles, 4096, shadow);
    expect(shadow.cascadeCount).toBe(1);
  });
});
