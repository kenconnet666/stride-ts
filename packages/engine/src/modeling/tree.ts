/**
 * 参数化的树（content/formats/treeFormat.ts 的 TreeFile）长成网格：按层生长出枝的骨架（每根枝分几节，每节带位置、朝向、半径），
 * 枝拉成圆管（树皮的槽），最后一层的枝上贴叶片卡片（叶片的槽）。编辑器后端烘成模型用（pipeline 的 treeModel.ts）。
 *
 * 生长（思路照 ez-tree：分节、随机偏转、生长的方向力、分层的子枝按高度和方位分层抽样）：
 * - 一根枝从根到梢分 sections 节，每节的朝向在上一节上随机偏转（gnarliness，越细偏得越多）、绕自己的轴扭（twist）、往
 *   growth.direction 转一点（越细转得越多：细枝下垂、向光）；
 * - 子枝沿母枝从 start 到梢均匀分层抽样（每根占一段，在段里随机），方位角也分层抽样、再打乱（高度和方位不相关，针叶树的长枝
 *   不会都转到一边）；朝向是母枝那一处的朝向绕自己的轴转方位角、再张开 angle 度；
 * - 叶片：两张交叉的卡片，长在最后一层的枝上；法线朝树冠的中心往外（看起来是一团圆的树冠，不是一片片的纸）。
 * 随机数用种子起的 mulberry32，每根枝自己一个（种子由母枝的种子和它是第几根哈希出来）：同一个文件长出同一棵树；少长最细的一层
 * （远处的简化版，摆放的 lods）时，树干和别的枝长得一模一样，换的时候不跳。
 */
import { TREE_SLOTS, type TreeFile, type TreeLevelFile } from '../content/formats/treeFormat.ts';
import { Quaternion, Vector3 } from '../data/vectors.ts';
import { MeshBuilder, slotMeshes, type SlotMesh } from './meshBuilder.ts';
import { hash32 } from '../data/hash.ts';

/** 枝的一节：位置、朝向（本地 +Y 是生长的方向）、半径。 */
interface Section {
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly radius: number;
}

/** 等着长的一根枝。 */
interface Bud {
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly length: number;
  readonly radius: number;
  readonly level: number;
  /** 这根枝自己的随机数种子（由母枝的种子和它是第几根算出来）：少长一层（远处的简化版）时，别的枝长得一模一样。 */
  readonly seed: number;
}

/** 一片叶子（两张交叉的卡片）：根部的位置、朝向（本地 +Y 是叶片伸出的方向）、大小。 */
interface Leaf {
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly size: number;
}

const UP = { x: 0, y: 1, z: 0 };
const X_AXIS = { x: 1, y: 0, z: 0 };
const Z_AXIS = { x: 0, y: 0, z: 1 };

/** 检查树的文件，不对时抛错（错误里带着位置）；返回原对象。 */
export function checkTree(file: TreeFile, where = file.name): TreeFile {
  const fail = (problem: string): never => {
    throw new Error(`${where}: ${problem}`);
  };
  if (!Array.isArray(file.levels) || file.levels.length < 1 || file.levels.length > 4) fail('levels needs 1 to 4 levels (the first is the trunk)');
  file.levels.forEach((level, i) => {
    if (!(level.length > 0)) fail(`levels[${i}].length must be positive`);
    if (!(level.radius > 0)) fail(`levels[${i}].radius must be positive`);
    if (i < file.levels.length - 1 && !(Number.isInteger(level.children) && level.children! >= 0)) fail(`levels[${i}].children must be a whole number`);
  });
  if (file.leaves && !(file.leaves.count >= 0 && file.leaves.size > 0)) fail('leaves needs a count and a positive size');
  return file;
}

