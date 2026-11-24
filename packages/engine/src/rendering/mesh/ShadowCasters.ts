/**
 * 阴影投射者在静态层里的变化（缓存的阴影图用，lighting/ShadowMapRenderer.ts、docs/realtime.md 第三节）。
 *
 * 投影者分两层：最近 SETTLE_UPDATES 次更新里动过的实例在提取时分进单独的"动态"批（MeshBatch.dynamic），连同蒙皮、形变、风里摆、
 * 顶点自己在动的批算动态的（MeshRenderFeature.isDynamicCaster），每帧画；其余是静态的，画一次缓存着。这里每帧比较静态批的成员
 * （槽位列表）和上次记下的：多出来的实例（停下来了、新加的、管线编好了）按现在的位置、少了的（开始动了、删了）按它上次在静态层
 * 里的位置报一块包围盒；材质改了整批报。阴影的缓存拿这些盒子和各盏光的范围比，决定重画谁。成员没变的批只比一下长度和槽位。
 */
import type { MeshBatch } from './MeshRenderFeature';

/** 实例在这么多次更新里没动过才算静止、进静态层（拖着走、在动画里的不来回在两层之间换）。 */
export const SETTLE_UPDATES = 10;

/** 世界变换的来源：渲染空间的世界矩阵（列主序，每个槽位 16 个）。 */
interface Worlds {
  readonly renderWorld: Float32Array;
}

export class ShadowCasters {
  /** 这一帧静态层里变了的地方：渲染空间的轴对齐包围盒，每 6 个数一块（最小角 xyz、最大角 xyz）。 */
  readonly regions: number[] = [];
  /** 这一帧动态的投影者：每批一块包围盒，同上。 */
  readonly dynamic: number[] = [];
  #update = Number.NaN;
  /** 批 → 上次在静态层里的槽位和材质的版本。 */
  readonly #recorded = new Map<MeshBatch, { slots: Uint32Array; materialVersion: number }>();
  /** 槽位 → 上次进静态层时的包围盒（6 个数）。 */
  #boxes = new Float64Array(0);
  readonly #seen = new Set<MeshBatch>();

  /**
   * 跟上这一帧（每次更新只算一次，同一次更新里再调直接返回）：update 是 GameTime.frameCount，dynamicCaster 判断一批是不是动态的
   * 投影者。批的 bounds 要已经是这一帧的（MeshRenderFeature 剔除前算好）。
   */
  track(batches: readonly MeshBatch[], worlds: Worlds, update: number, dynamicCaster: (batch: MeshBatch) => boolean): this {
    if (update === this.#update) return this;
    this.#update = update;
    this.regions.length = 0;
    this.dynamic.length = 0;
    this.#seen.clear();
    for (const batch of batches) {
      if (!batch.isShadowCaster) continue;
      if (dynamicCaster(batch)) {
        if (batch.count > 0 && batch.ready) this.#pushBatchBox(this.dynamic, batch, worlds);
        // 以前是静态的（比如材质加了风）：它在静态层里的影子要去掉
        continue;
      }
      this.#seen.add(batch);
      const count = batch.ready ? batch.count : 0;
      const recorded = this.#recorded.get(batch);
      const sameMembers = recorded !== undefined && recorded.slots.length === count && recorded.slots.every((slot, i) => slot === batch.slots[i]);
      if (sameMembers && recorded.materialVersion === batch.material.version) continue;
      // 材质改了：整批的旧影子去掉、新的整批画；不然只报多出来的和少了的实例
      const slots = batch.slots.slice(0, count);
      const sameMaterial = recorded?.materialVersion === batch.material.version;
      const before = new Set(sameMaterial ? recorded.slots : []), after = new Set(sameMaterial ? slots : []);
      // 少了的按旧盒子报（先报，再记新的）
      for (const slot of recorded?.slots ?? []) if (!after.has(slot)) this.#pushSlot(slot);
      for (const slot of slots) {
        if (before.has(slot)) continue;
        this.#remember(slot, batch, worlds);
        this.#pushSlot(slot);
      }
      this.#recorded.set(batch, { slots, materialVersion: batch.material.version });
    }
    // 不再是静态投影者的批（网格释放了、整批变成动态的、不投阴影了）：它在静态层里的都去掉
    for (const [batch, recorded] of this.#recorded) {
      if (this.#seen.has(batch)) continue;
      for (const slot of recorded.slots) this.#pushSlot(slot);
      this.#recorded.delete(batch);
    }
    return this;
  }

  /** 记下槽位现在的包围盒（批的网格包围盒乘世界矩阵）；网格没有包围盒（总是可见的）时是无穷大。 */
  #remember(slot: number, batch: MeshBatch, worlds: Worlds): void {
    if (this.#boxes.length < (slot + 1) * 6) {
      const grown = new Float64Array(Math.max((slot + 1) * 6, this.#boxes.length * 2));
      grown.set(this.#boxes);
      this.#boxes = grown;
    }
    const { min: lo, max: hi } = batch.mesh.cullBounds;
    const o = slot * 6;
    if (lo.every((value, i) => value === hi[i])) {
      this.#boxes.fill(-Infinity, o, o + 3);
      this.#boxes.fill(Infinity, o + 3, o + 6);
      return;
    }
    const world = worlds.renderWorld, m = slot * 16;
    for (let r = 0; r < 3; r++) {
      let center = world[m + 12 + r]!, extent = 0;
      for (let c = 0; c < 3; c++) {
        const axis = world[m + c * 4 + r]!;
        center += axis * (lo[c]! + hi[c]!) / 2;
        extent += Math.abs(axis) * (hi[c]! - lo[c]!) / 2;
      }
      this.#boxes[o + r] = center - extent;
      this.#boxes[o + 3 + r] = center + extent;
    }
  }

  #pushSlot(slot: number): void {
    const o = slot * 6;
    if (o + 6 > this.#boxes.length) return;
    for (let k = 0; k < 6; k++) this.regions.push(this.#boxes[o + k]!);
  }

  #pushBatchBox(target: number[], batch: MeshBatch, worlds: Worlds): void {
    const { min, max } = batch.bounds;
    if (min[0]! <= max[0]!) {
      target.push(min[0]!, min[1]!, min[2]!, max[0]!, max[1]!, max[2]!);
      return;
    }
    // 包围盒还没算过（总是可见的网格、或者剔除没在 GPU 上做）：按每个实例算
    for (let i = 0; i < batch.count; i++) {
      const slot = batch.slots[i]!;
      this.#remember(slot, batch, worlds);
      for (let k = 0; k < 6; k++) target.push(this.#boxes[slot * 6 + k]!);
    }
  }
}

/** 一块包围盒（boxes 里第 i 块）和球（中心、半径）相交。 */
export function boxTouchesSphere(boxes: readonly number[], i: number, x: number, y: number, z: number, radius: number): boolean {
  const o = i * 6;
  const dx = Math.max(boxes[o]! - x, 0, x - boxes[o + 3]!);
  const dy = Math.max(boxes[o + 1]! - y, 0, y - boxes[o + 4]!);
  const dz = Math.max(boxes[o + 2]! - z, 0, z - boxes[o + 5]!);
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}
