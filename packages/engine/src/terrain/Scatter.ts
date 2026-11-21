/**
 * 程序化摆放（W4）：Scatter 组件挂在地形实体上，引用一个 `.scatter.json`（content/scatterFormat.ts），按规则在地形上撒模型。
 *
 * - 撒法是纯函数（scatterCell）：一层按 density 的抖动网格出候选点（网格对齐地形的原点），每个点的随机数由种子、层、网格坐标
 *   哈希出来，所以同一个点不管哪个流式的格子、什么时候撒都一样；按坡度、高度、成片的噪声、离路和地物的距离筛，剩下的随机转、
 *   缩放、可选地顺着坡倾斜，贴在地面上（高度直接求值，同 game.terrain.heightAt）；
 * - ScatterSystem 按相机附近的格子撒（每层按自己的 viewDistance、cellSize），近的先撒，每帧有时间预算；走远了拿掉。每个格子
 *   一个子实体，下面每个实例一个带模型的实体（剔除、阴影、点选照常）。地形或摆放文件换了新版本（编辑器、热重载、雕刻）时只重撒
 *   受影响的：规则没变的层留着，地形只是加减了笔画、地物、样条时只重撒盖到改动范围的格子（同地形的块，changedRegions）；
 * - 草（层的 grass）：每个点一片草叶（一个三角形），一个格子的草合成一个网格挂在格子的实体上。草密，地面的高度不逐点求值：
 *   整个格子按 1 米的格距在工作线程上算一页高度（TerrainAsset.heights），双线性插值出高度和法线（草叶的法线用地面的，和地形的
 *   光照接得上）。
 */
import type { LoadedModel } from '../content/ContentManager';
import type { Material } from '../rendering/mesh/Material';
import { Mesh } from '../rendering/mesh/Mesh';
import { Model } from '../rendering/components';
import type { ScatterFile, ScatterLayerFile } from '../content/scatterFormat';
import { Matrix } from '../data/Matrix';
import { prop, type Branded, type EntityId } from '../data/prop';
import { Quaternion, Vector3 } from '../data/vectors';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { Game } from '../engine/Game';
import { ResourceTable } from '../engine/ResourceTable';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Terrain, TerrainAsset, type TerrainPath } from './Terrain';
import { changedRegions } from './TerrainSystem';

export type ScatterAssetId = Branded<number, 'ScatterAssetId'>;

/** 摆放：挂在地形实体上（同一个实体要有 Terrain），按 scatter 的规则在这个地形上撒。 */
export const Scatter = component('Scatter', {
  scatter: prop.u32().brand<'ScatterAssetId'>().default(0 as ScatterAssetId),
});

const assets = new ResourceTable<ScatterAsset>();

/**
 * 加载好的摆放资源：文件、每层每个细节层次的模型（models[层][层次]，0 是近处的，撒草的层没有）和草的材质（按层的顺序；没写的是
 * undefined，用默认材质）。
 */
export class ScatterAsset {
  readonly id: ScatterAssetId;
  readonly path: string;
  readonly file: ScatterFile;
  readonly models: readonly (readonly (LoadedModel | undefined)[])[];
  readonly materials: readonly (Material | undefined)[];

  constructor(path: string, file: ScatterFile, models: readonly (readonly (LoadedModel | undefined)[])[], materials: readonly (Material | undefined)[] = []) {
    this.path = path;
    this.file = file;
    this.models = models;
    this.materials = materials;
    this.id = assets.add(this) as ScatterAssetId;
  }

  /** @internal Scatter 组件里存的 id 对应的资源。 */
  static byId(id: number): ScatterAsset | undefined {
    return assets.get(id);
  }
}

/** 一个实例：地形本地的位置、旋转、均匀的缩放。 */
export interface ScatterInstance {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
  /** 地面在这一点的法线（草叶用它当法线）。 */
  readonly normal: readonly [number, number, number];
}

/** 地面上一点：高度和单位法线（地形本地）；地形以外是 undefined。 */
export type GroundSample = (x: number, z: number) => { readonly height: number; readonly normal: readonly [number, number, number] } | undefined;

/**
 * 撒一个格子（地形本地 [x0, x0 + size) × [z0, z0 + size)）里第 layerIndex 层的实例。blocked(x, z) 为真的点不撒（离路太近、
 * 在压平的地物里）。纯函数：同样的输入撒出同样的实例。
 */
