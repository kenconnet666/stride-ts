/**
 * 矢量地形的求值描述（纯函数，运行时的 TerrainAsset 和编辑器的 MCP 工具 terrain_height 共用，后者在 Node 里算高度）：地形文件
 * 加上它贴着的样条路径，交给原生的 createTerrain。
 */
import type { TerrainDescription } from '@stride-ts/native';
import { TERRAIN_NOISE_DEFAULTS, type TerrainFile, type TerrainSplineFile } from '../content/formats/terrainFormat.ts';
import type { SplineFile } from '../content/formats/splineFormat.ts';
import { splineCenterlines, splineCorridorWidth } from './spline.ts';

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
  const width = entry.width ?? splineCorridorWidth(profile);
  return splineCenterlines(spline, Math.min(PATH_STEP, spline.resolution ?? PATH_STEP)).map(({ points, curb }) => ({
    points: points.map(([x, y, z]) => [x + dx, y + dy, z + dz] as const),
    width, offset: (entry.offset ?? -0.1) - (curb ? CURB_DEPTH : 0), falloff: entry.falloff ?? 10, strength: entry.strength ?? 1, mode: entry.mode ?? 'conform',
  }));
}

/** 原生求值器的描述：噪声补上默认值，样条的路径排在多边形的地物之后（路压在广场上面）。 */
export function terrainDescription(file: TerrainFile, paths: readonly TerrainPath[]): TerrainDescription {
  const { noise, features = [], strokes = [] } = file;
  return { noise: { ...TERRAIN_NOISE_DEFAULTS, ...noise }, features: [...features, ...paths.map((path) => ({ type: 'path' as const, ...path }))], strokes };
}
