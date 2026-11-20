/**
 * 视口里拖着改位置、旋转、缩放的操纵器（Gizmo）。和编辑相机一样分两层：这个文件只有几何——把手在哪、鼠标碰到了哪个、
 * 拖到这里相当于改了多少——不碰输入、实体和绘制，单测直接测；EditAgent 每帧喂给它鼠标的射线、把结果画出来、换成对场景
 * 文档的修改。
 *
 * 把手：
 * - 移动：三根轴（沿轴拖）、三个面片（在两根轴的平面里拖）；
 * - 旋转：三个圈（绕轴转）；
 * - 缩放：三根轴（沿这根轴缩放）、中间的方块（三个方向一起）。
 * 操纵器在画面上的大小不变：size 是它在世界里的长度，由调用方按到相机的距离算好。
 */
import { Quaternion, Vector3, type QuatLike, type Vec3Like } from '../data/vectors';

export type GizmoMode = 'translate' | 'rotate' | 'scale';
export type GizmoAxis = 'x' | 'y' | 'z';
/** 把手：一根轴、垂直于某根轴的面片（plane 是它的法线那根轴）、缩放的中间方块。 */
export type GizmoHandle =
  | { readonly kind: 'axis'; readonly axis: GizmoAxis }
  | { readonly kind: 'plane'; readonly axis: GizmoAxis }
  | { readonly kind: 'ring'; readonly axis: GizmoAxis }
  | { readonly kind: 'center' };

/** 拖到现在相当于做了什么（从按下时算起）：世界里的位移、绕枢轴的旋转（世界里的四元数）、沿操纵器三根轴的缩放倍数。 */
export type GizmoChange =
  | { readonly type: 'translate'; readonly delta: Vector3 }
  | { readonly type: 'rotate'; readonly rotation: Quaternion }
  | { readonly type: 'scale'; readonly factor: Vector3 };

export interface Ray {
  readonly origin: Readonly<Vec3Like>;
  /** 单位向量。 */
  readonly direction: Readonly<Vec3Like>;
}

/** 世界里的点落在画面的哪里（像素）；在相机后面时是 undefined。 */
export type ProjectToScreen = (point: Readonly<Vec3Like>) => readonly [number, number] | undefined;

export const GIZMO_AXES: readonly GizmoAxis[] = ['x', 'y', 'z'];
const UNIT: Readonly<Record<GizmoAxis, Readonly<Vec3Like>>> = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };

/** 面片从枢轴往两根轴各伸出去多远到多远（size 的倍数）。 */
export const PLANE_NEAR = 0.25, PLANE_FAR = 0.5;
/** 旋转的圈用多少段折线画、算。 */
export const RING_SEGMENTS = 48;
/** 鼠标离把手这么近（像素）就算碰到。 */
const PICK_PIXELS = 8;
/** 射线和轴、和平面差不多平行时算不出稳定的结果：小于这个夹角的正弦就不动。 */
const PARALLEL = 1e-3;

/** 沿 axis 的直线上离射线最近的那一点的参数 t（点是 origin + axis * t）；射线和轴平行时是 undefined。 */
export function closestOnAxis(ray: Ray, origin: Readonly<Vec3Like>, axis: Readonly<Vec3Like>): number | undefined {
  const d = new Vector3().copy(ray.direction), a = new Vector3().copy(axis);
  const w = new Vector3().copy(origin).subtract(ray.origin);
  const b = a.dot(d), denominator = 1 - b * b;
  if (denominator < PARALLEL * PARALLEL) return undefined;
  // 最小化 |origin + a t - (ray.origin + d s)|
  return (b * w.dot(d) - w.dot(a)) / denominator;
}

/** 射线和平面（过 point、法线 normal）的交点；平行、交点在射线背后时是 undefined。 */
export function rayPlane(ray: Ray, point: Readonly<Vec3Like>, normal: Readonly<Vec3Like>): Vector3 | undefined {
  const n = new Vector3().copy(normal);
  const facing = n.dot(ray.direction);
  if (Math.abs(facing) < PARALLEL) return undefined;
  const t = n.dot(new Vector3().copy(point).subtract(ray.origin)) / facing;
  return t < 0 ? undefined : new Vector3().copy(ray.origin).addScaled(ray.direction, t);
}

/** 编辑器的吸附设置：三种操纵的步长和"一直吸附"。旋转按度（界面上的单位），操纵器里换成弧度。 */
export interface SnapSettings {
  /** 一直吸附；拖的时候按住 Ctrl 反过来（开着时临时不吸、关着时临时吸）。 */
  readonly enabled: boolean;
  /** 移动的步长（世界单位）。 */
  readonly translate: number;
  /** 旋转的步长（度）。 */
  readonly rotate: number;
  /** 缩放的步长（倍数）。 */
  readonly scale: number;
}

/** 默认的吸附：关着；步长 1 米、15 度、0.1 倍（Stride 编辑器的默认值）。 */
export const DEFAULT_SNAP: SnapSettings = { enabled: false, translate: 1, rotate: 15, scale: 0.1 };

