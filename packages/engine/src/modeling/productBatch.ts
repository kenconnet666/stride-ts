/**
 * 把一批摆好的商品（连同货架、筐这些架子）合成一个网格、一张标签图集（货架、堆放共用）：每个用到的商品变体在图集里一格（标签的
 * 图形照原样嵌进去，按毫米的大小一起缩放），架子的纯色、价签这些另外几格；商品的 UV 从自己的 0..1 换到它那一格。图集是两张 SVG：
 * 颜色，和表面（G 粗糙度、B 金属度，材质的 glossinessTexture 加 metalnessChannel）。整批一个材质，几千件商品一次绘制。
 *
 * 用法：new ProductBatch(sources, items, { solids, cells }) 排好图集；box、quad 加架子的几何（UV 指着纯色格、单独的格），
 * finish() 加上商品、出网格和两张 SVG。
 */
import type { MaterialFile } from '../content/formats/assetFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import { packPages } from '../data/rectPacking.ts';
import { productDesign, productLabelShapes, productMesh, SURFACE_MATERIAL, svgNumber, type ProductMesh } from './product.ts';
import type { TextFont } from './textOutline.ts';

/** 生成要的别的资源：商品文件（按内容路径）和字体。 */
export interface ProductSources {
  readonly products: ReadonlyMap<string, ProductFile>;
  readonly font: (path: string) => TextFont | undefined;
}

/** 摆好的一件商品：哪个商品文件、第几个变体，底面中心的位置、朝向（四元数），细不细（后排、堆在下面的给少一点面）。 */
export interface PlacedProduct {
  readonly product: string;
  readonly variant: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly fine: boolean;
}

/** 图集里一格纯色（架子、价签条、筐）：颜色（sRGB）、粗糙度、金属度。 */
export interface AtlasSolid {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
}

/** 图集里单独的一格（价签）：大小（毫米）、底色、表面，draw 往格子里画（像素坐标）。 */
export interface AtlasCell extends AtlasSolid {
  readonly size: readonly [number, number];
  readonly draw?: (cell: Cell) => string | undefined;
}

/** 图集里的一格（像素：x、y、宽、高）。 */
export type Cell = readonly [x: number, y: number, w: number, h: number];

/** 合成的网格（一个材质槽）、图集的两张 SVG 和栅格化的边长。 */
export interface MergedProducts {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly colorSvg: string;
  readonly surfaceSvg: string;
  readonly atlasPixels: number;
}

/** 图集的边长（像素）、格子之间的留边、纯色格的边长。 */
const ATLAS = 2048;
const PADDING = 3;
const SOLID = 8;
/** 不细的商品的旋转体分段（12 段：8 段从上往下看是八边形）。 */
const COARSE_SEGMENTS = 12;

export class ProductBatch {
  readonly #sources: ProductSources;
  readonly #where: string;
  readonly #items: readonly PlacedProduct[];
  readonly #solids: readonly AtlasSolid[];
  readonly #cells: readonly AtlasCell[];
  readonly #variantKeys: string[];
  readonly #labelCells: Cell[];
  readonly #extraCells: Cell[];
  readonly #solidCells: Cell[];
  readonly #meshes = new Map<string, ProductMesh>();
  readonly #vertices: number[] = [];
  readonly #indices: number[] = [];

  constructor(sources: ProductSources, where: string, items: readonly PlacedProduct[], { solids = [], cells = [] }: { readonly solids?: readonly AtlasSolid[]; readonly cells?: readonly AtlasCell[] } = {}) {
    this.#sources = sources;
    this.#where = where;
    this.#items = items;
    this.#solids = solids;
    this.#cells = cells;
    this.#variantKeys = [...new Set(items.map((item) => `${item.variant}|${item.product}`))];
    const labelSizes = this.#variantKeys.map((key) => this.#mesh(pathOf(key), true).labelSize);
    // 纯色格排在最下面一行（右往左），别的装进上面
    const reserve = solids.length > 0 ? SOLID + 2 * PADDING : 0;
    const packed = packAtlas([...labelSizes, ...cells.map((cell) => cell.size)], reserve);
    this.#labelCells = packed.slice(0, this.#variantKeys.length);
    this.#extraCells = packed.slice(this.#variantKeys.length);
    this.#solidCells = solids.map((_, i): Cell => [ATLAS - (i + 1) * (SOLID + PADDING * 2) + PADDING, ATLAS - SOLID - PADDING, SOLID, SOLID]);
  }

