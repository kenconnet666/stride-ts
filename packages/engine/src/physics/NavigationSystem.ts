/**
 * 导航（Stride.BepuPhysics.Navigation 的 RecastMeshSystem）：运行时用静态碰撞体建导航网格，按它寻路。
 * - 网格的输入是物理世界里静态物体的表面三角形（触发器不算，只取 includedLayers 里的层），同 Stride 收集静态碰撞体；
 *   原生侧在工作线程上分块并行建（Recast），建好后换上。`rebuild()` 要显式调用（同 Stride：没有系统自动重建）。
 * - 寻路用 Detour：起点、终点先在 (2, 4, 2) 的范围里找最近的多边形（Stride 的 polyPickExt），结果是路径的拐点（含起点和终点）。
 *   和 Stride 不同：Stride 的 FindFollowPath 沿拐点按固定步长采样出平滑的点，这里直接给拐点（跟随路径的脚本照样能用）。
 * - 大世界用分块流式的导航网格（settings.streaming，Stride 没有；照虚幻的 Navigation Invokers 加动态生成）：只在导航的引子
 *   （CrowdAgent、挂 NavigationInvoker 的实体，比如玩家）周围建块，走远了去掉；静态物体加上、移除（格子流式加载、摆了路障）
 *   时只重建盖到的块。建块在工作线程上，换进导航网格在游戏线程上，一次一批。
 */
import { NativeError, type AgentId, type Crowd, type NavConfig, type NavMesh, type NavTileBatch, type StrideNative } from '@stride-ts/native';
import { prop } from '../data/prop';
import { Matrix } from '../data/Matrix';
import { Vector3, type Vec3Like } from '../data/vectors';
import { component } from '../engine/component';
import type { EntityManager } from '../engine/EntityManager';
import type { GameTime } from '../engine/GameTime';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { CrowdAgent } from './CrowdAgent';
import type { Simulation } from './Simulation';

/** 导航的设置（Stride 的 RecastNavigationConfiguration）。 */
export interface NavigationSettings {
  /** Recast 的设置（BuildSettings）。 */
  readonly build: NavConfig;
  /** 参与的碰撞层（IncludedLayers），第 n 位是层 n。 */
  readonly includedLayers: number;
  /** 按块流式地建（大世界）；没写时 rebuild() 一次建整个场景。 */
  readonly streaming?: NavigationStreaming;
}

/** 分块流式的导航网格的设置。 */
export interface NavigationStreaming {
  /** 每个引子周围建多远（米，水平）。 */
  readonly radius: number;
  /** 离所有引子都超过这么远的块去掉（米；比 radius 大一截，免得在边上来回建）。 */
  readonly removeRadius: number;
  /** 最多同时有几块。 */
  readonly maxTiles: number;
  /** 一批最多建几块（一批在工作线程上并行建，建好才换上）。 */
  readonly tilesPerBatch: number;
}

export const DEFAULT_NAVIGATION_STREAMING: NavigationStreaming = { radius: 40, removeRadius: 60, maxTiles: 4096, tilesPerBatch: 32 };

/**
 * 导航的引子（虚幻的 NavigationInvoker）：分块流式的导航网格在它周围建块。CrowdAgent 自己就是引子；玩家、要寻路的别的东西挂这个。
 */
export const NavigationInvoker = component('NavigationInvoker', {
  /** 周围建多远（米）；0 用导航设置的 streaming.radius。 */
  radius: prop.number().min(0).default(0).unit('m'),
});

/** Stride 的 RecastNavigationConfiguration 的默认值。 */
export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettings = {
  build: {
    cellSize: 0.3, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9, agentMaxSlopeDegrees: 45, tileSize: 32,
    maxEdgeLength: 12, maxSimplificationError: 1.3, minRegionSize: 8, mergeRegionSize: 20, detailSampleDistance: 6, detailSampleMaxError: 1,
  },
  includedLayers: 0xffffffff,
};

