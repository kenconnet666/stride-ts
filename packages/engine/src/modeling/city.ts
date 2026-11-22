/**
 * 沿街摆楼（W5，文件格式和摆法见 content/cityFormat.ts）：纯函数，给城市文件、路的样条、每种楼的占地，算出每栋楼的位置和朝向。
 * 运行时的 CitySystem（city/City.ts）再按地面的高度把楼放上去。
 */
import type { CityFile } from '../content/cityFormat.ts';
import type { SplineFile } from '../content/splineFormat.ts';
import { sampleSpline, splineCorridorWidth, splinePaths, frameAt } from './spline.ts';
import { hash32 } from '../data/hash.ts';

type Vec2 = readonly [number, number];

/** 一种楼的占地：模型本地的包围盒在 x（顺着路）、z（朝路）上的宽、深和中心。 */
export interface CityFootprint {
  readonly width: number;
  readonly depth: number;
  readonly center: Vec2;
}

/** 摆下的一栋楼：第几种楼、实体的位置（x、z）、绕 Y 转多少（弧度）、地块的四个角（量地面的高度用）。 */
export interface CityLot {
  readonly building: number;
  readonly position: Vec2;
  readonly yaw: number;
  readonly corners: readonly Vec2[];
}

/** 沿路取样的间距、碰到东西时往前挪多远（米）。 */
const STEP = 2;
/** 路的线段放进网格的格子大小（米）。 */
const GRID = 32;

/** 一个朝向任意的矩形：中心、两根单位轴、两个半长。 */
interface Box {
  readonly center: Vec2;
  readonly axes: readonly [Vec2, Vec2];
  readonly half: Vec2;
}

