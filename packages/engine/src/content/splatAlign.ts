/**
 * 几段扫描合并、对齐（`.splatedit.json` 的 merge，格式见 content/formats/splatEditFormat.ts）：
 * - transformSplats：一段泼溅按相似变换（统一缩放、旋转、平移）放进源泼溅的坐标——位置、朝向、半轴长跟着变，视角相关的颜色
 *   （高阶球谐）跟着转：转过的系数 c' 要对每个方向 d 满足 Σ c'·Y(d) = Σ c·Y(Rᵀd)，在一组固定的方向上最小二乘一次就是那个
 *   旋转矩阵（每一阶的空间在旋转下封闭，PlayCanvas splat-transform 的 rotate-sh.ts 第 4 阶就是这么做的；我们 1～3 阶都这样，
 *   基同渲染器的 shColor）。
 * - alignSplats：ICP 把一段扫描对到另一段上，带缩放（Horn 1987 的四元数法求相似变换；手机扫的几段比例不一样）。只拿不透明的
 *   泼溅当表面上的点（各抽几万个），按 k-d 树找最近的，配对的距离上限一圈圈收紧。
 * 纯函数，编辑器后端烘焙、"自动对齐"、测试都用。
 */
import type { SplatEditPart } from './formats/splatEditFormat.ts';
import { shCoefficients, type SplatSource } from './splatFile.ts';

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

/** 相似变换：p' = scale · R(rotation) · p + position。 */
export interface SplatTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: number;
}

export const IDENTITY_TRANSFORM: SplatTransform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };

/** 合并的那一段的变换（没写的取恒等）。 */
export function partTransform(part: SplatEditPart): SplatTransform {
  return { position: part.position ?? [0, 0, 0], rotation: part.rotation ?? [0, 0, 0, 1], scale: part.scale ?? 1 };
}

/** 几段泼溅连成一段（球谐的阶数取最少的那段：多出来的系数丢掉）。 */
export function concatSplats(parts: readonly SplatSource[]): SplatSource {
  const count = parts.reduce((sum, part) => sum + part.count, 0);
  const bands = Math.min(...parts.map((part) => (part.sh ? part.shBands ?? 0 : 0)));
  const per = shCoefficients(bands) * 3;
  const join = (pick: (part: SplatSource) => Float32Array, stride: number) => {
    const out = new Float32Array(count * stride);
    let at = 0;
    for (const part of parts) {
      out.set(pick(part).subarray(0, part.count * stride), at);
      at += part.count * stride;
    }
    return out;
  };
  const sh = per > 0 ? new Float32Array(count * per) : undefined;
  if (sh) {
    let at = 0;
    for (const part of parts) {
      // 阶数比要的多的那段：每个通道只拷前面的系数
      const n = shCoefficients(part.shBands!), keep = shCoefficients(bands);
      for (let i = 0; i < part.count; i++) for (let c = 0; c < 3; c++) sh.set(part.sh!.subarray(i * n * 3 + c * n, i * n * 3 + c * n + keep), (at + i) * per + c * keep);
      at += part.count;
    }
  }
  return {
    count, positions: join((p) => p.positions, 3), scales: join((p) => p.scales, 3), rotations: join((p) => p.rotations, 4), colors: join((p) => p.colors, 4),
    ...(sh ? { shBands: bands, sh } : {}),
  };
}

/** 一段泼溅按相似变换放进别的坐标（新的一份）。 */
export function transformSplats(source: SplatSource, transform: SplatTransform): SplatSource {
  const { count } = source, { position, rotation: q, scale } = transform;
  const r = rotationMatrix(q);
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), rotations = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const p = apply(r, [source.positions[i * 3]!, source.positions[i * 3 + 1]!, source.positions[i * 3 + 2]!]);
    positions.set([scale * p[0] + position[0], scale * p[1] + position[1], scale * p[2] + position[2]], i * 3);
    scales.set([source.scales[i * 3]! * scale, source.scales[i * 3 + 1]! * scale, source.scales[i * 3 + 2]! * scale], i * 3);
    rotations.set(multiply(q, [source.rotations[i * 4]!, source.rotations[i * 4 + 1]!, source.rotations[i * 4 + 2]!, source.rotations[i * 4 + 3]!]), i * 4);
  }
  const bands = source.sh ? source.shBands ?? 0 : 0;
  let sh = source.sh;
  if (sh && bands > 0) {
    const matrices = shRotation(r, bands), n = shCoefficients(bands), rotated = new Float32Array(sh.length);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) {
        const base = i * n * 3 + c * n;
        let offset = 0;
        for (const m of matrices) {
          const size = Math.sqrt(m.length);
          for (let row = 0; row < size; row++) {
            let sum = 0;
            for (let col = 0; col < size; col++) sum += m[row * size + col]! * sh[base + offset + col]!;
            rotated[base + offset + row] = sum;
          }
          offset += size;
        }
      }
    }
    sh = rotated;
  }
  return { count, positions, scales, rotations, colors: source.colors, ...(sh ? { shBands: bands, sh } : {}) };
}

