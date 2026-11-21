/**
 * 地形的渲染（`game.terrain`）：每帧对每个 Terrain 实体按相机选块（terrainTiles.ts 的四叉树），没好的块在工作线程上求高度，写进
 * 高度页（rendering/mesh/HeightPages.ts）；好的块挂成实体的子实体（TerrainTile，带 Model 和 HeightfieldTile），全部用这个地形的
 * 同一个高度场网格和材质，网格渲染特性一次实例化绘制画完（剔除、阴影、材质都和普通模型一样）。
 *
 * - 没变就不做：相机挪得不到最细一层块边长的 1/8、也没有新的块好了时，不重选；
 * - 同时最多 MAX_PENDING 页在算；块的高度页缓存着（最近用过的留 MAX_CACHED 块），不用的还回去；
 * - 资源、尺寸、细节这些设置变了（编辑器里改了地形文件、热重载），整个重建。
 *
 * `stride call terrain` 看每个地形画了几块、在算几块、缓存了几块。
 */
import { Matrix } from '../data/Matrix';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { Entity } from '../engine/Entity';
import type { EntityId } from '../data/prop';
import type { Game } from '../engine/Game';
import { Model } from '../rendering/components';
import { Mesh } from '../rendering/mesh/Mesh';
import { HeightfieldTile, HeightPages } from '../rendering/mesh/HeightPages';
import { Character } from '../physics/components';
import { Terrain, TerrainAsset, TerrainTile } from './Terrain';
import type { TerrainFile } from '../content/terrainFormat';
import { heightfieldGrid, leafLevel, selectTiles, TILE_QUADS, TILE_SAMPLES, tileId, tilePageHeader, tileRect, type TileKey } from './terrainTiles';

/** 同时在算的高度页最多几个（每页约 1 毫秒，工作线程上）。 */
const MAX_PENDING = 8;
/** 每个地形缓存的块最多几个（不在画的、最久没用的先释放）。 */
const MAX_CACHED = 768;
/** 相机、角色所在的块往外几块建碰撞（最细一层；32 米的块时是 160 米见方）。 */
const COLLIDER_RADIUS = 2;
/** UV 按这么多个贴图周期取模：大世界里 UV 的数也小。 */
const UV_PERIODS = 256;
/** 射线找地面时假定地形最陡的坡（高差 ÷ 水平距离）：按它算一步能放心走多远；比它陡的悬崖可能被一步跨过去。 */
const MAX_SLOPE = 4;
/** 射线找地面最多走多少步、最小一步（米，离得远时按距离放大）。 */
const MAX_RAY_STEPS = 1024;
const MIN_RAY_STEP = 0.05;

interface Tile {
  readonly key: TileKey;
  /** 高度页的起点（HeightPages）；还在算时是 undefined。 */
  page: number | undefined;
  /** 最后一次被选中（画或者要）的帧。 */
  used: number;
  /** 高度页在算。 */
  requested: boolean;
  /** 地形文件改了、这块在改动的范围里：照旧画着旧的页，新的页算好了换上（雕刻时不闪）。 */
  stale: boolean;
}

/** 一个地形实体的状态。 */
interface TerrainState {
  readonly entity: Entity;
  /** 建块时的设置：变了整个重建。 */
  settings: string;
  asset: TerrainAsset;
  /** 这个地形的块共用的高度场网格；剔除的包围盒的高度范围跟着算好的页放大。 */
  readonly grid: Mesh;
  /** 算好的页的高度范围（包围盒用）。 */
  minHeight: number;
  maxHeight: number;
  readonly tiles: Map<string, Tile>;
  /** 正在画的块 → 子实体。 */
  readonly drawn: Map<string, Entity>;
  pending: number;
  /** 上次选块时的观察点（地形本地坐标）；新的块好了时清掉，下一帧重选。 */
  eye: [number, number, number] | undefined;
  /** 设置变了加一：算到一半的页发现代数不对就扔掉。 */
  generation: number;
  /** 算过的块数、碰撞块数（累计，调试命令 terrain 报，看雕刻时重算了多少）。 */
  built: { tiles: number; colliders: number };
  /** 碰撞的块（最细一层，按格子坐标 `x_z`）：物理世界里的高度场，相机和角色附近才有。 */
  readonly colliders: Map<string, Collider>;
}

/** 一块碰撞：建好了是拿掉它的函数，还在算时是 undefined。 */
interface Collider {
  release: (() => void) | undefined;
  /** 最后一次在要的范围里的帧。 */
  used: number;
}