/** 长一棵树，得出按材质槽分好的网格：树皮（槽 0）、叶片（槽 1）。 */
export function treeMeshes(file: TreeFile, where = file.name): SlotMesh[] {
  checkTree(file, where);
  const conifer = file.shape === 'conifer';
  const levels = file.levels, last = levels.length - 1;
  const slots = Array.from({ length: TREE_SLOTS }, () => new MeshBuilder());
  const leaves: Leaf[] = [];
  const queue: Bud[] = [{ position: new Vector3(), rotation: new Quaternion(), length: levels[0]!.length, radius: levels[0]!.radius, level: 0, seed: hash32(file.seed ?? 1, 0) }];
  while (queue.length > 0) {
    const bud = queue.shift()!;
    const random = mulberry32(bud.seed);
    let child = 0;
    const sections = grow(bud, levels[bud.level]!, file, conifer && bud.level === 0, bud.level === last, random);
    meshBranch(slots[0]!, sections, levels[bud.level]!.segments ?? 6);
    if (bud.level < last) {
      const next = levels[bud.level + 1]!;
      spread(levels[bud.level]!.children ?? 0, next.start ?? 0.3, random, (t, angle) => {
        const at = sectionAt(sections, t);
        const rotation = at.rotation.clone().multiply(new Quaternion().setAxisAngle(UP, angle)).multiply(new Quaternion().setAxisAngle(X_AXIS, ((next.angle ?? 45) * Math.PI) / 180));
        queue.push({ position: at.position, rotation, length: next.length * (conifer ? 1 - t : 1), radius: next.radius * at.radius, level: bud.level + 1, seed: hash32(bud.seed, ++child) });
      });
    } else if (file.leaves) {
      const spec = file.leaves;
      spread(spec.count, spec.start ?? 0, random, (t, angle) => {
        const at = sectionAt(sections, t);
        const rotation = at.rotation.clone().multiply(new Quaternion().setAxisAngle(UP, angle)).multiply(new Quaternion().setAxisAngle(X_AXIS, ((spec.angle ?? 40) * Math.PI) / 180));
        const variance = spec.sizeVariance ?? 0.3;
        leaves.push({ position: at.position, rotation, size: spec.size * (1 - variance / 2 + variance * random()) });
      });
    }
  }
  meshLeaves(slots[1]!, leaves);
  return slotMeshes(slots);
}

/** 长一根枝的骨架：sections + 1 个截面，从根到梢。 */
function grow(bud: Bud, level: TreeLevelFile, file: TreeFile, coniferTrunk: boolean, finest: boolean, random: () => number): Section[] {
  const count = Math.max(1, level.sections ?? 8);
  const step = bud.length / count;
  const taper = Math.min(1, Math.max(0, level.taper ?? 0.7));
  const gnarliness = level.gnarliness ?? 0.1;
  const growth = file.growth;
  const target = growth ? new Vector3(...growth.direction).normalize() : undefined;
  const position = bud.position.clone(), rotation = bud.rotation.clone();
  const sections: Section[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    // 针叶树的树干收到梢；最后一层的梢收成一个点
    let radius = bud.radius * (coniferTrunk ? 1 - t : 1 - taper * t);
    if (finest && i === count) radius = Math.min(radius, bud.radius * 0.05);
    sections.push({ position: position.clone(), rotation: rotation.clone(), radius });
    position.add(new Vector3(0, step, 0).rotate(rotation));
    // 随机偏转：越细偏得越多（√ 的倒数，上限 4 倍）
    const amount = gnarliness * Math.min(4, Math.max(1, 1 / Math.sqrt(Math.max(radius, 1e-3))));
    rotation.multiply(new Quaternion().setAxisAngle(X_AXIS, (random() * 2 - 1) * amount)).multiply(new Quaternion().setAxisAngle(Z_AXIS, (random() * 2 - 1) * amount));
    if (level.twist) rotation.multiply(new Quaternion().setAxisAngle(UP, level.twist));
    // 往生长的方向转：每节最多转 strength / 半径（细枝转得多），不转过头
    if (growth && target && growth.strength !== 0) {
      const up = new Vector3(0, 1, 0).rotate(rotation);
      const axis = up.clone().cross(target);
      const sin = axis.length();
      if (sin > 1e-6) {
        const full = Math.atan2(sin, up.dot(target));
        const turn = Math.max(-full, Math.min(full, growth.strength / Math.max(radius, 0.01)));
        rotation.copy(new Quaternion().setAxisAngle(axis.scale(1 / sin), turn).multiply(rotation));
      }
    }
  }
  return sections;
}

