/**
 * GPU 粒子按深度排序（SortingPolicy 是 ByDepth 的发射器，同 CPU 的 drawOrder：深度 = 位置 · 相机的朝后方向，从远到近）：
 * 先一遍算键（每个槽的深度和下标，死了的、补齐到 2 的幂的空位是 +∞，排到最后），再做 bitonic 排序。
 *
 * bitonic 排序每一步是一次派发（k、j 两个参数，按动态偏移从一块预先写好的 uniform 里取，同样的大小共用一块），
 * n = 2^m 个元素要 m(m+1)/2 步：26 万个粒子 171 步。每步每个线程比较、交换一对。
 */
import { PARTICLE_WGSL, WORKGROUP_SIZE } from './kernel';

/** 动态偏移的对齐。 */
export const STAGE_STRIDE = 256;

/** n（2 的幂）个元素的 bitonic 排序的每一步 [k, j]。 */
export function bitonicStages(n: number): [number, number][] {
  const stages: [number, number][] = [];
  for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) stages.push([k, j]);
  return stages;
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
`;
