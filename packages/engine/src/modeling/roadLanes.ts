/**
 * 道路的车道图（W3）：路网（modeling/spline.ts 的 roadNetwork）上每一段路按方向分出车道，路口里接上转向的连接车道。交通（W9）
 * 照它开车：每条车道是一条有方向的折线，next 是走到头以后能接着走的车道。
 *
 * - 靠右行驶：双向的路顺着路径的车道在右边（截面的 right 那边）、逆着的在左边，下标 0 是靠中线的那条；单行的全部顺着路径，
 *   下标从左往右；车道宽是路宽平均分，跟着控制点的宽度倍数伸缩；
 * - 路口：每条驶入的车道接到别的每一条路（不掉头）上下标相同的驶出车道（那条路车道少时接最外边的），中间是一条连接车道：
 *   三次贝塞尔，两头的切线顺着两条车道的行驶方向；
 * - 两条路径首尾焊在一起（不是路口）时直接接上；首尾相连的路径终点接回起点；路的尽头没有 next。
 */
import type { SplineFile } from '../content/formats/splineFormat.ts';
import { resampleFrames, roadNetwork, splinePaths, splineWeldKey, type SplineFrame } from './spline.ts';

type Vec3 = [number, number, number];

/** 一条车道：按行驶方向的折线、长度（米），走到头以后能接着走的车道（下标），路口里的连接车道是第几个路口（路段上的是 undefined）。 */
export interface RoadLane {
  readonly points: readonly Vec3[];
  readonly length: number;
  readonly next: readonly number[];
  readonly junction: number | undefined;
}

/** 车道上大约每几米一个点。 */
const LANE_STEP = 2;
/** 不写车道数时按多宽一条车道算（米）。 */
const LANE_WIDTH = 3.5;
/** 路口里连接车道的曲线分几段。 */
const CONNECTOR_SEGMENTS = 8;

/** 车道的一头：在哪个节点（路口或焊点）、从哪条路来或往哪条路去（不掉头用）、第几条车道。 */
interface LaneEnd {
  readonly node: string;
  readonly arm: string;
  readonly index: number;
}

/** 道路样条的车道图；不是道路的样条没有车道。 */
export function roadLanes(file: SplineFile): RoadLane[] {
  const profile = file.profile;
  if (profile.type !== 'road') return [];
  const network = roadNetwork(file);
  const paths = splinePaths(file);
  const oneWay = profile.oneWay === true;
  const perSide = profile.lanes ?? Math.max(1, Math.floor(profile.width / LANE_WIDTH / (oneWay ? 1 : 2)));
  const laneWidth = profile.width / (oneWay ? perSide : 2 * perSide);
  // 车道中线离路中线的距离（右为正）：dir 1 是顺着路径
  const offset = (dir: 1 | -1, index: number) => (oneWay ? -profile.width / 2 + (index + 0.5) * laneWidth : dir * (index + 0.5) * laneWidth);
  const lanes: { points: Vec3[]; next: number[]; junction: number | undefined; start?: LaneEnd; end?: LaneEnd }[] = [];

  // 一段路的一头接着什么：路口的某条路，或者路径的一端（焊点）
  const endOf = (p: number, distance: number, side: 'start' | 'end'): { node: string; arm: string } => {
    const path = network.paths[p]!, total = path.knots.at(-1)!;
    for (const [j, junction] of network.junctions.entries()) {
      for (const [a, arm] of junction.arms.entries()) {
        if (arm.path !== p || (arm.sign > 0) !== (side === 'start')) continue;
        const at = path.knots[arm.knot]! + arm.sign * arm.trim;
        if (Math.abs(at - distance) < 1e-6 || (path.closed && Math.abs(Math.abs(at - distance) - total) < 1e-6)) return { node: `J${j}`, arm: `J${j}:${a}` };
      }
    }
    const points = paths[p]!.points;
    const point = side === 'start' || path.closed ? points[0]! : points.at(-1)!;
    return { node: `W${splineWeldKey(point.position)}`, arm: `P${p}:${side}` };
  };

  network.paths.forEach((path, p) => {
    for (const [from, to] of network.kept[p]!) {
      const frames = resampleFrames(path.frames, from, to, LANE_STEP);
      const start = endOf(p, from, 'start'), end = endOf(p, to, 'end');
      for (const dir of oneWay ? [1 as const] : [1 as const, -1 as const]) {
        for (let index = 0; index < perSide; index++) {
          const x = offset(dir, index);
          const points = frames.map((frame) => along(frame, x));
          if (dir < 0) points.reverse();
          const [enter, exit] = dir > 0 ? [start, end] : [end, start];
          lanes.push({ points, next: [], junction: undefined, start: { ...enter, index }, end: { ...exit, index } });
        }
      }
    }
  });

  // 每个节点：驶入的车道接上别的路的驶出车道
  const outgoing = new Map<string, Map<string, number[]>>();
  lanes.forEach((lane, i) => {
    const byArm = outgoing.get(lane.start!.node) ?? new Map<string, number[]>();
    outgoing.set(lane.start!.node, byArm);
    byArm.set(lane.start!.arm, [...(byArm.get(lane.start!.arm) ?? []), i]);
  });
  const roadLaneCount = lanes.length;
  for (let i = 0; i < roadLaneCount; i++) {
    const lane = lanes[i]!, end = lane.end!;
    for (const [arm, targets] of outgoing.get(end.node) ?? []) {
      if (arm === end.arm) continue;
      const sorted = [...targets].sort((a, b) => lanes[a]!.start!.index - lanes[b]!.start!.index);
      const target = sorted[Math.min(end.index, sorted.length - 1)]!;
      if (!end.node.startsWith('J')) {
        lane.next.push(target);
        continue;
      }
      lane.next.push(lanes.length);
      lanes.push({ points: connector(lane.points, lanes[target]!.points), next: [target], junction: Number(end.node.slice(1)) });
    }
  }
  return lanes.map(({ points, next, junction }) => ({ points, length: polylineLength(points), next, junction }));
}

/** 截面处离中线 x 米（右为正，跟着宽度倍数伸缩）的点，在路面上。 */
function along(frame: SplineFrame, x: number): Vec3 {
  const k = x * frame.width;
  return [frame.position[0] + frame.right[0] * k, frame.position[1] + frame.right[1] * k, frame.position[2] + frame.right[2] * k];
}

/** 从 a 的终点到 b 的起点的连接车道：三次贝塞尔，两头的切线顺着行驶方向、长三分之一的距离。 */
function connector(a: readonly Vec3[], b: readonly Vec3[]): Vec3[] {
  const p0 = a.at(-1)!, p3 = b[0]!;
  const d0 = direction(a.at(-2)!, p0), d3 = direction(b[0]!, b[1]!);
  const reach = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]) / 3;
  const p1: Vec3 = [p0[0] + d0[0] * reach, p0[1] + d0[1] * reach, p0[2] + d0[2] * reach];
  const p2: Vec3 = [p3[0] - d3[0] * reach, p3[1] - d3[1] * reach, p3[2] - d3[2] * reach];
  return Array.from({ length: CONNECTOR_SEGMENTS + 1 }, (_, k) => {
    const t = k / CONNECTOR_SEGMENTS, u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t] as const;
    return [0, 1, 2].map((c) => w[0] * p0[c]! + w[1] * p1[c]! + w[2] * p2[c]! + w[3] * p3[c]!) as Vec3;
  });
}

function direction(a: readonly number[], b: readonly number[]): Vec3 {
  const d: Vec3 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const l = Math.hypot(...d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1], points[i]![2] - points[i - 1]![2]);
  return total;
}
