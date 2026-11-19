/**
 * 放在 3D 里的 UI（不是全屏的 UIComponent）怎么摆进场景、指针怎么落到 UI 上（Stride 的 UIRenderFeature.UIElementState.Update
 * 和 UIRenderFeature.Picking）。
 *
 * UI 的虚拟坐标 (0, 0) 在左上角、y 向下；摆进场景时 UI 的中心在实体的位置，x 沿实体的 X 轴，y 向下变成沿 -Y，
 * 整个 UI 的大小是 Size（世界单位）。
 */
import type { Matrix4 } from '../mathematics/Matrix';

type Vec2 = readonly [number, number];

/** uiWorldMatrix 用到的 UIComponent 的属性。 */
export interface UIPlacement {
  readonly isBillboard: boolean;
  readonly isFixedSize: boolean;
  readonly size: { readonly x: number; readonly y: number };
}

/** Stride 的 UIComponent.FixedSizeVerticalUnit：固定大小的 UI 高度占画面高度的比例。 */
const FIXED_SIZE_VERTICAL_UNIT = 1;

/**
 * UI 的虚拟坐标 → 世界坐标的矩阵（列主序），写进 out。entityWorld 是 UI 实体的世界矩阵，cameraWorld、projection 是相机的
 * 世界矩阵和投影矩阵。IsBillboard 时 UI 转成正对相机（保留实体的缩放），IsFixedSize 时按到相机的距离放大，看起来大小不变。
 */
export function uiWorldMatrix(
  out: Matrix4, component: UIPlacement, virtualResolution: Vec2,
  entityWorld: Readonly<Matrix4>, cameraWorld: Readonly<Matrix4>, projection: Readonly<Matrix4>,
): Matrix4 {
  const m = out;
  m.set(entityWorld);
  if (component.isBillboard) {
    const sx = length(entityWorld, 0), sy = length(entityWorld, 4);
    const cx = length(cameraWorld, 0), cy = length(cameraWorld, 4);
    for (let i = 0; i < 3; i++) {
      m[i] = (cameraWorld[i]! / cx) * sx;
      m[4 + i] = (cameraWorld[4 + i]! / cy) * sy;
      m[8 + i] = cameraWorld[8 + i]!;
    }
  }
  if (component.isFixedSize) {
    // 到相机平面的距离乘上画面在这个距离的高度（投影矩阵的 [5] 是 1 / tan(fov / 2)）
    const fz = length(cameraWorld, 8);
    let distance = 0;
    for (let i = 0; i < 3; i++) distance += (-cameraWorld[8 + i]! / fz) * (m[12 + i]! - cameraWorld[12 + i]!);
    const scale = (2 / projection[5]!) * Math.abs(distance) * FIXED_SIZE_VERTICAL_UNIT;
    for (let i = 0; i < 11; i++) if (i % 4 !== 3) m[i]! *= scale;
  }
  // 一个虚拟单位是 Size / Resolution 个世界单位；UI 的 y 向下，变成世界的 -Y（Stride 绕 X 转半圈）
  const [vx, vy] = virtualResolution;
  const ux = component.size.x / vx, uy = -component.size.y / vy;
  for (let i = 0; i < 3; i++) {
    m[i]! *= ux;
    m[4 + i]! *= uy;
    m[8 + i]! *= -1;
  }
  // 虚拟坐标的原点在左上角：中心移到实体的位置
  for (let i = 0; i < 3; i++) m[12 + i]! -= (m[i]! * vx) / 2 + (m[4 + i]! * vy) / 2;
  return m;
}

/**
 * 一个虚拟单位在画面上大约多少真实像素（Stride 估计 RealVirtualResolutionRatio 的做法）：UI 中心沿 x、y 各走半个虚拟分辨率，
 * 投影到画面上量长度。transform 是 虚拟坐标 → 裁剪空间，target 是画面的像素大小。UI 中心在相机后面时是 undefined。
 */
export function projectedPixelRatio(transform: Readonly<Matrix4>, virtualResolution: Vec2, target: Vec2): [number, number] | undefined {
  const [vx, vy] = virtualResolution;
  const center = project(transform, vx / 2, vy / 2, target);
  const right = project(transform, vx, vy / 2, target);
  const down = project(transform, vx / 2, vy, target);
  if (!center || !right || !down) return undefined;
  return [Math.hypot(right[0] - center[0], right[1] - center[1]) / (vx / 2), Math.hypot(down[0] - center[0], down[1] - center[1]) / (vy / 2)];
}

/**
 * 画布里 0..1 的位置（y 向下）对着 UI 平面上的哪一点，返回虚拟坐标：相机过这个位置的射线和 UI 平面求交。射线和平面平行、
 * 或者交点在相机近平面后面时是 undefined。uiWorld 是 uiWorldMatrix 的结果，inverseViewProjection 是相机的。
 */
export function pointerToVirtual(position: Vec2, uiWorld: Readonly<Matrix4>, inverseViewProjection: Readonly<Matrix4>): [number, number] | undefined {
  const x = position[0] * 2 - 1, y = 1 - position[1] * 2;
  const near = unproject(inverseViewProjection, x, y, 0);
  const far = unproject(inverseViewProjection, x, y, 1);
  // near + t · (far - near) = origin + u · axisX + v · axisY，按克莱姆法则解 u、v、t
  const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const ax = [uiWorld[0]!, uiWorld[1]!, uiWorld[2]!], ay = [uiWorld[4]!, uiWorld[5]!, uiWorld[6]!];
  const r = [near[0] - uiWorld[12]!, near[1] - uiWorld[13]!, near[2] - uiWorld[14]!];
  const minusD = [-d[0]!, -d[1]!, -d[2]!];
  const det = determinant(ax, ay, minusD);
  if (Math.abs(det) < 1e-12) return undefined;
  const t = determinant(ax, ay, r) / det;
  if (t < 0) return undefined;
  return [determinant(r, ay, minusD) / det, determinant(ax, r, minusD) / det];
}

/** 列主序矩阵第 offset 起那一列（前三个分量）的长度。 */
function length(m: Readonly<Matrix4>, offset: number): number {
  return Math.hypot(m[offset]!, m[offset + 1]!, m[offset + 2]!);
}

/** 虚拟坐标投影到画面的真实像素；在相机后面时是 undefined。 */
function project(m: Readonly<Matrix4>, x: number, y: number, [tw, th]: Vec2): Vec2 | undefined {
  const w = m[3]! * x + m[7]! * y + m[15]!;
  if (!(w > 0)) return undefined;
  return [(((m[0]! * x + m[4]! * y + m[12]!) / w + 1) / 2) * tw, ((1 - (m[1]! * x + m[5]! * y + m[13]!) / w) / 2) * th];
}

function unproject(m: Readonly<Matrix4>, x: number, y: number, z: number): [number, number, number] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w, (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w];
}

/** 以 a、b、c 为列的 3x3 行列式。 */
function determinant(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  return a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - b[0]! * (a[1]! * c[2]! - a[2]! * c[1]!) + c[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);
}
