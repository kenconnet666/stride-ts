/**
 * 货架的生成（`.shelf.json`，格式见 content/formats/shelfFormat.ts）：架子、价签条、价签和照规则摆上去的商品合成一个网格，
 * 用一张标签图集（颜色一张 SVG，粗糙度和金属度一张 SVG）和一个材质——几千件商品一次绘制。纯函数，编辑器后端烘焙
 * （pipeline/src/bakers/shelfModel.ts）和测试用。
 *
 * - 摆货（planShelf）：每一面、每一层从左往右，按种子挑放得下的商品（高不超过这层的净空）、哪个变体、几个排面，往里摆到层深
 *   或 rows 排；按 gaps 的比例空几个位子（卖掉了的），每一组商品在价签条上有一个价签。同一个文件、同一个种子摆出来一样。
 * - 图集：每个用到的商品变体一格（标签的图形照原样嵌进去，按毫米的大小一起缩放），价签几格，架子、价签条、底座的纯色各一小格。
 *   商品的 UV 从自己的 0..1 换到它那一格。第一排的商品照常细，后面几排的旋转体分段少一些（只看得见顶）。
 */
import type { MaterialFile } from '../content/formats/assetFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import type { ShelfFile } from '../content/formats/shelfFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { packPages } from '../data/rectPacking.ts';
import { productDesign, productFootprint, productLabelShapes, productMesh, SURFACE_MATERIAL, svgNumber as n, textPath, type ProductMesh } from './product.ts';
import type { TextFont } from './textOutline.ts';

/** 摆上去的一件商品：哪个商品文件、第几个变体，底面中心的位置，绕 Y 转多少（背面那一面转半圈），是不是第一排。 */
export interface ShelfItem {
  readonly product: string;
  readonly variant: number;
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly front: boolean;
}

/** 一个价签：价签条正面上的位置（价签的中心）、朝哪面、第几种价格。 */
export interface ShelfTag {
  readonly position: readonly [number, number, number];
  readonly side: 1 | -1;
  readonly price: number;
}

/** 生成货架要的别的资源：商品文件（按内容路径）和字体。 */
export interface ShelfSources {
  readonly products: ReadonlyMap<string, ProductFile>;
  readonly font: (path: string) => TextFont | undefined;
}

/** 生成的货架：网格（一个材质槽）、图集的两张 SVG（颜色、表面）和栅格化的边长。 */
export interface ShelfModel {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly colorSvg: string;
  readonly surfaceSvg: string;
  readonly atlasPixels: number;
  readonly items: number;
}

/** 中岛的背板一半的厚度（米）；单面的背板贴着 z = 0 往 -Z 厚。 */
const SPINE = 0.02;
const BOARD = 0.02;
/** 价签条：高、厚（米），贴在层板前沿往下。 */
const STRIP = [0.045, 0.008] as const;
const TAG = [0.055, 0.032] as const;
/** 商品之间留的缝（米）。 */
const GAP = 0.006;
/** 图集的边长（像素）和格子之间的留边。 */
const ATLAS = 2048;
const PADDING = 3;
/** 价签有几种价格。 */
const PRICES = 8;
/** 后排商品的旋转体分段。 */
const BACK_SEGMENTS = 12;

