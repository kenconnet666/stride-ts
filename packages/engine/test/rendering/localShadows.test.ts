import { describe, expect, test } from 'vitest';
import { Matrix } from '../../src/data/Matrix';
import { createLocalLight, RenderView, type LocalShadowReceiver } from '../../src/rendering/RenderSystem';
import { LocalShadowViews, screenCoverage } from '../../src/rendering/lighting/LocalShadowViews';

const ATLAS = 4096, SIZE = 256;
const receiver = (): LocalShadowReceiver => ({ point: false, worldToShadow: new Float32Array(96), depthA: 0, depthB: 0, depthBias: 0, normalOffsetScale: 0, filterSize: 0 });
/** 图集里第 i 块（一排排下去）。 */
const rectangle = (i: number) => ({ x: 512 + i * SIZE, y: 1024, width: SIZE, height: SIZE });

describe('LocalShadowViews', () => {
  test('点光：六个面的顺序同着色器选面的规则（+Z、-Z、+X、-X、+Y、-Y），沿轴的点落在各自那块的正中，深度按轴向距离算', () => {
    const light = createLocalLight();
    light.position.set(1, 2, 3);
    light.radius = 5;
    const shadow = receiver();
    const views = new LocalShadowViews().collect(light, [0, 1, 2, 3, 4, 5].map(rectangle), ATLAS, shadow);
    expect(views).toHaveLength(6);
    expect(shadow.point).toBe(true);
    // 近平面 0.1、远平面是半径的两倍：深度 = A + B / 距离，近平面上是 0、远平面上是 1
    expect(shadow.depthA + shadow.depthB / 0.1).toBeCloseTo(0, 5);
    expect(shadow.depthA + shadow.depthB / 10).toBeCloseTo(1, 5);
    const axes = [[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as const;
    axes.forEach(([x, y, z], face) => {
      const [u, v, depth] = Matrix.transformPoint(shadow.worldToShadow.subarray(face * 16, face * 16 + 16), 1 + x * 2, 2 + y * 2, 3 + z * 2);
      expect(u * ATLAS).toBeCloseTo(rectangle(face).x + SIZE / 2, 2);
      expect(v * ATLAS).toBeCloseTo(rectangle(face).y + SIZE / 2, 2);
      expect(depth).toBeCloseTo(shadow.depthA + shadow.depthB / 2, 5);
      expect(views[face]!.viewport).toEqual(rectangle(face));
    });
    // 视场角比 90° 大一圈（四周多 8 像素）：正好在 45° 上的点落在离块的边 8 · 128 / 136 像素的地方
    const [u] = Matrix.transformPoint(shadow.worldToShadow.subarray(0, 16), 1 + 2, 2, 3 + 2);
    expect(Math.abs(u * ATLAS - (rectangle(0).x + SIZE / 2))).toBeCloseTo((SIZE / 2) * (128 / 136), 2);
  });

  test('聚光：一个视图，按光源的世界矩阵摆（照向本地 -Z），射程以内的点深度在 0..1', () => {
    const light = createLocalLight();
    light.spot = true;
    light.radius = 4;
    light.angleOuter = 60;
    // 光源在 (0, 3, 0)，绕 X 转 -90°：本地 -Z 朝下
    Matrix.compose(light.world, [0, 3, 0], [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], [1, 1, 1]);
    const shadow = receiver();
    const views = new LocalShadowViews().collect(light, [rectangle(0)], ATLAS, shadow);
    expect(views).toHaveLength(1);
    expect(shadow.point).toBe(false);
    const [u, v, depth] = Matrix.transformPoint(shadow.worldToShadow.subarray(0, 16), 0, 1, 0);
    expect(u * ATLAS).toBeCloseTo(rectangle(0).x + SIZE / 2, 2);
    expect(v * ATLAS).toBeCloseTo(rectangle(0).y + SIZE / 2, 2);
    expect(depth).toBeGreaterThan(0);
    expect(depth).toBeLessThan(1);
    // 外锥的边（离轴 30°）落在块的边上
    const [edge] = Matrix.transformPoint(shadow.worldToShadow.subarray(0, 16), 2 * Math.tan(Math.PI / 6), 1, 0);
    expect(Math.abs(edge * ATLAS - (rectangle(0).x + SIZE / 2))).toBeCloseTo(SIZE / 2, 2);
  });

  test('光源在画面上盖住多大：相机在球里时是整个画面的长边，离远了按投影的半径缩小', () => {
    const view = new RenderView();
    Matrix.lookAtRH(view.view, [0, 0, 10], [0, 0, 0], [0, 1, 0]);
    Matrix.perspectiveFovRH(view.projection, Math.PI / 2, 16 / 9, 0.1, 1000);
    view.width = 1280;
    view.height = 720;
    view.update();
    const light = createLocalLight();
    light.radius = 12;
    expect(screenCoverage(view, light)).toBe(1280);
    light.radius = 1;
    // 距离 10、半径 1、cot(fov / 2) = 1：1 / sqrt(99) · 1280
    expect(screenCoverage(view, light)).toBeCloseTo(1280 / Math.sqrt(99), 1);
  });
});
