/**
 * 相机的屏幕坐标和世界坐标互换（Stride 的 CameraComponentExtensions）。相机的矩阵按这一帧的世界矩阵和 Camera 组件算，
 * 宽高比用画布的（同前向渲染器的主画面）。
 */
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Game } from '../games/Game';
import { Matrix } from '../mathematics/Matrix';
import { Vector3 } from '../mathematics/vectors';
import { Camera } from './components';

/**
 * 屏幕上的点（按画面归一化：0..1，y 向下，同 Stride 的 PointerEvent.Position）在近平面和远平面上的两个世界坐标点
 * （Stride 的 ScreenToWorldRaySegment）。射线从 start 指向 end，长度就是可见范围。
 */
export function screenToWorldRaySegment(game: Game, camera: Entity, screenX: number, screenY: number): { start: Vector3; end: Vector3 } {
  const settings = camera.require(Camera);
  const world = camera.require(Transform).world;
  const { width, height } = game.graphicsDevice.canvas;
  const view = Matrix.identity(), projection = Matrix.identity(), viewProjection = Matrix.identity();
  if (!Matrix.invert(view, world)) throw new Error(`camera '${camera.name}' has a singular world matrix`);
  Matrix.perspectiveFovRH(projection, (settings.verticalFieldOfView * Math.PI) / 180, width / height, settings.nearClipPlane, settings.farClipPlane);
  Matrix.multiply(viewProjection, projection, view);
  const inverse = Matrix.identity();
  Matrix.invert(inverse, viewProjection);
  // 规范化设备坐标：x、y 是 -1..1（y 向上），深度 0 是近平面、1 是远平面
  const x = screenX * 2 - 1, y = 1 - screenY * 2;
  return { start: new Vector3(...Matrix.transformPoint(inverse, x, y, 0)), end: new Vector3(...Matrix.transformPoint(inverse, x, y, 1)) };
}