/** 按规则摆货：每件商品、每个价签。商品文件读不到的、尺寸不对的跳过（where 是报错的前缀，规则本身不对时报错）。 */
export function planShelf(file: ShelfFile, products: ReadonlyMap<string, ProductFile>, where = file.name): { readonly items: ShelfItem[]; readonly tags: ShelfTag[] } {
  checkShelf(file, where);
  const items: ShelfItem[] = [], tags: ShelfTag[] = [];
  const stock = file.stock;
  if (!stock || stock.products.length === 0) return { items, tags };
  const candidates = stock.products.flatMap((path) => {
    const product = products.get(path);
    return product && product.size[0] > 0 && product.size[1] > 0 ? [{ path, product, footprint: productFootprint(product) }] : [];
  });
  const variants = Math.max(1, Math.round(stock.variants ?? 3));
  const [minFacings, maxFacings] = stock.facings ?? [2, 5];
  const maxRows = Math.max(1, Math.round(stock.rows ?? 4));
  const gaps = Math.min(1, Math.max(0, stock.gaps ?? 0.05));
  const sides: readonly (1 | -1)[] = file.sides === 2 ? [1, -1] : [1];
  const back = file.sides === 2 ? SPINE : 0;
  const xMin = -file.length / 2 + 0.03, xMax = file.length / 2 - 0.03;
  sides.forEach((side, sideIndex) => {
    file.levels.forEach((level, levelIndex) => {
      const above = file.levels[levelIndex + 1];
      const clearance = (above === undefined ? file.height : above - BOARD) - level - 0.015;
      const fits = candidates.filter((c) => c.footprint[1] <= clearance && c.footprint[2] <= file.depth);
      if (fits.length === 0) return;
      const random = seededRandom(hash32(hash32(file.seed ?? 1, sideIndex), levelIndex));
      let x = xMin;
      for (let groups = 0; groups < 1000; groups++) {
        const choice = fits[Math.floor(random() * fits.length)]!;
        const variant = Math.floor(random() * variants);
        const [w, , d] = choice.footprint;
        const room = Math.floor((xMax - x + GAP) / (w + GAP));
        if (room < 1) break;
        const facings = Math.min(room, minFacings + Math.floor(random() * (Math.max(minFacings, maxFacings) - minFacings + 1)));
        const rows = Math.max(1, Math.min(maxRows, Math.floor((file.depth - 0.02 + GAP) / (d + GAP))));
        tags.push({ position: [x + Math.min(TAG[0], w) / 2 + 0.005, level - STRIP[0] / 2, side * (back + file.depth + STRIP[1] + 0.001)], side, price: Math.floor(random() * PRICES) });
        for (let f = 0; f < facings; f++) {
          // 卖掉了的：这一列的前几排空着
          const missing = random() < gaps ? 1 + Math.floor(random() * rows) : 0;
          for (let r = missing; r < rows; r++) {
            const z = back + file.depth - 0.01 - d / 2 - r * (d + GAP);
            items.push({ product: choice.path, variant, position: [x + f * (w + GAP) + w / 2, level, side * z], yaw: side > 0 ? 0 : Math.PI, front: r === missing });
          }
        }
        x += facings * (w + GAP);
      }
    });
  });
  return { items, tags };
}

function checkShelf(file: ShelfFile, where: string): void {
  if (!(file.length > 0 && file.height > 0 && file.depth > 0)) throw new Error(`${where}: length, height and depth must be greater than 0`);
  if (file.levels.length === 0) throw new Error(`${where}: needs at least one level (the base)`);
  for (let i = 1; i < file.levels.length; i++) {
    if (!(file.levels[i]! > file.levels[i - 1]!)) throw new Error(`${where}: levels must go up (level ${i} is not above level ${i - 1})`);
  }
  if (file.levels.at(-1)! >= file.height) throw new Error(`${where}: the top level must be below the height`);
}

/** 图集里的一格（像素）。 */
type Cell = readonly [x: number, y: number, w: number, h: number];

