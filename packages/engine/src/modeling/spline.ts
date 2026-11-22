/**
 * 样条（content/formats/splineFormat.ts 的 SplineFile）的几何：路径按弧长采样成带朝向的截面（sampleSpline、frameAt），按横截面拉伸、
 * 沿路摆立柱和轨枕、在电杆之间挂下垂的导线，得出按材质槽分好的三角形网格（编辑器后端烘成模型用，pipeline 的 splineModel.ts）。
 * 地形贴合、车道图、列车沿路走以后也用这里的采样。
 *
 * - 路径：向心 Catmull-Rom（alpha 0.5，Barry–Goldman 的写法）经过每个控制点，开放的两端按反射补一个点；先每段密采样、按累计
 *   弧长重新等距取点；
 * - 朝向：right = 切线 × 世界上方（路面不随路径侧翻，竖直的一段沿用上一个），up = right × 切线；控制点的 tilt 让它绕切线转；
 * - 顶点同多边形网格：每个 8 个数（位置、法线、UV），UV 按米（贴图每米重复一次，同白盒），三角形逆时针是正面；
 * - 路网（文件的 branches）：道路在三条以上的路交汇处生成路口（roadNetwork，思路同 godot-road-generator 的 n 边形路口，截断
 *   距离自动算）：每条路的方向投到水平面、按角度排好，相邻两条路的边线求交点，各条路停在离路口中心最远的交点再往外一个转角
 *   半径的地方；路口的轮廓是各条路的端口加上相邻端口之间以交点为控制点的二次贝塞尔（转角的圆弧，夹角 180° 以上的直连），
 *   顶面从中心扇形铺满，转角外侧照路的边坡往下。别的横截面各条路径各自拉伸。
 */
import { SPLINE_SLOTS, type SplineBranchFile, type SplineFile, type SplinePointFile } from '../content/formats/splineFormat.ts';
import { MeshBuilder, slotMeshes, type SlotMesh } from './meshBuilder.ts';

type Vec3 = [number, number, number];

/** 路径上的一个截面：位置、切线、右、上（单位向量），离起点的弧长（米），截面宽度的倍数。 */
export interface SplineFrame {
  readonly position: Vec3;
  readonly tangent: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly distance: number;
  readonly width: number;
}

/** 一个材质槽的三角形网格。 */
export type SplineSlotMesh = SlotMesh;

const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const scale = (a: readonly number[], s: number): Vec3 => [a[0]! * s, a[1]! * s, a[2]! * s];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const length = (a: readonly number[]) => Math.sqrt(dot(a, a));
const normalize = (a: readonly number[]): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 0];
};
const lerp3 = (a: readonly number[], b: readonly number[], t: number): Vec3 => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];

/** 每段密采样的点数（重新等距取点前）。 */
const DENSE_PER_SEGMENT = 32;

/** 检查样条文件（结构和范围），不对时抛错，错误里带着位置；返回原对象。 */
export function checkSpline(file: SplineFile, where = file.name): SplineFile {
  const fail = (problem: string): never => {
    throw new Error(`${where}: ${problem}`);
  };
  const checkPoints = (points: readonly SplinePointFile[], at: string) => {
    if (!Array.isArray(points) || points.length < 2) fail(`${at} needs at least 2 points`);
    points.forEach((point, i) => {
      if (!Array.isArray(point.position) || point.position.length !== 3 || !point.position.every(Number.isFinite)) fail(`${at}[${i}].position must be 3 finite numbers`);
      if (point.width !== undefined && !(point.width > 0)) fail(`${at}[${i}].width must be positive`);
    });
  };
  checkPoints(file.points, 'points');
  if (file.branches !== undefined && !Array.isArray(file.branches)) fail('branches must be a list');
  file.branches?.forEach((branch, b) => checkPoints(branch.points, `branches[${b}].points`));
  if (file.resolution !== undefined && !(file.resolution > 0)) fail('resolution must be positive');
  const p = file.profile;
  if (!p || !['road', 'tube', 'custom', 'rail', 'fence', 'wire', 'river'].includes(p.type)) fail("profile.type must be one of road, tube, custom, rail, fence, wire, river");
  if ((p.type === 'road' || p.type === 'river') && !(p.width > 0)) fail('profile.width must be positive');
  if (p.type === 'tube' && !(p.radius > 0)) fail('profile.radius must be positive');
  if (p.type === 'custom' && (!Array.isArray(p.shape) || p.shape.length < 2)) fail('profile.shape needs at least 2 [right, up] points');
  return file;
}

