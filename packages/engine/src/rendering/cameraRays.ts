/**
 * 相机的投影矩阵，屏幕坐标和世界坐标互换（Stride 的 CameraComponentExtensions）。相机的矩阵按这一帧的世界矩阵和
 * Camera 组件算，宽高比用画布的（同前向渲染器的主画面）。
 */
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';
import { Matrix } from '../data/Matrix';
import { Vector3 } from '../data/vectors';
import { Camera } from './components';

/** Camera 组件里定投影的那几项。 */
export interface CameraProjection {
  readonly projection: 'perspective' | 'orthographic';
  readonly verticalFieldOfView: number;
  readonly orthographicSize: number;
  readonly nearClipPlane: number;
  readonly farClipPlane: number;
  /** 物理相机：竖直视角按焦距和传感器的高算。 */
  readonly physical?: boolean;
  readonly sensorHeight?: number;
  readonly focalLength?: number;
  /** 画幅（宽 / 高）：大于 0 时画面框成这个宽高比，多出来的是黑边（见 cameraGate）；0 或没有是整个画布。 */
  readonly aspectRatio?: number;
}

/**
 * 画幅在画布里的位置（uv：左、上、右、下）：画幅比画布宽时上下留黑边（视角是画幅的，画布的竖直视角相应加大），比画布窄时
 * 左右留黑边。没有画幅时是整个画布。
 */
export function cameraGate(gate: number, canvasAspect: number): [number, number, number, number] {
  if (!(gate > 0)) return [0, 0, 1, 1];
  if (gate > canvasAspect) {
    const bar = (1 - canvasAspect / gate) / 2;
    return [0, bar, 1, 1 - bar];
  }
  const bar = (1 - gate / canvasAspect) / 2;
  return [bar, 0, 1 - bar, 1];
}

/** 相机的竖直视角（度）：物理相机按焦距和传感器的高（2·atan(高 / 2·焦距)），否则是 verticalFieldOfView。 */
export function cameraVerticalFieldOfView(camera: CameraProjection): number {
  if (!camera.physical || !camera.sensorHeight || !camera.focalLength) return camera.verticalFieldOfView;
  return (2 * Math.atan(camera.sensorHeight / (2 * camera.focalLength)) * 180) / Math.PI;
}

/** 相机的投影矩阵（Stride 的 CameraComponent.Update）：透视按竖直视角，正交看到 orthographicSize 高、按宽高比的宽。 */
export function cameraProjectionMatrix(out: Float32Array, camera: CameraProjection, aspectRatio: number): Float32Array {
  const { nearClipPlane: near, farClipPlane: far } = camera;
  // 画幅比画布宽（上下黑边）：画幅的视角不变，画布的竖直方向按比例多看一些
  const gate = camera.aspectRatio ?? 0;
  const stretch = gate > aspectRatio ? gate / aspectRatio : 1;
  return camera.projection === 'orthographic'
    ? Matrix.orthoRH(out, aspectRatio * camera.orthographicSize * stretch, camera.orthographicSize * stretch, near, far)
    : Matrix.perspectiveFovRH(out, 2 * Math.atan(Math.tan((cameraVerticalFieldOfView(camera) * Math.PI) / 360) * stretch), aspectRatio, near, far);
}

/**
 * 屏幕上的点（按画面归一化：0..1，y 向下，同 Stride 的 PointerEvent.Position）在近平面和远平面上的两个世界坐标点
 * （Stride 的 ScreenToWorldRaySegment）。射线从 start 指向 end，长度就是可见范围。
 */
export function screenToWorldRaySegment(game: Game, camera: Entity, screenX: number, screenY: number): { start: Vector3; end: Vector3 } {
  const inverse = Matrix.identity();
  Matrix.invert(inverse, viewProjectionMatrix(game, camera));
  // 规范化设备坐标：x、y 是 -1..1（y 向上），深度 0 是近平面、1 是远平面
  const x = screenX * 2 - 1, y = 1 - screenY * 2;
  return { start: new Vector3(...Matrix.transformPoint(inverse, x, y, 0)), end: new Vector3(...Matrix.transformPoint(inverse, x, y, 1)) };
}

/**
 * 世界里的点落在画面的哪里（Stride 的 Vector3.Project、Viewport.Project）：x、y 按画面归一化（0..1，y 向下，同
 * screenToWorldRaySegment 的输入），z 是深度（0 是近平面，1 是远平面）。
 * 和 Stride 不同：点在相机后面时返回 undefined（Stride 照样除以 w，得到一个镜像过去的位置）。
 */
export function worldToScreen(game: Game, camera: Entity, point: { readonly x: number; readonly y: number; readonly z: number }): Vector3 | undefined {
  const m = viewProjectionMatrix(game, camera);
  const w = m[3]! * point.x + m[7]! * point.y + m[11]! * point.z + m[15]!;
  if (w <= 0) return undefined;
  const [x, y, z] = Matrix.transformPoint(m, point.x, point.y, point.z);
  return new Vector3((x + 1) / 2, (1 - y) / 2, z);
}

/** 相机这一帧的视图投影矩阵（世界 → 裁剪空间），宽高比用画布的。 */
function viewProjectionMatrix(game: Game, camera: Entity): Float32Array {
  const { width, height } = game.graphicsDevice.canvas;
  const view = Matrix.identity(), projection = Matrix.identity();
  if (!Matrix.invert(view, camera.require(Transform).world)) throw new Error(`camera '${camera.name}' has a singular world matrix`);
  cameraProjectionMatrix(projection, camera.require(Camera), width / height);
  return Matrix.multiply(Matrix.identity(), projection, view);
}
