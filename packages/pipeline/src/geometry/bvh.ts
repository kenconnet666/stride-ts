/**
 * 三角网格的 BVH：射线求交（两面都算）和最近点查询。离线用（烘焙位移、量两个网格之间的距离），求的是简单可靠，
 * 不追求构建速度：按质心在最长轴上对半分，叶子最多 4 个三角形。
 *
 *   const bvh = new TriangleBvh(positions, indices);
 *   const t = bvh.rayCast([0, 0, -5], [0, 0, 1], 10);   // 沿方向的距离，没打到是 undefined
 *   const d = bvh.distanceTo([1, 2, 3]);                 // 到网格表面最近的距离
 */
type Vec3 = readonly [number, number, number];

const LEAF_SIZE = 4;

export class TriangleBvh {
  readonly #positions: Float32Array;
  /** 按叶子的顺序排好的三角形：每个 3 个顶点下标。 */
  readonly #triangles: Uint32Array;
  /** 每个节点 6 个 float：包围盒的 min、max。 */
  readonly #bounds: Float32Array;
  /** 每个节点 2 个 int：内部节点是 (左孩子, -1)，右孩子紧跟在左子树后面记在 #right；叶子是 (第一个三角形, 个数)。 */
  readonly #nodes: Int32Array;
  readonly #right: Int32Array;
  #nodeCount = 0;

  constructor(positions: Float32Array, indices: Uint32Array) {
    const count = indices.length / 3;
    this.#positions = positions;
    this.#triangles = new Uint32Array(indices.length);
    const maxNodes = Math.max(1, 2 * count);
    this.#bounds = new Float32Array(maxNodes * 6);
    this.#nodes = new Int32Array(maxNodes * 2);
    this.#right = new Int32Array(maxNodes);
    const centroids = new Float32Array(count * 3);
    for (let t = 0; t < count; t++) {
      for (let axis = 0; axis < 3; axis++) {
        centroids[t * 3 + axis] = (positions[indices[t * 3]! * 3 + axis]! + positions[indices[t * 3 + 1]! * 3 + axis]! + positions[indices[t * 3 + 2]! * 3 + axis]!) / 3;
      }
    }
    const order = Uint32Array.from({ length: count }, (_, i) => i);
    this.#build(order, 0, count, centroids, indices);
    for (let i = 0; i < count; i++) this.#triangles.set(indices.subarray(order[i]! * 3, order[i]! * 3 + 3), i * 3);
  }

  /** 沿 direction（单位向量）最近的交点的距离，在 (0, maxDistance] 里；正反面都算。 */
  rayCast(origin: Vec3, direction: Vec3, maxDistance: number): number | undefined {
    const inverse = [1 / direction[0], 1 / direction[1], 1 / direction[2]] as const;
    let best = maxDistance, found = false;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!this.#rayHitsBox(node, origin, inverse, best)) continue;
      const first = this.#nodes[node * 2]!, count = this.#nodes[node * 2 + 1]!;
      if (count < 0) {
        stack.push(first, this.#right[node]!);
        continue;
      }
      for (let t = first; t < first + count; t++) {
        const hit = this.#rayTriangle(t, origin, direction);
        if (hit !== undefined && hit <= best) {
          best = hit;
          found = true;
        }
      }
    }
    return found ? best : undefined;
  }

  /** 点到网格表面最近的距离。 */
  distanceTo(point: Vec3): number {
    let best = Infinity;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.#boxDistanceSquared(node, point) >= best) continue;
      const first = this.#nodes[node * 2]!, count = this.#nodes[node * 2 + 1]!;
      if (count < 0) {
        // 先看近的那个孩子，剪掉的更多
        const left = first, right = this.#right[node]!;
        const near = this.#boxDistanceSquared(left, point) <= this.#boxDistanceSquared(right, point);
        stack.push(near ? right : left, near ? left : right);
        continue;
      }
      for (let t = first; t < first + count; t++) best = Math.min(best, this.#pointTriangleSquared(t, point));
    }
    return Math.sqrt(best);
  }

