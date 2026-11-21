/**
 * 地形的渲染（`game.terrain`）：每帧对每个 Terrain 实体按相机选块（terrainTiles.ts 的四叉树），没好的块在工作线程上求高度页、
 * 建网格，好的块挂成实体的子实体（TerrainTile，带 Model）交给网格渲染特性画（剔除、阴影、材质都和普通模型一样）。
 *
 * - 没变就不做：相机挪得不到最细一层块边长的 1/8、也没有新的块好了时，不重选；
 * - 同时最多 MAX_PENDING 页在算；块的网格缓存着（最近用过的留 MAX_CACHED 块），不用的释放显存；
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
import { Terrain, TerrainAsset, TerrainTile } from './Terrain';
import { buildTileMesh, selectTiles, TILE_LAYOUT, TILE_QUADS, TILE_SAMPLES, tileId, tileRect, type TileKey } from './terrainTiles';

/** 同时在算的高度页最多几个（每页约 1 毫秒，工作线程上）。 */
const MAX_PENDING = 8;
/** 每个地形缓存的块最多几个（不在画的、最久没用的先释放）。 */
const MAX_CACHED = 768;
/** UV 按这么多个贴图周期取模：大世界里 UV 的数也小。 */
const UV_PERIODS = 256;

interface Tile {
  readonly key: TileKey;
  mesh: Mesh | undefined;
  /** 最后一次被选中（画或者要）的帧。 */
  used: number;
  /** 高度页在算。 */
  requested: boolean;
}

/** 一个地形实体的状态。 */
interface TerrainState {
  readonly entity: Entity;
  /** 建块时的设置：变了整个重建。 */
  settings: string;
  asset: TerrainAsset;
  readonly tiles: Map<string, Tile>;
  /** 正在画的块 → 子实体。 */
  readonly drawn: Map<string, Entity>;
  pending: number;
  /** 上次选块时的观察点（地形本地坐标）；新的块好了时清掉，下一帧重选。 */
  eye: [number, number, number] | undefined;
  /** 设置变了加一：算到一半的页发现代数不对就扔掉。 */
  generation: number;
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
      const settings = `${asset.id}|${terrain.size}|${terrain.detail}|${terrain.lodFactor}|${terrain.isShadowCaster}|${terrain.renderGroup}`;
      let state = this.#states.get(id);
      if (state && state.settings !== settings) {
        this.#drop(id, state);
        state = undefined;
      }
      if (!state) {
        state = { entity, settings, asset, tiles: new Map(), drawn: new Map(), pending: 0, eye: undefined, generation: 0 };
        this.#states.set(id, state);
      }
      if (eye) this.#updateTerrain(state, eye);
    }
  }

  /** 每个地形的块数（调试命令 terrain 用）。 */
  stats(): { entity: string; asset: string; drawn: number; cached: number; pending: number }[] {
    return [...this.#states.values()].map((state) => ({
      entity: state.entity.name, asset: state.asset.path, drawn: state.drawn.size, cached: state.tiles.size, pending: state.pending,
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
    const ready = (key: TileKey) => state.tiles.get(tileId(key))?.mesh !== undefined;
    const { draw, want } = selectTiles({ size: terrain.size, leafEdge: terrain.detail, lodFactor: terrain.lodFactor, eye, ground, ready });
    const frame = this.#frame;
    // 要画的换上，不画了的拿掉
    const keep = new Set<string>();
    for (const key of draw) {
      const id = tileId(key);
      keep.add(id);
      const tile = state.tiles.get(id)!;
      tile.used = frame;
      if (!state.drawn.has(id)) state.drawn.set(id, this.#spawnTile(state, key, tile.mesh!));
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
      if (!tile) state.tiles.set(id, (tile = { key, mesh: undefined, used: frame, requested: false }));
      tile.used = frame;
      if (tile.mesh || state.pending >= MAX_PENDING || tile.requested) continue;
      tile.requested = true;
      void this.#build(state, tile, state.generation);
    }
    this.#evict(state);
  }

  async #build(state: TerrainState, tile: Tile, generation: number): Promise<void> {
    const terrain = state.entity.require(Terrain);
    const { x0, z0, edge } = tileRect(terrain.size, tile.key);
    const spacing = edge / TILE_QUADS;
    const uvScale = state.asset.file.uvScale ?? 4;
    state.pending++;
    try {
      const heights = await state.asset.evaluator(this.#game.native).heights(x0 - spacing, z0 - spacing, spacing, TILE_SAMPLES, TILE_SAMPLES);
      if (generation !== state.generation || !state.entity.alive) return;
      const period = uvScale * UV_PERIODS;
      const uvOrigin: [number, number] = [mod(x0, period) / uvScale, mod(z0, period) / uvScale];
      // 裙边垂下几个格那么深：相邻的块最多差一层，接缝的高度差在一个格的坡度以内
      const { vertices, indices } = buildTileMesh(heights, edge, uvOrigin, uvScale, Math.max(spacing * 4, 1));
      tile.mesh = new Mesh(`${state.asset.path}/${tileId(tile.key)}`, { vertices, indices, layout: TILE_LAYOUT });
      state.eye = undefined;
      this.#game.requestFrames();
    } finally {
      if (generation === state.generation) state.pending--;
      tile.requested = false;
    }
  }

  #spawnTile(state: TerrainState, key: TileKey, mesh: Mesh): Entity {
    const terrain = state.entity.require(Terrain);
    const { x0, z0 } = tileRect(terrain.size, key);
    const material = state.asset.material ?? this.#game.content.defaultMaterial;
    const child = this.#game.entities.create({
      name: `${state.entity.name}/tile ${tileId(key)}`,
      components: [
        Transform.with({ position: [x0, 0, z0] }),
        Model.with({ mesh: mesh.id, material: material.id, isShadowCaster: terrain.isShadowCaster, renderGroup: terrain.renderGroup }),
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
      tile.mesh?.dispose();
      state.tiles.delete(id);
    }
  }

  #drop(id: EntityId, state: TerrainState): void {
    state.generation++;
    for (const child of state.drawn.values()) if (child.alive) child.destroy();
    for (const tile of state.tiles.values()) tile.mesh?.dispose();
    state.drawn.clear();
    state.tiles.clear();
    this.#states.delete(id);
  }
}

const mod = (value: number, period: number) => value - Math.floor(value / period) * period;
