/**
 * 布娃娃（Stride 没有；Jolt 的 Ragdoll，原生侧见 fork 的 Physics.h）：挂在带骨架的模型实体上，`activate()` 时按现在的姿势把
 * 选中的骨头变成一串动态物体（胶囊沿骨头，父子之间摆动加扭转的约束），之后每帧模型的姿势来自物理：动画不再求值，蒙皮照常；
 * 实体跟着根骨头走（模型的包围盒、剔除、挂在它下面的东西都对得上）。`deactivate()` 交还给动画：实体扶正（只留朝向，落到骨盆
 * 下面的地上），从倒地的姿势在 blendTime 秒里淡回动画（有爬起来的剪辑时游戏先放它）。
 *
 *   const ragdoll = model.require(Ragdoll);
 *   ragdoll.activate([0, 0, -300]);   // 被撞的那一下（世界空间的冲量，加在全身）
 *
 * - 骨头：`bones` 列出关节名和各自的半径、质量、摆动和扭转的最大角；空着时自动选：骨头（到它第一个子关节）有 8 厘米以上的
 *   关节都进（手指、脚趾这些短的跟着父关节；场景的根节点这些零长度的不进，根是第一根够长的骨头），半径是骨头长的四分之一（4～15 厘米），总质量 `mass` 按骨头长分。
 * - 实体自己的物理（角色的胶囊）不管：会和布娃娃挤在一起，游戏在 activate 之前关掉它（移除 Character、换碰撞层），deactivate 以后
 *   把胶囊挪到实体那里再打开。
 */
import { prop } from '../data/prop';
import { Matrix } from '../data/Matrix';
import type { RagdollPartDesc } from '@stride-ts/native';
import { SyncScript } from '../engine/scripts';
import { Transform, type TransformView } from '../engine/transform';
import type { RagdollHandle } from './Simulation';

const DEGREES = Math.PI / 180;
/** 自动选骨头时，骨头至少这么长才进布娃娃（米，模型空间）。 */
const MIN_BONE = 0.08;

