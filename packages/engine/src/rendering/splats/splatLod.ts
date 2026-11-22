/**
 * 高斯泼溅的细节层次怎么选（每个视图、每个泼溅实体，每帧）：从根开始，误差最大的节点先往下细分——误差是节点这一级的粗细
 * （SplatNode.detail，米）投到屏幕上有几个像素；不到 pixelError 个像素、是叶子、或者再细分就超出预算的节点画自己那一级。
 * 整个在视锥外面的节点（包围盒按泼溅的 3σ）连同子孙都不画；按需加载时子节点的数据还没到的也画自己那一级（缺的报出来去读）。纯函数，渲染器（SplatRenderer）和测试用。
 *
 * 选的是一刀：选中的节点互不包含，合起来盖住看得见的部分。参考 PlayCanvas 的 gsplat-octree-instance（按距离和预算选级）。
 */
import type { SplatNode } from '../../content/splatFile';

/** 选节点要的视图信息，都在泼溅自己的坐标里（实体的变换已经反算过来）。 */
export interface SplatLodView {
  /** 相机的位置。 */
  readonly eye: readonly [number, number, number];
  /** 一米在一米远处是几个像素（焦距，像素；节点的粗细和到相机的距离在泼溅坐标里一起缩放，实体的缩放不用管）。 */
  readonly pixelsPerUnit: number;
  /** 朝内的视锥平面（每个 xyzw，n·p + w ≥ 0 在里面，n 不必单位长）；没有时不剔除。 */
  readonly planes?: Float32Array;
}

/** 选的参数：总共最多画几个泼溅、一级的粗细投到屏幕上不超过几个像素。 */
export interface SplatLodLimits {
  readonly budget: number;
  readonly pixelError: number;
}

/**
 * 按需加载时：ready 是每个节点的数据到了没有（没给时都到了）；wanted 收要细分却没到的节点（按误差从大到小，清空后写），
 * 交给资源去读——没到的子节点所在的节点先画自己那一级。
 */
export interface SplatLodLoading {
  readonly ready?: Uint8Array;
  readonly wanted?: number[];
}

/** 选一刀，选中的节点下标写进 out（清空后写），返回它们的泼溅总数。 */
export function selectSplatNodes(nodes: readonly SplatNode[], view: SplatLodView, limits: SplatLodLimits, out: number[], { ready, wanted }: SplatLodLoading = {}): number {
  out.length = 0;
  if (wanted) wanted.length = 0;
  const root = nodes[0];
  if (!root || !visible(root, view.planes)) return 0;
  if (ready && !ready[0]) {
    wanted?.push(0);
    return 0;
  }
  // 按误差从大到小的堆（误差相同的先后不要紧）
  const heap: { node: number; error: number }[] = [];
  const push = (node: number) => {
    heap.push({ node, error: projectedError(nodes[node]!, view) });
    for (let i = heap.length - 1; i > 0;) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.error >= heap[i]!.error) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        const left = i * 2 + 1, right = left + 1;
        let largest = i;
        if (left < heap.length && heap[left]!.error > heap[largest]!.error) largest = left;
        if (right < heap.length && heap[right]!.error > heap[largest]!.error) largest = right;
        if (largest === i) break;
        [heap[largest], heap[i]] = [heap[i]!, heap[largest]!];
        i = largest;
      }
    }
    return top;
  };
  let total = root.count;
  push(0);
  while (heap.length > 0) {
    const { node: n, error } = pop();
    const node = nodes[n]!;
    if (node.childCount === 0 || error <= limits.pixelError) {
      out.push(n);
      continue;
    }
    let extra = -node.count;
    const children: number[] = [];
    for (let c = node.firstChild; c < node.firstChild + node.childCount; c++) {
      if (!visible(nodes[c]!, view.planes)) continue;
      children.push(c);
      extra += nodes[c]!.count;
    }
    if (total + extra > limits.budget) {
      out.push(n);
      continue;
    }
    const missing = ready ? children.filter((c) => !ready[c]) : [];
    if (missing.length > 0) {
      out.push(n);
      wanted?.push(...missing);
      continue;
    }
    total += extra;
    for (const c of children) push(c);
  }
  return total;
}

/** 节点这一级的粗细投到屏幕上几个像素（相机在包围盒里时是无穷大：一定细分）。 */
function projectedError(node: SplatNode, view: SplatLodView): number {
  if (node.detail <= 0) return 0;
  let squared = 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.max(node.min[k]! - view.eye[k]!, 0, view.eye[k]! - node.max[k]!);
    squared += d * d;
  }
  return squared === 0 ? Infinity : (node.detail * view.pixelsPerUnit) / Math.sqrt(squared);
}

/** 包围盒是不是至少有一点在每个平面的里面。 */
function visible(node: SplatNode, planes: Float32Array | undefined): boolean {
  if (!planes) return true;
  for (let p = 0; p < planes.length; p += 4) {
    const [nx, ny, nz, w] = [planes[p]!, planes[p + 1]!, planes[p + 2]!, planes[p + 3]!];
    // 包围盒上沿平面法线最靠里的那个角
    const x = nx >= 0 ? node.max[0] : node.min[0], y = ny >= 0 ? node.max[1] : node.min[1], z = nz >= 0 ? node.max[2] : node.min[2];
    if (nx * x + ny * y + nz * z + w < 0) return false;
  }
  return true;
}
