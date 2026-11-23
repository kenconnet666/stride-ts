/**
 * 感知（Stride 没有；照虚幻的 AIPerception：视觉、听觉，记忆）：挂 `Perceiver` 的实体（守卫、行人）看得见、听得到挂
 * `PerceptionStimulus` 的实体（玩家、可疑的东西）和 `game.perception.noise(...)` 发出的声音，结果按实体查：
 *
 *   for (const seen of game.perception.of(guard)) if (seen.tag === 'player' && seen.seeing) chase(seen.position);
 *
 * - 视觉：在 sightRadius 以内（已经看见的放宽到 loseSightRadius）、在视野角里（实体的本地 +Z 是前方），从眼睛到目标胸口
 *   的射线中间没有别的碰撞体（自己和目标的碰撞体不算）。
 * - 听觉：声音的传播距离乘 hearing 以内就听到，记下声音的位置（不看遮挡）。
 * - 记忆：看不见、听不到以后再记 memory 秒，position 是最后知道的位置。
 * - 开销：每个感知者每 interval 秒看一次（按实体编号错开到不同的帧），候选目标按 16 米的格子找。
 */
import { prop, type EntityId } from '../data/prop';
import { Vector3, type Vec3Like } from '../data/vectors';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';

/** 会看、会听的东西。 */
export const Perceiver = component('Perceiver', {
  /** 看得见多远（米）。 */
  sightRadius: prop.f32().default(20).min(0).unit('m'),
  /** 已经看见的，走到多远才看丢（米，比 sightRadius 大一点，免得在边上闪）。 */
  loseSightRadius: prop.f32().default(25).min(0).unit('m'),
  /** 视野角（度，360 是四周都看得见）。 */
  fieldOfView: prop.f32().default(120).min(0).max(360).unit('°'),
  /** 眼睛离实体原点的高度（米）。 */
  eyeHeight: prop.f32().default(1.6).unit('m'),
  /** 听力：声音的传播距离乘它（0 是聋的）。 */
  hearing: prop.f32().default(1).min(0),
  /** 看不见、听不到以后还记多久（秒）。 */
  memory: prop.f32().default(5).min(0).unit('s'),
});

/** 能被看见的东西。 */
export const PerceptionStimulus = component('PerceptionStimulus', {
  /** 种类（player、threat……），感知者按它分。 */
  tag: prop.string().default(''),
  /** 看它的哪个高度（米，离实体原点；胸口）。 */
  height: prop.f32().default(1).unit('m'),
  /** 关掉时看不见（躲起来了）。 */
  visible: prop.bool().default(true),
});

/** 一个感知者知道的一样东西。 */
export interface Perceived {
  /** 看见的实体，或者声音的来源（没给来源的声音是 undefined）。 */
  readonly entity: Entity | undefined;
  readonly tag: string;
  /** 最近一次是看见的还是听到的。 */
  readonly sense: 'sight' | 'hearing';
  /** 最后知道的位置（世界坐标）。 */
  readonly position: Vector3;
  /** 最后一次看见、听到的游戏时间（秒）。 */
  readonly time: number;
  /** 这一刻看得见。 */
  readonly seeing: boolean;
}

interface Memory {
  entity: Entity | undefined;
  tag: string;
  sense: 'sight' | 'hearing';
  position: Vector3;
  time: number;
  seeing: boolean;
}

interface Stimulus {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tag: string;
}

interface Noise {
  readonly position: Vector3;
  readonly range: number;
  readonly tag: string;
  readonly instigator: Entity | undefined;
}

const CELL = 16;
const cellKey = (x: number, z: number): string => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