export function scatterCell(
  layer: ScatterLayerFile, layerIndex: number, seed: number, x0: number, z0: number, size: number, ground: GroundSample, blocked: (x: number, z: number) => boolean = () => false, keep = 1,
): ScatterInstance[] {
  const spacing = Math.sqrt(10_000 / layer.density);
  const [minSlope, maxSlope] = layer.slope ?? [0, 90];
  const [minScale, maxScale] = layer.scale ?? [0.8, 1.2];
  const align = Math.min(1, Math.max(0, layer.alignToSlope ?? 0));
  const instances: ScatterInstance[] = [];
  // 网格点 i 抖动后总在 [i·spacing, (i + 1)·spacing) 里：格子盖到的网格都看一遍，落在格子外的不要
  const i0 = Math.floor(x0 / spacing), i1 = Math.floor((x0 + size) / spacing);
  const j0 = Math.floor(z0 / spacing), j1 = Math.floor((z0 + size) / spacing);
  const layerSeed = hash(seed ^ 0x9e3779b9, layerIndex);
  // 草一个格子上万个点：每个点的随机数、旋转都不新建对象
  const random = (k: number) => hash(base, k) / 4294967296;
  let base = 0;
  for (let i = i0; i <= i1; i++) {
    const row = hash(layerSeed, i);
    for (let j = j0; j <= j1; j++) {
      base = hash(row, j);
      // 抖动不超出自己的网格：相邻的格子不会重复撒
      const x = (i + 0.5 + (random(0) - 0.5) * 0.9) * spacing, z = (j + 0.5 + (random(1) - 0.5) * 0.9) * spacing;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      // 成片：阈值按点抖一点（±0.08），斑块的边是渐渐稀下去的，不是一条硬线
      if (layer.clump && clumpNoise(x / layer.clump.scale, z / layer.clump.scale, seed + layerIndex * 101) > layer.clump.coverage + (random(4) - 0.5) * 0.16) continue;
      // 远处只留一部分（按点的随机数：留下的是近处那些点的子集）
      if (keep < 1 && random(5) >= keep) continue;
      if (blocked(x, z)) continue;
      const sample = ground(x, z);
      if (!sample) continue;
      const slope = (Math.acos(Math.min(1, sample.normal[1])) * 180) / Math.PI;
      if (slope < minSlope || slope > maxSlope) continue;
      if (layer.height && (sample.height < layer.height[0] || sample.height > layer.height[1])) continue;
      const scale = minScale + (maxScale - minScale) * random(2);
      const half = random(3) * Math.PI;
      let rotation: [number, number, number, number] = [0, Math.sin(half), 0, Math.cos(half)];
      if (align > 0) {
        const tilt = new Quaternion().slerp(Quaternion.betweenDirections({ x: 0, y: 1, z: 0 }, new Vector3(...sample.normal)), align).multiply(new Quaternion(...rotation));
        rotation = [tilt.x, tilt.y, tilt.z, tilt.w];
      }
      instances.push({ position: [x, sample.height - (layer.sink ?? 0) * scale, z], rotation, scale, normal: [sample.normal[0], sample.normal[1], sample.normal[2]] });
    }
  }
  return instances;
}

