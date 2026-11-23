/**
 * 可破碎的物体（Stride 没有）：挂在有 Static 或 Body 的实体上，`pieces` 是 `.fracture.json` 烘出的碎块模型（modeling/fracture.ts）。
 * 撞上别的东西时两者接近的速度（碰撞求解之前的，StartedContact.speed）到 breakSpeed 就碎：完整的模型和物体去掉，每块变成一个
 * 动态物体（凸包碰撞体，质量按体积乘 density），带着原物体的速度、再往外散一点；lifetime 秒以后碎块消失。代码里也能直接
 * `break()`（爆炸、剧情）。
 *
 * 设接触处理器会顶掉实体上原来的（simulation.setContactHandler 一个物体只有一个）。
 */
import { prop } from '../data/prop';
import { Matrix } from '../data/Matrix';
import { Vector3 } from '../data/vectors';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { LoadedModel } from '../content/ContentManager';
import { fracturePieceOf } from '../modeling/fracture';
import { Material } from '../rendering/mesh/Material';
import type { Mesh } from '../rendering/mesh/Mesh';
import { Model, ModelPart } from '../rendering/components';
import { Collider } from './Collider';
import { Body, Static } from './components';

export class Breakable extends SyncScript.props('Breakable', {
  /** 碎块：`.fracture.json` 烘出的同名模型。 */
  pieces: prop.asset('model'),
  /** 撞上时接近的速度到这么快就碎（米/秒）；0 是不会撞碎，只在 break() 时碎。 */
  breakSpeed: prop.number().min(0).default(5).unit('m/s'),
  /** 碎块的密度：质量是体积（按实体的世界缩放）乘它。木头 600，石头 2500，玻璃 2500。 */
  density: prop.number().min(1).default(600).unit('kg/m3'),
  /** 碎的时候每块往外散的速度（米/秒，从物体中心指向碎块中心）。 */
  scatter: prop.number().min(0).default(1).unit('m/s'),
  /** 碎块多少秒以后消失；0 是一直留着。 */
  lifetime: prop.number().min(0).default(10).unit('s'),
}) {
  /** 碎了以后的碎块（消失以后清空）。 */
  readonly pieceEntities: Entity[] = [];
  #broken = false;
  #age = 0;

  get broken(): boolean {
    return this.#broken;
  }

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Breakable on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    if (!this.entity.get(Body) && !this.entity.get(Static)) throw new Error(`Breakable on '${this.entity.name}': the entity needs a Static or a Body`);
    if (this.breakSpeed > 0) {
      // 原生在求解之前按同一个速度放行：撞它的东西不在这一步被挡住，带着原速度撞进碎块里把它们撞开
      simulation.setContactHandler(this.entity, { breakSpeed: this.breakSpeed, onStartedTouching: ({ speed }) => speed >= this.breakSpeed && this.break() });
    }
  }

  override update(): void {
    if (!this.#broken || this.lifetime <= 0 || this.pieceEntities.length === 0) return;
    this.#age += this.game.updateTime.elapsed;
    if (this.#age >= this.lifetime) this.#clearPieces();
  }

  override cancel(): void {
    this.#clearPieces();
  }

  /** 碎掉：换成碎块。已经碎了时什么也不做。 */
  break(): void {
    if (this.#broken) return;
    this.#broken = true;
    const simulation = this.game.simulation!;
    const entity = this.entity;
    const { translation, rotation, scale } = Matrix.decompose(entity.require(Transform).world);
    const body = entity.get(Body) ? simulation.body(entity) : undefined;
    const velocity = body?.linearVelocity.clone() ?? new Vector3();
    const spin = body?.angularVelocity.clone() ?? new Vector3();
    const layer = entity.get(Body)?.layer ?? entity.get(Static)?.layer ?? 0;
    const materials = this.#materialOverrides();
    this.game.content.removeModel(entity);
    if (entity.get(Body)) entity.remove(Body);
    if (entity.get(Static)) entity.remove(Static);

    for (const piece of piecesOf(this.pieces, scale, this.density)) {
      // 碎块的网格在原模型的模型空间里：碎块的实体照原物体摆，物理按凸包自己算质心
      const offset = new Vector3(...piece.center.map((v, k) => v * scale[k]!) as [number, number, number]).rotate({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] });
      const out = offset.length() > 1e-6 ? offset.clone().normalize().scale(this.scatter) : new Vector3();
      const part = entity.manager.create({
        name: `${entity.name} piece ${piece.index}`,
        scene: entity.scene,
        components: [Transform.with({ position: translation, rotation, scale }), Body.with({ collider: piece.collider, layer })],
      });
      this.game.content.addModel(part, { meshes: piece.meshes, materials: this.pieces.materials }, { materials });
      const control = simulation.body(part);
      control.linearVelocity = velocity.clone().add(spin.clone().cross(offset)).add(out);
      control.angularVelocity = spin;
      this.pieceEntities.push(part);
    }
  }

  /**
   * 碎块各材质槽的覆盖：原物体只有一个网格时（多数道具），它画出来的材质（场景里按槽覆盖过的也算）给碎块外表面的那个槽，断面的
   * 槽不动；原物体有几个网格时分不出哪个槽对哪个，用碎块模型自己的材质。
   */
  #materialOverrides(): (Material | null)[] {
    const parts = [this.entity, ...(this.entity.require(Transform).children.filter((child) => child.has(ModelPart)))];
    const material = parts.length === 1 ? this.entity.get(Model)?.material : undefined;
    const override = material === undefined ? undefined : Material.byId(material);
    if (!override) return [];
    const overrides: (Material | null)[] = [];
    for (const { mesh, material: slot } of this.pieces.meshes) if (slot !== null && !mesh.name.endsWith('-inside')) overrides[slot] = override;
    return Array.from(overrides, (value) => value ?? null);
  }

  #clearPieces(): void {
    for (const piece of this.pieceEntities) if (piece.alive) piece.destroy();
    this.pieceEntities.length = 0;
  }
}

