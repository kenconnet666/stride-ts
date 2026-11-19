import { describe, expect, test } from 'vitest';
import { Matrix } from '../src/mathematics/Matrix';
import { pointerToVirtual, projectedPixelRatio, uiWorldMatrix } from '../src/ui/UIProjection';

const VIRTUAL = [1280, 720] as const;
const SIZE = { x: 12.8, y: 7.2, z: 1 };

/** 相机在 eye，看向原点，竖直视角 60 度，16:9。 */
function camera(eye: [number, number, number]) {
  const view = Matrix.lookAtRH(new Float32Array(16), eye, [0, 0, 0], [0, 1, 0]);
  const projection = Matrix.perspectiveFovRH(new Float32Array(16), Math.PI / 3, 16 / 9, 0.1, 100);
  const world = new Float32Array(16);
  Matrix.invert(world, view);
  const viewProjection = Matrix.multiply(new Float32Array(16), projection, view);
  const inverseViewProjection = new Float32Array(16);
  Matrix.invert(inverseViewProjection, viewProjection);
  return { world, projection, viewProjection, inverseViewProjection };
}

function place(entityWorld: Float32Array, options: { isBillboard?: boolean; isFixedSize?: boolean } = {}, eye: [number, number, number] = [0, 0, 10]) {
  const cam = camera(eye);
  const component = { isBillboard: options.isBillboard ?? false, isFixedSize: options.isFixedSize ?? false, size: SIZE };
  return { cam, ui: uiWorldMatrix(new Float32Array(16), component, VIRTUAL, entityWorld, cam.world, cam.projection) };
}

function close(actual: readonly number[], expected: readonly number[], digits = 4): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits));
}

describe('放在 3D 里的 UI（照 Stride 的 UIElementState.Update）', () => {
  test('虚拟坐标的左上角在 (-Size/2, Size/2)，中心在实体的位置，y 向下变成世界的 -Y', () => {
    const entity = Matrix.compose(new Float32Array(16), [1, 2, 3], [0, 0, 0, 1], [1, 1, 1]);
    const { ui } = place(entity);
    close(Matrix.transformPoint(ui, 0, 0, 0), [1 - 6.4, 2 + 3.6, 3]);
    close(Matrix.transformPoint(ui, 640, 360, 0), [1, 2, 3]);
    close(Matrix.transformPoint(ui, 1280, 720, 0), [1 + 6.4, 2 - 3.6, 3]);
  });

  test('实体的缩放、旋转乘在 UI 上', () => {
    // 绕 Y 转 90 度：UI 的 x 沿世界的 -Z
    const s = Math.SQRT1_2;
    const entity = Matrix.compose(new Float32Array(16), [0, 0, 0], [0, s, 0, s], [2, 1, 1]);
    const { ui } = place(entity);
    close(Matrix.transformPoint(ui, 1280, 360, 0), [0, 0, -12.8]);
  });

  test('IsBillboard：UI 的 x、y 轴换成相机的右、上，保留实体的缩放', () => {
    const s = Math.SQRT1_2;
    const entity = Matrix.compose(new Float32Array(16), [0, 0, 0], [0, s, 0, s], [2, 1, 1]);
    // 相机在 +X 上看向原点：右边是 -Z
    const { ui } = place(entity, { isBillboard: true }, [10, 0, 0]);
    close(Matrix.transformPoint(ui, 1280, 360, 0), [0, 0, -12.8]);
    close(Matrix.transformPoint(ui, 640, 0, 0), [0, 3.6, 0]);
  });

  test('IsFixedSize：Size 的高 1 是画面的高，和距离无关', () => {
    const fixed = { x: 0.5 * (16 / 9), y: 0.5, z: 1 };
    for (const distance of [5, 20]) {
      const cam = camera([0, 0, distance]);
      const ui = uiWorldMatrix(new Float32Array(16), { isBillboard: true, isFixedSize: true, size: fixed }, VIRTUAL, Matrix.identity(), cam.world, cam.projection);
      const transform = Matrix.multiply(new Float32Array(16), cam.viewProjection, ui);
      // 画面 1920x1080：UI 占一半高
      close(projectedPixelRatio(transform, VIRTUAL, [1920, 1080])!, [540 / 720, 540 / 720]);
    }
  });

  test('指针：相机过画布位置的射线和 UI 平面的交点，换成虚拟坐标', () => {
    const { cam, ui } = place(Matrix.identity());
    close(pointerToVirtual([0.5, 0.5], ui, cam.inverseViewProjection)!, [640, 360]);
    // 画面上 UI 的右上角
    const transform = Matrix.multiply(new Float32Array(16), cam.viewProjection, ui);
    const [x, y] = Matrix.transformPoint(transform, 1280, 0, 0);
    // 矩阵是 float32：误差在百分之一像素以内
    close(pointerToVirtual([(x + 1) / 2, (1 - y) / 2], ui, cam.inverseViewProjection)!, [1280, 0], 2);
  });

  test('指针：UI 在相机后面、或者射线和 UI 平行时对不到', () => {
    const behind = Matrix.compose(new Float32Array(16), [0, 0, 20], [0, 0, 0, 1], [1, 1, 1]);
    const back = place(behind);
    expect(pointerToVirtual([0.5, 0.5], back.ui, back.cam.inverseViewProjection)).toBeUndefined();
    const s = Math.SQRT1_2;
    const edgeOn = place(Matrix.compose(new Float32Array(16), [0, 0, 0], [0, s, 0, s], [1, 1, 1]));
    expect(pointerToVirtual([0.5, 0.5], edgeOn.ui, edgeOn.cam.inverseViewProjection)).toBeUndefined();
  });
});