/** 32 位整数哈希（lowbias32，Chris Wellons）。 */
function hash(a: number, b: number): number {
  let h = (Math.imul(a, 0x7feb352d) ^ (b + 0x846ca68b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 成片的噪声：两层值噪声（平滑插值），值大致在 [0, 1] 里均匀分布（按 coverage 比较：小于它的地方撒）。坐标已经除过斑块的大小。
 */
function clumpNoise(x: number, z: number, seed: number): number {
  const value = (x: number, z: number, s: number) => {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const r = (a: number, b: number) => hash(hash(s, a), b) / 4294967296;
    const top = r(xi, zi) + (r(xi + 1, zi) - r(xi, zi)) * sx, bottom = r(xi, zi + 1) + (r(xi + 1, zi + 1) - r(xi, zi + 1)) * sx;
    return top + (bottom - top) * sz;
  };
  const n = value(x, z, seed) * 0.65 + value(x * 2.7 + 13.1, z * 2.7 - 7.3, seed + 1) * 0.35;
  // 两层值噪声的和集中在中间：拉开成大致均匀（经验的 S 形），coverage 才接近盖住的面积
  return Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2.1));
}

/** 撒好的一个格子：子实体（下面是各个实例，或者挂着草的网格），最后一次在范围里的帧，细节层次，草的网格（拿掉格子时放掉）。 */
interface Cell {
  readonly entity: Entity;
  used: number;
  readonly tier: number;
  mesh?: Mesh;
  /** 地形在这个格子里改了：下次选格子时重撒（新的撒好了再拿掉它）。 */
  stale?: boolean;
}

/** 细节层次的边界两边各留几米：相机在边界上来回走时格子不来回换。 */
const LOD_HYSTERESIS = 4;

/** 离相机 distance 米的格子用第几个细节层次（0 是近处的）；current 是它现在的，边界附近不换。 */
export function lodTier(layer: ScatterLayerFile, distance: number, current?: number): number {
  const lods = layer.lods ?? [];
  let tier = 0;
  while (tier < lods.length && distance > lods[tier]!.distance) tier++;
  if (current === undefined || current === tier) return tier;
  // 往远换要超过边界 LOD_HYSTERESIS 米，往近换要进来 LOD_HYSTERESIS 米
  const boundary = lods[Math.min(tier, current)]!.distance;
  return Math.abs(distance - boundary) < LOD_HYSTERESIS ? current : tier;
}

interface ScatterState {
  readonly entity: Entity;
  readonly asset: ScatterAsset;
  readonly terrain: TerrainAsset;
  /** `层:x_z` → 格子。 */
  readonly cells: Map<string, Cell>;
  /** 上次选格子时的观察点（地形本地的 x、z），那时要的格子是不是都撒好了：没挪多少、都撒好了就不再选。 */
  eye: readonly [number, number] | undefined;
  complete: boolean;
}

/** 观察点挪不到这么多米、格子都撒好了时不重选格子。 */
const RESELECT_DISTANCE = 2;

/** 每帧撒格子最多用多少毫秒（近的先撒，没撒完的下一帧接着撒）。 */
const BUDGET_MS = 2;
/** 求法线的差分步长（米）。 */
const NORMAL_STEP = 0.5;

/** 摆放的系统：Game 每帧在地形更新以后调。 */
export class ScatterSystem {
  readonly #game: Game;
  readonly #states = new Map<EntityId, ScatterState>();
  readonly #seen = new Set<EntityId>();
  readonly #inverse = new Float64Array(16);
  #frame = 0;
  /** 撒过的格子、实例数（累计，调试命令报）。 */
  built = { cells: 0, instances: 0 };
  /** 高度页算好了、等着撒的草的格子：在 update 里按每帧的预算撒（不在回调里一下子撒完，飞得快时一帧来十几个）。 */
  readonly #ready: (() => void)[] = [];

  readonly #collect = system('ScatterSystem.collect', {
    with: { scatter: Scatter, terrain: Terrain, transform: Transform },
    update: ({ entities, count }) => {
      for (let row = 0; row < count; row++) this.#seen.add(entities[row]!);
    },
  });

  constructor(game: Game) {
    this.#game = game;
  }

  update(eyeWorld: readonly number[] | undefined): void {
    const game = this.#game;
    this.#frame++;
    this.#seen.clear();
    game.entities.run(this.#collect, game.updateTime);
    for (const [id, state] of this.#states) if (!this.#seen.has(id) || !state.entity.alive) this.#drop(id, state);
    if (!eyeWorld) return;
    const deadline = performance.now() + BUDGET_MS;
    // 先撒高度页已经好了的草（近的先要的，也先好）
    while (this.#ready.length > 0 && performance.now() < deadline) this.#ready.shift()!();
    for (const id of this.#seen) {
      const entity = game.entities.entity(id);
      const asset = ScatterAsset.byId(entity.require(Scatter).scatter);
      const terrain = TerrainAsset.byId(entity.require(Terrain).terrain);
      if (!asset || !terrain) continue;
      let state = this.#states.get(id);
      // 摆放文件、地形换了新版本：留下没受影响的格子
      if (state && (state.asset !== asset || state.terrain !== terrain)) {
        state = this.#carryOver(state, asset, terrain);
        this.#states.set(id, state);
      }
      if (!state) {
        state = { entity, asset, terrain, cells: new Map(), eye: undefined, complete: false };
        this.#states.set(id, state);
      }
      this.#updateState(state, eyeWorld, deadline);
    }
  }

  /** 每个地形实体撒了几个格子、几个实例（调试命令 scatter 报）。 */
  stats(): { entity: string; asset: string; cells: number; instances: number }[] {
    return [...this.#states.values()].map((state) => ({
      entity: state.entity.name, asset: state.asset.path, cells: state.cells.size,
      instances: [...state.cells.values()].reduce((sum, cell) => sum + (cell.entity.get(Transform)?.children.length ?? 0), 0),
    }));
  }

  #updateState(state: ScatterState, eyeWorld: readonly number[], deadline: number): void {
    const world = state.entity.require(Transform).world;
    if (!Matrix.invert(this.#inverse, world)) return;
    const m = this.#inverse;
    const ex = m[0]! * eyeWorld[0]! + m[4]! * eyeWorld[1]! + m[8]! * eyeWorld[2]! + m[12]!;
    const ez = m[2]! * eyeWorld[0]! + m[6]! * eyeWorld[1]! + m[10]! * eyeWorld[2]! + m[14]!;
    if (state.complete && state.eye && Math.hypot(ex - state.eye[0], ez - state.eye[1]) < RESELECT_DISTANCE) return;
    const file = state.asset.file;
    const half = state.entity.require(Terrain).size / 2;
    // 要的格子：每层 viewDistance 以内（按格子中心），近的先撒
    const wanted: { key: string; layer: number; cx: number; cz: number; size: number; distance: number; tier: number; replaces?: Cell }[] = [];
    file.layers.forEach((layer, l) => {
      const reach = layer.viewDistance ?? 400, size = layer.cellSize ?? file.cellSize ?? 64;
      const c0x = Math.floor((ex - reach) / size), c1x = Math.floor((ex + reach) / size);
      const c0z = Math.floor((ez - reach) / size), c1z = Math.floor((ez + reach) / size);
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cz = c0z; cz <= c1z; cz++) {
          if ((cx + 1) * size < -half || cx * size > half || (cz + 1) * size < -half || cz * size > half) continue;
          const distance = Math.hypot((cx + 0.5) * size - ex, (cz + 0.5) * size - ez);
          if (distance > reach) continue;
          const key = `${l}:${cx}_${cz}`;
          const cell = state.cells.get(key);
          const tier = lodTier(layer, distance, cell?.tier);
          if (cell) cell.used = this.#frame;
          // 细节层次变了的格子重撒（新的撒好了再拿掉旧的，不闪）
          if (!cell || cell.tier !== tier || cell.stale) wanted.push({ key, layer: l, cx, cz, size, distance, tier, ...(cell ? { replaces: cell } : {}) });
        }
      }
    });
    wanted.sort((a, b) => a.distance - b.distance);
    let built = 0;
    for (const want of wanted) {
      if (performance.now() > deadline) break;
      const { layer, cx, cz, size, tier, replaces } = want;
      const grass = file.layers[layer]!.grass !== undefined;
      state.cells.set(want.key, grass
        ? this.#buildGrass(state, layer, tier, cx * size, cz * size, size, `${cx}_${cz}`, replaces)
        : { entity: this.#build(state, layer, tier, cx * size, cz * size, size, `${cx}_${cz}`), used: this.#frame, tier });
      if (replaces && !grass) dropCell(replaces);
      built++;
    }
    state.eye = [ex, ez];
    state.complete = built === wanted.length;
    // 出了范围的格子拿掉（留一帧的余地：刚好在边上的不来回建、拆）
    for (const [key, cell] of state.cells) {
      if (cell.used < this.#frame - 1) {
        dropCell(cell);
        state.cells.delete(key);
      }
    }
  }

  #build(state: ScatterState, layerIndex: number, tier: number, x0: number, z0: number, size: number, id: string): Entity {
    const game = this.#game, native = game.native, terrain = state.terrain;
    const layer = state.asset.file.layers[layerIndex]!;
    const half = state.entity.require(Terrain).size / 2;
    const ground: GroundSample = (x, z) => {
      if (Math.abs(x) > half || Math.abs(z) > half) return undefined;
      const h = terrain.heightAt(native, x, z);
      const hx = terrain.heightAt(native, x + NORMAL_STEP, z), hz = terrain.heightAt(native, x, z + NORMAL_STEP);
      const n = new Vector3(-(hx - h), NORMAL_STEP, -(hz - h)).normalize();
      return { height: h, normal: [n.x, n.y, n.z] };
    };
    const instances = scatterCell(layer, layerIndex, state.asset.file.seed ?? 1, x0, z0, size, ground, blockedBy(terrain, layer.avoidPaths ?? 3, x0, z0, size), keepOf(layer, tier));
    const cell = game.entities.create({ name: `${state.entity.name}/scatter ${layer.name} ${id}`, components: [Transform] });
    cell.require(Transform).parent = state.entity;
    const model = state.asset.models[layerIndex]?.[tier];
    if (!model) throw new Error(`${state.asset.path}: layer ${layer.name} has no model`);
    for (const instance of instances) {
      const child = game.entities.create({ name: layer.name, components: [Transform.with({ position: instance.position, rotation: instance.rotation, scale: [instance.scale, instance.scale, instance.scale] })] });
      child.require(Transform).parent = cell;
      game.content.addModel(child, model, { isShadowCaster: layer.castShadows ?? true });
    }
    this.built.cells++;
    this.built.instances += instances.length;
    return cell;
  }

  /**
   * 撒一个格子的草：格子的实体马上建（占住位置），高度页在工作线程上算好以后撒草叶、合成网格挂上去；那时格子已经拿掉了就不挂。
   */
  #buildGrass(state: ScatterState, layerIndex: number, tier: number, x0: number, z0: number, size: number, id: string, replaces?: Cell): Cell {
    const game = this.#game, terrain = state.terrain;
    const layer = state.asset.file.layers[layerIndex]!;
    const cellEntity = game.entities.create({ name: `${state.entity.name}/grass ${layer.name} ${id}`, components: [Transform] });
    cellEntity.require(Transform).parent = state.entity;
    const cell: Cell = { entity: cellEntity, used: this.#frame, tier };
    // 多算一圈（求格子边上的法线），格距 GRASS_SPACING
    const count = Math.ceil(size / GRASS_SPACING) + 3;
    const ox = x0 - GRASS_SPACING, oz = z0 - GRASS_SPACING;
    const half = state.entity.require(Terrain).size / 2;
    void terrain.heights(game.native, ox, oz, GRASS_SPACING, count, count).then((heights) => {
      // 编辑器按需出帧：叫醒一帧来撒
      game.requestFrames?.();
      this.#ready.push(() => {
        // 换细节层次时旧的格子留到新的好了才拿掉（新的已经拿掉了也要拿掉它：它不在格子表里了）
        if (replaces) dropCell(replaces);
        if (!cellEntity.alive) return;
        const ground = gridGround(heights, ox, oz, GRASS_SPACING, count, half);
        const instances = scatterCell(layer, layerIndex, state.asset.file.seed ?? 1, x0, z0, size, ground, blockedBy(terrain, layer.avoidPaths ?? 3, x0, z0, size), keepOf(layer, tier));
        if (instances.length === 0) return;
        cell.mesh = new Mesh(`${state.asset.path} ${layer.name} ${id}`, grassBlades(layer, instances));
        const material = state.asset.materials[layerIndex] ?? game.content.defaultMaterial;
        cellEntity.add(Model.with({ mesh: cell.mesh.id, material: material.id, isShadowCaster: layer.castShadows ?? false }));
        this.built.cells++;
        this.built.instances += instances.length;
      });
    }, (error: unknown) => {
      if (replaces) dropCell(replaces);
      console.warn(`[stride] ${state.asset.path}: grass ${layer.name} ${id}: ${(error as Error).message}`);
    });
    return cell;
  }

  /**
   * 换了新版本的摆放文件或地形：规则（文件的种子、格子大小，层的内容、模型、材质）没变的层留下它的格子，变了的拿掉；地形只是
   * 加减了笔画、地物、样条时，盖到改动范围（加上离路的距离）的格子标成要重撒，地形的底变了全部拿掉。
   */
  #carryOver(state: ScatterState, asset: ScatterAsset, terrain: TerrainAsset): ScatterState {
    const before = state.asset.file, after = asset.file;
    const regions = state.terrain === terrain ? [] : changedRegions(state.terrain.file, terrain.file, state.terrain.paths, terrain.paths);
    const sameLayer = (l: number) =>
      before.seed === after.seed && before.cellSize === after.cellSize && l < after.layers.length
      && JSON.stringify(before.layers[l]) === JSON.stringify(after.layers[l])
      && (state.asset.models[l] ?? []).every((model, k) => model === asset.models[l]?.[k]) && state.asset.materials[l] === asset.materials[l];
    const cells = new Map<string, Cell>();
    let kept = 0, stale = 0;
    for (const [key, cell] of state.cells) {
      const layerIndex = Number(key.slice(0, key.indexOf(':')));
      if (regions === undefined || !sameLayer(layerIndex)) {
        dropCell(cell);
        continue;
      }
      const layer = after.layers[layerIndex]!, size = layer.cellSize ?? after.cellSize ?? 64, margin = layer.avoidPaths ?? 3;
      const [cx, cz] = key.slice(key.indexOf(':') + 1).split('_').map(Number) as [number, number];
      const x0 = cx * size - margin, z0 = cz * size - margin, x1 = (cx + 1) * size + margin, z1 = (cz + 1) * size + margin;
      if (regions.some(([rx0, rz0, rx1, rz1]) => rx0 < x1 && rx1 > x0 && rz0 < z1 && rz1 > z0)) {
        cell.stale = true;
        stale++;
      }
      cells.set(key, cell);
      kept++;
    }
    this.carried = { kept, stale, dropped: state.cells.size - kept };
    return { entity: state.entity, asset, terrain, cells, eye: undefined, complete: false };
  }

  /** 上一次换版本时留下、要重撒、拿掉的格子数（调试命令 scatter 报，看雕刻时重撒了多少）。 */
  carried = { kept: 0, stale: 0, dropped: 0 };

  #drop(id: EntityId, state: ScatterState): void {
    for (const cell of state.cells.values()) dropCell(cell);
    this.#states.delete(id);
  }
}