/** 照吸附设置和"Ctrl 按着没有"设操纵器的步长（不吸附时是 0）。 */
export function applySnap(gizmo: TransformGizmo, settings: SnapSettings, invert: boolean): void {
  const on = settings.enabled !== invert;
  gizmo.translateSnap = on ? settings.translate : 0;
  gizmo.rotateSnap = on ? (settings.rotate * Math.PI) / 180 : 0;
  gizmo.scaleSnap = on ? settings.scale : 0;
}

export class TransformGizmo {
  mode: GizmoMode = 'translate';
  /** 枢轴（世界坐标）：操纵器画在这里，旋转绕着它。 */
  readonly pivot = new Vector3();
  /** 操纵器的朝向（世界）：单位四元数是世界轴，选中的实体的朝向是它的本地轴。缩放总是按本地轴。 */
  readonly orientation = new Quaternion();
  /** 轴在世界里的长度（画面上大小不变：调用方按枢轴到相机的距离算）。 */
  size = 1;
  /** 吸附的步长：移动（世界单位）、旋转（弧度）、缩放（倍数）；0 是不吸附。 */
  translateSnap = 0;
  rotateSnap = 0;
  scaleSnap = 0;
  /** origin 是按下时的枢轴：拖的过程中枢轴会跟着实体走（操纵器画在实体上），量拖了多少要从不动的地方量。 */
  #drag: { handle: GizmoHandle; origin: Vector3; startT: number; startPoint: Vector3 | undefined; startPixel: readonly [number, number] } | undefined;

  /** 正在拖的把手。 */
  get dragging(): GizmoHandle | undefined {
    return this.#drag?.handle;
  }

  /** 这次拖按下时的枢轴（旋转绕着它）；没在拖时是 undefined。 */
  get dragOrigin(): Vector3 | undefined {
    return this.#drag?.origin;
  }

  /** 操纵器的一根轴在世界里的方向。 */
  axis(axis: GizmoAxis): Vector3 {
    return new Vector3().copy(UNIT[axis]).rotate(this.orientation);
  }

  /** 这个模式有哪些把手。 */
  handles(): GizmoHandle[] {
    if (this.mode === 'rotate') return GIZMO_AXES.map((axis) => ({ kind: 'ring', axis }));
    const axes: GizmoHandle[] = GIZMO_AXES.map((axis) => ({ kind: 'axis', axis }));
    return this.mode === 'translate' ? [...axes, ...GIZMO_AXES.map((axis) => ({ kind: 'plane', axis }) as const)] : [...axes, { kind: 'center' }];
  }

  /** 把手的形状：世界里的一条折线（轴是一段，面片是四个角，圈是一圈点，中间的方块就是枢轴一个点）。画和碰都用它。 */
  outline(handle: GizmoHandle): Vector3[] {
    const at = (x: number, y: number, z: number) => new Vector3(x, y, z).scale(this.size).rotate(this.orientation).add(this.pivot);
    if (handle.kind === 'center') return [this.pivot.clone()];
    // 另外两根轴，按 x→y→z→x 的顺序
    const [u, v] = handle.axis === 'x' ? ['y', 'z'] as const : handle.axis === 'y' ? ['z', 'x'] as const : ['x', 'y'] as const;
    const point = (onU: number, onV: number, onAxis = 0) => {
      const c = { x: 0, y: 0, z: 0 };
      c[u] = onU;
      c[v] = onV;
      c[handle.axis] = onAxis;
      return at(c.x, c.y, c.z);
    };
    if (handle.kind === 'axis') return [this.pivot.clone(), point(0, 0, 1)];
    if (handle.kind === 'plane') return [point(PLANE_NEAR, PLANE_NEAR), point(PLANE_FAR, PLANE_NEAR), point(PLANE_FAR, PLANE_FAR), point(PLANE_NEAR, PLANE_FAR)];
    return Array.from({ length: RING_SEGMENTS }, (_, i) => point(Math.cos((i / RING_SEGMENTS) * 2 * Math.PI), Math.sin((i / RING_SEGMENTS) * 2 * Math.PI)));
  }

  /**
   * 鼠标（像素）碰到了哪个把手：离得最近、在 PICK_PIXELS 以内的；面片是鼠标落在它里面。中间的方块和面片比轴优先
   * （它们挨着轴的根部）。没碰到是 undefined。
   */
  pick(pixel: readonly [number, number], project: ProjectToScreen): GizmoHandle | undefined {
    let best: { handle: GizmoHandle; distance: number } | undefined;
    for (const handle of this.handles()) {
      const points = this.outline(handle).map(project);
      if (points.some((point) => point === undefined)) continue;
      const screen = points as (readonly [number, number])[];
      let distance: number;
      if (handle.kind === 'center') distance = Math.hypot(pixel[0] - screen[0]![0], pixel[1] - screen[0]![1]) - PICK_PIXELS;
      else if (handle.kind === 'plane') distance = insidePolygon(pixel, screen) ? -PICK_PIXELS : Infinity;
      else distance = distanceToPolyline(pixel, screen, handle.kind === 'ring');
      if (distance <= PICK_PIXELS && (!best || distance < best.distance)) best = { handle, distance };
    }
    return best?.handle;
  }