const SEARCH_EXTENTS = [2, 4, 2] as const;
/** 静态物体变了以后等多久再重建（秒）。 */
const SETTLE_SECONDS = 0.3;
/** 块的编号：x、y 各 21 位（±100 万块，块 10 米时 ±1 万公里）拼成一个安全整数。 */
const TILE_RANGE = 2 ** 20;
const tileKey = (x: number, y: number): number => (x + TILE_RANGE) * 2 ** 21 + (y + TILE_RANGE);
const tileX = (key: number): number => Math.floor(key / 2 ** 21) - TILE_RANGE;
const tileY = (key: number): number => (key % 2 ** 21) - TILE_RANGE;
/** 排队的寻路一帧最多算几条（Stride 的 RecastNavigationProcessor.Update 里的 10）。 */
const MAX_QUEUED_PATHS_PER_FRAME = 10;

export class NavigationSystem {
  settings: NavigationSettings = DEFAULT_NAVIGATION_SETTINGS;
  readonly #native: StrideNative;
  readonly #simulation: Simulation;
  #navMesh: NavMesh | undefined;
  /** 每次 rebuild 加一：建好时已经有更新的请求，这次的结果丢掉（同 Stride 取消上一次重建）。 */
  #generation = 0;
  /** 排队等着算的寻路（RecastNavigationComponent.setTarget）。 */
  readonly #queue: (() => void)[] = [];
  #queueFrame = -1;
  /** 人群（CrowdAgent）：导航网格建好、有人时才建；网格换了、人满了重建。 */
  readonly #agents = new Set<CrowdAgent>();
  #crowd: Crowd | undefined;
  #crowdCapacity = 0;
  #crowdFrame = -1;
  /** 人群避让有多仔细：0 低、1 中、2 好、3 高（Recast 演示的四档），越高每步越贵；改了下一次更新时生效。 */
  crowdAvoidance: 0 | 1 | 2 | 3 = 1;
  #appliedAvoidance = -1;
  /** 上一次人群更新：几个人、原生走一步花了多少毫秒。 */
  crowdStats = { agents: 0, milliseconds: 0 };

