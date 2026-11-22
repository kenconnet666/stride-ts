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
import { productFootprint, textPath } from './product.ts';
import { mergedMaterial, ProductBatch, type MergedProducts, type ProductSources } from './productBatch.ts';

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

/** 生成的货架：网格（一个材质槽）、图集的两张 SVG（颜色、表面）和栅格化的边长，摆了几件商品。 */
export interface ShelfModel extends MergedProducts {
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
/** 价签有几种价格。 */
const PRICES = 8;

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

/** 架子、价签条、底座的纯色（ProductBatch 的 solids 的下标）。 */
const FRAME = 0, STRIP_SOLID = 1, BASE = 2;

/** 生成货架的网格和图集。 */
export function shelfModel(file: ShelfFile, sources: ProductSources, where = file.name): ShelfModel {
  const { items, tags } = planShelf(file, sources.products, where);
  const tagFont = file.font ? sources.font(file.font) : undefined;
  const prices = Array.from({ length: PRICES }, (_, k) => {
    const random = seededRandom(hash32(file.seed ?? 1, 1000 + k));
    return `${Math.floor(1 + random() * 39)}.${['90', '80', '50', '00', '99'][Math.floor(random() * 5)]}`;
  });
  const batch = new ProductBatch(sources, where, items.map((item) => ({
    product: item.product, variant: item.variant, position: item.position, rotation: [0, Math.sin(item.yaw / 2), 0, Math.cos(item.yaw / 2)], fine: item.front,
  })), {
    solids: [
      { color: file.frameColor ?? '#d9dadc', roughness: 0.45, metalness: 0.5 },
      { color: file.stripColor ?? '#f4f4f2', roughness: 0.35, metalness: 0 },
      { color: '#3a3b3d', roughness: 0.5, metalness: 0.3 },
    ],
    // 价签：几种价格，三个里一个黄底
    cells: prices.map((price, k) => ({
      size: [TAG[0] * 1000, TAG[1] * 1000] as const, color: k % 3 === 0 ? '#f6d21a' : '#ffffff', roughness: 0.4, metalness: 0,
      draw: ([x, y, w, h]) => tagFont && textPath(tagFont, price, x + w * 0.55, y + h * 0.55, w * 0.78, h * 0.62, '#d7262b'),
    })),
  });
  const L = file.length / 2, H = file.height;
  const sides: readonly (1 | -1)[] = file.sides === 2 ? [1, -1] : [1];
  const back = file.sides === 2 ? SPINE : 0;
  // 背板、两头的侧板
  batch.box([-L, 0, -SPINE], [L, H, file.sides === 2 ? SPINE : 0], FRAME);
  const zFar = back + file.depth;
  for (const x of [-L, L - SPINE]) batch.box([x, 0, file.sides === 2 ? -zFar : -SPINE], [x + SPINE, H, zFar], FRAME);
  for (const side of sides) {
    const z0 = side * back, z1 = side * zFar;
    const zs = [Math.min(z0, z1), Math.max(z0, z1)] as const;
    // 底座（第一层的下面是实心的踢脚板）和每一层的层板
    batch.box([-L + SPINE, 0, zs[0]], [L - SPINE, file.levels[0]!, zs[1]], BASE);
    for (const level of file.levels.slice(1)) batch.box([-L + SPINE, level - BOARD, zs[0]], [L - SPINE, level, zs[1]], FRAME);
    // 价签条：层板前沿往下
    for (const level of file.levels) {
      const s0 = side * zFar, s1 = side * (zFar + STRIP[1]);
      batch.box([-L + SPINE, level - STRIP[0], Math.min(s0, s1)], [L - SPINE, level, Math.max(s0, s1)], STRIP_SOLID);
    }
  }
  // 价签：价签条正面上的一小片（从正面看左下、右下、右上、左上：背面那一面的 x 反过来）
  for (const tag of tags) {
    const [x, y, z] = tag.position, [tw, th] = TAG;
    const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => [x + sx * tw / 2 * tag.side, y + sy * th / 2, z]);
    batch.quad(corners, [0, 0, tag.side], tag.price);
  }
  return { ...batch.finish(), items: items.length };
}

/** 货架的材质：颜色图集、表面图集（G 粗糙度、B 金属度）。path 是货架的内容路径（图集是 `<path>.svg`、`<path>.surface.svg`）。 */
export function shelfMaterial(file: ShelfFile, path: string, pixels: number): MaterialFile {
  return mergedMaterial(file.name, path, pixels);
}