/** 球谐每一阶（1..bands）的基，同渲染器的 shColor（3DGS 的实数球谐，顺序和符号一样）。 */
function shBasis(band: number, [x, y, z]: Vec3): number[] {
  const xx = x * x, yy = y * y, zz = z * z;
  if (band === 1) return [-0.4886025 * y, 0.4886025 * z, -0.4886025 * x];
  if (band === 2) return [1.0925484 * x * y, -1.0925484 * y * z, 0.3153916 * (2 * zz - xx - yy), -1.0925484 * x * z, 0.5462742 * (xx - yy)];
  return [
    -0.5900436 * y * (3 * xx - yy), 2.8906114 * x * y * z, -0.4570458 * y * (4 * zz - xx - yy), 0.3731763 * z * (2 * zz - 3 * xx - 3 * yy),
    -0.4570458 * x * (4 * zz - xx - yy), 1.4453057 * z * (xx - yy), -0.5900436 * x * (xx - 3 * yy),
  ];
}

/** 投影用的方向（斐波那契球面上均匀的 64 个）和每一阶的基在它们上的伪逆，第一次用到时算。 */
let projection: { readonly directions: Vec3[]; readonly inverses: number[][] } | undefined;
const DIRECTIONS = 64;

function shProjection(): NonNullable<typeof projection> {
  if (projection) return projection;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const directions = Array.from({ length: DIRECTIONS }, (_, k): Vec3 => {
    const z = 1 - (2 * (k + 0.5)) / DIRECTIONS, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(golden * k), r * Math.sin(golden * k), z];
  });
  // 每一阶：A（方向 × 基）的伪逆 (AᵀA)⁻¹Aᵀ
  const inverses = [1, 2, 3].map((band) => {
    const a = directions.map((d) => shBasis(band, d)), size = 2 * band + 1;
    const normal = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => a.reduce((sum, row) => sum + row[i]! * row[j]!, 0)));
    const inverse = invert(normal);
    return Array.from({ length: size * DIRECTIONS }, (_, index) => {
      const i = Math.floor(index / DIRECTIONS), k = index % DIRECTIONS;
      return inverse[i]!.reduce((sum, value, j) => sum + value * a[k]![j]!, 0);
    });
  });
  return (projection = { directions, inverses });
}

/** 旋转 r（3×3，行主序）下球谐 1..bands 阶的旋转矩阵（每阶 (2l+1)²，行主序）。 */
export function shRotation(r: readonly number[], bands: number): number[][] {
  const { directions, inverses } = shProjection();
  // Rᵀd：行主序的 r，(Rᵀd)_i = Σ_j r[j][i] d_j
  const turned = directions.map(([x, y, z]): Vec3 => [r[0]! * x + r[3]! * y + r[6]! * z, r[1]! * x + r[4]! * y + r[7]! * z, r[2]! * x + r[5]! * y + r[8]! * z]);
  return Array.from({ length: bands }, (_, b) => {
    const band = b + 1, size = 2 * band + 1, inverse = inverses[b]!;
    const values = turned.map((d) => shBasis(band, d));
    return Array.from({ length: size * size }, (_, index) => {
      const i = Math.floor(index / size), j = index % size;
      let sum = 0;
      for (let k = 0; k < DIRECTIONS; k++) sum += inverse[i * DIRECTIONS + k]! * values[k]![j]!;
      return sum;
    });
  });
}

/** 对齐的结果：变换、配上的点数、配上的点之间的均方根距离（米）。 */
export interface SplatAlignment {
  readonly transform: SplatTransform;
  readonly matched: number;
  readonly error: number;
}

/**
 * 把 moving（一段扫描自己的坐标）对到 target 上，从 start 开始迭代：每次把 moving 的采样点按现在的变换放过去，在 target 里找
 * 最近的（不超过配对距离），按配上的点对求整个相似变换（不是累加：每次都从 moving 自己的坐标求，误差不攒）；一档配对距离里
 * 迭代到误差不再变小，再收 0.7 倍，到 minDistance 为止，一共最多 iterations 次。
 */
