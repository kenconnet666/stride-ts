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
import type { ProductFile } from '../content/formats/productFormat.ts';
import type { ShelfFile } from '../content/formats/shelfFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { productFootprint, svgNumber, textPath } from './product.ts';
import type { TextFont } from './textOutline.ts';
import { ProductBatch, type AtlasCell, type Cell, type MergedProducts, type ProductSources } from './productBatch.ts';

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

/** 挂钩架的一个挂钩：x、钩子的高、朝哪面。 */
export interface ShelfHook {
  readonly x: number;
  readonly y: number;
  readonly side: 1 | -1;
}

/** 挂钩架：商品挂在钩子下面多远（米）；洞洞板以上第一排挂钩下面留多少。 */
const HOOK_DROP = 0.015, HOOK_BOTTOM = 0.12;

/**
 * 按规则摆货：每件商品、每个价签（挂钩架还有每个挂钩）。商品文件读不到的、尺寸不对的跳过（where 是报错的前缀，规则本身不对时
 * 报错）。挂钩架的商品挂在钩子下面、一个排面一个钩子、往钩里串几个；堆头见 planStack。
 */
export function planShelf(file: ShelfFile, products: ReadonlyMap<string, ProductFile>, where = file.name): { readonly items: ShelfItem[]; readonly tags: ShelfTag[]; readonly hooks: ShelfHook[] } {
  checkShelf(file, where);
  if (file.type === 'stack') return { ...planStack(file, products), hooks: [] };
  const items: ShelfItem[] = [], tags: ShelfTag[] = [], hooks: ShelfHook[] = [];
  const pegboard = file.type === 'pegboard';
  const stock = file.stock;
  if (!stock || stock.products.length === 0) return { items, tags, hooks };
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
      const above = file.levels[levelIndex + 1], below = file.levels[levelIndex - 1];
      // 挂钩架的东西挂在钩子下面，空间到下面那排钩子为止
      const clearance = pegboard ? level - HOOK_DROP - (below ?? HOOK_BOTTOM) - 0.02 : (above === undefined ? file.height : above - BOARD) - level - 0.015;
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
        // 价签：货架的在价签条上，挂钩架的挂在第一个钩子的钩尖上
        tags.push(pegboard
          ? { position: [x + w / 2, level + 0.02, side * (back + file.depth + 0.003)], side, price: Math.floor(random() * PRICES) }
          : { position: [x + Math.min(TAG[0], w) / 2 + 0.005, level - STRIP[0] / 2, side * (back + file.depth + STRIP[1] + 0.001)], side, price: Math.floor(random() * PRICES) });
        const y = pegboard ? level - HOOK_DROP - choice.footprint[1] : level;
        for (let f = 0; f < facings; f++) {
          if (pegboard) hooks.push({ x: x + f * (w + GAP) + w / 2, y: level, side });
          // 卖掉了的：这一列的前几排空着
          const missing = random() < gaps ? 1 + Math.floor(random() * rows) : 0;
          for (let r = missing; r < rows; r++) {
            const z = back + file.depth - 0.01 - d / 2 - r * (d + GAP);
            items.push({ product: choice.path, variant, position: [x + f * (w + GAP) + w / 2, y, side * z], yaw: side > 0 ? 0 : Math.PI, front: r === missing });
          }
        }
        x += facings * (w + GAP);
      }
    });
  });
  return { items, tags, hooks };
}

/**
 * 堆头：台子上按块码垛——从左到右一块一种商品（几列、按种子挑），每块从下往上一层层码，每往上一层四周各收进去半件，码到
 * height 为止；台子中心是原点。最上面一层和朝外的那一圈是细的。
 */