/** 生成货架的网格和图集。 */
export function shelfModel(file: ShelfFile, sources: ShelfSources, where = file.name): ShelfModel {
  const { items, tags } = planShelf(file, sources.products, where);
  // 图集的格子：纯色的三格、价签、每个用到的商品变体
  const variantKeys = [...new Set(items.map((item) => `${item.variant}|${item.product}`))];
  const meshes = new Map<string, ProductMesh>();
  const meshOf = (path: string, front: boolean) => {
    const key = `${front ? 'f' : 'b'}|${path}`;
    let mesh = meshes.get(key);
    if (!mesh) meshes.set(key, mesh = productMesh(sources.products.get(path)!, `${where}: ${path}`, front ? undefined : BACK_SEGMENTS));
    return mesh;
  };
  const labelSizes = variantKeys.map((key) => meshOf(key.slice(key.indexOf('|') + 1), true).labelSize);
  const tagSize = [TAG[0] * 1000, TAG[1] * 1000] as const;
  const solid = 8;
  const cells = packAtlas([...labelSizes, ...Array.from({ length: PRICES }, () => tagSize)], 3 * solid);
  const solids = [0, 1, 2].map((i): Cell => [ATLAS - (i + 1) * (solid + PADDING * 2) + PADDING, ATLAS - solid - PADDING, solid, solid]);
  const [frameCell, stripCell, baseCell] = solids as [Cell, Cell, Cell];
  const labelCells = cells.slice(0, variantKeys.length), tagCells = cells.slice(variantKeys.length);

  // 网格
  const vertices: number[] = [], indices: number[] = [];
  const center = ([x, y, w, h]: Cell) => [(x + w / 2) / ATLAS, (y + h / 2) / ATLAS] as const;
  const box = (min: readonly number[], max: readonly number[], cell: Cell) => {
    const [u, v] = center(cell);
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
          vertices.push(p[0]!, p[1]!, p[2]!, normal[0]!, normal[1]!, normal[2]!, u, v);
        }
        // a、b、axis 是右手系的顺序：(0,0)→(1,0)→(1,1) 绕着 +axis 逆时针，负的那面反过来
        if (sign > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
    }
  };
  const L = file.length / 2, H = file.height;
  const sides: readonly (1 | -1)[] = file.sides === 2 ? [1, -1] : [1];
  const back = file.sides === 2 ? SPINE : 0;
  // 背板、两头的侧板
  box([-L, 0, -SPINE], [L, H, file.sides === 2 ? SPINE : 0], frameCell);
  const zFar = back + file.depth;
  for (const x of [-L, L - SPINE]) box([x, 0, file.sides === 2 ? -zFar : -SPINE], [x + SPINE, H, zFar], frameCell);
  for (const side of sides) {
    const z0 = side * back, z1 = side * zFar;
    const zs = [Math.min(z0, z1), Math.max(z0, z1)] as const;
    // 底座（第一层的下面是实心的踢脚板）和每一层的层板
    box([-L + SPINE, 0, zs[0]], [L - SPINE, file.levels[0]!, zs[1]], baseCell);
    for (const level of file.levels.slice(1)) box([-L + SPINE, level - BOARD, zs[0]], [L - SPINE, level, zs[1]], frameCell);
    // 价签条：层板前沿往下
    for (const level of file.levels) {
      const s0 = side * zFar, s1 = side * (zFar + STRIP[1]);
      box([-L + SPINE, level - STRIP[0], Math.min(s0, s1)], [L - SPINE, level, Math.max(s0, s1)], stripCell);
    }
  }
  // 价签：价签条正面上的一小片
  for (const tag of tags) {
    const [x, y, z] = tag.position, [tw, th] = TAG, [cx, cy, cw, ch] = tagCells[tag.price]!;
    const base = vertices.length / 8, normal = [0, 0, tag.side];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    for (const [sx, sy] of corners) {
      // 从正面看左下、右下、右上、左上：背面那一面的 x 反过来
      vertices.push(x + sx * tw / 2 * tag.side, y + sy * th / 2, z, ...normal, (cx + (sx + 1) / 2 * cw) / ATLAS, (cy + (1 - sy) / 2 * ch) / ATLAS);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // 商品
  const cellOf = new Map(variantKeys.map((key, i) => [key, labelCells[i]!]));
  for (const item of items) {
    const mesh = meshOf(item.product, item.front);
    const [cx, cy, cw, ch] = cellOf.get(`${item.variant}|${item.product}`)!;
    const cos = Math.cos(item.yaw), sin = Math.sin(item.yaw);
    const base = vertices.length / 8, src = mesh.vertices;
    for (let i = 0; i < src.length; i += 8) {
      const px = src[i]!, pz = src[i + 2]!, nx = src[i + 3]!, nz = src[i + 5]!;
      vertices.push(
        item.position[0] + px * cos + pz * sin, item.position[1] + src[i + 1]!, item.position[2] - px * sin + pz * cos,
        nx * cos + nz * sin, src[i + 4]!, -nx * sin + nz * cos,
        (cx + src[i + 6]! * cw) / ATLAS, (cy + src[i + 7]! * ch) / ATLAS,
      );
    }
    for (const index of mesh.indices) indices.push(base + index);
  }

  // 图集：颜色和表面（G 是粗糙度、B 是金属度）
  const color: string[] = [], surface: string[] = [];
  const surfaceFill = (roughness: number, metalness: number) => `rgb(0,${Math.round(roughness * 255)},${Math.round(metalness * 255)})`;
  const fill = (cell: Cell, colorFill: string, surfaceValue: string) => {
    const [x, y, w, h] = cell;
    color.push(`<rect x="${x - PADDING}" y="${y - PADDING}" width="${w + 2 * PADDING}" height="${h + 2 * PADDING}" fill="${colorFill}"/>`);
    surface.push(`<rect x="${x - PADDING}" y="${y - PADDING}" width="${w + 2 * PADDING}" height="${h + 2 * PADDING}" fill="${surfaceValue}"/>`);
  };
  fill(frameCell, file.frameColor ?? '#d9dadc', surfaceFill(0.45, 0.5));
  fill(stripCell, file.stripColor ?? '#f4f4f2', surfaceFill(0.35, 0));
  fill(baseCell, '#3a3b3d', surfaceFill(0.5, 0.3));
  variantKeys.forEach((key, i) => {
    const variant = Number(key.slice(0, key.indexOf('|'))), path = key.slice(key.indexOf('|') + 1);
    const product = sources.products.get(path)!, design = productDesign(product, variant), cell = labelCells[i]!;
    const [W, H2] = labelSizes[i]!;
    // 先铺一圈底色（留边：缩小的时候不混进别的格子），再把标签按格子缩放进去
    fill(cell, design.colors.background, surfaceFill(SURFACE_MATERIAL[design.surface].roughness, SURFACE_MATERIAL[design.surface].metalness));
    const font = product.font ? sources.font(product.font) : undefined;
    color.push(`<svg x="${cell[0]}" y="${cell[1]}" width="${cell[2]}" height="${cell[3]}" viewBox="0 0 ${n(W)} ${n(H2)}" preserveAspectRatio="none">${productLabelShapes(product, [W, H2], font, variant)}</svg>`);
  });
  const tagFont = file.font ? sources.font(file.font) : undefined;
  const prices = Array.from({ length: PRICES }, (_, k) => {
    const random = seededRandom(hash32(file.seed ?? 1, 1000 + k));
    return `${Math.floor(1 + random() * 39)}.${['90', '80', '50', '00', '99'][Math.floor(random() * 5)]}`;
  });
  tagCells.forEach((cell, k) => {
    fill(cell, k % 3 === 0 ? '#f6d21a' : '#ffffff', surfaceFill(0.4, 0));
    if (!tagFont) return;
    const [x, y, w, h] = cell;
    const price = textPath(tagFont, prices[k]!, x + w * 0.55, y + h * 0.55, w * 0.78, h * 0.62, '#d7262b');
    if (price) color.push(price);
  });
  const svg = (shapes: string[]) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ATLAS} ${ATLAS}" width="${ATLAS}" height="${ATLAS}">${shapes.join('')}</svg>`;
  return { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices), colorSvg: svg(color), surfaceSvg: svg(surface), atlasPixels: ATLAS, items: items.length };
}