export function alignSplats(target: SplatSource, moving: SplatSource, start: SplatTransform, options: { readonly maxDistance?: number; readonly minDistance?: number; readonly iterations?: number; readonly samples?: number } = {}): SplatAlignment {
  const samples = options.samples ?? 20000, minDistance = options.minDistance ?? 0.02;
  let distance = options.maxDistance ?? 0.5;
  const targetPoints = surfacePoints(target, samples * 4), movingPoints = surfacePoints(moving, samples);
  const tree = new PointTree(targetPoints);
  let transform = start, matched = 0, error = Infinity, atLevel = 0;
  for (let iteration = 0; iteration < (options.iterations ?? 100); iteration++) {
    const r = rotationMatrix(transform.rotation), s = transform.scale, [tx, ty, tz] = transform.position;
    const from: number[] = [], to: number[] = [];
    let squared = 0;
    for (let i = 0; i < movingPoints.length; i += 3) {
      const x = movingPoints[i]!, y = movingPoints[i + 1]!, z = movingPoints[i + 2]!;
      const hit = tree.nearest(s * (r[0]! * x + r[1]! * y + r[2]! * z) + tx, s * (r[3]! * x + r[4]! * y + r[5]! * z) + ty, s * (r[6]! * x + r[7]! * y + r[8]! * z) + tz, distance);
      if (hit < 0) continue;
      from.push(x, y, z);
      to.push(tree.points[hit]!, tree.points[hit + 1]!, tree.points[hit + 2]!);
      squared += tree.lastDistance2;
    }
    matched = from.length / 3;
    if (matched < 3) break;
    const previous = error;
    error = Math.sqrt(squared / matched);
    transform = similarity(from, to);
    // 这一档配对距离里误差不再变小（或者迭代了 8 次）才收紧：一下收得太快，比例和平移会一起停在半路（两者在平面上能互相抵）
    atLevel++;
    if (previous - error > error * 1e-3 && atLevel < 8) continue;
    if (distance <= minDistance) break;
    distance = Math.max(minDistance, distance * 0.7);
    atLevel = 0;
  }
  return { transform, matched, error };
}

/** 当表面上的点用的泼溅（不透明度 ≥ 0.5）的中心，均匀地隔着抽到 limit 个以内。 */
function surfacePoints(source: SplatSource, limit: number): Float32Array {
  const solid: number[] = [];
  for (let i = 0; i < source.count; i++) if (source.colors[i * 4 + 3]! >= 0.5) solid.push(i);
  const step = Math.max(1, solid.length / limit), out: number[] = [];
  for (let k = 0; k < solid.length; k = Math.floor(k + step) === k ? k + 1 : Math.floor(k + step)) {
    const i = solid[k]!;
    out.push(source.positions[i * 3]!, source.positions[i * 3 + 1]!, source.positions[i * 3 + 2]!);
  }
  return Float32Array.from(out);
}

/**
 * 找最近的点用的 k-d 树：点的下标按每层轮着的轴、中位数分成左右两半（隐式的平衡树，存在一个数组里），查的时候先下到点所在的
 * 那一半，回来时只看分界面离得比现在找到的还近的另一半。不管配对距离多大，一次都是对数级的（格子在距离大时一格里点太多）。
 */
class PointTree {
  readonly points: Float32Array;
  readonly #order: Int32Array;
  /** 上一次 nearest 找到的点的距离的平方。 */
  lastDistance2 = 0;
  #best = 0;
  #found = -1;

  constructor(points: Float32Array) {
    this.points = points;
    this.#order = Int32Array.from({ length: points.length / 3 }, (_, i) => i * 3);
    this.#build(0, this.#order.length, 0);
  }

  /** 离 (x, y, z) 最近、不超过 within 的点在 points 里的下标（xyz 的第一个）；没有时 −1。 */
  nearest(x: number, y: number, z: number, within: number): number {
    this.#best = within * within;
    this.#found = -1;
    this.#search(0, this.#order.length, 0, x, y, z);
    this.lastDistance2 = this.#best;
    return this.#found;
  }