/**
 * 路径上第 segment 段（控制点 segment 到下一个之间；首尾相连时最后一段回到第一个点）参数 u（0..1，不是弧长）处的位置。
 * 开放的两端按反射补一个点。
 */
export function splinePoint(points: readonly SplinePointFile[], closed: boolean, segment: number, u: number): Vec3 {
  const n = points.length;
  const at = (i: number): Vec3 => {
    if (closed) return [...points[((i % n) + n) % n]!.position] as Vec3;
    if (i < 0) return sub(scale(points[0]!.position, 2), points[1]!.position);
    if (i >= n) return sub(scale(points[n - 1]!.position, 2), points[n - 2]!.position);
    return [...points[i]!.position] as Vec3;
  };
  return catmullRom(at(segment - 1), at(segment), at(segment + 1), at(segment + 2), u);
}

/** 画路径用的折线：每段 perSegment 份，每段一组点（含两端），第 i 组是控制点 i 到下一个之间。 */
export function splineCurve(points: readonly SplinePointFile[], closed: boolean, perSegment = 16): Vec3[][] {
  const segments = points.length < 2 ? 0 : closed ? points.length : points.length - 1;
  return Array.from({ length: segments }, (_, s) => Array.from({ length: perSegment + 1 }, (_, k) => splinePoint(points, closed, s, k / perSegment)));
}

/**
 * 路径按弧长采样：大约每 step 米一个截面（总长平均分，最后一个正好在终点；首尾相连时最后一个和第一个重合）。控制点的 tilt、
 * width 沿路径线性过渡。
 */
export function sampleSpline(points: readonly SplinePointFile[], closed: boolean, step: number): SplineFrame[] {
  return samplePath(points, closed, step).frames;
}

/** 样条在地上占多宽（米）：道路是路面加两侧路肩，铁轨是轨距加 3 米的道床，别的 2 米。地形贴样条、城市摆楼避让用。 */
export function splineCorridorWidth(profile: SplineFile['profile']): number {
  return profile.type === 'road' ? profile.width + 2 * (profile.shoulder ?? 0.5) : profile.type === 'rail' ? (profile.gauge ?? 1.435) + 3 : profile.type === 'river' ? profile.width + 4 : 2;
}

/** 样条的全部路径：第一条是文件的 points，后面是 branches。 */
export function splinePaths(file: Pick<SplineFile, 'points' | 'closed' | 'branches'>): SplineBranchFile[] {
  return [{ points: file.points, closed: file.closed ?? false }, ...(file.branches ?? [])];
}

/** sampleSpline，再加上每个控制点离起点的弧长（knots；首尾相连时多一个，是回到起点的总长）。 */
function samplePath(points: readonly SplinePointFile[], closed: boolean, step: number): { frames: SplineFrame[]; knots: number[] } {
  const n = points.length;
  const segments = closed ? n : n - 1;
  // 密采样：位置和控制点上的 tilt、width（按段内的参数线性插值）
  const dense: { position: Vec3; tilt: number; width: number }[] = [];
  for (let s = 0; s < segments; s++) {
    const a = points[s % n]!, b = points[(s + 1) % n]!;
    for (let k = 0; k < DENSE_PER_SEGMENT || (s === segments - 1 && k === DENSE_PER_SEGMENT); k++) {
      const u = k / DENSE_PER_SEGMENT;
      dense.push({ position: splinePoint(points, closed, s, u), tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, u), width: lerp(a.width ?? 1, b.width ?? 1, u) });
    }
  }
  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1]! + length(sub(dense[i]!.position, dense[i - 1]!.position)));
  const total = lengths.at(-1)!;
  const knots = Array.from({ length: segments + 1 }, (_, s) => lengths[s * DENSE_PER_SEGMENT]!);
  const count = Math.max(1, Math.ceil(total / step));
  const samples: { position: Vec3; tilt: number; width: number; distance: number }[] = [];
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const d = (k / count) * total;
    while (j < dense.length - 2 && lengths[j + 1]! < d) j++;
    const span = lengths[j + 1]! - lengths[j]!;
    const t = span > 0 ? Math.min(1, Math.max(0, (d - lengths[j]!) / span)) : 0;
    const a = dense[j]!, b = dense[j + 1]!;
    samples.push({ position: lerp3(a.position, b.position, t), tilt: lerp(a.tilt, b.tilt, t), width: lerp(a.width, b.width, t), distance: d });
  }
  // 朝向：切线用前后两个点（首尾相连时绕回去），right 跟着世界的上方
  let previousRight: Vec3 = [1, 0, 0];
  const frames = samples.map((sample, k): SplineFrame => {
    const before = samples[k - 1] ?? (closed ? samples[samples.length - 2] : undefined) ?? sample;
    const after = samples[k + 1] ?? (closed ? samples[1] : undefined) ?? sample;
    const tangent = normalize(sub(after.position, before.position));
    let right = normalize(cross(tangent, [0, 1, 0]));
    if (length(right) < 0.5) right = previousRight;
    previousRight = right;
    let up = normalize(cross(right, tangent));
    if (sample.tilt !== 0) {
      // 绕切线转：正的 tilt 右边往下
      const c = Math.cos((sample.tilt * Math.PI) / 180), s = Math.sin((sample.tilt * Math.PI) / 180);
      [right, up] = [normalize(sub(scale(right, c), scale(up, s))), normalize(add(scale(up, c), scale(right, s)))];
    }
    return { position: sample.position, tangent, right, up, distance: sample.distance, width: sample.width };
  });
  return { frames, knots };
}