/**
 * 把标签（毫米）缩放、装进图集（右下角留 reserve 像素给纯色格）：找一个最大的缩放，让全部装得下。返回每一格（像素）。
 */
function packAtlas(sizes: readonly (readonly [number, number])[], reserve: number): Cell[] {
  if (sizes.length === 0) return [];
  let low = 0, high = 10;
  let best: Cell[] | undefined;
  for (let step = 0; step < 24; step++) {
    const scale = (low + high) / 2;
    const scaled = sizes.map(([w, h]) => [Math.max(4, Math.floor(w * scale)), Math.max(4, Math.floor(h * scale))] as const);
    // 最下面一行留给纯色格
    const placed = packPages(scaled, ATLAS - reserve, PADDING);
    if (placed.every((at) => at !== undefined && at[0] === 0)) {
      best = placed.map((at) => [at![1], at![2], at![3], at![4]] as const);
      low = scale;
    } else high = scale;
  }
  if (!best) throw new Error(`too many labels for one ${ATLAS}px atlas`);
  return best;
}

/** 货架的材质：颜色图集、表面图集（G 粗糙度、B 金属度）。path 是货架的内容路径（图集是 `<path>.svg`、`<path>.surface.svg`）。 */
export function shelfMaterial(file: ShelfFile, path: string, pixels: number): MaterialFile {
  const slot = { encoding: 'svg' as const, size: [pixels, pixels] as const, filter: 'anisotropic' as const, scale: [1, 1] as const, offset: [0, 0] as const };
  return {
    name: file.name,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: { texture: path, srgb: true, ...slot },
    metalness: 1,
    glossinessTexture: { texture: `${path}.surface`, srgb: false, channel: 'g', invert: true, metalnessChannel: 'b', ...slot },
  };
}