function planStack(file: ShelfFile, products: ReadonlyMap<string, ProductFile>): { items: ShelfItem[]; tags: ShelfTag[] } {
  const items: ShelfItem[] = [], tags: ShelfTag[] = [];
  const stock = file.stock;
  if (!stock || stock.products.length === 0) return { items, tags };
  const candidates = stock.products.flatMap((path) => {
    const product = products.get(path);
    return product && product.size[0] > 0 && product.size[1] > 0 ? [{ path, footprint: productFootprint(product) }] : [];
  });
  if (candidates.length === 0) return { items, tags };
  const random = seededRandom(hash32(file.seed ?? 1, 3));
  const variants = Math.max(1, Math.round(stock.variants ?? 3));
  const [minFacings, maxFacings] = stock.facings ?? [3, 6];
  const base = file.levels[0]!, xMax = file.length / 2 - 0.02;
  let x = -xMax;
  for (let blocks = 0; blocks < 200; blocks++) {
    const choice = candidates[Math.floor(random() * candidates.length)]!, variant = Math.floor(random() * variants);
    const [w, h, d] = choice.footprint;
    const room = Math.floor((xMax - x + GAP) / (w + GAP));
    if (room < 1) break;
    const columns = Math.min(room, minFacings + Math.floor(random() * (Math.max(minFacings, maxFacings) - minFacings + 1)));
    const rows = Math.max(1, Math.floor((file.depth + GAP) / (d + GAP)));
    const layers = Math.max(1, Math.floor((file.height - base) / (h + 0.002)));
    for (let k = 0; k < layers; k++) {
      // 每往上一层四周收进去半件
      const c = columns - k, r = rows - k;
      if (c < 1 || r < 1) break;
      for (let i = 0; i < c; i++) {
        for (let j = 0; j < r; j++) {
          const px = x + (k / 2 + i) * (w + GAP) + w / 2, pz = -file.depth / 2 + (k / 2 + j) * (d + GAP) + d / 2;
          const outside = i === 0 || j === 0 || i === c - 1 || j === r - 1;
          items.push({ product: choice.path, variant, position: [px, base + k * (h + 0.002), pz], yaw: 0, front: outside || k === layers - 1 });
        }
      }
    }
    // 价签插在台子正面
    tags.push({ position: [x + (columns * (w + GAP)) / 2, base / 2, file.depth / 2 + 0.032], side: 1, price: Math.floor(random() * PRICES) });
    x += columns * (w + GAP) + 0.02;
  }
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

/** 纯色（ProductBatch 的 solids 的下标）：架子、价签条、底座、冷柜的门框、灯带、冷柜里面的白、电子价签的外壳，熟食柜的黑柜体、白石英、金、保温灯的暖光。 */
const FRAME = 0, STRIP_SOLID = 1, BASE = 2, DARK = 3, LIGHT = 4, INTERIOR = 5, TAG_BODY = 6, COUNTER = 7, QUARTZ = 8, GOLD = 9, WARM = 10;
/** 电子价签：外壳比屏大一圈（米）、凸出价签条多厚。 */
const ESL_RIM = 0.004, ESL_DEPTH = 0.009;
/** 冷柜：门在层板前面多远、门框多宽；顶上灯箱的高；冰柜的壁厚。 */
const DOOR = 0.05, MULLION = 0.04, HEADER = 0.24, FREEZER_WALL = 0.06;
/** 熟食柜：前面白台面、后面白挡边的宽，托盘比台面低多少；保温灯罩的半径、高，吊杆多长。 */
const DELI_FRONT = 0.2, DELI_BACK = 0.08, DELI_SINK = 0.025, LAMP_RADIUS = 0.11, LAMP_HEIGHT = 0.14, LAMP_ROD = 0.6;

/** 熟食柜的托盘（摆碗盘的那块）：前后的 z（原点在柜子中心）。 */
function deliTray(file: ShelfFile): readonly [number, number] {
  return [-file.depth / 2 + DELI_BACK, file.depth / 2 - DELI_FRONT];
}

/**
 * 熟食柜上方每盏保温灯灯罩底面的中心（米，货架的坐标）：灯具只发光，照亮菜的光源由场景另放（同天花板的 ceilingLights），
 * 搭场景时放在这些位置往下照。
 */
export function deliLamps(file: ShelfFile): (readonly [number, number, number])[] {
  const bay = file.bay ?? 0.6, count = Math.max(1, Math.round(file.length / bay));
  const [zBack, zFront] = deliTray(file);
  return Array.from({ length: count }, (_, i) => [-file.length / 2 + (i + 0.5) * (file.length / count), file.height, (zBack + zFront) / 2] as const);
}

/** 生成货架（冷柜、冰柜）的网格和图集。 */
export function shelfModel(file: ShelfFile, sources: ProductSources, where = file.name): ShelfModel {
  const type = file.type ?? 'gondola';
  // 冰柜的货躺在槽里：按一个单面、一层、槽那么深的货架摆，再挪到槽的中间
  const inner = file.depth - 2 * FREEZER_WALL;
  // 熟食柜的碗盘摆在托盘上：按一个单面、一层、托盘那么深的货架摆，再挪到托盘那里（碗盘之间留宽一点）
  const [trayBack, trayFront] = deliTray(file);
  const plan = type === 'freezer'
    ? planShelf({ ...file, sides: 1, length: file.length - 2 * FREEZER_WALL, depth: inner, levels: [file.levels[0]!] }, sources.products, where)
    : type === 'deli'
      ? planShelf({ ...file, type: 'gondola', sides: 1, length: file.length - 0.04, depth: trayFront - trayBack, levels: [file.levels[0]!] }, sources.products, where)
      : planShelf(type === 'fridge' ? { ...file, sides: 1 } : file, sources.products, where);
  const items = type === 'freezer' ? plan.items.map((item) => ({ ...item, position: [item.position[0], item.position[1], item.position[2] - inner / 2] as const }))
    : type === 'deli' ? plan.items.map((item) => ({ ...item, position: [item.position[0], item.position[1], item.position[2] + trayBack] as const }))
    : plan.items;
  const tags = type === 'freezer' || type === 'deli' ? [] : plan.tags;
  const tagFont = file.font ? sources.font(file.font) : undefined;
  const electronic = file.priceTags === 'electronic';
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
      { color: '#2a2c2f', roughness: 0.35, metalness: 0.6 },
      { color: '#eef4ff', roughness: 0.5, metalness: 0, emissive: 6 },
      { color: '#eef1f3', roughness: 0.4, metalness: 0 },
      { color: '#f0f0ee', roughness: 0.45, metalness: 0 },
      { color: '#141518', roughness: 0.35, metalness: 0 },
      { color: '#e9e8e3', roughness: 0.12, metalness: 0 },
      { color: '#c9a250', roughness: 0.28, metalness: 0.9 },
      { color: '#ffd9a0', roughness: 0.5, metalness: 0, emissive: 8 },
    ],
    // 价签：几种价格；纸的三个里一个黄底，电子的是墨水屏
    cells: prices.map((price, k): AtlasCell => (electronic ? eslCell(price, k, tagFont, hash32(file.seed ?? 1, 2000 + k)) : {
      size: [TAG[0] * 1000, TAG[1] * 1000] as const, color: k % 3 === 0 ? '#f6d21a' : '#ffffff', roughness: 0.4, metalness: 0,
      draw: ([x, y, w, h]) => tagFont && textPath(tagFont, price, x + w * 0.55, y + h * 0.55, w * 0.78, h * 0.62, '#d7262b'),
    })).concat(type === 'fridge' ? [{
      // 冷柜顶上的灯箱：蓝底白字，整块发光
      size: [file.length * 1000, (HEADER - 0.04) * 1000] as const, color: '#1e64c8', roughness: 0.3, metalness: 0, emissive: 2,
      draw: ([x, y, w, h]: Cell) => (file.header && tagFont ? textPath(tagFont, file.header, x + w / 2, y + h / 2, w * 0.6, h * 0.62, '#ffffff') : undefined),
    }] : []),
  });
  if (type === 'freezer') {
    freezerBody(batch, file);
    return { ...batch.finish(), items: items.length };
  }
  if (type === 'deli') {
    deliBody(batch, file);
    return { ...batch.finish(), items: items.length };
  }
  if (type === 'stack') {
    // 台子（比垛四周大出一点）和插在正面的价签
    const L = file.length / 2, D = file.depth / 2 + 0.03;
    batch.box([-L, 0, -D], [L, file.levels[0]!, D], BASE);
    for (const tag of tags) addTag(batch, tag, electronic);
    return { ...batch.finish(), items: items.length };
  }
  if (type === 'pegboard') {
    pegboardBody(batch, file, plan.hooks);
    for (const tag of tags) addTag(batch, tag, electronic);
    return { ...batch.finish(), items: items.length };
  }
  const L = file.length / 2, H = file.height;
  const sides: readonly (1 | -1)[] = file.sides === 2 && type === 'gondola' ? [1, -1] : [1];
  const back = file.sides === 2 && type === 'gondola' ? SPINE : 0;
  // 背板、两头的侧板（冷柜里面是白的，侧板一直到门）
  batch.box([-L, 0, -SPINE], [L, H, file.sides === 2 && type === 'gondola' ? SPINE : 0], type === 'fridge' ? INTERIOR : FRAME);
  const zFar = back + file.depth;
  const zEnd = type === 'fridge' ? zFar + DOOR + 0.01 : zFar;
  for (const x of [-L, L - SPINE]) batch.box([x, 0, file.sides === 2 && type === 'gondola' ? -zFar : -SPINE], [x + SPINE, H, zEnd], FRAME);
  if (type === 'fridge') fridgeFront(batch, file, zFar, PRICES);
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
  for (const tag of tags) addTag(batch, tag, electronic);
  return { ...batch.finish(), items: items.length };
}

