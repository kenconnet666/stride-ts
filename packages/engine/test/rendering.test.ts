import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Camera, cameraProjectionMatrix, entityAtSlot, inRenderMask, RENDER_GROUP_ALL, coverSource, spotAngleAttenuation, DirectionalShadowCascades, spriteQuad, Fxaa, Game, gaussianOffsetsWeights, Instance, Instancing, Material, Matrix, Mesh, MeshRenderFeature, Model, RenderView, screenToWorldRaySegment, Transform, Vector3, transformSlot, worldToScreen,
  type DirectionalShadowSettings, type GraphicsDevice, type ShadowReceiver,
} from '../src/index';
import { VERTEX_FLOATS } from '../src/rendering/mesh/Mesh';

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

  test('相机的正交投影（Stride 的 OrthoRH）：看到 orthographicSize 高、按宽高比的宽；透视的同 PerspectiveFovRH', () => {
    const camera = { projection: 'orthographic', verticalFieldOfView: 45, orthographicSize: 21, nearClipPlane: 0.1, farClipPlane: 100 } as const;
    const ortho = cameraProjectionMatrix(new Float32Array(16), camera, 16 / 9);
    // 反向 Z（RenderView.reversedDepth）：近平面上的点深度 1，远平面上的 0
    expect(rounded(Matrix.transformPoint(ortho, (21 * 16) / 9 / 2, 10.5, -0.1))).toEqual([1, 1, 1]);
    expect(rounded(Matrix.transformPoint(ortho, 0, -10.5, -100))).toEqual([0, -1, 0]);
    const perspective = cameraProjectionMatrix(new Float32Array(16), { ...camera, projection: 'perspective' }, 16 / 9);
    expect([...perspective]).toEqual([...Matrix.perspectiveFovRH(new Float32Array(16), Math.PI / 4, 16 / 9, 0.1, 100, true)]);
    expect(Matrix.transformPoint(perspective, 0, 0, -0.1)[2]).toBeCloseTo(1, 5);
    expect(Matrix.transformPoint(perspective, 0, 0, -100)[2]).toBeCloseTo(0, 5);
  });

  test('聚光的角度衰减（Stride 的 LightSpot）：内锥的边上是 1，外锥的边上是 0；内外颠倒时按小的当内锥', () => {
    const [scale, offset] = spotAngleAttenuation(50, 90);
    const at = (degrees: number) => Math.min(Math.max(Math.cos((degrees * Math.PI) / 180) * scale + offset, 0), 1);
    expect(at(25)).toBeCloseTo(1, 6);
    expect(at(45)).toBeCloseTo(0, 6);
    expect(at(35)).toBeGreaterThan(0);
    expect(spotAngleAttenuation(90, 50)).toEqual([scale, offset]);
  });

  test.each([true, false])('视锥平面朝内（反向 Z：%s）：视野里的点在所有平面的正面，近平面后面、视野外的点在某个平面的背面', (reversed) => {
    const view = Object.assign(new RenderView(), { reversedDepth: reversed });
    Matrix.perspectiveFovRH(view.projection, Math.PI / 2, 1, 0.1, 100, reversed);
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

  test('worldToScreen（Stride 的 Vector3.Project）：按画面归一化的位置和深度，和 screenToWorldRaySegment 互为反过来；相机后面的点没有', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(4);
    game.graphicsDevice = { canvas: { width: 1600, height: 900 } } as GraphicsDevice;
    const camera = game.entities.create({
      components: [Transform.with({ position: [0, 0, 10] }), Camera.with({ verticalFieldOfView: 60, nearClipPlane: 1, farClipPlane: 100 })],
    });
    game.transforms.update();
    // 相机朝 -Z：正前方的点在画面中间，右上方的点在右上
    const center = worldToScreen(game, camera, { x: 0, y: 0, z: 0 })!;
    expect([center.x, center.y].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0.5, 0.5]);
    const upperRight = worldToScreen(game, camera, { x: 2, y: 1, z: 0 })!;
    expect(upperRight.x).toBeGreaterThan(0.5);
    expect(upperRight.y).toBeLessThan(0.5);
    expect(upperRight.z).toBeGreaterThan(0);
    expect(upperRight.z).toBeLessThan(1);
    // 反投影回去落在同一条射线上
    const { start, end } = screenToWorldRaySegment(game, camera, upperRight.x, upperRight.y);
    const t = (0 - start.z) / (end.z - start.z);
    expect([start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t].map((v) => Math.round(v * 1e4) / 1e4)).toEqual([2, 1]);
    expect(worldToScreen(game, camera, { x: 0, y: 0, z: 20 })).toBeUndefined();
  });

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

  test('模型实例化：Instance 按自己的变换画主实体（Instancing）的模型，和同网格同材质的物体合批；主实体自己不画，没有主实体的不画', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    const cube = Mesh.cube();
    const red = new Material('red', { baseColor: [1, 0, 0] });
    const master = game.entities.create({ components: [Transform, Instancing, Model.with({ mesh: cube.id, material: red.id })] });
    const plain = game.entities.create({ components: [Transform, Model.with({ mesh: cube.id, material: red.id })] });
    const instances = Array.from({ length: 2 }, () => game.entities.create({ components: [Transform, Instance.with({ master: master.id })] }));
    game.entities.create({ components: [Transform, Instance] });
    const feature = new MeshRenderFeature();
    feature.extract({ game, time: game.updateTime });
    expect(feature.batches.map((b) => [...b.slots.subarray(0, b.count)])).toEqual([[transformSlot(plain), ...instances.map(transformSlot)]]);
    master.destroy();
    feature.extract({ game, time: game.updateTime });
    expect(feature.batches.map((b) => b.count)).toEqual([1]);
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
    // 实例按变换槽位认；点选读回槽位以后用它换回实体
    expect(entities.map((entity) => entityAtSlot(game.entities, transformSlot(entity)))).toEqual(entities);
    expect(entityAtSlot(game.entities, 9999)).toBeUndefined();
    // 渲染组不同的也分开成批；视图的掩码里没有的组不画
    entities[3]!.require(Model).renderGroup = 4;
    feature.extract(context);
    expect(feature.batches.map((b) => [b.isShadowCaster, b.renderGroup, b.count])).toEqual([[true, 0, 2], [false, 0, 1], [true, 4, 1]]);
    expect([inRenderMask(RENDER_GROUP_ALL, 4), inRenderMask(0b10001, 4), inRenderMask(0b10001, 3), inRenderMask(0x80000000, 31), inRenderMask(0, 0)]).toEqual([true, true, false, true, false]);
    expect(new RenderView().cullingMask).toBe(RENDER_GROUP_ALL);
    entities[3]!.require(Model).renderGroup = 0;
    feature.extract(context);

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
    pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 50, blendCascades: true, lightAngle: 0.53,
  };
  const receiver = (): ShadowReceiver => ({
    cascadeCount: 0, worldToShadow: new Float32Array(64), splits: new Float32Array(4), rectangles: new Float32Array(16),
    depthBias: 0, normalOffsetScale: 0, filterSize: 0, penumbraTangent: 0, blendCascades: true, depthRangeAutomatic: true,
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

describe('后处理', () => {
  test('高斯模糊的权重同 Stride 的 GaussianUtil.Calculate1D：两边加起来是 1，相邻两个像素合成一次线性采样', () => {
    const taps = gaussianOffsetsWeights(9, 3.5);
    // 半径 9：中心加 (9 + 1) / 2 = 5 组
    expect(taps.length).toBe(6);
    expect(taps[0]![0]).toBe(0);
    expect(taps[0]![1] + 2 * taps.slice(1).reduce((sum, [, w]) => sum + w, 0)).toBeCloseTo(1, 6);
    // 第 1 组合并了像素 1 和 2，偏移落在它们之间，偏向权重大的 1
    expect(taps[1]![0]).toBeGreaterThan(1);
    expect(taps[1]![0]).toBeLessThan(1.5);
    // 半径是奇数时最后一组只有一个像素，偏移正好是半径
    expect(taps[5]![0]).toBe(9);
    // σ = 9 / 3.5：中心的未归一化权重 1，像素 1 的是 exp(-1 / (2σ²))
    const sigma = 9 / 3.5;
    const w1 = Math.exp(-1 / (2 * sigma * sigma)), w2 = Math.exp(-4 / (2 * sigma * sigma));
    expect(taps[1]![1] / taps[0]![1]).toBeCloseTo(w1 + w2, 6);
  });
});

describe('FXAA', () => {
  test('抖动和档位换成预设号（同 Stride 的 FXAAEffect）：默认 Low 第 3 档是 23，超出范围报错', () => {
    const fxaa = Object.assign(Object.create(Fxaa.prototype) as Fxaa, { dither: 'low', quality: 3 });
    expect(fxaa.preset).toBe(23);
    Object.assign(fxaa, { dither: 'medium', quality: 5 });
    expect(fxaa.preset).toBe(15);
    Object.assign(fxaa, { dither: 'none', quality: 9 });
    expect(fxaa.preset).toBe(39);
    Object.assign(fxaa, { dither: 'none', quality: 3 });
    expect(() => fxaa.preset).toThrow("FXAA quality must be 9..9 for dither 'none', got 3");
  });
});

describe('平面背景（Stride 的 Background Is2D）', () => {
  test('保持比例铺满视图：竖屏的视图裁掉横图的两边，横屏的视图裁掉竖图的上下', () => {
    expect(coverSource(1000, 500, 100, 100)).toEqual([0.25, 0, 0.5, 1]);
    expect(coverSource(500, 1000, 200, 100)).toEqual([0, 0.375, 1, 0.25]);
    expect(coverSource(640, 1136, 640, 1136)).toEqual([0, 0, 1, 1]);
  });
});

describe('精灵（Stride 的 SpriteRenderFeature）', () => {
  const round = (values: ArrayLike<number>) => Array.from(values, (v) => Math.round(v * 1e5) / 1e5 + 0);
  const shape = { pixelsPerUnit: 100, centerX: 0, centerY: 0, centerFromMiddle: false };

  test('宽高是贴图尺寸除以 pixelsPerUnit；center 在左上角时矩形往右下移半个', () => {
    const world = Matrix.identity();
    world[12] = 1;
    const out = new Float32Array(12);
    spriteQuad(out, 0, world, 0, undefined, 200, 100, shape);
    // 中心 = 位置 + (宽/2, -高/2)，X 边 2、Y 边 1
    expect(round(out)).toEqual([2, -0.5, 0, 1, 2, 0, 0, 0, 0, 1, 0, 0]);
    spriteQuad(out, 0, world, 0, undefined, 200, 100, { ...shape, centerFromMiddle: true });
    expect(round(out.subarray(0, 3))).toEqual([1, 0, 0]);
  });

  test('billboard 用相机的轴（去掉相机的缩放），长度是实体的缩放', () => {
    const world = Matrix.identity();
    world[0] = world[5] = 3;
    // 相机绕 Y 转了 90°（X 轴朝 -Z），并且放大了 2 倍
    const camera = new Float32Array([0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 5, 0, 0, 1]);
    const out = new Float32Array(12);
    spriteQuad(out, 0, world, 0, camera, 100, 100, { ...shape, centerFromMiddle: true });
    expect(round(out)).toEqual([0, 0, 0, 1, 0, 0, -3, 0, 0, 3, 0, 0]);
  });
});