  #build(order: Uint32Array, start: number, end: number, centroids: Float32Array, indices: Uint32Array): number {
    const node = this.#nodeCount++;
    const b = node * 6;
    this.#bounds.fill(Infinity, b, b + 3);
    this.#bounds.fill(-Infinity, b + 3, b + 6);
    const centroidMin = [Infinity, Infinity, Infinity], centroidMax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const t = order[i]!;
      for (let axis = 0; axis < 3; axis++) {
        for (let corner = 0; corner < 3; corner++) {
          const value = this.#positions[indices[t * 3 + corner]! * 3 + axis]!;
          this.#bounds[b + axis] = Math.min(this.#bounds[b + axis]!, value);
          this.#bounds[b + 3 + axis] = Math.max(this.#bounds[b + 3 + axis]!, value);
        }
        centroidMin[axis] = Math.min(centroidMin[axis]!, centroids[t * 3 + axis]!);
        centroidMax[axis] = Math.max(centroidMax[axis]!, centroids[t * 3 + axis]!);
      }
    }
    const extent = centroidMax.map((max, axis) => max - centroidMin[axis]!);
    const axis = extent.indexOf(Math.max(...extent));
    // 质心都重合时分不开，也当叶子
    if (end - start <= LEAF_SIZE || extent[axis] === 0) {
      this.#nodes[node * 2] = start;
      this.#nodes[node * 2 + 1] = end - start;
      return node;
    }
    const middle = (start + end) >> 1;
    selectNth(order, start, end, middle, (t) => centroids[t * 3 + axis]!);
    this.#nodes[node * 2] = this.#build(order, start, middle, centroids, indices);
    this.#nodes[node * 2 + 1] = -1;
    this.#right[node] = this.#build(order, middle, end, centroids, indices);
    return node;
  }

  #rayHitsBox(node: number, origin: Vec3, inverse: Vec3, maxDistance: number): boolean {
    const b = node * 6;
    let near = 0, far = maxDistance;
    for (let axis = 0; axis < 3; axis++) {
      const a = (this.#bounds[b + axis]! - origin[axis]!) * inverse[axis]!;
      const c = (this.#bounds[b + 3 + axis]! - origin[axis]!) * inverse[axis]!;
      near = Math.max(near, Math.min(a, c));
      far = Math.min(far, Math.max(a, c));
    }
    return near <= far;
  }

  /** Möller–Trumbore，不分正反面；返回 t > 0 的交点。 */
  #rayTriangle(triangle: number, origin: Vec3, direction: Vec3): number | undefined {
    const p = this.#positions;
    const a = this.#triangles[triangle * 3]! * 3, b = this.#triangles[triangle * 3 + 1]! * 3, c = this.#triangles[triangle * 3 + 2]! * 3;
    const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
    const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
    const px = direction[1] * e2z - direction[2] * e2y, py = direction[2] * e2x - direction[0] * e2z, pz = direction[0] * e2y - direction[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-20) return undefined;
    const inv = 1 / det;
    const tx = origin[0] - p[a]!, ty = origin[1] - p[a + 1]!, tz = origin[2] - p[a + 2]!;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return undefined;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv;
    if (v < 0 || u + v > 1) return undefined;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > 0 ? t : undefined;
  }

  #boxDistanceSquared(node: number, point: Vec3): number {
    const b = node * 6;
    let sum = 0;
    for (let axis = 0; axis < 3; axis++) {
      const d = Math.max(this.#bounds[b + axis]! - point[axis]!, 0, point[axis]! - this.#bounds[b + 3 + axis]!);
      sum += d * d;
    }
    return sum;
  }

  /** 点到三角形最近点的距离平方（Ericson，Real-Time Collision Detection 5.1.5：按重心坐标的区域分情况）。 */
  #pointTriangleSquared(triangle: number, point: Vec3): number {
    const p = this.#positions;
    const ia = this.#triangles[triangle * 3]! * 3, ib = this.#triangles[triangle * 3 + 1]! * 3, ic = this.#triangles[triangle * 3 + 2]! * 3;
    const abx = p[ib]! - p[ia]!, aby = p[ib + 1]! - p[ia + 1]!, abz = p[ib + 2]! - p[ia + 2]!;
    const acx = p[ic]! - p[ia]!, acy = p[ic + 1]! - p[ia + 1]!, acz = p[ic + 2]! - p[ia + 2]!;
    const apx = point[0] - p[ia]!, apy = point[1] - p[ia + 1]!, apz = point[2] - p[ia + 2]!;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    // 最近点 = a + ab * v + ac * w
    let v: number, w: number;
    if (d1 <= 0 && d2 <= 0) {
      v = 0; w = 0;
    } else {
      const bpx = point[0] - p[ib]!, bpy = point[1] - p[ib + 1]!, bpz = point[2] - p[ib + 2]!;
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      const cpx = point[0] - p[ic]!, cpy = point[1] - p[ic + 1]!, cpz = point[2] - p[ic + 2]!;
      const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
      const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) {
        v = 1; w = 0;
      } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        v = d1 / (d1 - d3); w = 0;
      } else if (d6 >= 0 && d5 <= d6) {
        v = 0; w = 1;
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        v = 0; w = d2 / (d2 - d6);
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        w = (d4 - d3) / (d4 - d3 + (d5 - d6)); v = 1 - w;
      } else {
        const denominator = 1 / (va + vb + vc);
        v = vb * denominator; w = vc * denominator;
      }
    }
    const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
    return dx * dx + dy * dy + dz * dz;
  }
}

/** 把 order[start, end) 重排成第 nth 个位置上是按 key 排第 nth 的元素，前面的都不比它大（快速选择）。 */
function selectNth(order: Uint32Array, start: number, end: number, nth: number, key: (item: number) => number): void {
  let low = start, high = end - 1;
  while (low < high) {
    const pivot = key(order[(low + high) >> 1]!);
    let i = low, j = high;
    while (i <= j) {
      while (key(order[i]!) < pivot) i++;
      while (key(order[j]!) > pivot) j--;
      if (i <= j) {
        const swap = order[i]!;
        order[i] = order[j]!;
        order[j] = swap;
        i++;
        j--;
      }
    }
    if (nth <= j) high = j;
    else if (nth >= i) low = i;
    else return;
  }
}