export class Ragdoll extends SyncScript.props('Ragdoll', {
  /** 进布娃娃的骨头；空着时自动选。 */
  bones: prop.list(prop.object({
    /** 关节名（骨架里的节点名）。 */
    joint: prop.string(),
    radius: prop.number().min(0.01).default(0.08).unit('m'),
    mass: prop.number().min(0.1).default(5).unit('kg'),
    /** 和父骨头之间摆动的最大角。 */
    swing: prop.number().min(0).max(180).default(45).unit('deg'),
    /** 绕骨头扭转的最大角。 */
    twist: prop.number().min(0).max(180).default(20).unit('deg'),
  })),
  /** 自动选骨头时的总质量。 */
  mass: prop.number().min(1).default(70).unit('kg'),
  /** 自动选骨头时的摆动、扭转的最大角。 */
  swing: prop.number().min(0).max(180).default(45).unit('deg'),
  twist: prop.number().min(0).max(180).default(20).unit('deg'),
  /** 碰撞层，0..31。 */
  layer: prop.int().min(0).max(31).default(0),
  /** 一开始就是布娃娃。 */
  startActive: prop.bool().default(false),
}) {
  #handle: RagdollHandle | undefined;

  /** 现在是不是布娃娃。 */
  get active(): boolean {
    return this.#handle !== undefined;
  }

  override start(): void {
    if (this.startActive) this.activate();
  }

  override cancel(): void {
    this.deactivate();
  }

  /** 变成布娃娃（已经是时不变）；给了 impulse 时全身加这一下冲量（世界空间，牛·秒）。 */
  activate(impulse?: readonly [number, number, number]): void {
    if (this.#handle) return;
    const { animation, simulation } = this.game;
    if (!simulation) throw new Error(`Ragdoll on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    const skeleton = animation.skeletonOf(this.entity), instance = animation.instanceOf(this.entity);
    if (!skeleton || !instance) throw new Error(`Ragdoll on '${this.entity.name}': the entity has no skinned model`);
    const matrices = instance.modelMatrices();
    const joints = skeleton.joints;
    const parents = Int32Array.from(joints.map((joint) => joint.parent));
    const position = (j: number) => [matrices[j * 16 + 12]!, matrices[j * 16 + 13]!, matrices[j * 16 + 14]!] as const;
    const children = joints.map((_, j) => joints.flatMap((joint, c) => (joint.parent === j ? [c] : [])));
    /** 骨头的另一头：第一个子关节（有进布娃娃的子关节时优先用它），在这个关节的本地空间。 */
    const boneEnd = (j: number, chosen: ReadonlySet<number>): [number, number, number] | undefined => {
      const child = children[j]!.find((c) => chosen.has(c)) ?? children[j]![0];
      if (child === undefined) return undefined;
      const inverse = new Float32Array(16);
      Matrix.invert(inverse, matrices.subarray(j * 16, j * 16 + 16));
      return Matrix.transformPoint(inverse, ...position(child));
    };
    const length = (j: number) => {
      const child = children[j]![0];
      if (child === undefined) return 0;
      const [a, b] = [position(j), position(child)];
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    };

    // 选骨头：写了的按写的，没写的自动选（根总是进）
    const listed = this.bones.map((bone) => {
      const joint = skeleton.jointIndex(bone.joint);
      if (joint < 0) throw new Error(`Ragdoll on '${this.entity.name}': the skeleton has no joint '${bone.joint}'`);
      return { joint, radius: bone.radius, mass: bone.mass, swing: bone.swing, twist: bone.twist };
    });
    const picked = listed.length > 0 ? listed : this.#autoBones(joints.length, length);
    const chosen = new Set(picked.map((bone) => bone.joint));
    // 按关节的顺序（父在前），父部分是最近的进了布娃娃的祖先；没有祖先的只留第一个当根，其余的跟着父关节
    picked.sort((a, b) => a.joint - b.joint);
    const partOf = new Map<number, number>();
    const parts: RagdollPartDesc[] = [];
    for (const bone of picked) {
      let ancestor = joints[bone.joint]!.parent;
      while (ancestor >= 0 && !partOf.has(ancestor)) ancestor = joints[ancestor]!.parent;
      const parent = ancestor >= 0 ? partOf.get(ancestor)! : -1;
      if (parent < 0 && parts.length > 0) continue;
      const end = boneEnd(bone.joint, chosen) ?? [0, bone.radius * 2, 0];
      partOf.set(bone.joint, parts.length);
      parts.push({ joint: bone.joint, parent, boneEnd: end, radius: bone.radius, mass: bone.mass, swing: bone.swing * DEGREES, twist: bone.twist * DEGREES });
    }
    if (parts.length === 0) throw new Error(`Ragdoll on '${this.entity.name}': no bones to simulate`);

    const transform = this.entity.require(Transform);
    const modelToWorld = Float64Array.from(transform.world);
    const handle = simulation.addRagdoll(parts, instance, modelToWorld, this.layer);
    // 根骨头在模型里的位姿（去掉缩放）的逆：实体 = 根物体的世界位姿 × 它
    const rootModel = Matrix.decompose(matrices.subarray(parts[0]!.joint * 16, parts[0]!.joint * 16 + 16));
    const rootInverse = new Float64Array(16);
    Matrix.invert(rootInverse, Matrix.compose(new Float64Array(16), rootModel.translation, rootModel.rotation, [1, 1, 1]));
    const scale = Matrix.decompose(modelToWorld).scale;
    const bodyWorld = new Float64Array(16), entityWorld = new Float64Array(16), parentInverse = new Float64Array(16), local = new Float64Array(16);
    animation.setPoseSource(this.entity, () => {
      const root = handle.root();
      Matrix.compose(bodyWorld, root.position, root.rotation, [1, 1, 1]);
      Matrix.multiply(entityWorld, bodyWorld, rootInverse);
      // 实体的世界位姿换成本地的（有父实体时按父实体现在的世界矩阵换），缩放不变
      const parent = transform.parent?.require(Transform).world;
      if (parent && Matrix.invert(parentInverse, parent)) Matrix.multiply(local, parentInverse, entityWorld);
      else local.set(entityWorld);
      const { translation, rotation } = Matrix.decompose(local);
      transform.position = { x: translation[0], y: translation[1], z: translation[2] };
      transform.rotation = { x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] };
      handle.pose(instance, Matrix.compose(modelToWorld, [entityWorld[12]!, entityWorld[13]!, entityWorld[14]!], Matrix.decompose(entityWorld).rotation, scale), parents);
    });
    this.#handle = handle;
    this.#parts = parts.map((part) => part.joint);
    if (impulse) handle.impulse(-1, impulse);
  }

  /**
   * 交还给动画：实体扶正（upright：朝向只留水平的那一份，位置落到骨盆下面的地上），姿势从倒地的样子在 blendTime 秒里淡回动画
   * （0 是一下子跳回去）。
   */
  deactivate({ blendTime = 0.5, upright = true }: { blendTime?: number; upright?: boolean } = {}): void {
    const handle = this.#handle;
    if (!handle) return;
    const animation = this.game.animation;
    const root = handle.root();
    animation.setPoseSource(this.entity, undefined);
    handle.remove();
    this.#handle = undefined;
    const transform = this.entity.require(Transform);
    const oldWorld = Float64Array.from(transform.world);
    if (upright) this.#standUp(transform, oldWorld, root.position);
    // 快照的根按新旧实体的位姿差修正：淡出的那段姿势在世界里不跳
    const newWorld = this.#worldAfter(transform, oldWorld);
    const inverse = new Float64Array(16), correction = new Float64Array(16);
    Matrix.invert(inverse, newWorld);
    Matrix.multiply(correction, inverse, oldWorld);
    animation.blendFromPose(this.entity, blendTime, correction);
  }

  /** 扶正：朝向只留绕竖直轴的那一份（模型的 +z 投到水平面上），位置是骨盆的水平位置、下面的地面（打不到时保持原高度）。 */
  #standUp(transform: TransformView, world: Float64Array, pelvis: readonly number[]): void {
    let fx = world[8]!, fz = world[10]!;
    if (Math.hypot(fx, fz) < 1e-3) {
      fx = world[0]!;
      fz = world[2]!;
    }
    const yaw = Math.atan2(fx, fz);
    const rotation: [number, number, number, number] = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
    let y = world[13]!;
    const hit = this.game.simulation?.rayCastPenetrating([pelvis[0]!, pelvis[1]! + 0.5, pelvis[2]!], [0, -1, 0], 5).find((h) => !this.#ancestors().has(h.entity));
    if (hit) y = hit.point[1];
    const scale = Matrix.decompose(world).scale;
    const entityWorld = Matrix.compose(new Float64Array(16), [pelvis[0]!, y, pelvis[2]!], rotation, scale);
    const parent = transform.parent?.require(Transform).world;
    const local = new Float64Array(16), parentInverse = new Float64Array(16);
    if (parent && Matrix.invert(parentInverse, parent)) Matrix.multiply(local, parentInverse, entityWorld);
    else local.set(entityWorld);
    const { translation, rotation: r } = Matrix.decompose(local);
    transform.position = { x: translation[0], y: translation[1], z: translation[2] };
    transform.rotation = { x: r[0], y: r[1], z: r[2], w: r[3] };
  }

  /** 改了本地位姿以后实体的世界矩阵（变换存储要到下一次更新才算，这里按父实体现在的世界矩阵自己乘）。 */
  #worldAfter(transform: TransformView, fallback: Float64Array): Float64Array {
    const { position, rotation } = transform;
    const scale = Matrix.decompose(fallback).scale;
    const parentScale = transform.parent ? Matrix.decompose(transform.parent.require(Transform).world).scale : [1, 1, 1];
    const local = Matrix.compose(new Float64Array(16), [position.x, position.y, position.z], [rotation.x, rotation.y, rotation.z, rotation.w], scale.map((v, k) => v / parentScale[k]!) as [number, number, number]);
    const parent = transform.parent?.require(Transform).world;
    if (!parent) return local;
    return Matrix.multiply(new Float64Array(16), Float64Array.from(parent), local);
  }

  /** 自己和祖先实体（射线不算角色的胶囊）。 */
  #ancestors(): Set<number> {
    const ids = new Set<number>();
    for (let entity: typeof this.entity | undefined = this.entity; entity; entity = entity.get(Transform)?.parent ?? undefined) ids.add(entity.id);
    return ids;
  }

  /** 给某根骨头（关节名）加冲量，比如被打中的地方；不是布娃娃或这根骨头没进布娃娃时什么都不做。 */
  push(joint: string, impulse: readonly [number, number, number]): void {
    if (!this.#handle) return;
    const index = this.#parts.indexOf(this.game.animation.skeletonOf(this.entity)?.jointIndex(joint) ?? -1);
    if (index >= 0) this.#handle.impulse(index, impulse);
  }

  /** 每个部分是骨架的哪个关节。 */
  #parts: number[] = [];

  /** 自动选骨头：到第一个子关节有 MIN_BONE 以上的关节，质量按骨头长分。 */
  #autoBones(count: number, length: (joint: number) => number): { joint: number; radius: number; mass: number; swing: number; twist: number }[] {
    // 场景的根节点、网格节点这些零长度的"骨头"不进：根是第一根够长的骨头（一般是骨盆）
    const bones = Array.from({ length: count }, (_, joint) => ({ joint, bone: length(joint) })).filter(({ bone }) => bone >= MIN_BONE);
    const total = bones.reduce((sum, { bone }) => sum + Math.max(bone, MIN_BONE), 0);
    return bones.map(({ joint, bone }) => ({
      joint,
      radius: Math.min(0.15, Math.max(0.04, bone / 4)),
      mass: (this.mass * Math.max(bone, MIN_BONE)) / total,
      swing: this.swing,
      twist: this.twist,
    }));
  }
}