interface Piece {
  readonly index: number;
  readonly meshes: LoadedModel['meshes'];
  readonly collider: Collider['id'];
  /** 模型空间里的体积中心。 */
  readonly center: readonly [number, number, number];
}

/** 碎块模型按块分好、建好碰撞体；同一个模型、缩放、密度只算一次（碰撞体不释放，换着缩放反复碎会一直攒）。 */
const pieceCache = new WeakMap<LoadedModel, Map<string, Piece[]>>();

function piecesOf(model: LoadedModel, scale: readonly number[], density: number): Piece[] {
  let byKey = pieceCache.get(model);
  if (!byKey) pieceCache.set(model, (byKey = new Map()));
  const key = `${scale.map((v) => v.toFixed(4)).join(',')}:${density}`;
  let pieces = byKey.get(key);
  if (pieces) return pieces;
  const groups = new Map<number, LoadedModel['meshes'][number][]>();
  for (const part of model.meshes) {
    const index = fracturePieceOf(part.mesh.name.slice(part.mesh.name.lastIndexOf('/') + 1));
    if (index === undefined) continue;
    let group = groups.get(index);
    if (!group) groups.set(index, (group = []));
    group.push(part);
  }
  if (groups.size === 0) throw new Error(`Breakable: the pieces model has no fracture pieces (bake it from a .fracture.json)`);
  const scaleVolume = Math.abs(scale[0]! * scale[1]! * scale[2]!);
  pieces = [...groups.entries()].map(([index, meshes]) => {
    const { volume, center } = solidOf(meshes.map((part) => part.mesh));
    const mass = Math.max(0.01, volume * scaleVolume * density);
    const collider = new Collider([{ type: 'convexHull', meshes: meshes.map((part) => part.mesh), mass }]).id;
    return { index, meshes, collider, center };
  });
  byKey.set(key, pieces);
  return pieces;
}

/** 封闭网格的体积和体积中心（按原点的四面体求和）。 */
export function solidOf(meshes: readonly Mesh[]): { volume: number; center: [number, number, number] } {
  let volume = 0, cx = 0, cy = 0, cz = 0;
  for (const mesh of meshes) {
    const p = mesh.positions(), indices = mesh.data.indices;
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
      const v = (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) / 6;
      volume += v;
      cx += (v * (p[a]! + p[b]! + p[c]!)) / 4;
      cy += (v * (p[a + 1]! + p[b + 1]! + p[c + 1]!)) / 4;
      cz += (v * (p[a + 2]! + p[b + 2]! + p[c + 2]!)) / 4;
    }
  }
  const inverse = Math.abs(volume) > 1e-12 ? 1 / volume : 0;
  return { volume: Math.abs(volume), center: [cx * inverse, cy * inverse, cz * inverse] };
}