  /** 单独的第 i 格（像素），架子的几何按它算 UV。 */
  cell(i: number): Cell {
    return this.#extraCells[i]!;
  }

  /** 轴对齐的盒子，六个面都是第 solid 个纯色。 */
  box(min: readonly number[], max: readonly number[], solid: number): void {
    const [x, y, w, h] = this.#solidCells[solid]!, u = (x + w / 2) / ATLAS, v = (y + h / 2) / ATLAS;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) {
        const normal = [0, 0, 0];
        normal[axis] = sign;
        const a = (axis + 1) % 3, b = (axis + 2) % 3;
        const base = this.#vertices.length / 8;
        for (const [sa, sb] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
          const p = [0, 0, 0];
          p[axis] = sign > 0 ? max[axis]! : min[axis]!;
          p[a] = sa ? max[a]! : min[a]!;
          p[b] = sb ? max[b]! : min[b]!;
          this.#vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, u, v);
        }
        // a、b、axis 是右手系的顺序：(0,0)→(1,0)→(1,1) 绕着 +axis 逆时针，负的那面反过来
        if (sign > 0) this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else this.#indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
  }

  /** 一个四边形：四个角（从正面看左下、右下、右上、左上），法线，贴第 cell 个单独的格子。 */
  quad(corners: readonly (readonly number[])[], normal: readonly number[], cell: number): void {
    const [cx, cy, cw, ch] = this.#extraCells[cell]!, base = this.#vertices.length / 8;
    const uv = [[0, 1], [1, 1], [1, 0], [0, 0]] as const;
    corners.forEach((p, i) => this.#vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, (cx + uv[i]![0] * cw) / ATLAS, (cy + uv[i]![1] * ch) / ATLAS));
    this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** 加上商品，出网格和图集。 */
  finish(): MergedProducts {
    const cellOf = new Map(this.#variantKeys.map((key, i) => [key, this.#labelCells[i]!]));
    for (const item of this.#items) {
      const mesh = this.#mesh(item.product, item.fine);
      const [cx, cy, cw, ch] = cellOf.get(`${item.variant}|${item.product}`)!;
      const [qx, qy, qz, qw] = item.rotation;
      const rotate = (x: number, y: number, z: number): [number, number, number] => {
        const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
        return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
      };
      const base = this.#vertices.length / 8, src = mesh.vertices, [px, py, pz] = item.position;
      for (let i = 0; i < src.length; i += 8) {
        const p = rotate(src[i]!, src[i + 1]!, src[i + 2]!), n = rotate(src[i + 3]!, src[i + 4]!, src[i + 5]!);
        this.#vertices.push(px + p[0], py + p[1], pz + p[2], n[0], n[1], n[2], (cx + src[i + 6]! * cw) / ATLAS, (cy + src[i + 7]! * ch) / ATLAS);
      }
      for (const index of mesh.indices) this.#indices.push(base + index);
    }

    const color: string[] = [], surface: string[] = [];
    const fill = ([x, y, w, h]: Cell, { color: colorFill, roughness, metalness }: AtlasSolid) => {
      // 每一格连留边一起铺底色：缩小的时候不混进别的格子
      const rect = `x="${x - PADDING}" y="${y - PADDING}" width="${w + 2 * PADDING}" height="${h + 2 * PADDING}"`;
      color.push(`<rect ${rect} fill="${colorFill}"/>`);
      surface.push(`<rect ${rect} fill="rgb(0,${Math.round(roughness * 255)},${Math.round(metalness * 255)})"/>`);
    };
    this.#solids.forEach((solid, i) => fill(this.#solidCells[i]!, solid));
    this.#variantKeys.forEach((key, i) => {
      const variant = Number(key.slice(0, key.indexOf('|'))), path = pathOf(key);
      const product = this.#sources.products.get(path)!, design = productDesign(product, variant), cell = this.#labelCells[i]!;
      const [W, H] = this.#mesh(path, true).labelSize;
      fill(cell, { color: design.colors.background, ...SURFACE_MATERIAL[design.surface] });
      const font = product.font ? this.#sources.font(product.font) : undefined;
      color.push(`<svg x="${cell[0]}" y="${cell[1]}" width="${cell[2]}" height="${cell[3]}" viewBox="0 0 ${svgNumber(W)} ${svgNumber(H)}" preserveAspectRatio="none">${productLabelShapes(product, [W, H], font, variant)}</svg>`);
    });
    this.#cells.forEach((cell, i) => {
      fill(this.#extraCells[i]!, cell);
      const drawn = cell.draw?.(this.#extraCells[i]!);
      if (drawn) color.push(drawn);
    });
    const svg = (shapes: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ATLAS} ${ATLAS}" width="${ATLAS}" height="${ATLAS}">${shapes.join('')}</svg>`;
    return { vertices: Float32Array.from(this.#vertices), indices: Uint32Array.from(this.#indices), colorSvg: svg(color), surfaceSvg: svg(surface), atlasPixels: ATLAS };
  }

  #mesh(path: string, fine: boolean): ProductMesh {
    const key = `${fine ? 'f' : 'c'}|${path}`;
    let mesh = this.#meshes.get(key);
    if (!mesh) this.#meshes.set(key, mesh = productMesh(this.#sources.products.get(path)!, `${this.#where}: ${path}`, fine ? undefined : COARSE_SEGMENTS));
    return mesh;
  }
}

const pathOf = (key: string) => key.slice(key.indexOf('|') + 1);

/** 把标签（毫米）缩放、装进图集（最下面留 reserve 像素给纯色格）：找一个最大的缩放，让全部装得下。返回每一格（像素）。 */
function packAtlas(sizes: readonly (readonly [number, number])[], reserve: number): Cell[] {
  if (sizes.length === 0) return [];
  let low = 0, high = 10;
  let best: Cell[] | undefined;
  for (let step = 0; step < 24; step++) {
    const scale = (low + high) / 2;
    const scaled = sizes.map(([w, h]) => [Math.max(4, Math.floor(w * scale)), Math.max(4, Math.floor(h * scale))] as const);
    const placed = packPages(scaled, ATLAS - reserve, PADDING);
    // 放不进的那块在结果里是空位（every 会跳过空位），按下标逐个查
    if (sizes.every((_, i) => placed[i] !== undefined && placed[i]![0] === 0)) {
      best = placed.map((at) => [at![1], at![2], at![3], at![4]] as const);
      low = scale;
    } else high = scale;
  }
  if (!best) throw new Error(`too many labels for one ${ATLAS}px atlas`);
  return best;
}

/** 合成的那批的材质：颜色图集、表面图集（G 粗糙度、B 金属度）。path 是资源的内容路径（图集是 `<path>.svg`、`<path>.surface.svg`）。 */
export function mergedMaterial(name: string, path: string, pixels: number): MaterialFile {
  const slot = { encoding: 'svg' as const, size: [pixels, pixels] as const, filter: 'anisotropic' as const, scale: [1, 1] as const, offset: [0, 0] as const };
  return {
    name,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: { texture: path, srgb: true, ...slot },
    metalness: 1,
    glossinessTexture: { texture: `${path}.surface`, srgb: false, channel: 'g', invert: true, metalnessChannel: 'b', ...slot },
  };
}