/** 一个价签：纸的是贴在价签条上的一片；电子的是凸出来的外壳加正面的屏。 */
function addTag(batch: ProductBatch, tag: ShelfTag, electronic: boolean): void {
  const [x, y, z0] = tag.position, [tw, th] = TAG;
  const z = electronic ? z0 + tag.side * ESL_DEPTH : z0;
  if (electronic) {
    const zs = [z0 - tag.side * 0.001, z - tag.side * 0.0005].sort((a, b) => a - b) as [number, number];
    batch.box([x - tw / 2 - ESL_RIM, y - th / 2 - ESL_RIM, zs[0]], [x + tw / 2 + ESL_RIM, y + th / 2 + ESL_RIM, zs[1]], TAG_BODY);
  }
  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => [x + sx * tw / 2 * tag.side, y + sy * th / 2, z]);
  batch.quad(corners, [0, 0, tag.side], tag.price);
}

/** 挂钩架：洞洞板（背板，双面时两面都有）、底座、两头的侧板，每个挂钩一根细的金属杆。 */
function pegboardBody(batch: ProductBatch, file: ShelfFile, hooks: readonly ShelfHook[]): void {
  const L = file.length / 2, H = file.height, double = file.sides === 2, back = double ? SPINE : 0;
  batch.box([-L, 0, -SPINE], [L, H, double ? SPINE : 0], FRAME);
  for (const x of [-L, L - SPINE]) batch.box([x, 0, double ? -back - 0.15 : -SPINE], [x + SPINE, H, back + 0.15], FRAME);
  batch.box([-L, 0, double ? -back - 0.15 : 0], [L, HOOK_BOTTOM - 0.02, back + 0.15], BASE);
  for (const hook of hooks) {
    const z0 = hook.side * back, z1 = hook.side * (back + file.depth);
    batch.box([hook.x - 0.002, hook.y - 0.002, Math.min(z0, z1)], [hook.x + 0.002, hook.y + 0.002, Math.max(z0, z1)], DARK);
  }
}