export class TerrainSystem {
  readonly #game: Game;
  readonly #states = new Map<EntityId, TerrainState>();
  #frame = 0;
  readonly #seen = new Set<EntityId>();
  readonly #inverse = new Float64Array(16);

  readonly #collect = system('TerrainSystem.collect', {
    with: { terrain: Terrain, transform: Transform },
    update: ({ entities, count }) => {
      for (let row = 0; row < count; row++) this.#seen.add(entities[row]!);
    },
  });

  constructor(game: Game) {
    this.#game = game;
  }

  /** 每帧（变换更新以后、画之前）：选块、发起要算的页、换上好了的块。 */
  update(): void {
    const game = this.#game;
    this.#frame++;
    this.#seen.clear();
    game.entities.run(this.#collect, game.updateTime);
    for (const [id, state] of this.#states) if (!this.#seen.has(id) || !state.entity.alive) this.#drop(id, state);
    const eye = this.#eyeWorld();
    for (const id of this.#seen) {
      const entity = game.entities.entity(id);
      const terrain = entity.require(Terrain);
      const asset = TerrainAsset.byId(terrain.terrain);
      if (!asset) continue;
      const settings = `${asset.path}|${terrain.size}|${terrain.detail}|${terrain.lodFactor}|${terrain.isShadowCaster}|${terrain.renderGroup}`;
      let state = this.#states.get(id);
      if (state && state.settings !== settings) {
        this.#drop(id, state);
        state = undefined;
      }
      // 同一个地形文件的新版本（编辑器、MCP 改了、热重载）：只改了笔画、地物时只重算盖到的块
      if (state && state.asset !== asset && !this.#swapAsset(state, asset)) {
        this.#drop(id, state);
        state = undefined;
      }
      if (!state) {
        const grid = new Mesh(`${asset.path} heightfield`, { ...heightfieldGrid(), heightfield: true });
        state = { entity, settings, asset, grid, minHeight: Infinity, maxHeight: -Infinity, tiles: new Map(), drawn: new Map(), pending: 0, eye: undefined, generation: 0, colliders: new Map(), built: { tiles: 0, colliders: 0 } };
        this.#states.set(id, state);
      }
      if (eye) this.#updateTerrain(state, eye);
      if (game.simulation) this.#updateColliders(state, eye);
    }
  }

  /**
   * 碰撞的块：相机和每个角色附近 COLLIDER_RADIUS 块以内的最细一层块建成静态的高度场（和画出来的最细一层同样的采样点，碰撞和画面
   * 对得上）；出了范围再多一块才拿掉。碰撞只跟地形实体的位置走（不转、不缩放）。
   */
  #updateColliders(state: TerrainState, eyeWorld: readonly number[] | undefined): void {
    const terrain = state.entity.require(Terrain);
    const leaf = tileRect(terrain.size, { level: leafLevel(terrain), x: 0, z: 0 }).edge;
    const origin = state.entity.require(Transform).world;
    const half = terrain.size / 2, cells = Math.round(terrain.size / leaf);
    this.#characters.length = 0;
    this.#game.entities.run(this.#collectCharacters, this.#game.updateTime);
    const sources = eyeWorld ? [...this.#characters, eyeWorld] : this.#characters;
    const frame = this.#frame;
    const wanted = (reach: number) => {
      const keys = new Set<string>();
      for (const source of sources) {
        const cx = Math.floor((source[0]! - origin[12]! + half) / leaf), cz = Math.floor((source[2]! - origin[14]! + half) / leaf);
        for (let z = cz - reach; z <= cz + reach; z++) for (let x = cx - reach; x <= cx + reach; x++) if (x >= 0 && z >= 0 && x < cells && z < cells) keys.add(`${x}_${z}`);
      }
      return keys;
    };
    for (const key of wanted(COLLIDER_RADIUS)) {
      let collider = state.colliders.get(key);
      if (!collider) {
        state.colliders.set(key, (collider = { release: undefined, used: frame }));
        const [x, z] = key.split('_').map(Number) as [number, number];
        void this.#buildCollider(state, collider, -half + x * leaf, -half + z * leaf, leaf, state.generation);
      }
      collider.used = frame;
    }
    const keep = wanted(COLLIDER_RADIUS + 1);
    for (const [key, collider] of state.colliders) {
      if (keep.has(key) || collider.used === frame) continue;
      collider.release?.();
      state.colliders.delete(key);
    }
  }

  async #buildCollider(state: TerrainState, collider: Collider, x0: number, z0: number, edge: number, generation: number): Promise<void> {
    const spacing = edge / TILE_QUADS, samples = TILE_QUADS + 1;
    const heights = await state.asset.heights(this.#game.native, x0, z0, spacing, samples, samples);
    const simulation = this.#game.simulation;
    // 算的时候块已经不要了（走远了、地形换了）：不建
    if (!simulation || generation !== state.generation || !state.entity.alive || ![...state.colliders.values()].includes(collider)) return;
    const world = state.entity.require(Transform).world;
    state.built.colliders++;
    collider.release = simulation.addHeightfield(state.entity.id, heights, samples, spacing, [world[12]! + x0, world[13]!, world[14]! + z0]);
  }

  readonly #characters: number[][] = [];
  readonly #collectCharacters = system('TerrainSystem.characters', {
    with: { character: Character, transform: Transform },
    update: ({ transform, count }) => {
      for (let row = 0; row < count; row++) {
        const at = transform.slot[row]! * 16;
        this.#characters.push([transform.world[at + 12]!, transform.world[at + 13]!, transform.world[at + 14]!]);
      }
    },
  });

  /** 每个地形的块数（调试命令 terrain 用）。 */
  stats(): { entity: string; asset: string; drawn: number; cached: number; pending: number; colliders: number; built: { tiles: number; colliders: number } }[] {
    return [...this.#states.values()].map((state) => ({
      entity: state.entity.name, asset: state.asset.path, drawn: state.drawn.size, cached: state.tiles.size, pending: state.pending,
      colliders: state.colliders.size, built: { ...state.built },
    }));
  }

  /**
   * 世界坐标 (x, z) 处地面的世界高度：第一个盖住这一点的地形（地形没有绕 X、Z 转过）；没有地形盖住时是 undefined。玩法、摆东西用，
   * 直接求值（和画出来的最细一层一致，比粗的块准）。
   */
  heightAt(x: number, z: number): number | undefined {
    for (const { entity, asset } of this.#states.values()) {
      const world = entity.require(Transform).world;
      if (!Matrix.invert(this.#inverse, world)) continue;
      const m = this.#inverse;
      const lx = m[0]! * x + m[8]! * z + m[12]!, lz = m[2]! * x + m[10]! * z + m[14]!;
      const half = entity.require(Terrain).size / 2;
      if (Math.abs(lx) > half || Math.abs(lz) > half) continue;
      const h = asset.heightAt(this.#game.native, lx, lz);
      return world[1]! * lx + world[5]! * h + world[9]! * lz + world[13]!;
    }
    return undefined;
  }

  /**
   * 射线（世界坐标，direction 是单位向量）最先碰到地形的地方：沿射线走，每步按"离地面的高度 ÷ 最陡的坡"放心地走（地形不会
   * 比 MAX_SLOPE 更陡地冒出来挡住），穿到地下以后在最后一步里二分。返回世界坐标的点、哪个地形、地形本地的 x、z 和高度
   * （雕刻的笔画按本地坐标存）；maxDistance 以内没碰到时是 undefined。编辑器的雕刻笔刷用；直接求值，不等块算好。
   */
  raycast(origin: readonly number[], direction: readonly number[], maxDistance = 20_000): TerrainHit | undefined {
    let best: TerrainHit | undefined;
    for (const state of this.#states.values()) {
      const hit = this.#raycastOne(state, origin, direction, Math.min(maxDistance, best?.distance ?? Infinity));
      if (hit) best = hit;
    }
    return best;
  }

  #raycastOne(state: TerrainState, origin: readonly number[], direction: readonly number[], maxDistance: number): TerrainHit | undefined {
    const { entity, asset } = state;
    const world = entity.require(Transform).world;
    if (!Matrix.invert(this.#inverse, world)) return undefined;
    const m = this.#inverse, half = entity.require(Terrain).size / 2, native = this.#game.native;
    const [ox, oy, oz] = origin as [number, number, number], [dx, dy, dz] = direction as [number, number, number];
    // 射线在地形本地坐标里（地形只能绕 Y 转、平移，见 heightAt）
    const lo = [m[0]! * ox + m[4]! * oy + m[8]! * oz + m[12]!, m[1]! * ox + m[5]! * oy + m[9]! * oz + m[13]!, m[2]! * ox + m[6]! * oy + m[10]! * oz + m[14]!];
    const ld = [m[0]! * dx + m[4]! * dy + m[8]! * dz, m[1]! * dx + m[5]! * dy + m[9]! * dz, m[2]! * dx + m[6]! * dy + m[10]! * dz];
    const length = Math.hypot(ld[0]!, ld[1]!, ld[2]!);
    const at = (t: number) => [lo[0]! + ld[0]! * t, lo[1]! + ld[1]! * t, lo[2]! + ld[2]! * t] as const;
    const gap = (t: number) => {
      const [x, y, z] = at(t);
      return Math.abs(x) > half || Math.abs(z) > half ? undefined : y - asset.heightAt(native, x, z);
    };
    const reach = length * maxDistance;
    const slope = Math.abs(ld[1]!) + MAX_SLOPE * Math.hypot(ld[0]!, ld[2]!);
    let t = 0, previous = 0;
    for (let step = 0; step < MAX_RAY_STEPS && t <= maxDistance; step++) {
      const g = gap(t);
      if (g !== undefined && g <= 0) {
        // 在 previous 和 t 之间二分到厘米以内
        let lo0 = previous, hi = t;
        for (let i = 0; i < 24 && (hi - lo0) * length > 0.01; i++) {
          const mid = (lo0 + hi) / 2;
          const gm = gap(mid);
          if (gm !== undefined && gm <= 0) hi = mid;
          else lo0 = mid;
        }
        const [x, , z] = at(hi);
        const h = asset.heightAt(native, x, z);
        return {
          entity, distance: hi, local: [x, z], height: h,
          point: [world[0]! * x + world[4]! * h + world[8]! * z + world[12]!, world[1]! * x + world[5]! * h + world[9]! * z + world[13]!, world[2]! * x + world[6]! * h + world[10]! * z + world[14]!],
        };
      }
      previous = t;
      // 在地形外面（或者刚开始）按固定的小步走；离地面高时按坡度放心地走
      t += g === undefined ? Math.max(1, reach / MAX_RAY_STEPS) / length : Math.max(MIN_RAY_STEP * (1 + t * length * 1e-3), g / slope) / length;
    }
    return undefined;
  }

  /** 主画面的相机在世界里的位置（视图在渲染空间里：加上渲染原点）；还没画过时用主相机实体的位置。 */
  #eyeWorld(): [number, number, number] | undefined {
    const game = this.#game;
    const view = (game.graphicsCompositor as Game['graphicsCompositor'] | undefined)?.mainView;
    if (!view || !Matrix.invert(this.#inverse, view.view)) return undefined;
    const origin = game.renderOrigin;
    return [this.#inverse[12]! + origin[0], this.#inverse[13]! + origin[1], this.#inverse[14]! + origin[2]];
  }

  #updateTerrain(state: TerrainState, eyeWorld: readonly number[]): void {
    const { entity, asset } = state;
    const terrain = entity.require(Terrain);
    // 观察点换到地形本地坐标（地形可能被移动、旋转过）
    if (!Matrix.invert(this.#inverse, entity.require(Transform).world)) return;
    const m = this.#inverse;
    const [wx, wy, wz] = eyeWorld as [number, number, number];
    const eye: [number, number, number] = [
      m[0]! * wx + m[4]! * wy + m[8]! * wz + m[12]!,
      m[1]! * wx + m[5]! * wy + m[9]! * wz + m[13]!,
      m[2]! * wx + m[6]! * wy + m[10]! * wz + m[14]!,
    ];
    const threshold = terrain.detail / 8;
    if (state.eye && Math.hypot(eye[0] - state.eye[0], eye[1] - state.eye[1], eye[2] - state.eye[2]) < threshold) return;
    state.eye = eye;
    const native = this.#game.native;
    const half = terrain.size / 2;
    const ground = asset.heightAt(native, Math.min(half, Math.max(-half, eye[0])), Math.min(half, Math.max(-half, eye[2])));
    const ready = (key: TileKey) => state.tiles.get(tileId(key))?.page !== undefined;
    const { draw, want } = selectTiles({ size: terrain.size, leafEdge: terrain.detail, lodFactor: terrain.lodFactor, eye, ground, ready });
    const frame = this.#frame;
    // 要画的换上，不画了的拿掉
    const keep = new Set<string>();
    for (const key of draw) {
      const id = tileId(key);
      keep.add(id);
      const tile = state.tiles.get(id)!;
      tile.used = frame;
      if (!state.drawn.has(id)) state.drawn.set(id, this.#spawnTile(state, key, tile.page!));
    }
    for (const [id, child] of state.drawn) {
      if (keep.has(id)) continue;
      if (child.alive) child.destroy();
      state.drawn.delete(id);
    }
    // 要算的：近的、粗的先
    for (const key of want) {
      const id = tileId(key);
      let tile = state.tiles.get(id);
      if (!tile) state.tiles.set(id, (tile = { key, page: undefined, used: frame, requested: false, stale: false }));
      tile.used = frame;
      if (tile.page !== undefined || state.pending >= MAX_PENDING || tile.requested) continue;
      tile.requested = true;
      void this.#build(state, tile, state.generation);
    }
    // 改动范围里正在画的块：后台重算（新的页好了再换上）
    for (const [id, child] of state.drawn) {
      const tile = state.tiles.get(id)!;
      if (!tile.stale || tile.requested || state.pending >= MAX_PENDING) continue;
      tile.requested = true;
      void this.#build(state, tile, state.generation, child);
    }
    this.#evict(state);
  }

  /**
   * 换成同一个地形文件的新版本：底（噪声）、材质、UV 变了返回 false（整个重建）；只是笔画、地物增减了，就只让改动范围（笔画按半径、
   * 地物按包围盒加过渡宽度）里的块和碰撞块重算，别的留着——笔画、地物只改自己范围里的高度，范围外逐位不变。
   */
  #swapAsset(state: TerrainState, asset: TerrainAsset): boolean {
    const rects = changedRegions(state.asset.file, asset.file);
    if (!rects) return false;
    state.asset = asset;
    state.generation++;
    const size = state.entity.require(Terrain).size;
    const hit = (x0: number, z0: number, edge: number, margin: number) =>
      rects.some((r) => x0 - margin < r[2] && x0 + edge + margin > r[0] && z0 - margin < r[3] && z0 + edge + margin > r[1]);
    for (const [id, tile] of state.tiles) {
      tile.requested = false;
      const { x0, z0, edge } = tileRect(size, tile.key);
      // 多一圈格子：页的边上那一圈是算法线用的
      if (!hit(x0, z0, edge, edge / TILE_QUADS)) continue;
      if (state.drawn.has(id)) tile.stale = true;
      else {
        if (tile.page !== undefined) this.#pages.free(tile.page);
        state.tiles.delete(id);
      }
    }
    const leaf = tileRect(size, { level: leafLevel(state.entity.require(Terrain)), x: 0, z: 0 }).edge;
    for (const [key, collider] of state.colliders) {
      const [x, z] = key.split('_').map(Number) as [number, number];
      if (!hit(-size / 2 + x * leaf, -size / 2 + z * leaf, leaf, 0)) continue;
      collider.release?.();
      state.colliders.delete(key);
    }
    state.pending = 0;
    state.eye = undefined;
    return true;
  }

  /** 算一块的高度页；replacing 是正在画着它的子实体时（改动范围里的旧块），算好以后换到新的页上。 */
  async #build(state: TerrainState, tile: Tile, generation: number, replacing?: Entity): Promise<void> {
    const terrain = state.entity.require(Terrain);
    const { x0, z0, edge } = tileRect(terrain.size, tile.key);
    const spacing = edge / TILE_QUADS;
    const uvScale = state.asset.file.uvScale ?? 4;
    state.pending++;
    try {
      const heights = await state.asset.heights(this.#game.native, x0 - spacing, z0 - spacing, spacing, TILE_SAMPLES, TILE_SAMPLES);
      if (generation !== state.generation || !state.entity.alive) return;
      const header = tilePageHeader(x0, z0, edge, uvScale, uvScale * UV_PERIODS);
      const pages = this.#pages;
      const old = tile.page;
      tile.page = pages.allocate();
      pages.write(tile.page, header, heights);
      state.built.tiles++;
      tile.stale = false;
      if (replacing?.alive) replacing.require(HeightfieldTile).page = tile.page;
      if (old !== undefined) pages.free(old);
      // 共用网格的包围盒（网格空间：x、z 是格坐标多一圈，y 是米）跟着算好的页放大，剔除、阴影的范围都对
      // 下界再减去裙边（粗的块裙边深）
      let min = state.minHeight, max = state.maxHeight;
      for (const h of heights) {
        if (h - header[3] < min) min = h - header[3];
        if (h > max) max = h;
      }
      if (min < state.minHeight || max > state.maxHeight) {
        state.minHeight = min;
        state.maxHeight = max;
        state.grid.cullBounds = { min: [-1, min, -1], max: [TILE_QUADS + 1, max, TILE_QUADS + 1] };
      }
      state.eye = undefined;
      this.#game.requestFrames();
    } finally {
      // 代数变了（换了文件）时 pending 已经清零
      if (generation === state.generation) {
        state.pending--;
        tile.requested = false;
      }
    }
  }

  get #pages(): HeightPages {
    return this.#game.meshes.heightPages;
  }

  #spawnTile(state: TerrainState, key: TileKey, page: number): Entity {
    const terrain = state.entity.require(Terrain);
    const { x0, z0, edge } = tileRect(terrain.size, key);
    const spacing = edge / TILE_QUADS;
    const material = state.asset.material ?? this.#game.content.defaultMaterial;
    const child = this.#game.entities.create({
      name: `${state.entity.name}/tile ${tileId(key)}`,
      components: [
        // 共用网格的一格是 1：按这一层的格距放大
        Transform.with({ position: [x0, 0, z0], scale: [spacing, 1, spacing] }),
        Model.with({ mesh: state.grid.id, material: material.id, isShadowCaster: terrain.isShadowCaster, renderGroup: terrain.renderGroup }),
        HeightfieldTile.with({ page }),
        TerrainTile,
      ],
    });
    child.require(Transform).parent = state.entity;
    return child;
  }

  /** 缓存超了：不在画的、最久没用的块释放。 */
  #evict(state: TerrainState): void {
    if (state.tiles.size <= MAX_CACHED) return;
    const idle = [...state.tiles.entries()].filter(([id, tile]) => !state.drawn.has(id) && !tile.requested).sort((a, b) => a[1].used - b[1].used);
    for (const [id, tile] of idle.slice(0, state.tiles.size - MAX_CACHED)) {
      if (tile.page !== undefined) this.#pages.free(tile.page);
      state.tiles.delete(id);
    }
  }

  #drop(id: EntityId, state: TerrainState): void {
    state.generation++;
    for (const child of state.drawn.values()) if (child.alive) child.destroy();
    for (const tile of state.tiles.values()) if (tile.page !== undefined) this.#pages.free(tile.page);
    state.grid.dispose();
    for (const collider of state.colliders.values()) collider.release?.();
    state.colliders.clear();
    state.drawn.clear();
    state.tiles.clear();
    this.#states.delete(id);
  }
}


