/**
 * 导航（Stride.BepuPhysics.Navigation 的 RecastMeshSystem）：运行时用静态碰撞体建导航网格，按它寻路。
 * - 网格的输入是物理世界里静态物体的表面三角形（触发器不算，只取 includedLayers 里的层），同 Stride 收集静态碰撞体；
 *   原生侧在工作线程上分块并行建（Recast），建好后换上。`rebuild()` 要显式调用（同 Stride：没有系统自动重建）。
 * - 寻路用 Detour：起点、终点先在 (2, 4, 2) 的范围里找最近的多边形（Stride 的 polyPickExt），结果是路径的拐点（含起点和终点）。
 *   和 Stride 不同：Stride 的 FindFollowPath 沿拐点按固定步长采样出平滑的点，这里直接给拐点（跟随路径的脚本照样能用）。
 */
import { NativeError, type Crowd, type NavConfig, type NavMesh, type StrideNative } from '@stride-ts/native';
import { Matrix } from '../data/Matrix';
import { Vector3, type Vec3Like } from '../data/vectors';
import type { GameTime } from '../engine/GameTime';
import { Transform } from '../engine/transform';
import type { CrowdAgent } from './CrowdAgent';
import type { Simulation } from './Simulation';

/** 导航的设置（Stride 的 RecastNavigationConfiguration）。 */
export interface NavigationSettings {
  /** Recast 的设置（BuildSettings）。 */
  readonly build: NavConfig;
  /** 参与的碰撞层（IncludedLayers），第 n 位是层 n。 */
  readonly includedLayers: number;
}

/** Stride 的 RecastNavigationConfiguration 的默认值。 */
export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettings = {
  build: {
    cellSize: 0.3, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9, agentMaxSlopeDegrees: 45, tileSize: 32,
    maxEdgeLength: 12, maxSimplificationError: 1.3, minRegionSize: 8, mergeRegionSize: 20, detailSampleDistance: 6, detailSampleMaxError: 1,
  },
  includedLayers: 0xffffffff,
};

const SEARCH_EXTENTS = [2, 4, 2] as const;
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

  constructor(native: StrideNative, simulation: Simulation) {
    this.#native = native;
    this.#simulation = simulation;
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
    let points: Float32Array;
    try {
      points = this.#navMesh.findPath([start.x, start.y, start.z], [end.x, end.y, end.z], SEARCH_EXTENTS);
    } catch (error) {
      if (error instanceof NativeError) return undefined;
      throw error;
    }
    const path: Vector3[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) path.push(new Vector3(points[i]!, points[i + 1]!, points[i + 2]!));
    return path.length > 0 ? path : undefined;
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
    for (const agent of this.#agents) {
      const world = agent.entity.require(Transform).world;
      if (agent.slot === -1) {
        try {
          agent.slot = crowd.addAgent([world[12]!, world[13]!, world[14]!], { radius: agent.radius, height: agent.height, maxSpeed: agent.maxSpeed, maxAcceleration: agent.maxAcceleration });
          agent.targetDirty = true;
        } catch (error) {
          // 不在导航网格上（还在空中、网格还没覆盖到）：下一帧再试
          if (error instanceof NativeError) continue;
          throw error;
        }
      }
      if (agent.slot === -1) continue;
      if (agent.targetDirty) {
        const target = agent.target ?? { x: world[12]!, y: world[13]!, z: world[14]! };
        try {
          crowd.requestMove(agent.slot, [target.x, target.y, target.z]);
          agent.targetDirty = false;
        } catch (error) {
          if (!(error instanceof NativeError)) throw error;
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
      placeAgent(agent, positions[k]!, positions[k + 1]!, positions[k + 2]!);
    }
  }

  #dropCrowd(): void {
    this.#crowd?.destroy();
    this.#crowd = undefined;
    for (const agent of this.#agents) agent.slot = -1;
  }

  destroy(): void {
    this.#dropCrowd();
    this.#generation++;
    this.#navMesh?.destroy();
    this.#navMesh = undefined;
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
