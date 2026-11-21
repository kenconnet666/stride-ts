/**
 * 样条（content/splineFormat.ts 的 SplineFile）的几何：路径按弧长采样成带朝向的截面（sampleSpline、frameAt），按横截面拉伸、
 * 沿路摆立柱和轨枕、在电杆之间挂下垂的导线，得出按材质槽分好的三角形网格（编辑器后端烘成模型用，pipeline 的 splineModel.ts）。
 * 地形贴合、车道图、列车沿路走以后也用这里的采样。
 *
 * - 路径：向心 Catmull-Rom（alpha 0.5，Barry–Goldman 的写法）经过每个控制点，开放的两端按反射补一个点；先每段密采样、按累计
 *   弧长重新等距取点；
 * - 朝向：right = 切线 × 世界上方（路面不随路径侧翻，竖直的一段沿用上一个），up = right × 切线；控制点的 tilt 让它绕切线转；
 * - 顶点同多边形网格：每个 8 个数（位置、法线、UV），UV 按米（贴图每米重复一次，同白盒），三角形逆时针是正面。
 */
import { SPLINE_SLOTS, type SplineFile, type SplinePointFile } from '../content/splineFormat.ts';

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

/** 一个材质槽的三角形网格（同 polyMesh.ts 的 PolySlotMesh）。 */
export interface SplineSlotMesh {
  readonly material: number;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

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
  if (!Array.isArray(file.points) || file.points.length < 2) fail('a spline needs at least 2 points');
  file.points.forEach((point, i) => {
    if (!Array.isArray(point.position) || point.position.length !== 3 || !point.position.every(Number.isFinite)) fail(`points[${i}].position must be 3 finite numbers`);
    if (point.width !== undefined && !(point.width > 0)) fail(`points[${i}].width must be positive`);
  });
  if (file.resolution !== undefined && !(file.resolution > 0)) fail('resolution must be positive');
  const p = file.profile;
  if (!p || !['road', 'tube', 'custom', 'rail', 'fence', 'wire'].includes(p.type)) fail("profile.type must be one of road, tube, custom, rail, fence, wire");
  if (p.type === 'road' && !(p.width > 0)) fail('profile.width must be positive');
  if (p.type === 'tube' && !(p.radius > 0)) fail('profile.radius must be positive');
  if (p.type === 'custom' && (!Array.isArray(p.shape) || p.shape.length < 2)) fail('profile.shape needs at least 2 [right, up] points');
  return file;
}

/**
 * 路径按弧长采样：大约每 step 米一个截面（总长平均分，最后一个正好在终点；首尾相连时最后一个和第一个重合）。控制点的 tilt、
 * width 沿路径线性过渡。
 */
export function sampleSpline(points: readonly SplinePointFile[], closed: boolean, step: number): SplineFrame[] {
  const n = points.length;
  const at = (i: number): Vec3 => {
    if (closed) return [...points[((i % n) + n) % n]!.position] as Vec3;
    if (i < 0) return sub(scale(points[0]!.position, 2), points[1]!.position);
    if (i >= n) return sub(scale(points[n - 1]!.position, 2), points[n - 2]!.position);
    return [...points[i]!.position] as Vec3;
  };
  const segments = closed ? n : n - 1;
  // 密采样：位置和控制点上的 tilt、width（按段内的参数线性插值）
  const dense: { position: Vec3; tilt: number; width: number }[] = [];
  for (let s = 0; s < segments; s++) {
    const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
    const a = points[s % n]!, b = points[(s + 1) % n]!;
    for (let k = 0; k < DENSE_PER_SEGMENT || (s === segments - 1 && k === DENSE_PER_SEGMENT); k++) {
      const u = k / DENSE_PER_SEGMENT;
      dense.push({ position: catmullRom(p0, p1, p2, p3, u), tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, u), width: lerp(a.width ?? 1, b.width ?? 1, u) });
    }
  }
  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1]! + length(sub(dense[i]!.position, dense[i - 1]!.position)));
  const total = lengths.at(-1)!;
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
  return samples.map((sample, k) => {
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
  const frames = sampleSpline(file.points, file.closed ?? false, file.resolution ?? 2);
  const profile = file.profile;
  const slots = Array.from({ length: SPLINE_SLOTS[profile.type] }, () => new MeshBuilder());
  switch (profile.type) {
    case 'road': {
      const w = profile.width / 2, t = profile.thickness ?? 0.3, s = profile.shoulder ?? 0.5;
      extrude(slots[0]!, frames, [[-w - s, -t], [w + s, -t], [w, 0], [-w, 0]], true);
      break;
    }
    case 'tube': {
      const sides = Math.max(3, Math.round(profile.sides ?? 12));
      extrudeRound(slots[0]!, frames, profile.radius, sides, [0, 0]);
      break;
    }
    case 'custom':
      extrude(slots[0]!, frames, profile.shape, profile.closed ?? false);
      break;
    case 'rail': {
      const gauge = profile.gauge ?? 1.435, spacing = profile.sleeperSpacing ?? 0.6;
      // 钢轨（宽 7 厘米、高 15 厘米）立在轨枕（高 15 厘米）上
      for (const side of [-1, 1]) {
        const x = side * (gauge / 2 + 0.035);
        extrude(slots[0]!, frames, [[x - 0.035, 0.15], [x + 0.035, 0.15], [x + 0.035, 0.3], [x - 0.035, 0.3]], true);
      }
      along(frames, spacing, file.closed ?? false, (frame) => box(slots[1]!, frame, gauge + 1.1, 0.15, 0.25, 0));
      break;
    }
    case 'fence': {
      const height = profile.height ?? 1.2, spacing = profile.postSpacing ?? 2.5, rails = Math.max(1, Math.round(profile.rails ?? 2));
      along(frames, spacing, file.closed ?? false, (frame) => box(slots[0]!, frame, 0.1, height, 0.1, 0));
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
      along(frames, spacing, file.closed ?? false, (frame) => {
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
  return slots.flatMap((builder, material) => (builder.indices.length === 0 ? [] : [{ material, vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices) }]));
}

class MeshBuilder {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];

  vertex(position: readonly number[], normal: readonly number[], u: number, v: number): number {
    this.vertices.push(position[0]!, position[1]!, position[2]!, normal[0]!, normal[1]!, normal[2]!, u, v);
    return this.vertices.length / 8 - 1;
  }

  /** 四边形 a b c d：按法线定绕向（逆时针朝着法线是正面）。 */
  quad(a: number, b: number, c: number, d: number, normal: readonly number[]): void {
    const p = (i: number) => this.vertices.slice(i * 8, i * 8 + 3);
    const facing = dot(cross(sub(p(b), p(a)), sub(p(c), p(a))), normal);
    if (facing >= 0) this.indices.push(a, b, c, a, c, d);
    else this.indices.push(a, c, b, a, d, c);
  }
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