  #build(lo: number, hi: number, axis: number): void {
    if (hi - lo <= 1) return;
    const mid = (lo + hi) >> 1;
    this.#select(lo, hi - 1, mid, axis);
    this.#build(lo, mid, (axis + 1) % 3);
    this.#build(mid + 1, hi, (axis + 1) % 3);
  }

  /** 快速选择：把第 k 小的（按 axis）放到 k，左边的都不比它大、右边的都不比它小。 */
  #select(lo: number, hi: number, k: number, axis: number): void {
    const order = this.#order, points = this.points;
    while (hi > lo) {
      const pivot = points[order[(lo + hi) >> 1]! + axis]!;
      let i = lo, j = hi;
      while (i <= j) {
        while (points[order[i]! + axis]! < pivot) i++;
        while (points[order[j]! + axis]! > pivot) j--;
        if (i <= j) {
          const t = order[i]!;
          order[i] = order[j]!;
          order[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  #search(lo: number, hi: number, axis: number, x: number, y: number, z: number): void {
    if (hi <= lo) return;
    const mid = (lo + hi) >> 1, i = this.#order[mid]!, points = this.points;
    const dx = points[i]! - x, dy = points[i + 1]! - y, dz = points[i + 2]! - z, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < this.#best) {
      this.#best = d2;
      this.#found = i;
    }
    const gap = (axis === 0 ? x : axis === 1 ? y : z) - points[i + axis]!, next = (axis + 1) % 3;
    // 先找点所在的那一半，另一半只在分界面比现在最近的还近时看
    if (gap < 0) {
      this.#search(lo, mid, next, x, y, z);
      if (gap * gap < this.#best) this.#search(mid + 1, hi, next, x, y, z);
    } else {
      this.#search(mid + 1, hi, next, x, y, z);
      if (gap * gap < this.#best) this.#search(lo, mid, next, x, y, z);
    }
  }
}

/** 点对（from → to，各是 xyz 连着放）的最小二乘相似变换：Horn 的四元数法求旋转，再求缩放、平移。 */
export function similarity(from: readonly number[], to: readonly number[]): SplatTransform {
  const n = from.length / 3;
  const mean = (points: readonly number[]) => [0, 1, 2].map((k) => points.reduce((sum, v, i) => (i % 3 === k ? sum + v : sum), 0) / n);
  const mp = mean(from), mq = mean(to);
  const s = Array.from({ length: 9 }, () => 0);
  let fromSpread = 0;
  for (let i = 0; i < n; i++) {
    const p = [0, 1, 2].map((k) => from[i * 3 + k]! - mp[k]!), q = [0, 1, 2].map((k) => to[i * 3 + k]! - mq[k]!);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s[a * 3 + b]! += p[a]! * q[b]!;
    fromSpread += p[0]! ** 2 + p[1]! ** 2 + p[2]! ** 2;
  }
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = s as [number, number, number, number, number, number, number, number, number];
  // Horn 的 4×4 对称矩阵（四元数 w x y z 的顺序），最大的特征值的特征向量是旋转
  const m = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const [w, x, y, z] = largestEigenvector(m) as [number, number, number, number];
  const rotation = normalizeQuat([x, y, z, w]);
  const r = rotationMatrix(rotation);
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = apply(r, [from[i * 3]! - mp[0]!, from[i * 3 + 1]! - mp[1]!, from[i * 3 + 2]! - mp[2]!]);
    along += p[0] * (to[i * 3]! - mq[0]!) + p[1] * (to[i * 3 + 1]! - mq[1]!) + p[2] * (to[i * 3 + 2]! - mq[2]!);
  }
  const scale = fromSpread > 0 ? along / fromSpread : 1;
  const turned = apply(r, [mp[0]!, mp[1]!, mp[2]!]);
  return { position: [mq[0]! - scale * turned[0], mq[1]! - scale * turned[1], mq[2]! - scale * turned[2]], rotation, scale };
}

/** 4×4 对称矩阵的最大特征值的特征向量（雅可比旋转）。 */
function largestEigenvector(input: readonly (readonly number[])[]): number[] {
  const a = input.map((row) => [...row]), v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p]![q]! ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p]![q]!) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k]![p]!, akq = a[k]![q]!;
          a[k]![p] = c * akp - sn * akq;
          a[k]![q] = sn * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p]![k]!, aqk = a[q]![k]!;
          a[p]![k] = c * apk - sn * aqk;
          a[q]![k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k]![p]!, vkq = v[k]![q]!;
          v[k]![p] = c * vkp - sn * vkq;
          v[k]![q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i;
  return v.map((row) => row[best]!);
}

/** 小方阵求逆（高斯-约当）。 */
function invert(matrix: readonly (readonly number[])[]): number[][] {
  const n = matrix.length, m = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    [m[c], m[pivot]] = [m[pivot]!, m[c]!];
    const inverse = 1 / m[c]![c]!;
    for (let j = 0; j < 2 * n; j++) m[c]![j]! *= inverse;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]!;
      if (f !== 0) for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

/** 四元数（xyzw）的旋转矩阵，行主序。 */
export function rotationMatrix([x, y, z, w]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

function apply(r: readonly number[], [x, y, z]: Vec3): [number, number, number] {
  return [r[0]! * x + r[1]! * y + r[2]! * z, r[3]! * x + r[4]! * y + r[5]! * z, r[6]! * x + r[7]! * y + r[8]! * z];
}

function multiply([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): [number, number, number, number] {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

function normalizeQuat(q: readonly number[]): [number, number, number, number] {
  const l = Math.hypot(...q) || 1, sign = q[3]! < 0 ? -1 : 1;
  return [(q[0]! / l) * sign, (q[1]! / l) * sign, (q[2]! / l) * sign, (q[3]! / l) * sign];
}