/** 弧长 distance 处的截面（在相邻两个采样之间插值；超出两端时取端点）。 */
export function frameAt(frames: readonly SplineFrame[], distance: number): SplineFrame {
  if (distance <= frames[0]!.distance) return frames[0]!;
  const last = frames.at(-1)!;
  if (distance >= last.distance) return last;
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.distance <= distance) lo = mid;
    else hi = mid;
  }
  const a = frames[lo]!, b = frames[hi]!;
  const t = (distance - a.distance) / (b.distance - a.distance);
  const tangent = normalize(lerp3(a.tangent, b.tangent, t));
  const right = normalize(lerp3(a.right, b.right, t));
  return { position: lerp3(a.position, b.position, t), tangent, right, up: normalize(cross(right, tangent)), distance, width: lerp(a.width, b.width, t) };
}

/** 按横截面拉伸、摆放，得出按材质槽分好的网格。 */
export function splineMeshes(file: SplineFile, where = file.name): SplineSlotMesh[] {
  checkSpline(file, where);
  const profile = file.profile, step = file.resolution ?? 2;
  const slots = Array.from({ length: SPLINE_SLOTS[profile.type] }, () => new MeshBuilder());
  if (profile.type === 'road') {
    const w = profile.width / 2, t = profile.thickness ?? 0.3, s = profile.shoulder ?? 0.5;
    const network = roadNetwork(file);
    network.paths.forEach((path, p) => {
      for (const [from, to] of network.kept[p]!) extrude(slots[0]!, resampleFrames(path.frames, from, to, step), [[-w - s, -t], [w + s, -t], [w, 0], [-w, 0]], true);
    });
    for (const junction of network.junctions) junctionMesh(slots[0]!, junction, t, s);
  } else {
    for (const path of splinePaths(file)) {
      const closed = path.closed ?? false;
      profileMeshes(slots, profile, sampleSpline(path.points, closed, step), closed);
    }
  }
  return slotMeshes(slots);
}

