/**
 * 高度页（矢量地形的块用，见 terrain/TerrainSystem.ts）：所有块共用一个网格（32 × 32 格的平面加裙边），每块的高度放在一个大的
 * 存储缓冲里的一页，顶点着色器（meshShader.ts 的 vsHeightfield）按格坐标取高度、用相邻的高度算法线。这样整片地形是同一个网格、
 * 同一个材质，一次实例化绘制画完（每个视图一次），不是每块一个网格一次绘制。
 *
 * 一页是 HEIGHT_PAGE_HEADER 个 float 的页头（UV 的原点 u、v，每格的 UV 步长，裙边的深度）加 HEIGHT_PAGE_SAMPLES² 个高度（按行 z
 * 排，比块的顶点多一圈，算法线用）。块的实体带 HeightfieldTile（page 是页在缓冲里的起点，按 float 算），网格渲染特性按变换槽位
 * 把它传给着色器（和形变的权重起点共用一张槽位表：一个实体不会既是地形块又带形变）。
 *
 * CPU 这边存一份，改了的页记在脏区间里，网格渲染特性每帧上传脏的部分；缓冲按需翻倍增长。
 */
import { component } from '../../engine/component';
import { prop } from '../../data/prop';

/** 一页每边的高度个数：32 格的块 33 个顶点，两边各多一圈。同 terrain/terrainTiles.ts 的 TILE_SAMPLES。 */
export const HEIGHT_PAGE_SAMPLES = 35;
export const HEIGHT_PAGE_HEADER = 4;
export const HEIGHT_PAGE_FLOATS = HEIGHT_PAGE_HEADER + HEIGHT_PAGE_SAMPLES * HEIGHT_PAGE_SAMPLES;

/** 地形块：它的高度在高度页缓冲里从第 page 个 float 起（页头加高度）。网格是共用的高度场网格（Mesh 的 heightfield）。 */
export const HeightfieldTile = component('HeightfieldTile', {
  page: prop.u32().default(0).transient(),
});

export class HeightPages {
  data = new Float32Array(HEIGHT_PAGE_FLOATS * 64);
  readonly #free: number[] = [];
  #count = 0;
  /** 改过、还没上传的范围（float 下标，[start, end)）。 */
  dirtyStart = Infinity;
  dirtyEnd = 0;
  /** 缓冲长大了（GPU 那边要重建缓冲、整个重传）。 */
  grown = true;

  /** 占一页，返回它的起点（float）。 */
  allocate(): number {
    const page = this.#free.pop() ?? this.#count++;
    const offset = page * HEIGHT_PAGE_FLOATS;
    if (offset + HEIGHT_PAGE_FLOATS > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, offset + HEIGHT_PAGE_FLOATS));
      grown.set(this.data);
      this.data = grown;
      this.grown = true;
    }
    return offset;
  }

  /** 写一页：页头（UV 原点、每格的 UV 步长、裙边深度）和 HEIGHT_PAGE_SAMPLES² 个高度。 */
  write(offset: number, header: readonly [number, number, number, number], heights: Float32Array): void {
    if (heights.length !== HEIGHT_PAGE_SAMPLES * HEIGHT_PAGE_SAMPLES) throw new RangeError(`height page needs ${HEIGHT_PAGE_SAMPLES}² heights, got ${heights.length}`);
    this.data.set(header, offset);
    this.data.set(heights, offset + HEIGHT_PAGE_HEADER);
    this.dirtyStart = Math.min(this.dirtyStart, offset);
    this.dirtyEnd = Math.max(this.dirtyEnd, offset + HEIGHT_PAGE_FLOATS);
  }

  free(offset: number): void {
    this.#free.push(offset / HEIGHT_PAGE_FLOATS);
  }

  /** 用着的页数。 */
  get used(): number {
    return this.#count - this.#free.length;
  }
}
