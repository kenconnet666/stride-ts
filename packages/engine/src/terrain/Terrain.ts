/**
 * 矢量地形的组件和资源（Stride 没有，新加的；W2）：Terrain 组件引用一个地形资源（`.terrain.json`，content/terrainFormat.ts），
 * TerrainSystem 按相机把它分块、分细节层次求值成网格画出来。地形以实体为中心、边长 size（米），跟着实体的变换摆。
 */
import type { StrideNative, TerrainEvaluator } from '@stride-ts/native';
import { component, tag } from '../engine/component';
import { prop } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';
import type { Branded } from '../data/prop';
import type { Material } from '../rendering/mesh/Material';
import { TERRAIN_NOISE_DEFAULTS, type TerrainFile, type TerrainSplineFile } from '../content/terrainFormat';
import type { SplineFile } from '../content/splineFormat';
import { splineCenterlines } from '../modeling/spline';

export type TerrainAssetId = Branded<number, 'TerrainAssetId'>;

export const Terrain = component('Terrain', {
  terrain: prop.u32().brand<'TerrainAssetId'>().default(0 as TerrainAssetId),
  /** 地形的边长（米），以实体为中心。 */
  size: prop.f32().default(4096).min(1),
  /** 最细的块的边长（米）：一块 32 × 32 个格，16 是半米一个顶点。 */
  detail: prop.f32().default(32).min(1),
  /** 离相机不到块边长的这么多倍就细分：大了近处更细、三角形更多。 */
  lodFactor: prop.f32().default(2).min(0.5),
  isShadowCaster: prop.bool().default(true),
  /** 渲染组（0 到 31），同 Model 的。 */
  renderGroup: prop.u8().max(31).default(0),
});

/** 地形的块（TerrainSystem 建的子实体，只在运行时有，不进场景文件）。 */
export const TerrainTile = tag('TerrainTile');

const assets = new ResourceTable<TerrainAsset>();

/**
 * 地形贴着的一条样条，解析好的：路径上的点（地形本地的 x、y、z，样条按弧长采样过），压平的宽度、偏移、过渡、强度、模式
 * （同 TerrainSplineFile，默认值已经填上）。
 */
export interface TerrainPath {
  readonly points: readonly (readonly [number, number, number])[];
  readonly width: number;
  readonly offset: number;
  readonly falloff: number;
  readonly strength: number;
  readonly mode: 'conform' | 'carve' | 'fill';
}

/** 地形贴样条时取样的间距（米）：比样条自己的分辨率粗也够（压平按线段插值高度）。 */
const PATH_STEP = 4;
/** 路口的路缘比路多压的深度（米）：路缘的端头盖到往外斜下去的路上，不压深一点地会冒到路面上。 */
const CURB_DEPTH = 0.2;

/**
 * 解析地形贴着的一个样条：每条中心线一条（splineCenterlines：路网去掉路口剩下的各段加路口的辐条，别的横截面是每条路径），
 * 按弧长每 PATH_STEP 米取一个点（加上 position），宽度不写时按横截面定（道路是路面加两侧路肩，铁轨是轨距加 3 米的道床，
 * 别的 2 米）。连着的几条在原生侧一起算（路面上的那条说了算）；路口的路缘压得深 CURB_DEPTH。
 */
export function terrainPaths(entry: TerrainSplineFile, spline: SplineFile): TerrainPath[] {
  const [dx, dy, dz] = entry.position ?? [0, 0, 0];
  const profile = spline.profile;
  const width = entry.width ?? (profile.type === 'road' ? profile.width + 2 * (profile.shoulder ?? 0.5) : profile.type === 'rail' ? (profile.gauge ?? 1.435) + 3 : 2);
  return splineCenterlines(spline, Math.min(PATH_STEP, spline.resolution ?? PATH_STEP)).map(({ points, curb }) => ({
    points: points.map(([x, y, z]) => [x + dx, y + dy, z + dz] as const),
    width, offset: (entry.offset ?? -0.1) - (curb ? CURB_DEPTH : 0), falloff: entry.falloff ?? 10, strength: entry.strength ?? 1, mode: entry.mode ?? 'conform',
  }));
}

/**
 * 加载好的地形资源：文件、它的材质、解析好的样条路径（文件的 splines，ContentManager 加载时读样条文件采样）；原生的求值器
 * 第一次用到时建（每个原生模块一个）。
 */
export class TerrainAsset {
  readonly id: TerrainAssetId;
  readonly path: string;
  readonly file: TerrainFile;
  readonly material: Material | undefined;
  readonly paths: readonly TerrainPath[];
  #evaluator: { native: StrideNative; evaluator: TerrainEvaluator } | undefined;

  constructor(path: string, file: TerrainFile, material: Material | undefined, paths: readonly TerrainPath[] = []) {
    this.path = path;
    this.file = file;
    this.material = material;
    this.paths = paths;
    this.id = assets.add(this) as TerrainAssetId;
  }

  /** @internal Terrain 组件里存的 id 对应的资源。 */
  static byId(id: number): TerrainAsset | undefined {
    return assets.get(id);
  }

  /** 原生的求值器（同样的描述在任何机器上求出逐位相同的高度）。 */
  evaluator(native: StrideNative): TerrainEvaluator {
    if (this.#evaluator?.native !== native) {
      const { noise, features = [], strokes = [] } = this.file;
      // 样条的路径在多边形的地物之后：路压在广场上面
      const paths = this.paths.map((path) => ({ type: 'path' as const, ...path }));
      this.#evaluator = { native, evaluator: native.createTerrain({ noise: { ...TERRAIN_NOISE_DEFAULTS, ...noise }, features: [...features, ...paths], strokes }) };
    }
    return this.#evaluator.evaluator;
  }

  /** 地形本地坐标 (x, z) 处的高度（同步，摆东西、玩法用）。 */
  heightAt(native: StrideNative, x: number, z: number): number {
    return this.evaluator(native).height(x, z);
  }

  /** 一页高度（工作线程上算，见 TerrainEvaluator.heights）；算着的时候 dispose 了，算完再放原生的求值器。 */
  async heights(native: StrideNative, x0: number, z0: number, spacing: number, countX: number, countZ: number): Promise<Float32Array> {
    this.#inflight++;
    try {
      return await this.evaluator(native).heights(x0, z0, spacing, countX, countZ);
    } finally {
      if (--this.#inflight === 0 && this.#disposed) this.#release();
    }
  }

  /**
   * 不再用了（编辑器雕刻时预览用的中间版本）：从资源表里拿掉，原生的求值器等手上的计算算完再放。
   * 内容管理器加载的资源不用调它（跟着内容缓存走）。
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    assets.remove(this.id);
    if (this.#inflight === 0) this.#release();
  }

  #inflight = 0;
  #disposed = false;

  #release(): void {
    this.#evaluator?.evaluator.destroy();
    this.#evaluator = undefined;
  }
}