/** 道路以外的横截面沿一条路径拉伸、摆放。 */
function profileMeshes(slots: readonly MeshBuilder[], profile: Exclude<SplineFile['profile'], { type: 'road' }>, frames: readonly SplineFrame[], closed: boolean): void {
  switch (profile.type) {
    case 'tube': {
      const sides = Math.max(3, Math.round(profile.sides ?? 12));
      extrudeRound(slots[0]!, frames, profile.radius, sides, [0, 0]);
      break;
    }
    case 'custom':
      extrude(slots[0]!, frames, profile.shape, profile.closed ?? false);
      break;
    case 'river':
      // 河道没有几何：水面由水体画（world/Water.ts）
      break;
    case 'rail': {
      const gauge = profile.gauge ?? 1.435, spacing = profile.sleeperSpacing ?? 0.6;
      // 钢轨（宽 7 厘米、高 15 厘米）立在轨枕（高 15 厘米）上
      for (const side of [-1, 1]) {
        const x = side * (gauge / 2 + 0.035);
        extrude(slots[0]!, frames, [[x - 0.035, 0.15], [x + 0.035, 0.15], [x + 0.035, 0.3], [x - 0.035, 0.3]], true);
      }
      along(frames, spacing, closed, (frame) => box(slots[1]!, frame, gauge + 1.1, 0.15, 0.25, 0));
      break;
    }
    case 'fence': {
      const height = profile.height ?? 1.2, spacing = profile.postSpacing ?? 2.5, rails = Math.max(1, Math.round(profile.rails ?? 2));
      along(frames, spacing, closed, (frame) => box(slots[0]!, frame, 0.1, height, 0.1, 0));
      for (let i = 1; i <= rails; i++) {
        const y = (height * i) / (rails + 0.5);
        extrude(slots[1]!, frames, [[-0.025, y - 0.04], [0.025, y - 0.04], [0.025, y + 0.04], [-0.025, y + 0.04]], true);
      }
      break;
    }
    case 'wire': {
      const height = profile.poleHeight ?? 10, spacing = profile.poleSpacing ?? 40, sag = profile.sag ?? 1.5, wires = Math.max(1, Math.round(profile.wires ?? 3));
      const arm = (wires - 1) * 0.8 + 0.6;
      const poles: SplineFrame[] = [];
      along(frames, spacing, closed, (frame) => {
        poles.push(frame);
        box(slots[0]!, frame, 0.3, height, 0.3, 0);
        box(slots[0]!, frame, arm, 0.15, 0.15, height - 0.5);
      });
      // 相邻两根杆的横担之间挂导线：抛物线近似悬链线，中点下垂 sag
      for (let p = 0; p + 1 < poles.length; p++) {
        const a = poles[p]!, b = poles[p + 1]!;
        for (let i = 0; i < wires; i++) {
          const x = (i - (wires - 1) / 2) * 0.8;
          const from = add(add(a.position, scale(a.right, x)), scale(a.up, height - 0.35));
          const to = add(add(b.position, scale(b.right, x)), scale(b.up, height - 0.35));
          const line: Vec3[] = [];
          for (let k = 0; k <= 16; k++) {
            const t = k / 16;
            const point = lerp3(from, to, t);
            point[1] -= 4 * sag * t * (1 - t);
            line.push(point);
          }
          extrudeRound(slots[1]!, polylineFrames(line), 0.015, 4, [0, 0]);
        }
      }
      break;
    }
  }
}

/** 路口的一条路：第几条路径、在哪个控制点、往哪边走（1 是往路径的后面，-1 是往前面），路停在离路口中心多远（沿路径的弧长）。 */
export interface RoadArm {
  readonly path: number;
  readonly knot: number;
  readonly sign: 1 | -1;
  readonly trim: number;
}

/**
 * 一个路口：中心（路径上的那个控制点）、交汇的路（按水平面上的角度逆时针排）、顶面的轮廓（逆时针，从第一条路的端口开始），
 * curb[i] 是轮廓上 i 到 i + 1 这条边是不是路缘（转角；不是的是接着路的端口）。
 */
export interface RoadJunction {
  readonly position: Vec3;
  readonly arms: readonly RoadArm[];
  readonly outline: readonly Vec3[];
  readonly curb: readonly boolean[];
}

/** 路网：每条路径的采样和控制点的弧长，路口，每条路径去掉路口以后剩下的弧长区间（拉伸这些段）。 */
export interface RoadNetwork {
  readonly paths: readonly { readonly frames: readonly SplineFrame[]; readonly knots: readonly number[]; readonly closed: boolean }[];
  readonly junctions: readonly RoadJunction[];
  readonly kept: readonly (readonly (readonly [number, number])[])[];
}

/** 控制点焊在一起的容差：位置按厘米取整后相同。 */
export const splineWeldKey = (position: readonly number[]): string => position.map((c) => Math.round(c * 100)).join(',');
/** 转角的圆弧分几段。 */
const CORNER_SEGMENTS = 8;

