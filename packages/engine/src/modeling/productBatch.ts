/**
 * 把一批摆好的商品（连同货架、筐这些架子）合成一个网格、一张标签图集（货架、堆放共用）：每个用到的商品变体在图集里一格（标签的
 * 图形照原样嵌进去，按毫米的大小一起缩放），架子的纯色、价签这些另外几格；商品的 UV 从自己的 0..1 换到它那一格。图集是两张 SVG：
 * 颜色，和表面（G 粗糙度、B 金属度，材质的 glossinessTexture 加 metalnessChannel；R 是透射的比例）。整批一个材质，几千件商品
 * 一次绘制；瓶身透光的商品（ProductFile.transmission）另成一个网格，用同样的图集加透射的材质（透明阶段画，标签按 R 不透）。
 *
 * 用法：new ProductBatch(sources, items, { solids, cells }) 排好图集；box、quad 加架子的几何（UV 指着纯色格、单独的格），
 * finish() 加上商品、出网格和两张 SVG。
 */
import type { MaterialFile } from '../content/formats/assetFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import { packPages } from '../data/rectPacking.ts';
import { PACKAGE_TRANSMISSION, productDesign, productFootprint, productLabelShapes, productMesh, productSurface, productTransmission, svgNumber, type ProductMesh } from './product.ts';
import type { FoodPiecePose } from './ware.ts';
import type { TextFont } from './textOutline.ts';

/** 生成要的别的资源：商品文件（按内容路径）和字体。 */
export interface ProductSources {
  readonly products: ReadonlyMap<string, ProductFile>;
  readonly font: (path: string) => TextFont | undefined;
  /** 器皿里落定的菜块（商品路径 → 位姿，pipeline 的 settleFood 跑物理得到）；没有的器皿只有菜面。 */
  readonly food?: ReadonlyMap<string, readonly FoodPiecePose[]>;
}

/** 摆好的一件商品：哪个商品文件、第几个变体，底面中心的位置、朝向（四元数），细不细（后排、堆在下面的给少一点面，也不透光）。 */
export interface PlacedProduct {
  readonly product: string;
  readonly variant: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly fine: boolean;
}

/**
 * 图集里一格纯色（架子、价签条、筐）：颜色（sRGB）、粗糙度、金属度；emissive 是发光的强度（冷柜的灯带、灯箱的字面：
 * 自发光贴图里这一格是它的颜色，整批的自发光乘所有格子里最大的强度，弱一点的格子按比例暗）。
 */
export interface AtlasSolid {
  readonly color: string;
  readonly roughness: number;
  readonly metalness: number;
  readonly emissive?: number;
}

/** 图集里单独的一格（价签）：大小（毫米）、底色、表面，draw 往格子里画（像素坐标）。 */
export interface AtlasCell extends AtlasSolid {
  readonly size: readonly [number, number];
  readonly draw?: (cell: Cell) => string | undefined;
}

/** 图集里的一格（像素：x、y、宽、高）。 */
export type Cell = readonly [x: number, y: number, w: number, h: number];

/**
 * 合成的网格（材质槽 0）、图集的 SVG 和栅格化的边长；有发光的格子时还有自发光的图集和最大的强度；有玻璃时玻璃是单独的网格
 * （透明的玻璃材质，不进图集）；有透光的商品时它们是单独的网格（同样的图集加透射，mergedClearMaterial）。
 */
export interface MergedProducts {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly colorSvg: string;
  readonly surfaceSvg: string;
  readonly emissiveSvg: string | undefined;
  readonly emissive: number;
  readonly atlasPixels: number;
  readonly glass: MeshArrays | undefined;
  readonly clear: MeshArrays | undefined;
  /** 细管子（wire：吊杆、喷淋管的下垂段），用细线的材质（mergedWireMaterial：远处加粗、抖动着画，不闪）。 */
  readonly wire: MeshArrays | undefined;
  /** 贴在玻璃外面的一层脏（hazeQuad）；有它时生成的一方给出贴图的 SVG 和像素大小（mergedHazeMaterial）。 */
  readonly haze: MeshArrays | undefined;
  readonly hazeSvg?: string;
  readonly hazePixels?: readonly [number, number];
}