/** 第 tier 个细节层次留下多少点：那一层（或更近的一层）写的 keep，都没写是 1。 */
function keepOf(layer: ScatterLayerFile, tier: number): number {
  for (let k = tier - 1; k >= 0; k--) {
    const keep = layer.lods?.[k]?.keep;
    if (keep !== undefined) return keep;
  }
  return 1;
}

/** 草的格子按多少米的格距算地面的高度页。 */
const GRASS_SPACING = 1;

/** 拿掉一个格子：实体（连同下面的实例）、草的网格。 */
function dropCell(cell: Cell): void {
  if (cell.entity.alive) cell.entity.destroy();
  cell.mesh?.dispose();
}

/**
 * 从一页高度（count × count 个，原点 (ox, oz)，格距 spacing，按行 x 先变）插出地面：双线性的高度，法线按中心差分（也双线性）。
 * 地形以外（|x|、|z| 超过 half）是 undefined。
 */
export function gridGround(heights: Float32Array, ox: number, oz: number, spacing: number, count: number, half: number): GroundSample {
  const at = (i: number, j: number) => heights[Math.min(count - 1, Math.max(0, j)) * count + Math.min(count - 1, Math.max(0, i))]!;
  return (x, z) => {
    if (Math.abs(x) > half || Math.abs(z) > half) return undefined;
    const fx = (x - ox) / spacing, fz = (z - oz) / spacing;
    const i = Math.min(count - 2, Math.max(0, Math.floor(fx))), j = Math.min(count - 2, Math.max(0, Math.floor(fz)));
    const tx = fx - i, tz = fz - j;
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const h = lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), tz);
    const dx = lerp(lerp(at(i + 1, j) - at(i - 1, j), at(i + 2, j) - at(i, j), tx), lerp(at(i + 1, j + 1) - at(i - 1, j + 1), at(i + 2, j + 1) - at(i, j + 1), tx), tz) / 2;
    const dz = lerp(lerp(at(i, j + 1) - at(i, j - 1), at(i + 1, j + 1) - at(i + 1, j - 1), tx), lerp(at(i, j + 2) - at(i, j), at(i + 1, j + 2) - at(i + 1, j), tx), tz) / 2;
    const length = Math.hypot(dx, spacing, dz);
    return { height: h, normal: [-dx / length, spacing / length, -dz / length] };
  };
}