/** 道路的路网：找出三条以上的路交汇的控制点，算各条路停在哪、路口的轮廓（见文件开头）。 */
export function roadNetwork(file: SplineFile): RoadNetwork {
  const profile = file.profile;
  const halfWidth = profile.type === 'road' ? profile.width / 2 : 0;
  const radius = profile.type === 'road' ? (profile.cornerRadius ?? profile.width / 2) : 0;
  const paths = splinePaths(file).map((path) => ({ ...samplePath(path.points, path.closed ?? false, file.resolution ?? 2), closed: path.closed ?? false, points: path.points }));
  // 焊点 → 从它出发的路（每个控制点往前、往后各一条，开放路径的两端只有一条）
  const nodes = new Map<string, { position: Vec3; arms: { path: number; knot: number; sign: 1 | -1 }[] }>();
  paths.forEach((path, p) => {
    path.points.forEach((point, k) => {
      const key = splineWeldKey(point.position);
      const node = nodes.get(key) ?? { position: [...point.position] as Vec3, arms: [] };
      nodes.set(key, node);
      if (k > 0 || path.closed) node.arms.push({ path: p, knot: k, sign: -1 });
      if (k < path.points.length - 1 || path.closed) node.arms.push({ path: p, knot: k, sign: 1 });
    });
  });
  const junctionNodes = [...nodes.values()].filter((node) => node.arms.length >= 3);
  const junctionKnots = paths.map((_, p) => new Set(junctionNodes.flatMap((node) => node.arms.filter((arm) => arm.path === p).map((arm) => arm.knot))));
  // 一条路最多退多远：到同一条路径上下一个路口的一半弱（两头的路口各占一半），到路径的一端的九成
  const room = (arm: { path: number; knot: number; sign: 1 | -1 }): number => {
    const path = paths[arm.path]!, n = path.points.length, total = path.knots.at(-1)!, at = path.knots[arm.knot]!;
    for (let step = 1; step <= n; step++) {
      const raw = arm.knot + arm.sign * step;
      if (!path.closed && (raw < 0 || raw >= n)) break;
      const k = ((raw % n) + n) % n;
      if (!junctionKnots[arm.path]!.has(k)) continue;
      const d = arm.sign > 0 ? path.knots[k]! - at : at - path.knots[k]!;
      return (path.closed ? (((d % total) + total) % total || total) : d) * 0.45;
    }
    if (path.closed) return total * 0.45;
    return (arm.sign > 0 ? total - at : at) * 0.9;
  };

  const junctions = junctionNodes.map((node): RoadJunction => {
    // 每条路离开路口的水平方向、路口处的半宽，按角度逆时针排
    const arms = node.arms.map((arm) => {
      const path = paths[arm.path]!;
      const frame = frameAt(path.frames, path.knots[arm.knot]!);
      const dx = frame.tangent[0] * arm.sign, dz = frame.tangent[2] * arm.sign, l = Math.hypot(dx, dz) || 1;
      return { ...arm, dir: [dx / l, dz / l] as const, half: halfWidth * frame.width, angle: Math.atan2(dz, dx), trim: 0 };
    }).sort((a, b) => a.angle - b.angle);
    // 相邻两条路（a 逆时针转到 b）：a 靠 b 那边的边线和 b 靠 a 那边的边线的交点（离中心 s、r 远）；夹角 180° 以上没有
    const corners = arms.map((a, i) => {
      const b = arms[(i + 1) % arms.length]!;
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      if (gap >= Math.PI - 0.05) return undefined;
      const pa = [-a.dir[1], a.dir[0]] as const, pb = [-b.dir[1], b.dir[0]] as const;
      // pa·wa + s·da = −pb·wb + r·db
      const rx = -pb[0] * b.half - pa[0] * a.half, rz = -pb[1] * b.half - pa[1] * a.half;
      const det = -a.dir[0] * b.dir[1] + b.dir[0] * a.dir[1];
      if (Math.abs(det) < 1e-9) return undefined;
      const s = (-rx * b.dir[1] + b.dir[0] * rz) / det, r = (a.dir[0] * rz - a.dir[1] * rx) / det;
      return { s: Math.max(0, s), r: Math.max(0, r), point: [pa[0] * a.half + a.dir[0] * s, pa[1] * a.half + a.dir[1] * s] as const };
    });
    arms.forEach((arm, i) => {
      const next = corners[i], previous = corners[(i - 1 + arms.length) % arms.length];
      arm.trim = Math.min(room(arm), Math.max(next?.s ?? 0, previous?.r ?? 0) + radius);
    });
    // 每条路的端口：靠上一条路那边的点、靠下一条路那边的点（路面的边，含侧倾和宽度倍数）
    const ports = arms.map((arm) => {
      const path = paths[arm.path]!;
      const frame = frameAt(path.frames, wrapDistance(path.knots[arm.knot]! + arm.sign * arm.trim, path.knots.at(-1)!, path.closed));
      const side = frame.right[0] * -arm.dir[1] + frame.right[2] * arm.dir[0] >= 0 ? 1 : -1;
      return { toPrevious: place(frame, -side * halfWidth, 0), toNext: place(frame, side * halfWidth, 0) };
    });
    const outline: Vec3[] = [], curb: boolean[] = [];
    arms.forEach((_, i) => {
      const port = ports[i]!, nextPort = ports[(i + 1) % arms.length]!;
      outline.push(port.toPrevious, port.toNext);
      curb.push(false, true);
      const corner = corners[i];
      if (!corner) return;
      const control: Vec3 = [node.position[0] + corner.point[0], (port.toNext[1] + nextPort.toPrevious[1]) / 2, node.position[2] + corner.point[1]];
      for (let k = 1; k < CORNER_SEGMENTS; k++) {
        const t = k / CORNER_SEGMENTS;
        outline.push(add(add(scale(port.toNext, (1 - t) ** 2), scale(control, 2 * t * (1 - t))), scale(nextPort.toPrevious, t * t)));
        curb.push(true);
      }
    });
    return { position: node.position, arms: arms.map(({ path, knot, sign, trim }) => ({ path, knot, sign, trim })), outline, curb };
  });

  // 每条路径去掉路口占的弧长以后剩下的区间
  const kept = paths.map((path, p) => {
    const total = path.knots.at(-1)!;
    const cuts: [number, number][] = [];
    for (const arm of junctions.flatMap((junction) => junction.arms)) {
      if (arm.path !== p) continue;
      const at = path.knots[arm.knot]!;
      const [a, b] = arm.sign > 0 ? [at, at + arm.trim] : [at - arm.trim, at];
      if (path.closed && a < 0) cuts.push([a + total, total], [0, b]);
      else if (path.closed && b > total) cuts.push([a, total], [0, b - total]);
      else cuts.push([Math.max(0, a), Math.min(total, b)]);
    }
    cuts.sort((x, y) => x[0] - y[0]);
    const spans: [number, number][] = [];
    let from = 0;
    for (const [a, b] of cuts) {
      if (a > from + 1e-6) spans.push([from, a]);
      from = Math.max(from, b);
    }
    if (total > from + 1e-6) spans.push([from, total]);
    return spans;
  });
  return { paths: paths.map(({ frames, knots, closed }) => ({ frames, knots, closed })), junctions, kept };
}