/**
 * 电子价签的屏（墨水屏：浅灰底、黑色的大数字、右边一个二维码样子的方块；三个里一个底下有红色的促销条）。seed 定二维码的花样。
 */
function eslCell(price: string, k: number, font: TextFont | undefined, seed: number): AtlasCell {
  return {
    size: [TAG[0] * 1000, TAG[1] * 1000], color: '#d8dbd4', roughness: 0.5, metalness: 0,
    draw: ([x, y, w, h]: Cell) => {
      const shapes: string[] = [];
      const promo = k % 3 === 0;
      if (promo) shapes.push(`<rect x="${x}" y="${svgNumber(y + h * 0.78)}" width="${w}" height="${svgNumber(h * 0.22)}" fill="#c8261e"/>`);
      const digits = font && textPath(font, price, x + w * 0.36, y + h * (promo ? 0.4 : 0.5), w * 0.58, h * 0.5, '#151515');
      if (digits) shapes.push(digits);
      // 二维码样子的 7×7 格子
      const random = seededRandom(seed), size = h * 0.42, cell = size / 7, qx = x + w * 0.74, qy = y + h * 0.12;
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 7; j++) {
          const finder = (i < 2 && j < 2) || (i < 2 && j > 4) || (i > 4 && j < 2);
          if (finder || random() < 0.45) shapes.push(`<rect x="${svgNumber(qx + i * cell)}" y="${svgNumber(qy + j * cell)}" width="${svgNumber(cell)}" height="${svgNumber(cell)}" fill="#151515"/>`);
        }
      }
      return shapes.join('');
    },
  };
}

/**
 * 冷柜的前面：每一扇门的玻璃、门之间的门框（深色）和门框里侧竖着的灯带，顶盖和顶上的灯箱（图集里 PRICES 之后那一格）。
 * zFar 是层板前沿。
 */