  readonly #entities: EntityManager;
  /** 分块流式时导航网格的原点（世界坐标，双精度；建网格时取第一个引子所在的块角，导航网格里的坐标都相对它，远离原点时保住精度）。 */
  readonly #origin = new Vector3();
  /** 分块流式：现在有的块、在建的块、建着的时候又变了的块（建好换上以后再建一次）。 */
  readonly #tiles = new Set<number>();
  readonly #building = new Set<number>();
  readonly #stale = new Set<number>();
  /** 静态物体变了、要重建的块 → 最早什么时候建（游戏时间）：一阵接一阵的变化（格子、地形的碰撞一块块进来）等停下来再建一次。 */
  readonly #dirty = new Map<number, number>();
  #now = 0;
  /** 上一次扫完什么都不用做时的样子（#signature）。 */
  #idleSignature = '';
  /** 在建的一批：建好后 built 有值，下一帧的 update 换上。 */
  #batch: { keys: number[]; generation: number; started: number; built: NavTileBatch | undefined } | undefined;
  readonly #invokers: { x: number; z: number; radius: number }[] = [];
  readonly #collectInvokers = system('Navigation.invokers', {
    with: { invoker: NavigationInvoker, transform: Transform },
    update: ({ invoker, transform, count }) => {
      const radius = this.settings.streaming?.radius ?? 0;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16;
        this.#invokers.push({ x: transform.world[w + 12]!, z: transform.world[w + 14]!, radius: invoker.radius[i]! || radius });
      }
    },
  });
  /**
   * 分块流式的统计：有几块（其中有可走区域的 walkable）、在建几块、等着重建几块、上一批几块、多少个三角形、花了多少毫秒（从发出到换上，建在工作线程上）、一共建过几块、去掉过几块、这一帧
   * 在主线程上花了多少毫秒（取三角形、发出、换上）。
   */
  streamStats = { tiles: 0, walkable: 0, building: 0, dirty: 0, lastBatchTiles: 0, lastBatchTriangles: 0, lastBatchMs: 0, built: 0, removed: 0, updateMs: 0 };
  /** 上一帧分块流式的引子（世界的 x、z 和半径）：地形按它们建脚下的碰撞。没有 streaming 时是空的。 */
  get invokers(): readonly { readonly x: number; readonly z: number; readonly radius: number }[] {
    return this.#invokers;
  }

  /** 每帧用调试线画出有的块（绿）、在建的块（黄）。 */
  showTiles = false;

  constructor(native: StrideNative, simulation: Simulation, entities: EntityManager) {
    this.#native = native;
    this.#simulation = simulation;
    this.#entities = entities;
  }

  /** 有没有建好的导航网格。 */
  get ready(): boolean {
    return this.#navMesh !== undefined;
  }

  /**
   * 重建导航网格（Stride 的 RebuildNavMesh）：在这里取静态物体的三角形，原生任务并行建，建好后换上；返回的 Promise
   * 在换上之后兑现。建的期间旧网格照常可用。
   */
  async rebuild(): Promise<void> {
    if (this.settings.streaming) {
      // 分块的：有的块都重建（场景换了这类）
      for (const key of this.#tiles) this.#dirty.set(key, 0);
      return;
    }
    const generation = ++this.#generation;
    const triangles = this.#simulation.staticTriangles(this.settings.includedLayers);
    const navMesh = triangles.length === 0
      ? undefined
      : await this.#native.buildNavMesh(triangles, Int32Array.from({ length: triangles.length / 3 }, (_, i) => i), this.settings.build);
    if (generation !== this.#generation) {
      navMesh?.destroy();
      return;
    }
    // 人群挂在旧网格上：先拆掉，下一次更新时在新网格上重建
    this.#dropCrowd();
    this.#navMesh?.destroy();
    this.#navMesh = navMesh;
  }

  /** 从 start 到 end 的路径拐点（含起点和终点）；还没有导航网格、或找不到路径时是 undefined。 */
  findPath(start: Vec3Like, end: Vec3Like): Vector3[] | undefined {
    if (!this.#navMesh) return undefined;
    const o = this.#origin;
    let points: Float32Array;
    try {
      points = this.#navMesh.findPath([start.x - o.x, start.y - o.y, start.z - o.z], [end.x - o.x, end.y - o.y, end.z - o.z], SEARCH_EXTENTS);
    } catch (error) {
      if (error instanceof NativeError) return undefined;
      throw error;
    }
    const path: Vector3[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) path.push(new Vector3(points[i]! + o.x, points[i + 1]! + o.y, points[i + 2]! + o.z));
    return path.length > 0 ? path : undefined;
  }

  /**
   * 每帧一次（Game 在仿真之后调）：分块流式时按引子的位置加块、去块，按静态物体的变化重建块，建好的一批换上。整个建的
   * 导航网格（没有 streaming）什么也不做。
   */
  update(time: GameTime): void {
    const streaming = this.settings.streaming;
    if (!streaming) return;
    const started = performance.now();
    this.#now = time.total;
    if (!this.#navMesh) this.#startStreaming(streaming);
    this.#commit();
    this.#invokers.length = 0;
    this.#entities.run(this.#collectInvokers, time);
    for (const agent of this.#agents) {
      const world = agent.entity.require(Transform).world;
      this.#invokers.push({ x: world[12]!, z: world[14]!, radius: streaming.radius });
    }
    this.#markChanged();
    // 引子都没走进别的块、块没变、没有到时候要重建的块：上一次扫过没有要建、要去的，这次也没有
    const signature = this.#signature();
    if (signature !== this.#idleSignature) {
      this.#dropFarTiles(streaming);
      if (!this.#batch) this.#startBatch(streaming, signature);
    }
    this.streamStats.tiles = this.#tiles.size;
    this.streamStats.building = this.#building.size;
    this.streamStats.dirty = this.#dirty.size;
    if (this.showTiles) this.#drawTiles();
    this.streamStats.updateMs = performance.now() - started;
  }

  /** 引子在哪块、范围多大，加上块的个数和等着重建的块：没变时不用重新扫。 */
  #signature(): string {
    const size = this.#tileSize, o = this.#origin;
    let signature = `${this.#generation}|${this.#tiles.size}|${this.#dirty.size}|${this.#batch ? 1 : 0}`;
    for (const invoker of this.#invokers) signature += `|${Math.floor((invoker.x - o.x) / size)},${Math.floor((invoker.z - o.z) / size)},${invoker.radius}`;
    return signature;
  }

  /** 块的边长（米）；没写的设置同原生的默认值（sn_nav_default_config）。 */
  get #tileSize(): number {
    return (this.settings.build.tileSize ?? 48) * (this.settings.build.cellSize ?? 0.3);
  }

  /** Recast 建一块时看得到的边缘（agentRadius 加 3 格，多给一格，米）：三角形和"变了"的范围都往外扩这么多。 */
  get #border(): number {
    return (this.settings.build.agentRadius ?? 0.6) + 4 * (this.settings.build.cellSize ?? 0.3);
  }

  #startStreaming(streaming: NavigationStreaming): void {
    this.#dropCrowd();
    this.#dropBatch();
    this.#generation++;
    this.#tiles.clear();
    this.#building.clear();
    this.#stale.clear();
    this.#dirty.clear();
    const size = this.#tileSize;
    const first = this.#agents.values().next().value?.entity.require(Transform).world;
    // 原点放在一个块角上：块的划分和原点无关，换原点不用重建
    this.#origin.set(first ? Math.round(first[12]! / size) * size : 0, 0, first ? Math.round(first[14]! / size) * size : 0);
    this.#navMesh = this.#native.createTiledNavMesh(this.settings.build, streaming.maxTiles);
    this.#simulation.trackStaticChanges(true);
    this.#simulation.staticChanges();
  }

  /** 静态物体变了：盖到的（有的、在建的）块标成要重建（盒子往外扩一圈块的边缘，Recast 建块时看得到边缘以内的东西）。 */
  #markChanged(): void {
    const boxes = this.#simulation.staticChanges();
    if (boxes.length === 0) return;
    const size = this.#tileSize, o = this.#origin;
    const border = this.#border;
    for (let i = 0; i < boxes.length; i += 6) {
      const x0 = Math.floor((boxes[i]! - border - o.x) / size), x1 = Math.floor((boxes[i + 3]! + border - o.x) / size);
      const y0 = Math.floor((boxes[i + 2]! - border - o.z) / size), y1 = Math.floor((boxes[i + 5]! + border - o.z) / size);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const key = tileKey(x, y);
          if (this.#building.has(key)) this.#stale.add(key);
          else if (this.#tiles.has(key)) this.#dirty.set(key, this.#now + SETTLE_SECONDS);
        }
      }
    }
  }

  /** 离所有引子都超过 removeRadius 的块去掉。 */
  #dropFarTiles(streaming: NavigationStreaming): void {
    const far: number[] = [];
    for (const key of this.#tiles) {
      if (!this.#nearInvoker(key, streaming.removeRadius - streaming.radius)) far.push(tileX(key), tileY(key));
    }
    if (far.length === 0) return;
    this.streamStats.removed += this.#navMesh!.removeTiles(Int32Array.from(far));
    for (let i = 0; i < far.length; i += 2) {
      const key = tileKey(far[i]!, far[i + 1]!);
      this.#tiles.delete(key);
      this.#dirty.delete(key);
    }
  }

  /** 块的中心离某个引子不到（它的半径 + extra + 半块的对角线）。 */
  #nearInvoker(key: number, extra: number): boolean {
    const size = this.#tileSize;
    const cx = this.#origin.x + (tileX(key) + 0.5) * size, cz = this.#origin.z + (tileY(key) + 0.5) * size;
    const reach = size * Math.SQRT1_2 + extra;
    return this.#invokers.some((invoker) => Math.hypot(cx - invoker.x, cz - invoker.z) <= invoker.radius + reach);
  }

  /**
   * 发出下一批：要重建的块和引子周围还没有的块，离引子近的先建；一批只取第一块附近（8 × 8 块以内）的，免得三角形的
   * 范围太大。
   */
  #startBatch(streaming: NavigationStreaming, signature: string): void {
    const size = this.#tileSize, o = this.#origin;
    const wanted: { key: number; distance: number }[] = [];
    // 引子的范围互相重叠：每块只看一次（一批里同一块出现两次时，后面那份没有三角形、会把前面建好的换成空的）
    const seen = new Set<number>();
    const consider = (key: number): void => {
      if (seen.has(key) || this.#building.has(key)) return;
      seen.add(key);
      const cx = o.x + (tileX(key) + 0.5) * size, cz = o.z + (tileY(key) + 0.5) * size;
      let distance = Infinity;
      for (const invoker of this.#invokers) distance = Math.min(distance, Math.hypot(cx - invoker.x, cz - invoker.z) - invoker.radius);
      wanted.push({ key, distance });
    };
    for (const [key, ready] of this.#dirty) if (ready <= this.#now) consider(key);
    for (const invoker of this.#invokers) {
      const x0 = Math.floor((invoker.x - invoker.radius - o.x) / size), x1 = Math.floor((invoker.x + invoker.radius - o.x) / size);
      const y0 = Math.floor((invoker.z - invoker.radius - o.z) / size), y1 = Math.floor((invoker.z + invoker.radius - o.z) / size);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const key = tileKey(x, y);
          if (!seen.has(key) && !this.#tiles.has(key) && !this.#dirty.has(key) && this.#nearInvoker(key, 0)) consider(key);
        }
      }
    }
    if (wanted.length === 0) {
      // 只有等着时候到的重建时不算闲着（到时候要再扫）
      if (this.#dirty.size === 0) this.#idleSignature = signature;
      return;
    }
    wanted.sort((a, b) => a.distance - b.distance);
    const seed = wanted[0]!.key;
    const near = wanted.filter(({ key }) => Math.abs(tileX(key) - tileX(seed)) < 8 && Math.abs(tileY(key) - tileY(seed)) < 8).slice(0, streaming.tilesPerBatch);
    const room = streaming.maxTiles - this.#tiles.size;
    const batch = near.filter(({ key }) => this.#tiles.has(key)).concat(near.filter(({ key }) => !this.#tiles.has(key)).slice(0, Math.max(0, room)));
    if (batch.length === 0) return;
    const xy = new Int32Array(batch.length * 2);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    batch.forEach(({ key }, i) => {
      const x = tileX(key), y = tileY(key);
      xy[i * 2] = x;
      xy[i * 2 + 1] = y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      this.#building.add(key);
      this.#dirty.delete(key);
    });
    // 三角形取这几块加边缘（Recast 的 borderSize：agentRadius 加 3 格，多给一格）；高度不限
    const border = this.#border;
    const vertices = this.#simulation.staticTrianglesInBox(
      { x: o.x + minX * size - border, y: -1e7, z: o.z + minY * size - border },
      { x: o.x + (maxX + 1) * size + border, y: 1e7, z: o.z + (maxY + 1) * size + border },
      o, this.settings.includedLayers);
    const triangles = Int32Array.from({ length: vertices.length / 3 }, (_, i) => i);
    this.streamStats.lastBatchTriangles = triangles.length / 3;
    const generation = this.#generation, navMesh = this.#navMesh!, started = performance.now();
    const keys = batch.map(({ key }) => key);
    this.#batch = { keys, generation, started, built: undefined };
    const pending = this.#batch;
    navMesh.buildTiles(vertices, triangles, xy).then(
      (built) => {
        // 换上留到下一帧的 update（游戏线程、帧里固定的位置）；导航网格已经换了的丢掉
        if (this.#batch === pending) pending.built = built;
        else built.destroy();
      },
      (error: unknown) => {
        // 建失败（几何坏了这类）：这几块留着旧的，报一次
        if (this.#batch !== pending) return;
        for (const key of keys) this.#building.delete(key);
        this.#batch = undefined;
        console.error('navigation: building navmesh tiles failed', error);
      });
  }

  /** 建好的一批换进导航网格。 */
  #commit(): void {
    const batch = this.#batch;
    if (!batch?.built) return;
    this.#batch = undefined;
    if (batch.generation !== this.#generation || !this.#navMesh) {
      batch.built.destroy();
      return;
    }
    const { built, keys, started } = batch;
    built.commit();
    this.streamStats.walkable = this.#navMesh.tileCount;
    for (const key of keys) {
      this.#building.delete(key);
      this.#tiles.add(key);
      if (this.#stale.delete(key)) this.#dirty.set(key, this.#now + SETTLE_SECONDS);
    }
    this.streamStats.lastBatchTiles = keys.length;
    this.streamStats.lastBatchMs = performance.now() - started;
    this.streamStats.built += keys.length;
    // 有的块都没被引子留住时（引子在建的时候走了）下一帧去掉
  }

  #drawTiles(): void {
    const game = this.#entities.game;
    const size = this.#tileSize, o = this.#origin;
    // 角上贴着地形（有的话），没有地形时画在高度 0
    const at = (x: number, z: number): [number, number, number] => [x, (game.terrain.heightAt(x, z) ?? 0) + 0.2, z];
    const square = (key: number, color: readonly [number, number, number, number]): void => {
      const x0 = o.x + tileX(key) * size + 0.1, z0 = o.z + tileY(key) * size + 0.1, x1 = x0 + size - 0.2, z1 = z0 + size - 0.2;
      const corners = [at(x0, z0), at(x1, z0), at(x1, z1), at(x0, z1)];
      for (let i = 0; i < 4; i++) game.debugDraw.line(corners[i]!, corners[(i + 1) % 4]!, color);
    };
    for (const key of this.#tiles) square(key, [0.2, 0.9, 0.3, 1]);
    for (const key of this.#building) square(key, [1, 0.8, 0.1, 1]);
  }

  /** 导航网格上离 point 最近的点（在水平 2 米、上下 4 米以内找）；没有时是 undefined。 */
  nearestPoint(point: Vec3Like): Vector3 | undefined {
    // 起点、终点相同的寻路：Detour 先把两头贴到最近的多边形上，第一个拐点就是贴好的位置
    return this.findPath(point, point)?.[0];
  }

  /** @internal 排队算一条路：plan 在之后的某一帧调用。 */
  queuePath(plan: () => void): void {
    this.#queue.push(plan);
  }

  /** @internal 每帧第一次调用时算掉队里最前面的几条（寻路的组件在自己的 update 里调，一帧只算一次）。 */
  processQueue(frame: number): void {
    if (frame === this.#queueFrame) return;
    this.#queueFrame = frame;
    for (const plan of this.#queue.splice(0, MAX_QUEUED_PATHS_PER_FRAME)) plan();
  }

  /** @internal CrowdAgent 开始时登记。 */
  addAgent(agent: CrowdAgent): void {
    agent.slot = -1;
    agent.targetDirty = true;
    this.#agents.add(agent);
  }

  /** @internal CrowdAgent 去掉时。 */
  removeAgent(agent: CrowdAgent): void {
    if (this.#crowd && agent.slot !== -1) this.#crowd.removeAgent(agent.slot);
    agent.slot = -1;
    this.#agents.delete(agent);
  }

  /**
   * @internal 人群走一步（每帧第一个 CrowdAgent 的 update 调，一帧只走一次）：没进人群的加进去，改了目标的交给人群，走完把位置、朝向
   * 写回实体。
   */
  updateCrowd(time: GameTime): void {
    if (time.frameCount === this.#crowdFrame) return;
    this.#crowdFrame = time.frameCount;
    const navMesh = this.#navMesh;
    if (!navMesh || this.#agents.size === 0) return;
    if (!this.#crowd || this.#agents.size > this.#crowdCapacity) {
      this.#dropCrowd();
      this.#crowdCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(this.#agents.size * 1.5)));
      const radius = Math.max(...[...this.#agents].map((agent) => agent.radius));
      this.#crowd = navMesh.createCrowd(this.#crowdCapacity, radius);
      this.#appliedAvoidance = -1;
    }
    const crowd = this.#crowd;
    if (this.#appliedAvoidance !== this.crowdAvoidance) {
      crowd.setAvoidanceQuality(this.crowdAvoidance);
      this.#appliedAvoidance = this.crowdAvoidance;
    }
    // 这一帧才出生的实体世界矩阵还没算（变换存储下一次更新才算）：要加人时先更新一次
    const joining = [...this.#agents].find((agent) => agent.slot === -1);
    if (joining) joining.game.transforms.update();
    const o = this.#origin;
    for (const agent of this.#agents) {
      const world = agent.entity.require(Transform).world;
      if (agent.slot === -1) {
        try {
          agent.slot = crowd.addAgent([world[12]! - o.x, world[13]! - o.y, world[14]! - o.z], { radius: agent.radius, height: agent.height, maxSpeed: agent.maxSpeed, maxAcceleration: agent.maxAcceleration });
          agent.targetDirty = true;
        } catch (error) {
          // 不在导航网格上（还在空中、网格还没覆盖到）：下一帧再试
          if (error instanceof NativeError) continue;
          throw error;
        }
      }
      if (agent.slot === -1) continue;
      if (agent.targetDirty && time.total >= agent.retryAt) {
        const target = agent.target ?? { x: world[12]!, y: world[13]!, z: world[14]! };
        if (this.#requestMove(crowd, agent.slot, target.x - o.x, target.y - o.y, target.z - o.z)) agent.targetDirty = false;
        else {
          // 目标不在导航网格上（分块流式时多半是还没建到那）：先朝它走到已经建了的范围里，过一会儿再试真的目标
          agent.retryAt = time.total + 0.5;
          const reach = this.settings.streaming ? this.settings.streaming.radius * 0.75 : 0;
          const dx = target.x - world[12]!, dz = target.z - world[14]!, distance = Math.hypot(dx, dz);
          if (reach > 0 && distance > reach) {
            this.#requestMove(crowd, agent.slot, world[12]! + (dx / distance) * reach - o.x, world[13]! - o.y, world[14]! + (dz / distance) * reach - o.z);
          }
        }
      }
    }
    const started = performance.now();
    crowd.update(time.elapsed);
    this.crowdStats = { agents: this.#agents.size, milliseconds: performance.now() - started };
    const positions = crowd.positions(), velocities = crowd.velocities();
    for (const agent of this.#agents) {
      if (agent.slot === -1) continue;
      const k = agent.slot * 3;
      agent.velocity.set(velocities[k]!, velocities[k + 1]!, velocities[k + 2]!);
      placeAgent(agent, positions[k]! + o.x, positions[k + 1]! + o.y, positions[k + 2]! + o.z);
    }
  }

  /** 交给人群（导航网格的坐标）；目标不在导航网格上时是 false。 */
  #requestMove(crowd: Crowd, slot: number, x: number, y: number, z: number): boolean {
    try {
      crowd.requestMove(slot as AgentId, [x, y, z]);
      return true;
    } catch (error) {
      if (error instanceof NativeError) return false;
      throw error;
    }
  }

  #dropCrowd(): void {
    this.#crowd?.destroy();
    this.#crowd = undefined;
    for (const agent of this.#agents) agent.slot = -1;
  }

  /** 丢掉在建的一批（还在工作线程上的，建好时看到不是自己了就丢掉）。 */
  #dropBatch(): void {
    this.#batch?.built?.destroy();
    this.#batch = undefined;
  }

  destroy(): void {
    this.#dropCrowd();
    this.#dropBatch();
    this.#generation++;
    this.#navMesh?.destroy();
    this.#navMesh = undefined;
    this.#tiles.clear();
    this.#building.clear();
  }
}

const PARENT_INVERSE = Matrix.identity();

/** 人群算出的世界位置（和朝向）写回实体：有父实体时换成本地的。 */
function placeAgent(agent: CrowdAgent, x: number, y: number, z: number): void {
  const transform = agent.entity.require(Transform);
  const parent = transform.parent?.require(Transform).world;
  let lx = x, ly = y, lz = z;
  if (parent && Matrix.invert(PARENT_INVERSE, parent)) [lx, ly, lz] = Matrix.transformPoint(PARENT_INVERSE, x, y, z);
  transform.position = { x: lx, y: ly, z: lz };
  const vx = agent.velocity.x, vz = agent.velocity.z;
  if (agent.faceMovement && vx * vx + vz * vz > 0.01) {
    // 模型的 +z 朝走的方向（绕竖直轴；有父实体时按世界的算，父实体一般不转）
    const yaw = Math.atan2(vx, vz);
    transform.rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  }
}