/**
 * 地面要贴着的中心线（地形贴样条用，每条大约每 step 米一个点），每条路径一条。道路经过路口时中间那段换成"端口中点 → 路口中心
 * → 端口中点"的直线（路口的顶面从中心扇形铺开，沿这些线正好是直的，地面贴着它们就贴着路口）；一条路径保持一条折线，段和段之间
 * 不重叠（折线的端头会往外多压半个宽度）。每个路口的路缘（转角）再各是一条，curb 为 true：转角离两条辐条都远，只靠辐条的话
 * 转角里原来的地会冒出来；地形给它们压得深一点（它们的端头盖到了路上，路往外是斜的）。别的横截面就是每条路径。
 */
export function splineCenterlines(file: SplineFile, step: number): { readonly points: Vec3[]; readonly curb: boolean }[] {
  if (file.profile.type !== 'road') return splinePaths(file).map((path) => ({ points: sampleSpline(path.points, path.closed ?? false, step).map((frame) => frame.position), curb: false }));
  const network = roadNetwork(file);
  // 路缘：轮廓上连着的路缘边（从一个端口靠下一条路的点，经过转角，到下一个端口靠这条路的点）
  const curbs = network.junctions.flatMap(({ outline, curb }) => {
    const runs: Vec3[][] = [];
    outline.forEach((point, i) => {
      if (!curb[i]) return;
      if (i === 0 || !curb[i - 1]) runs.push([point]);
      runs.at(-1)!.push(outline[(i + 1) % outline.length]!);
    });
    return runs.map((points) => ({ points, curb: true }));
  });
  const lines = network.paths.map((path, p) => {
    // 这条路径经过的路口中心（按弧长）
    const centers = network.junctions.flatMap((junction) => junction.arms.filter((arm) => arm.path === p).map((arm) => path.knots[arm.knot]!));
    const line: Vec3[] = [];
    const spans = network.kept[p]!;
    let at = 0;
    for (const [from, to] of spans) {
      // 上一段（或路径的起点）到这一段之间的路口：先到路口中心
      for (const center of centers) if (center >= at - 1e-6 && center <= from + 1e-6 && (line.length > 0 || center < from)) line.push(frameAt(path.frames, center).position);
      line.push(...resampleFrames(path.frames, from, to, step).map((frame) => frame.position));
      at = to;
    }
    const total = path.knots.at(-1)!;
    for (const center of centers) if (center >= at - 1e-6 && center <= total + 1e-6 && at < total) line.push(frameAt(path.frames, center).position);
    // 重复的中心（往前、往后两条路都记了同一个点）去掉
    return { points: line.filter((point, i) => i === 0 || point.some((c, k) => c !== line[i - 1]![k])), curb: false };
  });
  return [...lines, ...curbs];
}