/**
 * 草叶合成一个网格：每个实例一个三角形——根部两个点（宽 width · 缩放，横着的方向随实例的朝向）、梢一个点（高 height · 缩放，
 * 往实例的 +Z 歪 lean 个叶高）。法线用地面的（和地形的光照接得上），UV 的 v 根是 1、梢是 0（风的草模式按它摆）。
 */
export function grassBlades(layer: ScatterLayerFile, instances: readonly ScatterInstance[]): { vertices: Float32Array; indices: Uint32Array } {
  const { height, width, lean = 0.3 } = layer.grass!;
  const vertices = new Float32Array(instances.length * 3 * 8), indices = new Uint32Array(instances.length * 3);
  for (let k = 0; k < instances.length; k++) {
    const { position: [x, y, z], rotation: [qx, qy, qz, qw], scale, normal: [nx, ny, nz] } = instances[k]!;
    // 实例的本地 +X（横着）、+Z（梢歪的方向）转到地形里：四元数直接转单位向量（不建对象）
    const ax = 1 - 2 * (qy * qy + qz * qz), ay = 2 * (qx * qy + qw * qz), az = 2 * (qx * qz - qw * qy);
    const fx = 2 * (qx * qz + qw * qy), fz = 1 - 2 * (qx * qx + qy * qy);
    const w = (width * scale) / 2, l = lean * height * scale;
    let o = k * 24;
    const put = (px: number, py: number, pz: number, u: number, v: number) => {
      vertices[o] = px; vertices[o + 1] = py; vertices[o + 2] = pz;
      vertices[o + 3] = nx; vertices[o + 4] = ny; vertices[o + 5] = nz;
      vertices[o + 6] = u; vertices[o + 7] = v;
      o += 8;
    };
    put(x - ax * w, y - ay * w, z - az * w, 0, 1);
    put(x + ax * w, y + ay * w, z + az * w, 1, 1);
    put(x + fx * l, y + height * scale, z + fz * l, 0.5, 0);
    indices[k * 3] = k * 3;
    indices[k * 3 + 1] = k * 3 + 1;
    indices[k * 3 + 2] = k * 3 + 2;
  }
  return { vertices, indices };
}

