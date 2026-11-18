/**
 * 导航（Stride.BepuPhysics.Navigation 的 RecastMeshSystem）：运行时用静态碰撞体建导航网格，按它寻路。
 * - 网格的输入是物理世界里静态物体的表面三角形（触发器不算，只取 includedLayers 里的层），同 Stride 收集静态碰撞体；
 *   原生侧在工作线程上分块并行建（Recast），建好后换上。`rebuild()` 要显式调用（同 Stride：没有系统自动重建）。
 * - 寻路用 Detour：起点、终点先在 (2, 4, 2) 的范围里找最近的多边形（Stride 的 polyPickExt），结果是路径的拐点（含起点和终点）。
 *   和 Stride 不同：Stride 的 FindFollowPath 沿拐点按固定步长采样出平滑的点，这里直接给拐点（跟随路径的脚本照样能用）。
 */
import { NativeError, type NavConfig, type NavMesh, type StrideNative } from '@stride-ts/native';
import { Vector3, type Vec3Like } from '../mathematics/vectors';
import type { Simulation } from '../physics/Simulation';

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

export class NavigationSystem {
  settings: NavigationSettings = DEFAULT_NAVIGATION_SETTINGS;
  readonly #native: StrideNative;
  readonly #simulation: Simulation;
  #navMesh: NavMesh | undefined;
  /** 每次 rebuild 加一：建好时已经有更新的请求，这次的结果丢掉（同 Stride 取消上一次重建）。 */
  #generation = 0;

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

  destroy(): void {
    this.#generation++;
    this.#navMesh?.destroy();
    this.#navMesh = undefined;
  }
}