/** 首尾相连的路径上弧长绕回 [0, total)；开放的夹在两端。 */
function wrapDistance(distance: number, total: number, closed: boolean): number {
  if (!closed) return Math.min(total, Math.max(0, distance));
  return ((distance % total) + total) % total;
}

/** 弧长 from 到 to 这一段重新等距取截面（大约每 step 米一个，两端都在）。 */
export function resampleFrames(frames: readonly SplineFrame[], from: number, to: number, step: number): SplineFrame[] {
  const count = Math.max(1, Math.ceil((to - from) / step));
  return Array.from({ length: count + 1 }, (_, k) => frameAt(frames, from + ((to - from) * k) / count));
}

/**
 * 路口的网格：顶面从中心扇形铺到轮廓（UV 是水平的世界坐标，米），路缘外侧照路的边坡往外 shoulder、往下 thickness。
 */
function junctionMesh(builder: MeshBuilder, junction: RoadJunction, thickness: number, shoulder: number): void {
  const up: Vec3 = [0, 1, 0];
  const { position: center, outline, curb } = junction;
  const c = builder.vertex(center, up, center[0], center[2]);
  const ring = outline.map((point) => builder.vertex(point, up, point[0], point[2]));
  for (let i = 0; i < ring.length; i++) builder.triangle(c, ring[i]!, ring[(i + 1) % ring.length]!, up);
  outline.forEach((a, i) => {
    if (!curb[i]) return;
    const b = outline[(i + 1) % outline.length]!;
    const ex = b[0] - a[0], ez = b[2] - a[2], l = Math.hypot(ex, ez);
    if (l < 1e-9) return;
    // 逆时针的轮廓（按 atan2(z, x) 转）：边的方向转 -90° 朝外
    const out = [ez / l, -ex / l] as const;
    const normal = normalize([out[0] * thickness, shoulder, out[1] * thickness]);
    const below = (p: Vec3): Vec3 => [p[0] + out[0] * shoulder, p[1] - thickness, p[2] + out[1] * shoulder];
    const a0 = builder.vertex(a, normal, 0, 0), b0 = builder.vertex(b, normal, l, 0);
    const b1 = builder.vertex(below(b), normal, l, 1), a1 = builder.vertex(below(a), normal, 0, 1);
    builder.quad(a0, b0, b1, a1, normal);
  });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 向心 Catmull-Rom（Barry–Goldman）：p1 到 p2 这一段上参数 u（0..1）处的点。 */
function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const knot = (a: Vec3, b: Vec3) => Math.max(1e-6, Math.sqrt(length(sub(b, a))));
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a: Vec3, b: Vec3, ta: number, tb: number) => lerp3(a, b, (t - ta) / (tb - ta));
  const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/** 截面上的一点（[右, 上]，米）在这个截面处的位置；右边按截面的宽度倍数伸缩。 */
function place(frame: SplineFrame, x: number, y: number): Vec3 {
  return add(add(frame.position, scale(frame.right, x * frame.width)), scale(frame.up, y));
}

/**
 * 沿路径拉伸折线截面（硬边：每条边单独一组顶点，法线垂直于这条边）。closed 时首尾相连；截面按逆时针给（[右, 上] 平面），
 * 法线朝外。U 沿截面的周长、V 沿路径，都按米。
 */