/**
 * count 个东西沿枝从 start 到梢分层抽样（每个占一段，在段里随机）、方位角也分层抽样再打乱；对每个调 at(位置 0..1, 方位角)。
 */
function spread(count: number, start: number, random: () => number, at: (t: number, angle: number) => void): void {
  if (count <= 0) return;
  const offset = random();
  const slots = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  for (let i = 0; i < count; i++) {
    const t = start + ((i + random()) * (1 - start)) / count;
    const angle = 2 * Math.PI * (offset + (slots[i]! + random() - 0.5) / count);
    at(Math.min(1, t), angle);
  }
}

/** 枝上 t（0..1）处：在两个截面之间插值位置、朝向、半径。 */
function sectionAt(sections: readonly Section[], t: number): Section {
  const f = t * (sections.length - 1);
  const i = Math.min(sections.length - 2, Math.floor(f)), alpha = f - i;
  const a = sections[i]!, b = sections[i + 1]!;
  return {
    position: a.position.clone().lerp(b.position, alpha),
    rotation: a.rotation.clone().slerp(b.rotation, alpha),
    radius: a.radius + (b.radius - a.radius) * alpha,
  };
}

/** 一根枝拉成圆管：每个截面一圈（接缝处多一个顶点，UV 不断），法线朝外；UV 按米（u 绕一圈是周长，v 沿长度）。 */
function meshBranch(builder: MeshBuilder, sections: readonly Section[], segments: number): void {
  const sides = Math.max(3, segments);
  const circumference = 2 * Math.PI * sections[0]!.radius;
  let distance = 0;
  let previous: number[] | undefined;
  sections.forEach((section, k) => {
    if (k > 0) distance += section.position.clone().subtract(sections[k - 1]!.position).length();
    const ring: number[] = [];
    for (let j = 0; j <= sides; j++) {
      const angle = (j / sides) * Math.PI * 2;
      const normal = new Vector3(Math.cos(angle), 0, Math.sin(angle)).rotate(section.rotation);
      const position = section.position.clone().add(normal.clone().scale(section.radius));
      ring.push(builder.vertex([position.x, position.y, position.z], [normal.x, normal.y, normal.z], (j / sides) * circumference, distance));
    }
    if (previous) {
      for (let j = 0; j < sides; j++) {
        const n = builder.vertices.slice(ring[j]! * 8 + 3, ring[j]! * 8 + 6);
        builder.quad(previous[j]!, previous[j + 1]!, ring[j + 1]!, ring[j]!, n);
      }
    }
    previous = ring;
  });
}

/**
 * 叶片：每片两张交叉的卡片（叶片平面里一张、转 90° 一张），宽是 size、沿伸出的方向长 size，UV 是整张贴图。法线从树冠的中心
 * （所有叶片根部的包围盒中心）朝外，光照像一团圆的树冠；卡片两面都画（材质的 doubleSided）。
 */
function meshLeaves(builder: MeshBuilder, leaves: readonly Leaf[]): void {
  if (leaves.length === 0) return;
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const { position: p } of leaves) {
    min.set(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max.set(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
  }
  const center = min.clone().add(max).scale(0.5);
  for (const leaf of leaves) {
    const along = new Vector3(0, leaf.size, 0).rotate(leaf.rotation);
    for (const side of [X_AXIS, Z_AXIS]) {
      const across = new Vector3(side.x, side.y, side.z).scale(leaf.size / 2).rotate(leaf.rotation);
      const corners = [[-1, 0], [1, 0], [1, 1], [-1, 1]].map(([s, l]) => leaf.position.clone().add(across.clone().scale(s!)).add(along.clone().scale(l!)));
      const ids = corners.map((corner, i) => {
        const normal = corner.clone().subtract(center).normalize();
        return builder.vertex([corner.x, corner.y, corner.z], [normal.x, normal.y, normal.z], i === 0 || i === 3 ? 0 : 1, i < 2 ? 1 : 0);
      });
      // 卡片自己的面朝向（叉积）定绕向；两面都画，哪面朝外不要紧
      const facing = across.clone().cross(along);
      builder.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!, [facing.x, facing.y, facing.z]);
    }
  }
}


/** mulberry32：种子起的 [0, 1) 随机数。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