/** 一个网格的顶点（每个 8 个数：位置、法线、UV）和下标。 */
export interface MeshArrays {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * 图集的边长（像素）：最大 2048；标签最多画到每毫米 4 个像素，东西少、小的（地上的杂物、一筐蒜）用装得下的最小的边长（最小 256），
 * 不白占一整张 2048 的显存。格子之间的留边、纯色格的边长。
 */
const MAX_ATLAS = 2048;
const MIN_ATLAS = 256;
const MAX_DENSITY = 4;
const PADDING = 3;
const SOLID = 8;
/** 不细的商品的旋转体分段（12 段：8 段从上往下看是八边形）；最长不到 2 厘米的（砂粒、石子）6 段。 */
const COARSE_SEGMENTS = 12;
const TINY_SEGMENTS = 6;
const TINY = 0.02;

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
  readonly #glassVertices: number[] = [];
  readonly #glassIndices: number[] = [];
  readonly #clearVertices: number[] = [];
  readonly #clearIndices: number[] = [];
  readonly #solidTextures = new Map<number, number>();
  readonly #wireVertices: number[] = [];
  readonly #wireIndices: number[] = [];
  readonly #hazeVertices: number[] = [];
  readonly #hazeIndices: number[] = [];
  /** 图集的边长（像素）。 */
  readonly #atlas: number;

  /** maxDensity：标签最多画到每毫米几个像素（默认 4；地上的杂物远看就行，给 2）。 */
  constructor(sources: ProductSources, where: string, items: readonly PlacedProduct[], { solids = [], cells = [], maxDensity = MAX_DENSITY }: { readonly solids?: readonly AtlasSolid[]; readonly cells?: readonly AtlasCell[]; readonly maxDensity?: number } = {}) {
    this.#sources = sources;
    this.#where = where;
    this.#items = items;
    this.#solids = solids;
    this.#cells = cells;
    this.#variantKeys = [...new Set(items.map((item) => `${item.variant}|${item.product}`))];
    const labelSizes = this.#variantKeys.map((key) => this.#mesh(pathOf(key), true).labelSize);
    // 纯色格排在最下面一行（右往左），别的装进上面
    const reserve = solids.length > 0 ? SOLID + 2 * PADDING : 0;
    const { atlas, cells: packed } = packAtlas([...labelSizes, ...cells.map((cell) => cell.size)], reserve, solids.length * (SOLID + 2 * PADDING), maxDensity);
    this.#atlas = atlas;
    this.#labelCells = packed.slice(0, this.#variantKeys.length);
    this.#extraCells = packed.slice(this.#variantKeys.length);
    this.#solidCells = solids.map((_, i): Cell => [atlas - (i + 1) * (SOLID + PADDING * 2) + PADDING, atlas - SOLID - PADDING, SOLID, SOLID]);
  }

  /** 单独的第 i 格（像素），架子的几何按它算 UV。 */
  cell(i: number): Cell {
    return this.#extraCells[i]!;
  }

  /**
   * 之后 box 里用第 solid 个纯色的盒子都换成 texturedBox 贴第 cell 个格子（器具的主色换成用旧了的漆面，wear.ts 的 wornPaintCell）；
   * 圆管、斜板这些照旧是纯色。
   */
  textureSolid(solid: number, cell: number): void {
    this.#solidTextures.set(solid, cell);
  }