/**
 * 格子里哪些点不撒：离地形贴着的样条（路、铁路）的路面边 margin 米以内，或者在压平的地物（多边形）里。只看盖到这个格子的
 * 路径线段和地物。
 */
function blockedBy(terrain: TerrainAsset, margin: number, x0: number, z0: number, size: number): (x: number, z: number) => boolean {
  const segments: { ax: number; az: number; bx: number; bz: number; reach: number }[] = [];
  for (const path of terrain.paths as readonly TerrainPath[]) {
    const reach = path.width / 2 + margin;
    for (let i = 0; i + 1 < path.points.length; i++) {
      const [ax, , az] = path.points[i]!, [bx, , bz] = path.points[i + 1]!;
      if (Math.max(ax, bx) + reach < x0 || Math.min(ax, bx) - reach > x0 + size || Math.max(az, bz) + reach < z0 || Math.min(az, bz) - reach > z0 + size) continue;
      segments.push({ ax, az, bx, bz, reach });
    }
  }
  const polygons = (terrain.file.features ?? []).map((feature) => feature.points).filter((points) => {
    const xs = points.map((p) => p[0]), zs = points.map((p) => p[1]);
    return Math.max(...xs) >= x0 && Math.min(...xs) <= x0 + size && Math.max(...zs) >= z0 && Math.min(...zs) <= z0 + size;
  });
  return (x, z) => {
    for (const s of segments) {
      const ex = s.bx - s.ax, ez = s.bz - s.az, len = ex * ex + ez * ez;
      const t = len > 0 ? Math.min(1, Math.max(0, ((x - s.ax) * ex + (z - s.az) * ez) / len)) : 0;
      if (Math.hypot(x - s.ax - ex * t, z - s.az - ez * t) < s.reach) return true;
    }
    return polygons.some((points) => inside(points, x, z));
  };
}

/** 点在多边形里（奇偶规则）。 */
function inside(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) result = !result;
  }
  return result;
}