export class PerceptionSystem {
  /** 每个感知者隔多久看一次（秒）。 */
  interval = 0.2;
  /** 每帧用调试线画出：看见的（绿）、记着的（黄）、听到的（蓝）。 */
  show = false;
  /** 上一帧：几个感知者、几个可见的东西、看了几个、打了几条射线、花了多少毫秒。 */
  stats = { perceivers: 0, stimuli: 0, evaluated: 0, rays: 0, milliseconds: 0 };
  readonly #memories = new Map<EntityId, Map<string, Memory>>();
  /** 每个感知者上一次看是在哪一段（见 #perceivers）。 */
  readonly #lastLook = new Map<EntityId, number>();
  #noises: Noise[] = [];
  readonly #stimuli: Stimulus[] = [];
  readonly #grid = new Map<string, Stimulus[]>();
  readonly #collectStimuli = system('Perception.stimuli', {
    with: { stimulus: PerceptionStimulus, transform: Transform },
    update: ({ stimulus, transform, entities, count }) => {
      for (let i = 0; i < count; i++) {
        if (!stimulus.visible[i]) continue;
        const w = transform.slot[i]! * 16;
        const item: Stimulus = { id: entities[i]!, x: transform.world[w + 12]!, y: transform.world[w + 13]! + stimulus.height[i]!, z: transform.world[w + 14]!, tag: stimulus.tag[i]! };
        this.#stimuli.push(item);
        const key = cellKey(item.x, item.z);
        const cell = this.#grid.get(key);
        if (cell) cell.push(item);
        else this.#grid.set(key, [item]);
      }
    },
  });

  /** 发一个声音：range 米以内（乘各自的 hearing）的感知者听到；instigator 是发声的东西（脚步、枪声的主人）。 */
  noise(position: Vec3Like, range: number, tag = '', instigator?: Entity): void {
    this.#noises.push({ position: new Vector3(position.x, position.y, position.z), range, tag, instigator });
  }

  /** entity 现在知道的东西（最近的在前）；不是感知者时是空的。 */
  of(entity: Entity | EntityId): readonly Perceived[] {
    const id = typeof entity === 'number' ? entity : entity.id;
    const memories = this.#memories.get(id);
    return memories ? [...memories.values()].sort((a, b) => b.time - a.time) : [];
  }

  /** 每帧一次（Game 的内置子系统）。 */
  update(game: Game): void {
    const started = performance.now();
    this.#stimuli.length = 0;
    this.#grid.clear();
    game.entities.run(this.#collectStimuli, game.updateTime);
    this.#frame = { game, noises: this.#noises, perceivers: 0, evaluated: 0, rays: 0 };
    this.#noises = [];
    game.entities.run(this.#perceivers, game.updateTime);
    const { perceivers, evaluated, rays } = this.#frame;
    this.#frame = undefined;
    // 不再是感知者的（实体没了、组件去掉了）忘掉
    if (this.#memories.size > perceivers) {
      for (const id of this.#memories.keys()) if (!game.entities.isAlive(id) || !game.entities.entity(id).get(Perceiver)) this.#memories.delete(id);
    }
    if (this.show) this.#draw(game);
    this.stats = { perceivers, stimuli: this.#stimuli.length, evaluated, rays, milliseconds: performance.now() - started };
  }

  /** update 的这一帧（感知者的系统里用）。 */
  #frame: { game: Game; noises: readonly Noise[]; perceivers: number; evaluated: number; rays: number } | undefined;

  readonly #perceivers = system('Perception.perceivers', {
    with: { perceiver: Perceiver, transform: Transform },
    update: ({ perceiver, transform, entities: ids, count }, time) => {
      const frame = this.#frame!;
      for (let i = 0; i < count; i++) {
        frame.perceivers++;
        const id = ids[i]!;
        const w = transform.slot[i]! * 16;
        const world = transform.world;
        const eye = { x: world[w + 12]!, y: world[w + 13]! + perceiver.eyeHeight[i]!, z: world[w + 14]! };
        let memories = this.#memories.get(id);
        if (!memories) this.#memories.set(id, (memories = new Map()));
        this.#hear(id, memories, eye, perceiver.hearing[i]!, frame.noises, time.total);
        // 隔 interval 秒看一次：时间按 interval 分段，每个感知者按编号错开一个相位，一段里看一次（同时出现的一大群不会挤在同一帧）
        const bucket = Math.floor(time.total / this.interval + ((id * 0.618034) % 1));
        if (this.#lastLook.get(id) !== bucket) {
          this.#lastLook.set(id, bucket);
          frame.evaluated++;
          frame.rays += this.#look(frame.game, id, memories, eye, world[w + 8]!, world[w + 10]!, perceiver.sightRadius[i]!, perceiver.loseSightRadius[i]!, perceiver.fieldOfView[i]!, time.total);
        }
        const memory = perceiver.memory[i]!;
        for (const [key, item] of memories) if (!item.seeing && time.total - item.time > memory) memories.delete(key);
      }
    },
  });

  /** 传播距离（乘 hearing）以内的声音记下来；看得见的东西发出的声音不改"看得见"。 */
  #hear(id: EntityId, memories: Map<string, Memory>, eye: Vec3Like, hearing: number, noises: readonly Noise[], now: number): void {
    for (const noise of noises) {
      if (noise.instigator?.id === id) continue;
      if (Math.hypot(noise.position.x - eye.x, noise.position.y - eye.y, noise.position.z - eye.z) > noise.range * hearing) continue;
      const key = noise.instigator ? `e${noise.instigator.id}` : `n${noise.tag}`;
      if (memories.get(key)?.seeing) continue;
      memories.set(key, { entity: noise.instigator, tag: noise.tag, sense: 'hearing', position: noise.position.clone(), time: now, seeing: false });
    }
  }

  /** 看一次：候选的可见东西逐个看距离、视野角、遮挡；返回打了几条射线。 */
  #look(game: Game, id: EntityId, memories: Map<string, Memory>, eye: Vec3Like, forwardX: number, forwardZ: number, sight: number, lose: number, fov: number, now: number): number {
    const forwardLength = Math.hypot(forwardX, forwardZ) || 1;
    const fx = forwardX / forwardLength, fz = forwardZ / forwardLength;
    const halfCos = Math.cos((Math.min(fov, 360) / 2) * Math.PI / 180);
    const reach = Math.max(sight, lose);
    let rays = 0;
    const seen = new Set<string>();
    const x0 = Math.floor((eye.x - reach) / CELL), x1 = Math.floor((eye.x + reach) / CELL);
    const z0 = Math.floor((eye.z - reach) / CELL), z1 = Math.floor((eye.z + reach) / CELL);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const target of this.#grid.get(`${cx},${cz}`) ?? []) {
          if (target.id === id) continue;
          const key = `e${target.id}`;
          const before = memories.get(key);
          const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z;
          const distance = Math.hypot(dx, dy, dz);
          if (distance > (before?.seeing ? lose : sight) || distance < 1e-6) continue;
          const flat = Math.hypot(dx, dz);
          if (fov < 360 && flat > 1e-6 && (dx * fx + dz * fz) / flat < halfCos) continue;
          rays++;
          if (!this.#clear(game, id, target.id, eye, dx / distance, dy / distance, dz / distance, distance)) continue;
          seen.add(key);
          memories.set(key, { entity: game.entities.entity(target.id), tag: target.tag, sense: 'sight', position: new Vector3(target.x, target.y, target.z), time: now, seeing: true });
        }
      }
    }
    // 这次没看见的：不再"看得见"，记着最后的位置
    for (const [key, memory] of memories) if (memory.seeing && !seen.has(key)) memory.seeing = false;
    return rays;
  }

  /** 从眼睛到目标中间没有别的碰撞体（自己、目标和它们的子实体的碰撞体不算）。 */
  #clear(game: Game, self: EntityId, target: EntityId, eye: Vec3Like, dx: number, dy: number, dz: number, distance: number): boolean {
    const simulation = game.simulation;
    if (!simulation) return true;
    for (const hit of simulation.rayCastPenetrating([eye.x, eye.y, eye.z], [dx, dy, dz], distance)) {
      if (hit.distance >= distance - 0.05) return true;
      if (!belongsTo(game, hit.entity, self) && !belongsTo(game, hit.entity, target)) return false;
    }
    return true;
  }

  #draw(game: Game): void {
    for (const [id, memories] of this.#memories) {
      if (!game.entities.isAlive(id)) continue;
      const world = game.entities.entity(id).require(Transform).world;
      const eye: [number, number, number] = [world[12]!, world[13]! + (game.entities.entity(id).get(Perceiver)?.eyeHeight ?? 1.6), world[14]!];
      for (const memory of memories.values()) {
        const color: [number, number, number, number] = memory.seeing ? [0.2, 1, 0.3, 1] : memory.sense === 'hearing' ? [0.3, 0.6, 1, 1] : [1, 0.85, 0.2, 1];
        game.debugDraw.line(eye, [memory.position.x, memory.position.y, memory.position.z], color);
      }
    }
  }

  /** 换场景、清空时忘掉一切。 */
  clear(): void {
    this.#memories.clear();
    this.#lastLook.clear();
    this.#noises = [];
  }
}

/** entity 是 owner 自己或者它的子孙。 */
function belongsTo(game: Game, entity: EntityId | undefined, owner: EntityId): boolean {
  for (let current = entity !== undefined && game.entities.isAlive(entity) ? game.entities.entity(entity) : undefined; current; current = current.get(Transform)?.parent) {
    if (current.id === owner) return true;
  }
  return false;
}