  /** 轴对齐的盒子，六个面都是第 solid 个纯色（textureSolid 换过的贴那一格）。 */
  box(min: readonly number[], max: readonly number[], solid: number): void {
    const cell = this.#solidTextures.get(solid);
    if (cell !== undefined) return this.texturedBox(min, max, cell);
    const [x, y, w, h] = this.#solidCells[solid]!;
    addBox(this.#vertices, this.#indices, min, max, (x + w / 2) / this.#atlas, (y + h / 2) / this.#atlas);
  }

  /**
   * 轴对齐的盒子，六个面都贴第 cell 个单独的格子（木纹的层板）：格子的 u 顺着盒子的 x（x 不变的两头顺着 z），v 是面上另一个
   * 方向，每个面都铺满整格。
   */
  texturedBox(min: readonly number[], max: readonly number[], cell: number): void {
    const [cx, cy, cw, ch] = this.#extraCells[cell]!;
    addBox(this.#vertices, this.#indices, min, max, 0, 0, (axis, sa, sb) => {
      // 面上变的两个轴是 (axis + 1) % 3 和 (axis + 2) % 3；u 取 x（没有 x 时取 z），v 取另一个
      const a = (axis + 1) % 3, alongU = a === 0 || (axis === 0 && a === 2) ? sa : sb;
      const alongV = alongU === sa ? sb : sa;
      return [(cx + alongU * cw) / this.#atlas, (cy + alongV * ch) / this.#atlas];
    });
  }

  /**
   * 斜放的一块板（格子柜里切角的斜隔板）：在 XY 平面上从 from 到 to、厚 thickness，沿 Z 从 z0 到 z1；六个面都是第 solid 个纯色。
   */
  plank(from: readonly [number, number], to: readonly [number, number], thickness: number, z0: number, z1: number, solid: number): void {
    const [x, y, w, h] = this.#solidCells[solid]!, u = (x + w / 2) / this.#atlas, v = (y + h / 2) / this.#atlas;
    const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
    if (length < 1e-9) return;
    // 沿板的方向 d、板面的法线 n（XY 平面里和 d 垂直）
    const d = [dx / length, dy / length], n = [-d[1]!, d[0]!], half = thickness / 2;
    const corner = (end: readonly [number, number], side: number, z: number) => [end[0] + n[0]! * half * side, end[1] + n[1]! * half * side, z];
    const quad = (a: number[], b: number[], c: number[], e: number[], normal: readonly number[]) => {
      const base = this.#vertices.length / 8;
      for (const p of [a, b, c, e]) this.#vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, u, v);
      // 按法线定绕向：(b - a) × (c - a) 和法线同向是逆时针
      const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], ac = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const facing = (ab[1]! * ac[2]! - ab[2]! * ac[1]!) * normal[0]! + (ab[2]! * ac[0]! - ab[0]! * ac[2]!) * normal[1]! + (ab[0]! * ac[1]! - ab[1]! * ac[0]!) * normal[2]!;
      if (facing >= 0) this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.#indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    };
    for (const side of [1, -1]) quad(corner(from, side, z0), corner(to, side, z0), corner(to, side, z1), corner(from, side, z1), [n[0]! * side, n[1]! * side, 0]);
    for (const [end, sign] of [[from, -1], [to, 1]] as const) quad(corner(end, 1, z0), corner(end, -1, z0), corner(end, -1, z1), corner(end, 1, z1), [d[0]! * sign, d[1]! * sign, 0]);
    for (const [z, sign] of [[z0, -1], [z1, 1]] as const) quad(corner(from, 1, z), corner(to, 1, z), corner(to, -1, z), corner(from, -1, z), [0, 0, sign]);
  }

  /** 轴对齐的一块玻璃（冷柜的门、冰柜的盖）：进玻璃那个网格。 */
  glassBox(min: readonly number[], max: readonly number[]): void {
    addBox(this.#glassVertices, this.#glassIndices, min, max, 0, 0);
  }

  /**
   * 一根圆管（从 from 到 to，半径 radius，绕一圈 segments 段，不封口），第 solid 个纯色：水管、吊杆、灯管；toRadius 给了时是圆台
   * （to 那头的半径，熟食柜的灯罩），法线按斜边。
   */
  tube(from: readonly number[], to: readonly number[], radius: number, solid: number, segments = 10, toRadius = radius): void {
    this.#tube(this.#vertices, this.#indices, from, to, radius, solid, segments, toRadius);
  }

  /**
   * 一根细管子（吊杆、电线；半径不过 WIRE_RADIUS 左右）：同 tube，但进细线的网格（mergedWireMaterial），远处不到一个像素宽时
   * 加粗、抖动着画，不闪。
   */
  wire(from: readonly number[], to: readonly number[], radius: number, solid: number, segments = 6): void {
    this.#tube(this.#wireVertices, this.#wireIndices, from, to, radius, solid, segments, radius);
  }

  #tube(vertices: number[], indices: number[], from: readonly number[], to: readonly number[], radius: number, solid: number, segments: number, toRadius: number): void {
    const [x, y, w, h] = this.#solidCells[solid]!, u = (x + w / 2) / this.#atlas, v = (y + h / 2) / this.#atlas;
    const axis = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!], length = Math.hypot(axis[0]!, axis[1]!, axis[2]!);
    if (length < 1e-9) return;
    const a = axis.map((c) => c / length);
    // 和轴垂直的两个方向
    const helper = Math.abs(a[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const p = normalize3(cross3(a, helper)), q = cross3(a, p);
    const base = vertices.length / 8;
    // 圆台的斜边：法线往轴的方向偏 (r0 − r1) / length
    const slope = (radius - toRadius) / length, scale = 1 / Math.hypot(1, slope);
    for (let k = 0; k <= segments; k++) {
      const angle = (k / segments) * 2 * Math.PI, c = Math.cos(angle), s = Math.sin(angle);
      const n = [p[0]! * c + q[0]! * s, p[1]! * c + q[1]! * s, p[2]! * c + q[2]! * s];
      const normal = [(n[0]! + a[0]! * slope) * scale, (n[1]! + a[1]! * slope) * scale, (n[2]! + a[2]! * slope) * scale];
      for (const [end, r] of [[from, radius], [to, toRadius]] as const) vertices.push(end[0]! + n[0]! * r, end[1]! + n[1]! * r, end[2]! + n[2]! * r, normal[0]!, normal[1]!, normal[2]!, u, v);
    }
    for (let k = 0; k < segments; k++) {
      const i = base + k * 2;
      // 从外面看逆时针：p→q 的方向绕着 a 转
      indices.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }

  /** 一片玻璃（四个角，从正面看左下、右下、右上、左上；两面都画）：进玻璃那个网格。 */
  glassQuad(corners: readonly (readonly number[])[]): void {
    const [a, b, c] = corners as [readonly number[], readonly number[], readonly number[]];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (const side of [1, -1]) {
      const base = this.#glassVertices.length / 8;
      for (const p of corners) this.#glassVertices.push(p[0]!, p[1]!, p[2]!, (n[0]! / l) * side, (n[1]! / l) * side, (n[2]! / l) * side, 0, 0);
      if (side > 0) this.#glassIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else this.#glassIndices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  /** 任意的网格（每个顶点 8 个数：位置、法线、0..1 的 UV），贴第 cell 个单独的格子（UV 换进那一格）。 */
  mesh(vertices: ArrayLike<number>, indices: ArrayLike<number>, cell: number): void {
    const [cx, cy, cw, ch] = this.#extraCells[cell]!, base = this.#vertices.length / 8;
    for (let i = 0; i < vertices.length; i += 8) {
      this.#vertices.push(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!, vertices[i + 3]!, vertices[i + 4]!, vertices[i + 5]!, (cx + vertices[i + 6]! * cw) / this.#atlas, (cy + vertices[i + 7]! * ch) / this.#atlas);
    }
    for (let i = 0; i < indices.length; i++) this.#indices.push(base + indices[i]!);
  }

  /** 一个四边形：四个角（从正面看左下、右下、右上、左上），法线，贴第 cell 个单独的格子。 */
  quad(corners: readonly (readonly number[])[], normal: readonly number[], cell: number): void {
    const [cx, cy, cw, ch] = this.#extraCells[cell]!, base = this.#vertices.length / 8;
    const uv = [[0, 1], [1, 1], [1, 0], [0, 0]] as const;
    corners.forEach((p, i) => this.#vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, (cx + uv[i]![0] * cw) / this.#atlas, (cy + uv[i]![1] * ch) / this.#atlas));
    this.#indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * 贴在玻璃外面的一层脏（冷柜门上的手印、水雾；半透明混合，见 mergedHazeMaterial）：corners 同 quad（左下、右下、右上、左上），
   * uv 是这一片在脏的贴图里的范围 [u0, v0, u1, v1]（v 朝下）。
   */
  hazeQuad(corners: readonly (readonly number[])[], normal: readonly number[], [u0, v0, u1, v1]: readonly [number, number, number, number]): void {
    const base = this.#hazeVertices.length / 8, uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]] as const;
    corners.forEach((p, i) => this.#hazeVertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, uv[i]![0], uv[i]![1]));
    this.#hazeIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** 加上商品，出网格和图集。 */
  finish(): MergedProducts {
    const cellOf = new Map(this.#variantKeys.map((key, i) => [key, this.#labelCells[i]!]));
    // 透光的商品每一排都用透射的材质：前后排不透明、透射混着画，同一个价签后面的油看着像两种（用户 11-23 指出）
    const placed = this.#items.map((item) => ({ item, mesh: this.#mesh(item.product, item.fine), clear: productTransmission(this.#sources.products.get(item.product)!) > 0 }));
    // 商品直接写进定长的数组：货架上几千件商品、上百万个顶点，往 number[] 里逐个 push 慢
    const merge = (vertices: readonly number[], indices: readonly number[], clear: boolean): MeshArrays => {
      const mine = placed.filter((entry) => entry.clear === clear);
      const out = new Float32Array(vertices.length + mine.reduce((sum, { mesh }) => sum + mesh.vertices.length, 0));
      const outIndices = new Uint32Array(indices.length + mine.reduce((sum, { mesh }) => sum + mesh.indices.length, 0));
      out.set(vertices);
      outIndices.set(indices);
      let at = vertices.length, indexAt = indices.length;
      const atlas = this.#atlas;
      for (const { item, mesh } of mine) {
        const [cx, cy, cw, ch] = cellOf.get(`${item.variant}|${item.product}`)!;
        const [qx, qy, qz, qw] = item.rotation, [px, py, pz] = item.position, src = mesh.vertices, base = at / 8;
        // 四元数转位置和法线（v + 2w(q×v) + 2q×(q×v)），展开写，不出小数组
        for (let i = 0; i < src.length; i += 8, at += 8) {
          const x = src[i]!, y = src[i + 1]!, z = src[i + 2]!, nx = src[i + 3]!, ny = src[i + 4]!, nz = src[i + 5]!;
          const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
          const sx = 2 * (qy * nz - qz * ny), sy = 2 * (qz * nx - qx * nz), sz = 2 * (qx * ny - qy * nx);
          out[at] = px + x + qw * tx + qy * tz - qz * ty;
          out[at + 1] = py + y + qw * ty + qz * tx - qx * tz;
          out[at + 2] = pz + z + qw * tz + qx * ty - qy * tx;
          out[at + 3] = nx + qw * sx + qy * sz - qz * sy;
          out[at + 4] = ny + qw * sy + qz * sx - qx * sz;
          out[at + 5] = nz + qw * sz + qx * sy - qy * sx;
          out[at + 6] = (cx + src[i + 6]! * cw) / atlas;
          out[at + 7] = (cy + src[i + 7]! * ch) / atlas;
        }
        for (const index of mesh.indices) outIndices[indexAt++] = base + index;
      }
      return { vertices: out, indices: outIndices };
    };
    const opaque = merge(this.#vertices, this.#indices, false), clear = merge(this.#clearVertices, this.#clearIndices, true);

    const color: string[] = [], surface: string[] = [], glow: string[] = [], defs = new Set<string>();
    const strongest = Math.max(0, ...this.#solids.map((solid) => solid.emissive ?? 0), ...this.#cells.map((cell) => cell.emissive ?? 0));
    // surfaceFill 是表面图集里这一格的颜色（商品的按 productSurface，带透射的 R）
    const fill = ([x, y, w, h]: Cell, { color: colorFill, roughness, metalness, emissive = 0 }: AtlasSolid, surfaceFill = `rgb(0,${Math.round(roughness * 255)},${Math.round(metalness * 255)})`) => {
      // 每一格连留边一起铺底色：缩小的时候不混进别的格子
      const rect = `x="${x - PADDING}" y="${y - PADDING}" width="${w + 2 * PADDING}" height="${h + 2 * PADDING}"`;
      color.push(`<rect ${rect} fill="${colorFill}"/>`);
      surface.push(`<rect ${rect} fill="${surfaceFill}"/>`);
      if (emissive > 0) glow.push(`<rect ${rect} fill="${colorFill}" opacity="${svgNumber(emissive / strongest)}"/>`);
    };
    this.#solids.forEach((solid, i) => fill(this.#solidCells[i]!, solid));
    this.#variantKeys.forEach((key, i) => {
      const variant = Number(key.slice(0, key.indexOf('|'))), path = pathOf(key);
      const product = this.#sources.products.get(path)!, design = productDesign(product, variant), cell = this.#labelCells[i]!;
      const [W, H] = this.#mesh(path, true).labelSize;
      const font = product.font ? this.#sources.font(product.font) : undefined;
      const surfaceCell = productSurface(product, [W, H], font, variant);
      fill(cell, { color: design.colors.background, roughness: 0, metalness: 0 }, surfaceCell.color);
      const nested = (shapes: string) => `<svg x="${cell[0]}" y="${cell[1]}" width="${cell[2]}" height="${cell[3]}" viewBox="0 0 ${svgNumber(W)} ${svgNumber(H)}" preserveAspectRatio="none">${shapes}</svg>`;
      color.push(nested(productLabelShapes(product, [W, H], font, variant)));
      if (surfaceCell.print) {
        surface.push(nested(surfaceCell.print));
        defs.add(surfaceCell.defs);
      }
    });
    this.#cells.forEach((cell, i) => {
      fill(this.#extraCells[i]!, cell);
      const drawn = cell.draw?.(this.#extraCells[i]!);
      if (!drawn) return;
      color.push(drawn);
      // 发光的格子里画的字也发光（灯箱的字）
      if ((cell.emissive ?? 0) > 0) glow.push(drawn);
    });
    const svg = (shapes: string[], background?: string, definitions = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.#atlas} ${this.#atlas}" width="${this.#atlas}" height="${this.#atlas}">${definitions ? `<defs>${definitions}</defs>` : ''}${background ? `<rect width="${this.#atlas}" height="${this.#atlas}" fill="${background}"/>` : ''}${shapes.join('')}</svg>`;
    return {
      vertices: opaque.vertices, indices: opaque.indices, colorSvg: svg(color), surfaceSvg: svg(surface, undefined, [...defs].join('')),
      emissiveSvg: strongest > 0 ? svg(glow, '#000000') : undefined, emissive: strongest, atlasPixels: this.#atlas,
      glass: this.#glassIndices.length > 0 ? { vertices: Float32Array.from(this.#glassVertices), indices: Uint32Array.from(this.#glassIndices) } : undefined,
      clear: clear.indices.length > 0 ? clear : undefined,
      wire: this.#wireIndices.length > 0 ? { vertices: Float32Array.from(this.#wireVertices), indices: Uint32Array.from(this.#wireIndices) } : undefined,
      haze: this.#hazeIndices.length > 0 ? { vertices: Float32Array.from(this.#hazeVertices), indices: Uint32Array.from(this.#hazeIndices) } : undefined,
    };
  }

  #mesh(path: string, fine: boolean): ProductMesh {
    const key = `${fine ? 'f' : 'c'}|${path}`;
    let mesh = this.#meshes.get(key);
    if (!mesh) {
      const product = this.#sources.products.get(path)!;
      const segments = fine ? undefined : Math.max(...productFootprint(product)) < TINY ? TINY_SEGMENTS : COARSE_SEGMENTS;
      this.#meshes.set(key, mesh = productMesh(product, `${this.#where}: ${path}`, segments, this.#sources.food?.get(path)));
    }
    return mesh;
  }
}

const pathOf = (key: string) => key.slice(key.indexOf('|') + 1);
const cross3 = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize3 = (v: readonly number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/** 轴对齐的盒子的六个面，UV 都是 (u, v)。 */
function addBox(vertices: number[], indices: number[], min: readonly number[], max: readonly number[], u: number, v: number, uvOf?: (axis: number, sa: 0 | 1, sb: 0 | 1) => readonly [number, number]): void {
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const normal = [0, 0, 0];
      normal[axis] = sign;
      const a = (axis + 1) % 3, b = (axis + 2) % 3;
      const base = vertices.length / 8;
      for (const [sa, sb] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        const p = [0, 0, 0];
        p[axis] = sign > 0 ? max[axis]! : min[axis]!;
        p[a] = sa ? max[a]! : min[a]!;
        p[b] = sb ? max[b]! : min[b]!;
        const [fu, fv] = uvOf ? uvOf(axis, sa, sb) : [u, v];
        vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, fu, fv);
      }
      // a、b、axis 是右手系的顺序：(0,0)→(1,0)→(1,1) 绕着 +axis 逆时针，负的那面反过来
      if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
}

/**
 * 把标签（毫米）缩放、装进图集（最下面留 reserve 像素给纯色格，那一行至少 solidsWidth 宽）：从最小的边长往上试，每种边长找一个
 * 最大的缩放（不超过每毫米 maxDensity 个像素）让全部装得下；够到上限的、或者已经是最大的边长就用它。返回边长和每一格（像素）。
 */
function packAtlas(sizes: readonly (readonly [number, number])[], reserve: number, solidsWidth: number, maxDensity: number): { readonly atlas: number; readonly cells: Cell[] } {
  for (let atlas = MIN_ATLAS; ; atlas *= 2) {
    const last = atlas >= MAX_ATLAS;
    if (!last && solidsWidth > atlas) continue;
    if (sizes.length === 0) return { atlas, cells: [] };
    let low = 0, high = maxDensity;
    let best: Cell[] | undefined;
    for (let step = 0; step < 24; step++) {
      const scale = step === 0 ? high : (low + high) / 2;
      const scaled = sizes.map(([w, h]) => [Math.max(4, Math.floor(w * scale)), Math.max(4, Math.floor(h * scale))] as const);
      const placed = packPages(scaled, atlas - reserve, PADDING);
      // 放不进的那块在结果里是空位（every 会跳过空位），按下标逐个查
      if (sizes.every((_, i) => placed[i] !== undefined && placed[i]![0] === 0)) {
        best = placed.map((at) => [at![1], at![2], at![3], at![4]] as const);
        low = scale;
        // 最细的那一档就装得下：不用再试
        if (step === 0) break;
      } else high = step === 0 ? maxDensity : scale;
    }
    if (best && (low >= maxDensity || last)) return { atlas, cells: best };
    if (last) throw new Error(`too many labels for one ${MAX_ATLAS}px atlas`);
  }
}

/**
 * 合成的那批的材质：颜色图集、表面图集（G 粗糙度、B 金属度），有发光的格子时加自发光图集乘 emissive。path 是资源的内容路径
 * （图集是 `<path>.svg`、`<path>.surface.svg`、`<path>.emissive.svg`，颜色图集的矢量版 `<path>.vector`）。
 */
export function mergedMaterial(name: string, path: string, pixels: number, emissive = 0): MaterialFile {
  const slot = { encoding: 'svg' as const, size: [pixels, pixels] as const, filter: 'anisotropic' as const, scale: [1, 1] as const, offset: [0, 0] as const };
  return {
    name,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: { texture: path, srgb: true, ...slot },
    // 颜色图集的矢量版（`<path>.vector`，烘焙时由颜色图集的 SVG 建）：近处按曲线画，走多近都清楚
    vector: path,
    metalness: 1,
    glossinessTexture: { texture: `${path}.surface`, srgb: false, channel: 'g', invert: true, metalnessChannel: 'b', ...slot },
    ...(emissive > 0 ? { emissive: [emissive, emissive, emissive] as const, emissiveTexture: { texture: `${path}.emissive`, srgb: true, ...slot } } : {}),
  };
}

/** 合成的那批里透光的商品的材质（油瓶）：同样的图集，表面图集的 R 乘透射的比例（标签那里是 0，不透）。 */
export function mergedClearMaterial(name: string, path: string, pixels: number): MaterialFile {
  const material = mergedMaterial(`${name} clear`, path, pixels);
  return { ...material, glossinessTexture: { ...material.glossinessTexture!, transmissionChannel: 'r' }, transmission: PACKAGE_TRANSMISSION };
}

/** 玻璃外面那层脏的材质：白色、按贴图的 alpha 半透明混合，比玻璃糙（手印、水雾把反光打散）。 */
export function mergedHazeMaterial(name: string, path: string, pixels: readonly [number, number]): MaterialFile {
  return {
    name: `${name} haze`, baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.55,
    baseColorTexture: { texture: `${path}.haze`, encoding: 'svg', size: pixels, srgb: true, filter: 'anisotropic', scale: [1, 1], offset: [0, 0] },
    transparency: { type: 'blend', alpha: 1 },
  };
}

/** 细线的网格（ProductBatch.wire）的管子半径按这个算（顶点着色器从表面退回中心线用；吊杆 4～6 毫米、喷淋管的下垂段 1 厘米）。 */
export const WIRE_RADIUS = 0.005;

/** 合成的那批里细线的材质：同图集的材质（纯色格），加 wire（远处加粗、抖动着画），不要矢量版（纯色）。 */
export function mergedWireMaterial(name: string, path: string, pixels: number, emissive = 0): MaterialFile {
  const { vector: _vector, ...material } = mergedMaterial(name, path, pixels, emissive);
  return { ...material, name: `${name} wire`, wire: WIRE_RADIUS };
}

/** 合成的那批里玻璃的材质（冷柜的门、冰柜的盖）：同材质库的透明玻璃，带一点冷色。 */
export function mergedGlassMaterial(name: string): MaterialFile {
  return { name: `${name} glass`, baseColor: [0.9, 0.95, 0.97, 1], metalness: 0, roughness: 0.03, glass: { refractiveIndex: 1.5 }, diffuseShading: false };
}