/** 算出城里的每栋楼。roads 和 file.roads 一一对应，footprints 和 file.buildings 一一对应。 */
export function cityLots(file: CityFile, roads: readonly SplineFile[], footprints: readonly CityFootprint[]): CityLot[] {
  const setback = file.setback ?? 3, gap = file.gap ?? 2;
  const segments = roadSegments(roads);
  const placed = new BoxGrid();
  const lots: CityLot[] = [];
  const weights = file.buildings.map((rule) => rule.weight ?? 1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const seed = file.seed ?? 1;
  const pickAt = (key: number) => pick(weights, totalWeight, key / 4294967296);
  /** 楼 building 的地块中心放在 center、正面朝着 −outward（路那边）：碰到路、别的楼或者出了范围时不放，返回 false。 */
  const place = (building: number, center: Vec2, outward: Vec2): boolean => {
    const footprint = footprints[building]!;
    // 楼的正面（本地 +Z）朝着路：(sin yaw, cos yaw) = −outward；本地 X 是 (cos yaw, −sin yaw)
    const yaw = Math.atan2(-outward[0], -outward[1]);
    const xAxis: Vec2 = [Math.cos(yaw), -Math.sin(yaw)], zAxis: Vec2 = [Math.sin(yaw), Math.cos(yaw)];
    const box: Box = { center, axes: [xAxis, zAxis], half: [footprint.width / 2, footprint.depth / 2] };
    const padded: Box = { ...box, half: [box.half[0] + gap / 2, box.half[1] + gap / 2] };
    if ((file.area && !inside(file.area, center)) || hitsRoad(box, segments, setback * 0.5) || placed.overlaps(padded)) return false;
    // 实体的位置：模型的包围盒中心转过去以后落在地块中心
    const [cx, cz] = footprint.center;
    const position: Vec2 = [center[0] - (xAxis[0] * cx + zAxis[0] * cz), center[1] - (xAxis[1] * cx + zAxis[1] * cz)];
    lots.push({ building, position, yaw, corners: corners(box) });
    placed.add(padded);
    return true;
  };
  // 临街的一排：沿每条路径的两边一栋挨一栋
  roads.forEach((road, r) => {
    const halfRoad = splineCorridorWidth(road.profile) / 2;
    splinePaths(road).forEach((path, p) => {
      const frames = sampleSpline(path.points, path.closed ?? false, 1);
      const total = frames.at(-1)!.distance;
      for (const side of [1, -1] as const) {
        let d = 0, k = 0;
        while (d < total) {
          const building = pickAt(hash32(hash32(hash32(hash32(seed, r), p), side + 2), k++));
          const footprint = footprints[building]!;
          const along = d + footprint.width / 2;
          if (along + footprint.width / 2 > total) break;
          const frame = frameAt(frames, along);
          const right = normalize2([frame.right[0], frame.right[2]]);
          const outward: Vec2 = [right[0] * side, right[1] * side];
          const offset = halfRoad * frame.width + setback + footprint.depth / 2;
          if (place(building, [frame.position[0] + outward[0] * offset, frame.position[2] + outward[1] * offset], outward)) d += footprint.width + gap;
          else d += STEP;
        }
      }
    });
  });
  // 街区里面：格点（带抖动）按离路由近到远地试，楼朝着最近的路
  if (file.fill) {
    const spacing = file.fill.spacing ?? 12, reach = file.fill.maxDistance ?? 100;
    const [x0, z0, x1, z1] = file.area ? boundsOf(file.area) : expand(segmentBounds(segments), reach);
    const candidates: { center: Vec2; outward: Vec2; distance: number; key: number }[] = [];
    for (let i = 0; x0 + i * spacing <= x1; i++) {
      for (let j = 0; z0 + j * spacing <= z1; j++) {
        const key = hash32(hash32(seed ^ 0x5bd1e995, i), j);
        const center: Vec2 = [x0 + (i + (key & 0xffff) / 0x10000 - 0.5) * spacing, z0 + (j + (key >>> 16) / 0x10000 - 0.5) * spacing];
        const nearest = nearestRoad(segments, center, reach);
        if (!nearest || nearest.distance < 1e-6) continue;
        candidates.push({ center, outward: [(center[0] - nearest.point[0]) / nearest.distance, (center[1] - nearest.point[1]) / nearest.distance], distance: nearest.distance, key });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.key - b.key);
    for (const { center, outward, key } of candidates) place(pickAt(hash32(key, 0x2545f491)), center, outward);
  }
  return lots;
}

/** 摆下的楼的地块，按网格分好（查一个矩形碰没碰到已经摆下的）。 */
class BoxGrid {
  readonly #cells = new Map<string, Box[]>();

  add(box: Box): void {
    for (const key of this.#keys(box)) {
      let list = this.#cells.get(key);
      if (!list) this.#cells.set(key, (list = []));
      list.push(box);
    }
  }

  overlaps(box: Box): boolean {
    for (const key of this.#keys(box)) for (const other of this.#cells.get(key) ?? []) if (overlaps(box, other)) return true;
    return false;
  }

  #keys(box: Box): string[] {
    const r = Math.hypot(box.half[0], box.half[1]), keys: string[] = [];
    for (let x = Math.floor((box.center[0] - r) / GRID); x <= Math.floor((box.center[0] + r) / GRID); x++) {
      for (let z = Math.floor((box.center[1] - r) / GRID); z <= Math.floor((box.center[1] + r) / GRID); z++) keys.push(`${x},${z}`);
    }
    return keys;
  }
}

/** 离 p 最近的路的中心线上的点和距离；reach 米以内没有路时是 undefined。 */
function nearestRoad(grid: Map<string, Segment[]>, p: Vec2, reach: number): { point: Vec2; distance: number } | undefined {
  let best: { point: Vec2; distance: number } | undefined;
  for (let x = Math.floor((p[0] - reach) / GRID); x <= Math.floor((p[0] + reach) / GRID); x++) {
    for (let z = Math.floor((p[1] - reach) / GRID); z <= Math.floor((p[1] + reach) / GRID); z++) {
      for (const { a, b } of grid.get(`${x},${z}`) ?? []) {
        const ex = b[0] - a[0], ez = b[1] - a[1], length = ex * ex + ez * ez;
        const t = length > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / length)) : 0;
        const point: Vec2 = [a[0] + ex * t, a[1] + ez * t];
        const distance = Math.hypot(p[0] - point[0], p[1] - point[1]);
        if (distance <= reach && (!best || distance < best.distance)) best = { point, distance };
      }
    }
  }
  return best;
}

