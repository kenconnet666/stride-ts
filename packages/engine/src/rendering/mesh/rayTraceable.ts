import type { MeshBatch } from './MeshRenderFeature';

/**
 * 光追得到的批：不透明、不蒙皮、不形变、不是远处卡片、有三角形（空网格的 BVH 根是个数为 0 的叶子，GPU 上和内部节点分不开）。
 * 地形块（高度页的网格）按每块的高度建。
 */
export function rayTraceable(batch: MeshBatch): boolean {
  const mesh = batch.mesh;
  return batch.count > 0 && batch.visibleInRayTracing && mesh.data.indices.length >= 3 && !batch.skinned && !batch.material.isTransparent && !mesh.impostor && mesh.data.morph === undefined;
}