function fridgeFront(batch: ProductBatch, file: ShelfFile, zFar: number, headerCell: number): void {
  const L = file.length / 2, H = file.height, bottom = file.levels[0]!;
  const doors = Math.max(1, Math.round(file.length / (file.bay ?? 0.75)));
  const z0 = zFar + DOOR - 0.01, z1 = zFar + DOOR + 0.01;
  for (let k = 0; k <= doors; k++) {
    const x = -L + (file.length * k) / doors;
    batch.box([x - MULLION / 2, bottom, z0 - 0.01], [x + MULLION / 2, H, z1], DARK);
    // 灯带贴在门框里侧（最两头的只有一边）
    if (k > 0) batch.box([x - MULLION / 2 - 0.012, bottom + 0.03, z0 - 0.03], [x - MULLION / 2, H - 0.03, z0 - 0.01], LIGHT);
    if (k < doors) batch.box([x + MULLION / 2, bottom + 0.03, z0 - 0.03], [x + MULLION / 2 + 0.012, H - 0.03, z0 - 0.01], LIGHT);
    if (k < doors) batch.glassBox([x + MULLION / 2, bottom, z0], [-L + (file.length * (k + 1)) / doors - MULLION / 2, H, z0 + 0.008]);
  }
  // 门的上下框、顶盖、灯箱
  batch.box([-L, bottom - 0.03, z0 - 0.01], [L, bottom, z1], DARK);
  batch.box([-L, H - 0.03, z0 - 0.01], [L, H, z1], DARK);
  batch.box([-L, H, -SPINE], [L, H + 0.04, z1], FRAME);
  batch.box([-L, H + 0.04, z1 - 0.2], [L, H + HEADER, z1], FRAME);
  const z = z1 + 0.001, y0 = H + 0.06, y1 = H + HEADER - 0.02;
  batch.quad([[-L, y0, z], [L, y0, z], [L, y1, z], [-L, y1, z]], [0, 0, 1], headerCell);
}

/** 卧式冰柜：四壁和槽底（槽里白的），柜沿深色，沿下一圈灯带，上面两块错开的玻璃推拉盖。 */
/**
 * 熟食柜：黑柜体到台面下，前面白石英台面（比托盘高一点、前沿出挑），后面一道白挡边，中间托盘下沉 DELI_SINK、黑色，托盘前沿
 * 一道金边；上方每盏保温灯是一根细吊杆、一个上小下大的金色灯罩、罩底一片发光的暖光。
 */
function deliBody(batch: ProductBatch, file: ShelfFile): void {
  const L = file.length / 2, D = file.depth / 2, tray = file.levels[0]!, top = tray + DELI_SINK;
  const [zBack, zFront] = deliTray(file);
  batch.box([-L, 0, -D], [L, tray, D - 0.03], COUNTER);
  batch.box([-L, top - 0.04, zFront], [L, top, D], QUARTZ);
  batch.box([-L, tray, -D], [L, top + 0.03, zBack], QUARTZ);
  batch.box([-L, tray - 0.02, zBack], [L, tray, zFront], COUNTER);
  batch.box([-L, tray, zFront - 0.006], [L, top, zFront], GOLD);
  for (const [x, y, z] of deliLamps(file)) {
    batch.tube([x, y + LAMP_HEIGHT, z], [x, y + LAMP_HEIGHT + LAMP_ROD, z], 0.006, GOLD, 6);
    // 灯罩是上小下大的圆台（钟形）
    batch.tube([x, y, z], [x, y + LAMP_HEIGHT, z], LAMP_RADIUS, GOLD, 20, LAMP_RADIUS * 0.35);
    batch.box([x - LAMP_RADIUS * 0.6, y + 0.02, z - LAMP_RADIUS * 0.6], [x + LAMP_RADIUS * 0.6, y + 0.03, z + LAMP_RADIUS * 0.6], WARM);
  }
}

function freezerBody(batch: ProductBatch, file: ShelfFile): void {
  const L = file.length / 2, W = file.depth / 2, H = file.height, t = FREEZER_WALL, floor = file.levels[0]!;
  batch.box([-L, 0, -W], [L, H, -W + t], FRAME);
  batch.box([-L, 0, W - t], [L, H, W], FRAME);
  batch.box([-L, 0, -W + t], [-L + t, H, W - t], FRAME);
  batch.box([L - t, 0, -W + t], [L, H, W - t], FRAME);
  batch.box([-L + t, 0, -W + t], [L - t, floor, W - t], INTERIOR);
  // 柜沿、沿下的灯带
  batch.box([-L, H, -W], [L, H + 0.015, -W + t], DARK);
  batch.box([-L, H, W - t], [L, H + 0.015, W], DARK);
  batch.box([-L, H, -W + t], [-L + t, H + 0.015, W - t], DARK);
  batch.box([L - t, H, -W + t], [L, H + 0.015, W - t], DARK);
  batch.box([-L + t, H - 0.04, -W + t], [L - t, H - 0.025, -W + t + 0.012], LIGHT);
  // 两块推拉盖，一高一低、在中间叠一点
  batch.glassBox([-L + t, H + 0.016, -W + t], [0.05, H + 0.022, W - t]);
  batch.glassBox([-0.05, H + 0.024, -W + t], [L - t, H + 0.03, W - t]);
}
