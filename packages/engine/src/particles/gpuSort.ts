/**
 * GPU 粒子按深度排序（SortingPolicy 是 ByDepth 的发射器，同 CPU 的 drawOrder：深度 = 位置 · 相机的朝后方向，从远到近）：
 * 先一遍算键（每个槽的深度和下标，死了的、补齐到 2 的幂的空位是 +∞，排到最后），再做 bitonic 排序。
 *
 * bitonic 排序：n = 2^m 个元素要 m(m+1)/2 步（26 万个粒子 171 步），每步每对比较、交换。步距 j 小于 SORT_BLOCK 的那些步只在
 * 一块 SORT_BLOCK 个元素里交换，放进工作组共享内存一次派发做完（GPU 排序的常见做法）：一开始一次把每块排好（k ≤ SORT_BLOCK 的
 * 所有步），之后每个 k 先是 j ≥ SORT_BLOCK 的几步全局的派发，再一次块内的派发做完剩下的。26 万个粒子 171 次派发变成 55 次，
 * 大部分的步不再读写全局内存。每次派发的参数（k、j）按动态偏移从一块预先写好的 uniform 里取，同样的大小共用一块。
 */
import { PARTICLE_WGSL, WORKGROUP_SIZE } from './gpuKernel';

/** 动态偏移的对齐。 */
export const STAGE_STRIDE = 256;
/** 一个工作组在共享内存里排的元素数（256 个线程，每个管一对）。 */
export const SORT_BLOCK = 512;
const BLOCK_THREADS = SORT_BLOCK / 2;

/**
 * 排序的一次派发：block 时在共享内存里做（k 是 0 时是一开始把每块排好，否则是这个 k 里 j < SORT_BLOCK 的那些步），否则是
 * 一步全局的 [k, j]。
 */
export interface SortPass {
  readonly k: number;
  readonly j: number;
  readonly block: boolean;
}

/** n（2 的幂）个元素的排序的每一次派发。 */
export function sortPasses(n: number): SortPass[] {
  const passes: SortPass[] = [{ k: 0, j: 0, block: true }];
  for (let k = SORT_BLOCK * 2; k <= n; k *= 2) {
    for (let j = k / 2; j >= SORT_BLOCK; j /= 2) passes.push({ k, j, block: false });
    passes.push({ k, j: SORT_BLOCK / 2, block: true });
  }
  return passes;
}

/** 不小于 count 的 2 的幂（至少 2）。 */
export function sortSize(count: number): number {
  return Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(count, 1))));
}

export const SORT_KEYS_WGSL = /* wgsl */ `${PARTICLE_WGSL}
struct SortView {
  // 相机的朝后方向（世界）；局部模拟时先按粒子系统的变换换到世界
  back: vec4f,
  spacePosition: vec4f,
  spaceRotation: vec4f,
  // x：粒子数，y：排序的大小（2 的幂），z：1 是局部模拟
  counts: vec4u,
};
@group(0) @binding(0) var<uniform> view: SortView;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> keys: array<vec2u>;

fn rotateVector(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@compute @workgroup_size(${WORKGROUP_SIZE}) fn sortKeys(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= view.counts.y) {
    return;
  }
  var key = 3.4e38;
  var index = 0xffffffffu;
  if (i < view.counts.x && particles[i].life > 0.0) {
    var position = particles[i].position;
    if (view.counts.z == 1u) {
      position = rotateVector(view.spaceRotation, position) * view.spacePosition.w + view.spacePosition.xyz;
    }
    key = dot(position, view.back.xyz);
    index = i;
  }
  keys[i] = vec2u(bitcast<u32>(key), index);
}
`;

export const SORT_STEP_WGSL = /* wgsl */ `
struct Stage {
  k: u32,
  j: u32,
};
@group(0) @binding(0) var<uniform> stage: Stage;
@group(0) @binding(1) var<storage, read_write> keys: array<vec2u>;

// 一步全局的比较交换
@compute @workgroup_size(${WORKGROUP_SIZE}) fn sortStep(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let l = i ^ stage.j;
  if (l <= i || l >= arrayLength(&keys)) {
    return;
  }
  let a = keys[i];
  let b = keys[l];
  let ascending = (i & stage.k) == 0u;
  let greater = bitcast<f32>(a.x) > bitcast<f32>(b.x);
  if (greater == ascending) {
    keys[i] = b;
    keys[l] = a;
  }
}

var<workgroup> block: array<vec2u, ${SORT_BLOCK}>;

// 块内：这个工作组的 SORT_BLOCK 个元素读进共享内存，做完 j < SORT_BLOCK 的那些步再写回。stage.k 是 0 时从 k = 2 做到
// min(SORT_BLOCK, n)（一开始把每块排好），否则只做这个 k、j 从 SORT_BLOCK / 2 起。方向按全局的下标（同 sortStep）
@compute @workgroup_size(${BLOCK_THREADS}) fn sortBlock(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) t: u32) {
  let n = arrayLength(&keys);
  let size = min(${SORT_BLOCK}u, n);
  let base = group.x * ${SORT_BLOCK}u;
  for (var r = 0u; r < 2u; r++) {
    let i = t + r * ${BLOCK_THREADS}u;
    if (i < size) {
      block[i] = keys[base + i];
    }
  }
  workgroupBarrier();
  var k = stage.k;
  var last = stage.k;
  if (stage.k == 0u) {
    k = 2u;
    last = size;
  }
  for (; k <= last; k *= 2u) {
    var j = select(k / 2u, ${SORT_BLOCK / 2}u, stage.k != 0u);
    for (; j > 0u; j /= 2u) {
      // 线程 t 管一对：块里的 i 和 i + j
      let i = 2u * j * (t / j) + t % j;
      let l = i + j;
      if (l < size) {
        let a = block[i];
        let b = block[l];
        let ascending = ((base + i) & k) == 0u;
        if ((bitcast<f32>(a.x) > bitcast<f32>(b.x)) == ascending) {
          block[i] = b;
          block[l] = a;
        }
      }
      workgroupBarrier();
    }
  }
  for (var r = 0u; r < 2u; r++) {
    let i = t + r * ${BLOCK_THREADS}u;
    if (i < size) {
      keys[base + i] = block[i];
    }
  }
}
`;
