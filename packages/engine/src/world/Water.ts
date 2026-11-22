/**
 * 水体（W6，Stride 没有）：Water 组件引用一个 `.water.json`（content/formats/waterFormat.ts），实体的位置是水面；WaterAsset 是加载好
 * 的资源（河的带子网格），waterAreas、underWater 给程序化摆放、浮力判断哪儿是水。怎么画见 WaterRenderer.ts。
 */
import type { SplineFile } from '../content/formats/splineFormat';
import type { WaterFile } from '../content/formats/waterFormat';
import { sampleSpline, splinePaths } from '../modeling/spline';
import { prop, type Branded } from '../data/prop';
import { component } from '../engine/component';
import type { GameTime } from '../engine/GameTime';
import { ResourceTable } from '../engine/ResourceTable';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';

export type WaterAssetId = Branded<number, 'WaterAssetId'>;

/** 水体：实体的位置是水面（本地 y = 0），水体文件里的岸线是本地的 [x, z]。 */
export const Water = component('Water', {
  water: prop.u32().brand<'WaterAssetId'>().default(0 as WaterAssetId),
});

const assets = new ResourceTable<WaterAsset>();

/**
 * 一片水在世界里占哪儿：水面的高度、岸线（世界的 [x, z]；海是 undefined，哪儿都是）；河是 river：中心线（世界的 [x, 水面高度, z]）
 * 和半宽。
 */
export interface WaterArea {
  readonly level: number;
  readonly outline: readonly (readonly [number, number])[] | undefined;
  readonly river?: { readonly line: readonly (readonly [number, number, number])[]; readonly halfWidth: number; readonly speed: number };
}

/** 河的水面每隔多少米一节。 */
const RIVER_STEP = 2;
/** 河的水面网格一个顶点几个 float：本地的 x、水面高度、z，弧长；流向的 x、z，横向（−1..1），半宽。 */
export const RIVER_VERTEX_FLOATS = 8;

/**
 * 河的水面：样条每条路径每 RIVER_STEP 米一节，两边按样条的宽展开，水面比样条低 level 米；三角形列表（不用索引），坐标是样条的
 * （= 实体的本地）。
 */
export function riverRibbon(spline: SplineFile, level: number): Float32Array {
  const width = spline.profile.type === 'river' ? spline.profile.width : 4;
  const out: number[] = [];
  for (const path of splinePaths(spline)) {
    const frames = sampleSpline(path.points, path.closed ?? false, RIVER_STEP);
    for (let i = 0; i + 1 < frames.length; i++) {
      const pair = [frames[i]!, frames[i + 1]!];
      const corner = (k: number, side: number) => {
        const f = pair[k]!, half = (width * f.width) / 2;
        const rl = Math.hypot(f.right[0], f.right[2]) || 1, tl = Math.hypot(f.tangent[0], f.tangent[2]) || 1;
        out.push(f.position[0] + (f.right[0] / rl) * half * side, f.position[1] - level, f.position[2] + (f.right[2] / rl) * half * side, f.distance,
          f.tangent[0] / tl, f.tangent[2] / tl, side, half);
      };
      corner(0, -1); corner(0, 1); corner(1, 1);
      corner(0, -1); corner(1, 1); corner(1, -1);
    }
  }
  return Float32Array.from(out);
}

/** 下了很久的大雨以后这片水涨多少米（文件的 rise，没写时湖 0.5、河 0.6、海 0）。 */
export function waterRise(file: WaterFile): number {
  return file.rise ?? (file.river ? 0.6 : file.outline ? 0.5 : 0);
}

let floodNow = 0;
const areaQuery = system('waterAreas', {
  with: { water: Water, transform: Transform },
  update: ({ water, transform, count }) => {
    for (let i = 0; i < count; i++) {
      const asset = WaterAsset.byId(water.water[i]!);
      if (!asset) continue;
      const w = transform.slot[i]! * 16, m = transform.world;
      const toWorld = (x: number, y: number, z: number) => [m[w]! * x + m[w + 4]! * y + m[w + 8]! * z + m[w + 12]!, m[w + 1]! * x + m[w + 5]! * y + m[w + 9]! * z + m[w + 13]!, m[w + 2]! * x + m[w + 6]! * y + m[w + 10]! * z + m[w + 14]!] as const;
      const river = asset.river;
      if (river) {
        const level = asset.file.river?.level ?? 0.3;
        for (const path of splinePaths(river)) {
          const line = sampleSpline(path.points, path.closed ?? false, RIVER_STEP * 2).map((f) => toWorld(f.position[0], f.position[1] - level + waterRise(asset.file) * floodNow, f.position[2]));
          collected.push({ level: Number.NaN, outline: undefined, river: { line, halfWidth: (river.profile.type === 'river' ? river.profile.width : 4) / 2, speed: asset.file.river?.speed ?? 1.5 } });
        }
        continue;
      }
      collected.push({
        level: m[w + 13]! + waterRise(asset.file) * floodNow,
        outline: asset.file.outline?.map(([x, z]) => [toWorld(x, 0, z)[0], toWorld(x, 0, z)[2]] as const),
      });
    }
  },
});
let collected: WaterArea[] = [];

/**
 * 场景里的水体占的地方。flood 是天气的涨水（0..1，WeatherState.flood）：浮力用现在的水面；程序化摆放用平时的（不写，不随天气重撒）。
 */
export function waterAreas(entities: { run: (query: typeof areaQuery, time: GameTime) => void }, time: GameTime, flood = 0): WaterArea[] {
  collected = [];
  floodNow = flood;
  entities.run(areaQuery, time);
  return collected;
}

/** 点（世界的 x、高度 y、z）在不在水下（河：离中心线半宽以内、低于那里的水面）。 */
export function underWater(areas: readonly WaterArea[], x: number, y: number, z: number): boolean {
  return areas.some((area) => (area.river ? underRiver(area.river, x, y, z) : y < area.level && (!area.outline || insidePolygon(area.outline, x, z))));
}

function underRiver({ line, halfWidth }: NonNullable<WaterArea['river']>, x: number, y: number, z: number): boolean {
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay, az] = line[i]!, [bx, by, bz] = line[i + 1]!;
    const ex = bx - ax, ez = bz - az, length = ex * ex + ez * ez;
    const t = length > 0 ? Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / length)) : 0;
    if (Math.hypot(x - ax - ex * t, z - az - ez * t) < halfWidth + 0.5 && y < ay + (by - ay) * t) return true;
  }
  return false;
}

/** 点在多边形里（奇偶规则）。 */
export function insidePolygon(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 加载好的水体资源；river 是河的样条（文件写了 river 时）。 */
export class WaterAsset {
  readonly id: WaterAssetId;
  readonly path: string;
  readonly file: WaterFile;
  readonly river: SplineFile | undefined;
  #ribbon: Float32Array | undefined;

  constructor(path: string, file: WaterFile, river?: SplineFile) {
    this.path = path;
    this.file = file;
    this.river = river;
    this.id = assets.add(this) as WaterAssetId;
  }

  /** 河的水面网格（riverRibbon，第一次要时算）；不是河时是 undefined。 */
  get ribbon(): Float32Array | undefined {
    if (!this.river) return undefined;
    return (this.#ribbon ??= riverRibbon(this.river, this.file.river?.level ?? 0.3));
  }

  /** @internal Water 组件里存的 id 对应的资源。 */
  static byId(id: number): WaterAsset | undefined {
    return assets.get(id);
  }
}