function boundsOf(points: readonly (readonly [number, number])[]): [number, number, number, number] {
  return [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
}

function segmentBounds(grid: Map<string, Segment[]>): [number, number, number, number] {
  const points = [...grid.values()].flat().flatMap((segment) => [segment.a, segment.b]);
  return points.length > 0 ? boundsOf(points) : [0, 0, 0, 0];
}

function expand([x0, z0, x1, z1]: readonly [number, number, number, number], by: number): [number, number, number, number] {
  return [x0 - by, z0 - by, x1 + by, z1 + by];
}

/** 按权重挑一个（random 在 [0, 1)）。 */
function pick(weights: readonly number[], total: number, random: number): number {
  let at = random * total;
  for (let i = 0; i < weights.length; i++) {
    at -= weights[i]!;
    if (at < 0) return i;
  }
  return weights.length - 1;
}

/** 一条路的线段：两端、离中心线多远以内是路。 */
interface Segment {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly reach: number;
}

/** 所有路的线段，按网格分好（查一个矩形附近的线段）。 */
function roadSegments(roads: readonly SplineFile[]): Map<string, Segment[]> {
  const grid = new Map<string, Segment[]>();
  for (const road of roads) {
    const half = splineCorridorWidth(road.profile) / 2;
    for (const path of splinePaths(road)) {
      const frames = sampleSpline(path.points, path.closed ?? false, STEP);
      for (let i = 0; i + 1 < frames.length; i++) {
        const f0 = frames[i]!, f1 = frames[i + 1]!;
        const segment: Segment = { a: [f0.position[0], f0.position[2]], b: [f1.position[0], f1.position[2]], reach: half * Math.max(f0.width, f1.width) };
        const x0 = Math.floor((Math.min(segment.a[0], segment.b[0]) - segment.reach) / GRID), x1 = Math.floor((Math.max(segment.a[0], segment.b[0]) + segment.reach) / GRID);
        const z0 = Math.floor((Math.min(segment.a[1], segment.b[1]) - segment.reach) / GRID), z1 = Math.floor((Math.max(segment.a[1], segment.b[1]) + segment.reach) / GRID);
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
          const key = `${x},${z}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(segment);
        }
      }
    }
  }
  return grid;
}

/** 矩形离哪条路比 reach + margin 近（碰到路）。 */
function hitsRoad(box: Box, grid: Map<string, Segment[]>, margin: number): boolean {
  const extent = Math.hypot(box.half[0], box.half[1]);
  const x0 = Math.floor((box.center[0] - extent) / GRID), x1 = Math.floor((box.center[0] + extent) / GRID);
  const z0 = Math.floor((box.center[1] - extent) / GRID), z1 = Math.floor((box.center[1] + extent) / GRID);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    for (const segment of grid.get(`${x},${z}`) ?? []) if (segmentBoxDistance(segment.a, segment.b, box) < segment.reach + margin) return true;
  }
  return false;
}

/** 线段到矩形的距离（相交是 0）：换到矩形自己的坐标里算轴对齐的。 */
export function segmentBoxDistance(a: Vec2, b: Vec2, box: Box): number {
  const local = (p: Vec2): Vec2 => {
    const dx = p[0] - box.center[0], dz = p[1] - box.center[1];
    return [dx * box.axes[0][0] + dz * box.axes[0][1], dx * box.axes[1][0] + dz * box.axes[1][1]];
  };
  const la = local(a), lb = local(b), [hx, hz] = box.half;
  if (segmentHitsRect(la, lb, hx, hz)) return 0;
  const pointRect = (p: Vec2) => Math.hypot(Math.max(Math.abs(p[0]) - hx, 0), Math.max(Math.abs(p[1]) - hz, 0));
  const rectCorners: Vec2[] = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  return Math.min(pointRect(la), pointRect(lb), ...rectCorners.map((c) => pointSegment(c, la, lb)));
}

/** 线段和轴对齐矩形（±hx、±hz）相交（Liang–Barsky 裁剪）。 */
function segmentHitsRect(a: Vec2, b: Vec2, hx: number, hz: number): boolean {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [[-d[0]!, a[0] + hx], [d[0]!, hx - a[0]], [-d[1]!, a[1] + hz], [d[1]!, hz - a[1]]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function pointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ex = b[0] - a[0], ez = b[1] - a[1], length = ex * ex + ez * ez;
  const t = length > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / length)) : 0;
  return Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t);
}

/** 两个矩形重叠（分离轴：四根轴上的投影都重叠）。 */
export function overlaps(a: Box, b: Box): boolean {
  for (const axis of [...a.axes, ...b.axes]) {
    const project = (box: Box) => Math.abs(axis[0] * box.axes[0][0] + axis[1] * box.axes[0][1]) * box.half[0] + Math.abs(axis[0] * box.axes[1][0] + axis[1] * box.axes[1][1]) * box.half[1];
    const distance = Math.abs((a.center[0] - b.center[0]) * axis[0] + (a.center[1] - b.center[1]) * axis[1]);
    if (distance >= project(a) + project(b)) return false;
  }
  return true;
}

function corners(box: Box): Vec2[] {
  const [x, z] = box.axes, [hx, hz] = box.half, c = box.center;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [c[0] + x[0] * hx * sx! + z[0] * hz * sz!, c[1] + x[1] * hx * sx! + z[1] * hz * sz!] as Vec2);
}

/** 点在多边形里（奇偶规则）。 */
function inside(points: readonly (readonly [number, number])[], [x, z]: Vec2): boolean {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) result = !result;
  }
  return result;
}

function normalize2(v: Vec2): Vec2 {
  const length = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / length, v[1] / length];
}