/**
 * 新旧两版地形文件的改动范围（地形本地坐标的矩形 [x0, z0, x1, z1]）：底（噪声）、材质、UV 变了返回 undefined（整个重算）；
 * 否则是增加或去掉了的笔画（按半径）、地物（按包围盒加过渡宽度）的范围。
 */
/** TerrainSystem.raycast 的结果：世界坐标的点、射线上的距离、哪个地形、地形本地的 x、z 和高度。 */
export interface TerrainHit {
  readonly point: readonly [number, number, number];
  readonly distance: number;
  readonly entity: Entity;
  readonly local: readonly [number, number];
  readonly height: number;
}

export function changedRegions(before: TerrainFile, after: TerrainFile): [number, number, number, number][] | undefined {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.noise, after.noise) || !same(before.material, after.material) || !same(before.uvScale, after.uvScale)) return undefined;
  const rects: [number, number, number, number][] = [];
  const diff = <T>(a: readonly T[], b: readonly T[], rect: (item: T) => [number, number, number, number]) => {
    const count = new Map<string, number>();
    for (const item of a) count.set(JSON.stringify(item), (count.get(JSON.stringify(item)) ?? 0) + 1);
    for (const item of b) count.set(JSON.stringify(item), (count.get(JSON.stringify(item)) ?? 0) - 1);
    for (const item of [...a, ...b]) if (count.get(JSON.stringify(item))) rects.push(rect(item));
  };
  diff(before.strokes ?? [], after.strokes ?? [], (s) => [s.x - s.radius, s.z - s.radius, s.x + s.radius, s.z + s.radius]);
  diff(before.features ?? [], after.features ?? [], (f) => {
    const xs = f.points.map((p) => p[0]), zs = f.points.map((p) => p[1]), m = f.falloff ?? 0;
    return [Math.min(...xs) - m, Math.min(...zs) - m, Math.max(...xs) + m, Math.max(...zs) + m];
  });
  // 笔画的先后影响结果：同样的笔画换了顺序时，这些笔画的范围都算改了
  if (rects.length === 0 && !same(before.strokes ?? [], after.strokes ?? [])) for (const s of after.strokes ?? []) rects.push([s.x - s.radius, s.z - s.radius, s.x + s.radius, s.z + s.radius]);
  return rects;
}