function extrude(builder: MeshBuilder, frames: readonly SplineFrame[], shape: readonly (readonly [number, number])[], closed: boolean): void {
  const edges = closed ? shape.length : shape.length - 1;
  let perimeter = 0;
  for (let e = 0; e < edges; e++) {
    const [ax, ay] = shape[e]!, [bx, by] = shape[(e + 1) % shape.length]!;
    const ex = bx - ax, ey = by - ay, edge = Math.hypot(ex, ey);
    if (edge === 0) continue;
    // 逆时针的截面：边的方向转 -90° 朝外
    const n2 = [ey / edge, -ex / edge] as const;
    let previous: [number, number] | undefined;
    for (const frame of frames) {
      const normal = normalize(add(scale(frame.right, n2[0]), scale(frame.up, n2[1])));
      const a = builder.vertex(place(frame, ax, ay), normal, perimeter, frame.distance);
      const b = builder.vertex(place(frame, bx, by), normal, perimeter + edge, frame.distance);
      if (previous) builder.quad(previous[0], previous[1], b, a, normal);
      previous = [a, b];
    }
    perimeter += edge;
  }
}

/** 沿路径拉伸圆截面（光滑的法线），圆心在截面的 center（[右, 上]）。 */
function extrudeRound(builder: MeshBuilder, frames: readonly SplineFrame[], radius: number, sides: number, center: readonly [number, number]): void {
  const rings: number[][] = [];
  for (const frame of frames) {
    const ring: number[] = [];
    for (let i = 0; i <= sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      const x = Math.cos(angle), y = Math.sin(angle);
      const normal = normalize(add(scale(frame.right, x), scale(frame.up, y)));
      ring.push(builder.vertex(place(frame, center[0] + x * radius, center[1] + y * radius), normal, (i / sides) * Math.PI * 2 * radius, frame.distance));
    }
    rings.push(ring);
  }
  for (let k = 1; k < rings.length; k++) {
    for (let i = 0; i < sides; i++) {
      const outward = normalize(sub(builder.vertices.slice(rings[k]![i]! * 8, rings[k]![i]! * 8 + 3), frames[k]!.position));
      builder.quad(rings[k - 1]![i]!, rings[k - 1]![i + 1]!, rings[k]![i + 1]!, rings[k]![i]!, outward);
    }
  }
}

/** 每隔 spacing 米（总长平均分，两端都有；首尾相连时终点和起点重合、不重复）在路径上调一次 place。 */
function along(frames: readonly SplineFrame[], spacing: number, closed: boolean, at: (frame: SplineFrame) => void): void {
  const total = frames.at(-1)!.distance;
  const count = Math.max(1, Math.round(total / Math.max(0.01, spacing)));
  for (let i = 0; i <= count - (closed ? 1 : 0); i++) at(frameAt(frames, (i / count) * total));
}

/** 截面处一个方块：横向 sx、高 sy（从截面往上 y0 起）、沿路径 sz（米），六个面硬边。 */
function box(builder: MeshBuilder, frame: SplineFrame, sx: number, sy: number, sz: number, y0: number): void {
  const center = add(frame.position, scale(frame.up, y0 + sy / 2));
  const axes = [scale(frame.right, sx / 2), scale(frame.up, sy / 2), scale(frame.tangent, sz / 2)] as const;
  const sizes = [sx, sy, sz];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const normal = normalize(scale(axes[axis]!, sign));
      const u = axes[(axis + 1) % 3]!, v = axes[(axis + 2) % 3]!;
      const c = add(center, scale(axes[axis]!, sign));
      const su = sizes[(axis + 1) % 3]!, sv = sizes[(axis + 2) % 3]!;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
        builder.vertex(add(add(c, scale(u, a!)), scale(v, b!)), normal, ((a! + 1) / 2) * su, ((b! + 1) / 2) * sv));
      builder.quad(corners[0]!, corners[1]!, corners[2]!, corners[3]!, normal);
    }
  }
}

/** 一串点（导线）的截面：切线按前后点，right 跟着世界的上方（同 sampleSpline）。 */
function polylineFrames(points: readonly Vec3[]): SplineFrame[] {
  let distance = 0;
  return points.map((position, k) => {
    if (k > 0) distance += length(sub(position, points[k - 1]!));
    const tangent = normalize(sub(points[Math.min(k + 1, points.length - 1)]!, points[Math.max(k - 1, 0)]!));
    let right = normalize(cross(tangent, [0, 1, 0]));
    if (length(right) < 0.5) right = [1, 0, 0];
    return { position, tangent, right, up: normalize(cross(right, tangent)), distance, width: 1 };
  });
}