  /** 在这个把手上按下了鼠标；算不出起点（射线和轴、和平面平行）时不开始拖，返回 false。 */
  begin(handle: GizmoHandle, ray: Ray, pixel: readonly [number, number]): boolean {
    let startT = 0, startPoint: Vector3 | undefined;
    if (handle.kind === 'axis') {
      const t = closestOnAxis(ray, this.pivot, this.axis(handle.axis));
      // 缩放按"现在到枢轴的距离是按下时的几倍"算：按在枢轴上（t 是 0）没法算
      if (t === undefined || (this.mode === 'scale' && Math.abs(t) < this.size * 1e-3)) return false;
      startT = t;
    } else if (handle.kind !== 'center') {
      startPoint = rayPlane(ray, this.pivot, this.axis(handle.axis));
      if (!startPoint) return false;
    }
    this.#drag = { handle, origin: this.pivot.clone(), startT, startPoint, startPixel: pixel };
    return true;
  }

  /** 拖到这里相当于做了什么；没在拖、这一帧算不出来（射线转到和轴平行了）时是 undefined，保持上一次的结果。 */
  drag(ray: Ray, pixel: readonly [number, number]): GizmoChange | undefined {
    const drag = this.#drag;
    if (!drag) return undefined;
    const { handle } = drag;
    if (handle.kind === 'center') {
      // 往上拖放大：每 100 像素一倍
      const factor = snap(Math.max(0.01, 1 + (drag.startPixel[1] - pixel[1]) / 100), this.scaleSnap);
      return { type: 'scale', factor: new Vector3(factor, factor, factor) };
    }
    const axis = this.axis(handle.axis);
    if (handle.kind === 'axis') {
      const t = closestOnAxis(ray, drag.origin, axis);
      if (t === undefined) return undefined;
      if (this.mode === 'translate') return { type: 'translate', delta: axis.scale(snap(t - drag.startT, this.translateSnap)) };
      const factor = new Vector3(1, 1, 1);
      factor[handle.axis] = snap(Math.max(0.01, t / drag.startT), this.scaleSnap);
      return { type: 'scale', factor };
    }
    const point = rayPlane(ray, drag.origin, axis);
    if (!point) return undefined;
    if (handle.kind === 'plane') {
      const delta = point.subtract(drag.startPoint!);
      if (this.translateSnap > 0) {
        // 沿面片的两根轴各自吸附
        const snapped = new Vector3();
        for (const other of GIZMO_AXES) if (other !== handle.axis) snapped.addScaled(this.axis(other), snap(delta.dot(this.axis(other)), this.translateSnap));
        return { type: 'translate', delta: snapped };
      }
      return { type: 'translate', delta };
    }
    // 圈：按下的点和现在的点绕轴转过的角度
    const from = drag.startPoint!.clone().subtract(drag.origin), to = point.subtract(drag.origin);
    const angle = Math.atan2(from.clone().cross(to).dot(axis), from.dot(to));
    return { type: 'rotate', rotation: new Quaternion().setAxisAngle(axis, snap(angle, this.rotateSnap)) };
  }

  /** 松开鼠标。 */
  end(): void {
    this.#drag = undefined;
  }
}

/** 把一个实体按 change 改过以后的世界位置、朝向和本地缩放（从拖之前的值算，不累积误差）。 */
export function applyGizmoChange(
  change: GizmoChange, pivot: Readonly<Vec3Like>,
  start: { readonly position: Readonly<Vec3Like>; readonly rotation: Readonly<QuatLike>; readonly scale: Readonly<Vec3Like> },
): { position: Vector3; rotation: Quaternion; scale: Vector3 } {
  const position = new Vector3().copy(start.position), rotation = new Quaternion().copy(start.rotation), scale = new Vector3().copy(start.scale);
  if (change.type === 'translate') position.add(change.delta);
  else if (change.type === 'rotate') {
    // 绕枢轴转：位置跟着转，朝向左乘
    position.subtract(pivot).rotate(change.rotation).add(pivot);
    rotation.copy(change.rotation.clone().multiply(start.rotation)).normalize();
  } else scale.set(scale.x * change.factor.x, scale.y * change.factor.y, scale.z * change.factor.z);
  return { position, rotation, scale };
}

const snap = (value: number, step: number): number => (step > 0 ? Math.round(value / step) * step : value);

/** 点到折线的距离（像素）；closed 时首尾相连。 */
function distanceToPolyline(point: readonly [number, number], line: readonly (readonly [number, number])[], closed: boolean): number {
  let best = Infinity;
  const count = closed ? line.length : line.length - 1;
  for (let i = 0; i < count; i++) {
    const [ax, ay] = line[i]!, [bx, by] = line[(i + 1) % line.length]!;
    const dx = bx - ax, dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(point[0] - (ax + dx * t), point[1] - (ay + dy * t)));
  }
  return best;
}

/** 点在不在多边形里（射线法）。 */
function insidePolygon(point: readonly [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
