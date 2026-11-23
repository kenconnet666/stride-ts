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
import { SHELF, type Shelf, type ShelfFile } from '../content/formats/shelfFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { productFootprint, svgNumber, textPath } from './product.ts';
import { shadeColor } from './svg.ts';
import type { TextFont } from './textOutline.ts';
import { ProductBatch, type AtlasCell, type Cell, type MergedProducts, type PlacedProduct, type ProductSources } from './productBatch.ts';

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
  /** 价签上印的价格（元，两位小数）。 */
  readonly price: string;
}

/** 生成的货架：网格（一个材质槽）、图集的两张 SVG（颜色、表面）和栅格化的边长，摆了几件商品。 */
export interface ShelfModel extends MergedProducts {
  readonly items: number;
}

/** 中岛的背板一半的厚度（米）；单面的背板贴着 z = 0 往 -Z 厚。 */
const SPINE = 0.02;
/** 价签条：高、厚（米），贴在层板前沿往下。 */
const STRIP = [0.045, 0.008] as const;
const TAG = [0.055, 0.032] as const;
/** 插在透明挡条里的纸价签大一些（照片里和 1.8 升的油瓶差不多宽）。 */
const RAIL_TAG = [0.075, 0.036] as const;
/** 透明挡条（tagHolder: 'rail'）：高（米）、往后仰的角度、底边在层板前沿外多远；价签在挡条后面多远、底边离层板多高。 */
const RAIL_HEIGHT = 0.05, RAIL_TILT = (10 * Math.PI) / 180, RAIL_OUT = 0.004, RAIL_TAG_BEHIND = 0.0015, RAIL_TAG_LIFT = 0.006;
/** 商品之间留的缝（米）。 */
const GAP = 0.006;
/** 商品没写价格时，价签从这么多个按货架种子随机的价格里挑。 */
const PRICES = 8;
/** 价格的尾数（超市的习惯）。 */
const PRICE_ENDINGS = ['.90', '.80', '.50', '.00', '.99'] as const;

/**
 * 价签上印的价格。商品写了 price 的：第 0 款就是它，别的款（同一种货的别的牌子）按款式和货架的种子在它的 0.9～1.12 倍之间，
 * 取整到元再配超市常见的尾数；没写的从 PRICES 个按货架种子随机的价格（1～39 元）里按 pick（0..1）挑一个。
 */
function tagPrice(file: Shelf, product: ProductFile, variant: number, pick: number): string {
  if (product.price === undefined) {
    const random = seededRandom(hash32(file.seed, 1000 + Math.floor(pick * PRICES)));
    return `${Math.floor(1 + random() * 39)}${PRICE_ENDINGS[Math.floor(random() * PRICE_ENDINGS.length)]}`;
  }
  if (variant === 0) return product.price.toFixed(2);
  const random = seededRandom(hash32(hash32(file.seed, 1100), hash32(variant, Math.round(product.price * 100))));
  const price = product.price * (0.9 + random() * 0.22);
  // 贵的不用 .99、.00 这种零头（几十块的油写 59.90、62.80）
  const endings = price >= 20 ? PRICE_ENDINGS.slice(0, 3) : PRICE_ENDINGS;
  return `${Math.max(0, Math.floor(price))}${endings[Math.floor(random() * endings.length)]}`;
}

/** 挂钩架的一个挂钩：x、钩子的高、朝哪面。 */
export interface ShelfHook {
  readonly x: number;
  readonly y: number;
  readonly side: 1 | -1;
}

/** 绕竖直轴转了占的地方不变的外形（摆货乱的时候随便转）。 */
const ROUND_SHAPES: ReadonlySet<ProductFile['shape']> = new Set(['bottle', 'can', 'jar', 'tub', 'bowl']);

/** 挂钩架：商品挂在钩子下面多远（米）；洞洞板以上第一排挂钩下面留多少。 */
const HOOK_DROP = 0.015, HOOK_BOTTOM = 0.12;

/**
 * 按规则摆货：每件商品、每个价签（挂钩架还有每个挂钩）。商品文件读不到的、尺寸不对的跳过（where 是报错的前缀，规则本身不对时
 * 报错）。挂钩架的商品挂在钩子下面、一个排面一个钩子、往钩里串几个；堆头见 planStack。
 */
export function planShelf(input: ShelfFile, products: ReadonlyMap<string, ProductFile>, where = input.name): { readonly items: ShelfItem[]; readonly tags: ShelfTag[]; readonly hooks: ShelfHook[] } {
  const file = SHELF.parse(input, where);
  checkShelf(file, where);
  if (file.type === 'stack') return { ...planStack(file, products), hooks: [] };
  const items: ShelfItem[] = [], tags: ShelfTag[] = [], hooks: ShelfHook[] = [];
  const pegboard = file.type === 'pegboard';
  const stock = file.stock;
  if (!stock || stock.products.length === 0) return { items, tags, hooks };
  const candidatesOf = (paths: readonly string[]) => paths.flatMap((path) => {
    const product = products.get(path);
    return product && product.size[0] > 0 && product.size[1] > 0 ? [{ path, product, footprint: productFootprint(product) }] : [];
  });
  const candidates = candidatesOf(stock.products);
  const variants = Math.max(1, Math.round(stock.variants));
  const [minFacings, maxFacings] = stock.facings ?? [2, 5];
  const maxRows = Math.max(1, Math.round(stock.rows));
  const gaps = Math.min(1, Math.max(0, stock.gaps));
  const messiness = Math.min(1, Math.max(0, stock.messiness));
  const sides: readonly (1 | -1)[] = file.sides === 2 ? [1, -1] : [1];
  const back = file.sides === 2 ? SPINE : 0;
  const xMin = -file.length / 2 + 0.03, xMax = file.length / 2 - 0.03;
  sides.forEach((side, sideIndex) => {
    file.levels.forEach((level, levelIndex) => {
      const above = file.levels[levelIndex + 1], below = file.levels[levelIndex - 1];
      // 挂钩架的东西挂在钩子下面，空间到下面那排钩子为止
      const clearance = pegboard ? level - HOOK_DROP - (below ?? HOOK_BOTTOM) - 0.02 : (above === undefined ? file.height : above - (file.boardThickness)) - level - 0.015;
      const own = stock.levels?.[levelIndex];
      const fits = (own ? candidatesOf(own) : candidates).filter((c) => c.footprint[1] <= clearance && c.footprint[2] <= file.depth);
      if (fits.length === 0) return;
      const random = seededRandom(hash32(hash32(file.seed, sideIndex), levelIndex));
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
          ? { position: [x + w / 2, level + 0.02, side * (back + file.depth + 0.003)], side, price: tagPrice(file, choice.product, variant, random()) }
          : { position: [x + Math.min(TAG[0], w) / 2 + 0.005, level - STRIP[0] / 2, side * (back + file.depth + STRIP[1] + 0.001)], side, price: tagPrice(file, choice.product, variant, random()) });
        const y = pegboard ? level - HOOK_DROP - choice.footprint[1] : level;
        // 乱：圆的转起来不占地方，随便转；方的转了会碰到旁边的，最多转到对角刚好碰不着（sin θ ≤ 缝 / 深）
        const round = ROUND_SHAPES.has(choice.product.shape);
        const maxYaw = messiness * (round ? Math.PI / 4 : Math.min(0.12, Math.asin(Math.min(1, GAP / Math.max(d, GAP)))));
        // 挂钩上的东西挂在钩尖上，不左右前后挪
        const nudge = pegboard ? 0 : messiness * GAP * 0.45;
        for (let f = 0; f < facings; f++) {
          if (pegboard) hooks.push({ x: x + f * (w + GAP) + w / 2, y: level, side });
          // 卖掉了的：这一列的前几排空着；被拿过的：整列往里推了一截，最里面放不下的那件不要
          const missing = random() < gaps ? 1 + Math.floor(random() * rows) : 0;
          const pushed = !pegboard && random() < 0.3 * messiness ? random() * 0.5 * (d + GAP) : 0;
          for (let r = missing; r < rows; r++) {
            const z = back + file.depth - 0.01 - d / 2 - r * (d + GAP) - pushed;
            if (z - d / 2 < back + 0.003) break;
            const jitter = () => (random() * 2 - 1) * nudge;
            items.push({ product: choice.path, variant, position: [x + f * (w + GAP) + w / 2 + jitter(), y, side * (z + jitter())], yaw: (side > 0 ? 0 : Math.PI) + (random() * 2 - 1) * maxYaw, front: r === missing });
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
function planStack(file: Shelf, products: ReadonlyMap<string, ProductFile>): { items: ShelfItem[]; tags: ShelfTag[] } {
  const items: ShelfItem[] = [], tags: ShelfTag[] = [];
  const stock = file.stock;
  if (!stock || stock.products.length === 0) return { items, tags };
  const candidates = stock.products.flatMap((path) => {
    const product = products.get(path);
    return product && product.size[0] > 0 && product.size[1] > 0 ? [{ path, product, footprint: productFootprint(product) }] : [];
  });
  if (candidates.length === 0) return { items, tags };
  const random = seededRandom(hash32(file.seed, 3));
  const variants = Math.max(1, Math.round(stock.variants));
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
    tags.push({ position: [x + (columns * (w + GAP)) / 2, base / 2, file.depth / 2 + 0.032], side: 1, price: tagPrice(file, choice.product, variant, random()) });
    x += columns * (w + GAP) + 0.02;
  }
  return { items, tags };
}

function checkShelf(file: Shelf, where: string): void {
  if (!(file.length > 0 && file.height > 0 && file.depth > 0)) throw new Error(`${where}: length, height and depth must be greater than 0`);
  if (file.levels.length === 0) throw new Error(`${where}: needs at least one level (the base)`);
  for (let i = 1; i < file.levels.length; i++) {
    if (!(file.levels[i]! > file.levels[i - 1]!)) throw new Error(`${where}: levels must go up (level ${i} is not above level ${i - 1})`);
  }
  if (file.levels.at(-1)! >= file.height) throw new Error(`${where}: the top level must be below the height`);
}

/**
 * 纯色（ProductBatch 的 solids 的下标）：架子、价签条、底座、冷柜的门框、灯带、冷柜里面的白、电子价签的外壳，熟食柜的黑柜体、
 * 白石英、金、保温灯的暖光，层板，透明挡条顶上折边（塑料折过的地方发白、很亮的一道反光），冷柜的门框和柜体（doorColor）、门把手。
 */
const FRAME = 0, STRIP_SOLID = 1, BASE = 2, DARK = 3, LIGHT = 4, INTERIOR = 5, TAG_BODY = 6, COUNTER = 7, QUARTZ = 8, GOLD = 9, WARM = 10, BOARD_SOLID = 11, RAIL_EDGE = 12, DOOR_BODY = 13, HANDLE = 14, LED = 15, STICKER = 16, CUBBY = 17;
/** 电子价签：外壳比屏大一圈（米）、凸出价签条多厚。 */
const ESL_RIM = 0.004, ESL_DEPTH = 0.009;
/** 冷柜：门在层板前面多远、门框多宽；顶上灯箱的高；冰柜的壁厚。 */
const DOOR = 0.05, MULLION = 0.04, HEADER = 0.24, FREEZER_WALL = 0.06;
/** 熟食柜：前面白台面、后面白挡边的宽，托盘比台面低多少；保温灯罩的半径、高，吊杆多长。 */
const DELI_FRONT = 0.2, DELI_BACK = 0.08, DELI_SINK = 0.025, LAMP_RADIUS = 0.11, LAMP_HEIGHT = 0.14, LAMP_ROD = 0.6;

/** 熟食柜的托盘（摆碗盘的那块）：前后的 z（原点在柜子中心）。 */
function deliTray(file: Shelf): readonly [number, number] {
  return [-file.depth / 2 + DELI_BACK, file.depth / 2 - DELI_FRONT];
}

/**
 * 熟食柜上方每盏保温灯灯罩底面的中心（米，货架的坐标）：灯具只发光，照亮菜的光源由场景另放（同天花板的 ceilingLights），
 * 搭场景时放在这些位置往下照。
 */
export function deliLamps(input: ShelfFile): (readonly [number, number, number])[] {
  const file = SHELF.parse(input, input.name);
  const bay = file.bay ?? 0.6, count = Math.max(1, Math.round(file.length / bay));
  const [zBack, zFront] = deliTray(file);
  return Array.from({ length: count }, (_, i) => [-file.length / 2 + (i + 0.5) * (file.length / count), file.height, (zBack + zFront) / 2] as const);
}

/** 生成货架（冷柜、冰柜）的网格和图集。 */
export function shelfModel(input: ShelfFile, sources: ProductSources, where = input.name): ShelfModel {
  const file = SHELF.parse(input, where), type = file.type;
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
  const cubbies = type === 'gondola' && file.cubbies ? planCubbies(file, file.cubbies, sources.products) : undefined;
  const tags = type === 'freezer' || type === 'deli' ? [] : plan.tags;
  const tagFont = file.font ? sources.font(file.font) : undefined;
  const electronic = file.priceTags === 'electronic';
  // 透明挡条只给纸价签的货架、冷柜（价签插在挡条后面）
  const rail = file.tagHolder === 'rail' && !electronic && (type === 'gondola' || type === 'fridge');
  // 每个不同的价格一格（排在图集的最前面）
  const prices = [...new Set(tags.map((tag) => tag.price))], priceCell = new Map(prices.map((price, k) => [price, k]));
  const batch = new ProductBatch(sources, where, items.map((item): PlacedProduct => ({
    product: item.product, variant: item.variant, position: item.position, rotation: [0, Math.sin(item.yaw / 2), 0, Math.cos(item.yaw / 2)], fine: item.front,
  })).concat(cubbies?.bottles ?? []), {
    solids: [
      { color: file.frameColor, roughness: 0.45, metalness: 0.5 },
      { color: file.stripColor, roughness: 0.35, metalness: 0 },
      { color: '#3a3b3d', roughness: 0.5, metalness: 0.3 },
      { color: '#2a2c2f', roughness: 0.35, metalness: 0.6 },
      { color: '#eef4ff', roughness: 0.5, metalness: 0, emissive: 6 },
      { color: '#eef1f3', roughness: 0.4, metalness: 0 },
      { color: '#f0f0ee', roughness: 0.45, metalness: 0 },
      { color: '#141518', roughness: 0.35, metalness: 0 },
      { color: '#e9e8e3', roughness: 0.12, metalness: 0 },
      { color: '#c9a250', roughness: 0.28, metalness: 0.9 },
      { color: '#ffd9a0', roughness: 0.5, metalness: 0, emissive: 8 },
      // 层板：写了 boardColor 时是木纹板那样的哑光，没写同架子
      file.boardColor ? { color: file.boardColor, roughness: 0.55, metalness: 0 } : { color: file.frameColor, roughness: 0.45, metalness: 0.5 },
      { color: '#e6ecee', roughness: 0.12, metalness: 0 },
      file.doorColor ? { color: file.doorColor, roughness: 0.35, metalness: 0.1 } : { color: '#2a2c2f', roughness: 0.35, metalness: 0.6 },
      { color: '#c9ccd0', roughness: 0.3, metalness: 0.85 },
      // 冷柜门框里侧的 LED 灯带：一颗颗灯珠直接对着人，比层板下的灯条亮得多（照片里刺眼、发出光晕）
      { color: '#f4f8ff', roughness: 0.5, metalness: 0, emissive: 120 },
      // 门上广告贴的底色（两边的边框）
      { color: file.doorSticker?.color ?? '#ffffff', roughness: 0.35, metalness: 0 },
      // 格子柜的斜隔板（格子柜的板是木纹格）
      { color: file.cubbies?.color ?? '#5f5650', roughness: 0.6, metalness: 0 },
    ],
    // 价签：几种价格；纸的三个里一个黄底，电子的是墨水屏
    cells: prices.map((price, k): AtlasCell => (electronic ? eslCell(price, k, tagFont, hash32(file.seed, 2000 + k))
      : file.tagAccent ? accentTagCell(price, file.tagAccent, tagFont, rail ? RAIL_TAG : TAG)
      : {
        size: [(rail ? RAIL_TAG : TAG)[0] * 1000, (rail ? RAIL_TAG : TAG)[1] * 1000] as const, color: k % 3 === 0 ? '#f6d21a' : '#ffffff', roughness: 0.4, metalness: 0,
        draw: ([x, y, w, h]) => tagFont && textPath(tagFont, price, x + w * 0.55, y + h * 0.55, w * 0.78, h * 0.62, '#d7262b'),
      })).concat(type === 'fridge' ? [{
      // 冷柜顶上的灯箱：蓝底白字，整块发光
      size: [file.length * 1000, (HEADER - 0.04) * 1000] as const, color: file.doorColor ?? '#1e64c8', roughness: 0.3, metalness: 0, emissive: 2,
      draw: ([x, y, w, h]: Cell) => (file.header && tagFont ? textPath(tagFont, file.header, x + w / 2, y + h / 2, w * 0.6, h * 0.62, '#ffffff') : undefined),
    }, ...stickerCells(file, tagFont)] : []).concat(file.boardColor ? [woodCell(file.boardColor, file.seed)] : [])
      .concat(cubbies && file.cubbies ? [woodCell(file.cubbies.color, file.seed + 7)] : []),
  });
  // 木纹层板、格子柜的木纹在所有格子的最后
  const woodBoard = file.boardColor ? prices.length + (type === 'fridge' ? 1 + stickerCells(file, undefined).length : 0) : -1;
  const cubbyWood = cubbies ? prices.length + (type === 'fridge' ? 1 + stickerCells(file, undefined).length : 0) + (file.boardColor ? 1 : 0) : -1;
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
    for (const tag of tags) addTag(batch, tag, electronic, priceCell.get(tag.price)!);
    return { ...batch.finish(), items: items.length };
  }
  if (type === 'pegboard') {
    pegboardBody(batch, file, plan.hooks);
    for (const tag of tags) addTag(batch, tag, electronic, priceCell.get(tag.price)!);
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
  const haze = type === 'fridge' ? fridgeFront(batch, file, zFar, prices.length) : undefined;
  for (const side of sides) {
    const z0 = side * back, z1 = side * zFar;
    const zs = [Math.min(z0, z1), Math.max(z0, z1)] as const;
    // 底座（第一层的下面是实心的踢脚板）和每一层的层板
    batch.box([-L + SPINE, 0, zs[0]], [L - SPINE, file.levels[0]!, zs[1]], BASE);
    for (const level of file.levels.slice(1)) {
      const min = [-L + SPINE, level - (file.boardThickness), zs[0]], max = [L - SPINE, level, zs[1]];
      if (woodBoard >= 0) batch.texturedBox(min, max, woodBoard);
      else batch.box(min, max, BOARD_SOLID);
    }
    for (const level of file.levels) {
      if (rail) {
        tagRail(batch, -L + SPINE, L - SPINE, level, zFar, side);
        continue;
      }
      // 价签条：层板前沿往下
      const s0 = side * zFar, s1 = side * (zFar + STRIP[1]);
      batch.box([-L + SPINE, level - STRIP[0], Math.min(s0, s1)], [L - SPINE, level, Math.max(s0, s1)], STRIP_SOLID);
    }
  }
  // 价签：价签条正面上的一小片（从正面看左下、右下、右上、左上：背面那一面的 x 反过来），或者插在透明挡条后面
  for (const tag of tags) {
    if (rail) railTag(batch, tag, zFar, priceCell.get(tag.price)!);
    else addTag(batch, tag, electronic, priceCell.get(tag.price)!);
  }
  if (cubbies) cubbyBody(batch, cubbies, cubbyWood);
  return { ...batch.finish(), ...(haze && { hazeSvg: haze.svg, hazePixels: haze.pixels }), items: items.length + (cubbies?.bottles.length ?? 0) };
}

/** 格子柜的板厚（米）。 */
const CUBBY_BOARD = 0.02;
/** 六边形格占几格宽；切角的板从半高的尖角斜到顶、底，横着占六边形宽的多少。 */
const CUBBY_HEX_WIDTH = 1.3, CUBBY_HEX_CUT = 0.28;

/** 格子柜怎么分（米，都是板以内的空当）：柜子的范围、每排的格子、上下贯通的六边形格，瓶子摆在哪。 */
interface CubbyPlan {
  readonly box: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number; readonly z0: number; readonly z1: number };
  /** 六边形格把每排切成几段，段和段之间是六边形格。 */
  readonly segments: readonly { readonly x0: number; readonly x1: number }[];
  readonly rows: readonly { readonly y0: number; readonly y1: number; readonly cells: readonly { readonly x0: number; readonly x1: number }[] }[];
  readonly hexes: readonly { readonly x0: number; readonly x1: number }[];
  readonly bottles: PlacedProduct[];
}

/**
 * 格子柜怎么分、瓶子放在哪（照片里油货架顶上的木格子）：hex 个六边形格上下贯通所有排（左右两边在半高处是尖角），位置按种子挑、
 * 不挨着两头；别的地方每排各分各的格子，格宽按种子在平均宽的 0.8～1.2 倍之间，所以上下两排的竖板错开。fill 比例的格子里，
 * 瓶子瓶口朝外、贴近前沿横躺成一排，瓶子之间留半个瓶身的空，各自绕瓶身转一点（标签朝向不一）。
 */
function planCubbies(file: Shelf, cubbies: NonNullable<Shelf['cubbies']>, products: ReadonlyMap<string, ProductFile>): CubbyPlan {
  const random = seededRandom(hash32(file.seed, 5003));
  const L = file.length / 2, t = CUBBY_BOARD, depth = cubbies.depth ?? file.depth;
  const box = { x0: -L, x1: L, y0: file.height, y1: file.height + cubbies.height, z0: 0, z1: depth };
  const perRow = Math.max(1, Math.round(file.length / (file.bay ?? 1))) * cubbies.columns;
  // 一格连同一块板的平均宽
  const unit = (file.length - t) / perRow;
  const hexes: { x0: number; x1: number }[] = [], segments: { x0: number; x1: number }[] = [];
  let cursor = box.x0 + t;
  for (const slot of hexSlots(random, perRow, cubbies.hex)) {
    const x0 = box.x0 + t + slot * unit, x1 = x0 + CUBBY_HEX_WIDTH * unit - t;
    segments.push({ x0: cursor, x1: x0 - t });
    hexes.push({ x0, x1 });
    cursor = x1 + t;
  }
  segments.push({ x0: cursor, x1: box.x1 - t });
  const rowHeight = (cubbies.height - t) / cubbies.rows;
  const rows = Array.from({ length: cubbies.rows }, (_, r) => ({
    y0: box.y0 + t + r * rowHeight, y1: box.y0 + (r + 1) * rowHeight,
    cells: segments.flatMap((segment) => {
      const span = segment.x1 - segment.x0 + t, count = Math.max(1, Math.round(span / unit));
      const weights = Array.from({ length: count }, () => 0.8 + random() * 0.4), total = weights.reduce((a, b) => a + b, 0);
      let x = segment.x0;
      return weights.map((weight) => {
        const x0 = x;
        x += (span * weight) / total;
        return { x0, x1: x - t };
      });
    }),
  }));
  const candidates = cubbies.products.flatMap((path) => {
    const product = products.get(path);
    return product ? [{ path, footprint: productFootprint(product) }] : [];
  });
  const bottles: PlacedProduct[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      if (candidates.length === 0 || random() >= cubbies.fill) continue;
      const choice = candidates[Math.floor(random() * candidates.length)]!, variant = Math.floor(random() * 3);
      // 横躺着：瓶身的直径朝上，瓶身的长朝外
      const [w, length] = choice.footprint, width = cell.x1 - cell.x0, count = Math.floor((width + w * 0.5) / (w * 1.5));
      if (count < 1 || w > row.y1 - row.y0 || length > depth - 0.01) continue;
      const pitch = width / count;
      for (let k = 0; k < count; k++) {
        const roll = random() * Math.PI * 2, x = cell.x0 + pitch * (k + 0.5) + (random() - 0.5) * (pitch - w) * 0.6;
        // 瓶底离前沿 length 再往里 2～5 厘米（瓶口差不多和前沿齐）；先绕 X 转 90°（瓶身的 +Y 朝 +Z），再绕 Z 转 roll：q = qz · qx
        const z = Math.max(box.z0 + 0.005, box.z1 - length - 0.02 - random() * 0.03);
        const s = Math.SQRT1_2, sz = Math.sin(roll / 2), cz = Math.cos(roll / 2);
        bottles.push({ product: choice.path, variant, position: [x, row.y0 + w / 2, z], rotation: [cz * s, sz * s, sz * s, cz * s], fine: true });
      }
    }
  }
  return { box, segments, rows, hexes, bottles };
}

/** 六边形格放在哪几格（从左数，按种子挑）：不挨着两头，两个之间至少隔两格；放不下的不放。 */
function hexSlots(random: () => number, perRow: number, count: number): number[] {
  const slots: number[] = [];
  for (let attempt = 0; slots.length < count && attempt < 64; attempt++) {
    const slot = 1 + Math.floor(random() * Math.max(0, perRow - 1 - CUBBY_HEX_WIDTH));
    if (slot + CUBBY_HEX_WIDTH <= perRow - 1 && slots.every((other) => Math.abs(other - slot) >= 2 + CUBBY_HEX_WIDTH)) slots.push(slot);
  }
  return slots.sort((a, b) => a - b);
}

/** 格子柜的板（木纹格）：底、顶、背板、两侧，每段每排之间的横板、格之间的竖板，六边形格两边的竖板和切角的四块斜板（纯色）。 */
function cubbyBody(batch: ProductBatch, plan: CubbyPlan, wood: number): void {
  const t = CUBBY_BOARD, { x0, x1, y0, y1, z0, z1 } = plan.box;
  batch.texturedBox([x0, y0, z0], [x1, y0 + t, z1], wood);
  batch.texturedBox([x0, y1 - t, z0], [x1, y1, z1], wood);
  batch.texturedBox([x0, y0, z0 - t], [x1, y1, z0], wood);
  batch.texturedBox([x0, y0, z0], [x0 + t, y1, z1], wood);
  batch.texturedBox([x1 - t, y0, z0], [x1, y1, z1], wood);
  for (const [r, row] of plan.rows.entries()) {
    if (r < plan.rows.length - 1) for (const segment of plan.segments) batch.texturedBox([segment.x0, row.y1, z0], [segment.x1, row.y1 + t, z1], wood);
    for (const cell of row.cells) {
      // 段尾的竖板是侧板或六边形格边上的竖板
      if (plan.segments.some((segment) => Math.abs(segment.x1 - cell.x1) < 1e-6)) continue;
      batch.texturedBox([cell.x1, row.y0, z0], [cell.x1 + t, row.y1, z1], wood);
    }
  }
  const bottom = y0 + t, top = y1 - t, middle = (bottom + top) / 2;
  for (const hex of plan.hexes) {
    batch.texturedBox([hex.x0 - t, bottom, z0], [hex.x0, top, z1], wood);
    batch.texturedBox([hex.x1, bottom, z0], [hex.x1 + t, top, z1], wood);
    const cut = (hex.x1 - hex.x0) * CUBBY_HEX_CUT, h = t / 2;
    batch.plank([hex.x0, middle], [hex.x0 + cut, top - h], t, z0, z1, CUBBY);
    batch.plank([hex.x0, middle], [hex.x0 + cut, bottom + h], t, z0, z1, CUBBY);
    batch.plank([hex.x1, middle], [hex.x1 - cut, top - h], t, z0, z1, CUBBY);
    batch.plank([hex.x1, middle], [hex.x1 - cut, bottom + h], t, z0, z1, CUBBY);
  }
}

/** 一个价签：纸的是贴在价签条上的一片；电子的是凸出来的外壳加正面的屏。 */
function addTag(batch: ProductBatch, tag: ShelfTag, electronic: boolean, cell: number): void {
  const [x, y, z0] = tag.position, [tw, th] = TAG;
  const z = electronic ? z0 + tag.side * ESL_DEPTH : z0;
  if (electronic) {
    const zs = [z0 - tag.side * 0.001, z - tag.side * 0.0005].sort((a, b) => a - b) as [number, number];
    batch.box([x - tw / 2 - ESL_RIM, y - th / 2 - ESL_RIM, zs[0]], [x + tw / 2 + ESL_RIM, y + th / 2 + ESL_RIM, zs[1]], TAG_BODY);
  }
  const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => [x + sx * tw / 2 * tag.side, y + sy * th / 2, z]);
  batch.quad(corners, [0, 0, tag.side], cell);
}

/**
 * 透明挡条：立在层板前沿（zFar，side 那一面）的一条透明塑料，从 x0 到 x1，往后（往商品那边）仰 RAIL_TILT；顶上折一道小边（照片里
 * 挡条顶上那条亮线）。进玻璃的网格。
 */
function tagRail(batch: ProductBatch, x0: number, x1: number, level: number, zFar: number, side: 1 | -1): void {
  const z = side * (zFar + RAIL_OUT), top = level + RAIL_HEIGHT * Math.cos(RAIL_TILT), zTop = z - side * RAIL_HEIGHT * Math.sin(RAIL_TILT);
  // 从正面看左下、右下、右上、左上（背面那一面 x 反过来）
  const [left, right] = side > 0 ? [x0, x1] : [x1, x0];
  batch.glassQuad([[left, level, z], [right, level, z], [right, top, zTop], [left, top, zTop]]);
  // 顶上往前折的小边：不透明的一道（照片里很亮的那条线）
  const lip = [zTop, zTop + side * 0.004].sort((a, b) => a - b) as [number, number];
  batch.box([x0, top - 0.0015, lip[0]], [x1, top, lip[1]], RAIL_EDGE);
}

/**
 * 插在透明挡条后面的纸价签（RAIL_TAG 大）：和挡条一样仰着，底边离层板 RAIL_TAG_LIFT，在挡条后面 RAIL_TAG_BEHIND。tag 的位置是
 * 价签条上的（TAG 大）：左边对齐。
 */
function railTag(batch: ProductBatch, tag: ShelfTag, zFar: number, cell: number): void {
  const [tw, th] = RAIL_TAG, side = tag.side, level = tag.position[1] + STRIP[0] / 2;
  const x = tag.position[0] + ((tw - TAG[0]) / 2) * side;
  const sin = Math.sin(RAIL_TILT), cos = Math.cos(RAIL_TILT);
  const at = (along: number): [number, number] => [level + along * cos, side * (zFar + RAIL_OUT - RAIL_TAG_BEHIND - along * sin)];
  const [y0, z0] = at(RAIL_TAG_LIFT), [y1, z1] = at(RAIL_TAG_LIFT + th);
  const corners = [[x - (tw / 2) * side, y0, z0], [x + (tw / 2) * side, y0, z0], [x + (tw / 2) * side, y1, z1], [x - (tw / 2) * side, y1, z1]];
  batch.quad(corners, [0, sin, side * cos], cell);
}

/**
 * 带色块的纸价签（tagAccent）：白底，左边深灰的价格、价格上下两道浅灰的细字（品名、规格），右边一块超市的颜色里一个白色的手指
 * 图标那样的圆。
 */
function accentTagCell(price: string, accent: string, font: TextFont | undefined, [tw, th]: readonly [number, number]): AtlasCell {
  return {
    size: [tw * 1000, th * 1000], color: '#f4f5f3', roughness: 0.45, metalness: 0,
    draw: ([x, y, w, h]: Cell) => {
      const tab = w * 0.2, shapes = [`<rect x="${svgNumber(x + w - tab)}" y="${y}" width="${svgNumber(tab)}" height="${h}" fill="${accent}"/>`];
      shapes.push(`<circle cx="${svgNumber(x + w - tab / 2)}" cy="${svgNumber(y + h * 0.5)}" r="${svgNumber(tab * 0.28)}" fill="none" stroke="#ffffff" stroke-width="${svgNumber(tab * 0.09)}"/>`);
      for (const [row, width] of [[0.16, 0.62], [0.8, 0.4]] as const) shapes.push(`<rect x="${svgNumber(x + w * 0.06)}" y="${svgNumber(y + h * row)}" width="${svgNumber(w * width)}" height="${svgNumber(h * 0.07)}" fill="#a9acab"/>`);
      const digits = font && textPath(font, price, x + (w - tab) * 0.45, y + h * 0.5, (w - tab) * 0.6, h * 0.42, '#4a4c4d');
      if (digits) shapes.push(digits);
      return shapes.join('');
    },
  };
}

/** 挂钩架：洞洞板（背板，双面时两面都有）、底座、两头的侧板，每个挂钩一根细的金属杆。 */
function pegboardBody(batch: ProductBatch, file: Shelf, hooks: readonly ShelfHook[]): void {
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
 * 木纹层板的一格（boardColor 写了时）：顺着层板长的木纹（深浅不一、微微起伏的细线）、几个节疤、前沿一带用旧了的擦痕和灰；
 * 一整条层板铺满这一格（u 顺着长），按种子。
 */
function woodCell(color: string, seed: number): AtlasCell {
  const size = [1200, 300] as const;
  return {
    size, color, roughness: 0.55, metalness: 0,
    draw: ([x, y, w, h]: Cell) => {
      const random = seededRandom(hash32(seed, 3001));
      const shapes: string[] = [];
      for (let i = 0; i < 60; i++) {
        const y0 = y + random() * h, amplitude = h * (0.004 + random() * 0.012), waves = 2 + Math.floor(random() * 4);
        let d = `M${svgNumber(x)} ${svgNumber(y0)}`;
        for (let k = 1; k <= waves; k++) d += `Q${svgNumber(x + (w * (k - 0.5)) / waves)} ${svgNumber(y0 + (k % 2 ? amplitude : -amplitude))} ${svgNumber(x + (w * k) / waves)} ${svgNumber(y0)}`;
        shapes.push(`<path d="${d}" fill="none" stroke="${shadeColor(color, 0.78 + random() * 0.3)}" stroke-width="${svgNumber(0.6 + random() * 2.2)}" opacity="${svgNumber(0.35 + random() * 0.4)}"/>`);
      }
      for (let i = 0; i < 4; i++) {
        const cx = x + random() * w, cy = y + random() * h, r = h * (0.02 + random() * 0.03);
        shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber(cy)}" rx="${svgNumber(r * 2.2)}" ry="${svgNumber(r)}" fill="${shadeColor(color, 0.62)}" opacity="0.6"/>`);
      }
      // 前沿（v 大的那边，顶面朝外的那一侧）磨得发白、沾灰
      for (let i = 0; i < 40; i++) {
        const sx = x + random() * w, sy = y + h * (0.75 + random() * 0.25), length = w * (0.004 + random() * 0.02);
        shapes.push(`<rect x="${svgNumber(sx)}" y="${svgNumber(sy)}" width="${svgNumber(length)}" height="${svgNumber(0.6 + random())}" fill="${random() < 0.6 ? '#ffffff' : '#3a332c'}" opacity="${svgNumber(0.15 + random() * 0.25)}"/>`);
      }
      return `<g>${shapes.join('')}</g>`;
    },
  };
}

/** 门上广告贴的横幅、下面那条占门的玻璃多高（米），整圈贴纸的上沿在门的玻璃高的多少。 */
const STICKER_TITLE = 0.11, STICKER_SLOGAN = 0.09, STICKER_TOP = 0.68;

/** 一扇门的玻璃有多宽（米）。 */
const doorWidth = (file: Shelf) => file.length / Math.max(1, Math.round(file.length / (file.bay ?? 0.75))) - MULLION;

/** 门上广告贴的横幅、下面那条的两格（底色加字；图集里灯箱之后），没贴时没有。 */
function stickerCells(file: Shelf, font: TextFont | undefined): AtlasCell[] {
  const sticker = file.doorSticker;
  if (!sticker) return [];
  const width = doorWidth(file) * 1000, ink = sticker.textColor;
  const cell = (text: string | undefined, height: number): AtlasCell => ({
    size: [width, height * 1000] as const, color: sticker.color, roughness: 0.35, metalness: 0,
    draw: ([x, y, w, h]: Cell) => (text && font ? textPath(font, text, x + w / 2, y + h / 2, w * 0.86, h * 0.6, ink) : undefined),
  });
  return [cell(sticker.title, STICKER_TITLE), cell(sticker.slogan, STICKER_SLOGAN)];
}

/**
 * 冷柜的前面：每一扇门的玻璃、门之间的门框（doorColor，默认深色）和门框里侧竖着的灯带、门把手，门下面压缩机那一格的前脸，
 * 顶盖和顶上的灯箱（图集里价签格之后那一格；写了 doorColor 时顶盖、灯箱也是这个颜色），门上的广告贴（doorSticker：灯箱之后
 * 的两格是横幅和下面那条，两边的边框是纯色），玻璃外面那层脏（doorHaze：每扇门一片，贴图是一条横排的 SVG，返回它）。zFar 是层板前沿。
 */
function fridgeFront(batch: ProductBatch, file: Shelf, zFar: number, headerCell: number): { svg: string; pixels: [number, number] } | undefined {
  const L = file.length / 2, H = file.height, bottom = file.levels[0]!;
  const doors = Math.max(1, Math.round(file.length / (file.bay ?? 0.75)));
  const z0 = zFar + DOOR - 0.01, z1 = zFar + DOOR + 0.01;
  const doorWidth = file.length / doors - MULLION, doorHeight = H - bottom;
  const [cellW, cellH] = [Math.round(doorWidth * HAZE_PIXELS), Math.round(doorHeight * HAZE_PIXELS)], hazes: string[] = [];
  for (let k = 0; k <= doors; k++) {
    const x = -L + (file.length * k) / doors;
    batch.box([x - MULLION / 2, bottom, z0 - 0.01], [x + MULLION / 2, H, z1], DOOR_BODY);
    // 灯带贴在门框里侧（最两头的只有一边）
    if (k > 0) batch.box([x - MULLION / 2 - 0.02, bottom + 0.03, z0 - 0.03], [x - MULLION / 2, H - 0.03, z0 - 0.01], LED);
    if (k < doors) batch.box([x + MULLION / 2, bottom + 0.03, z0 - 0.03], [x + MULLION / 2 + 0.02, H - 0.03, z0 - 0.01], LED);
    if (k < doors) {
      const right = -L + (file.length * (k + 1)) / doors - MULLION / 2;
      batch.glassBox([x + MULLION / 2, bottom, z0], [right, H, z0 + 0.008]);
      if (file.doorSticker) doorSticker(batch, file.doorSticker, [x + MULLION / 2, right], [bottom, H], z0 + 0.0085, headerCell + 1);
      // 门把手：竖着一根，在门不开铰链的那边（相邻两扇对开）
      const hx = k % 2 === 0 ? right - 0.05 : x + MULLION / 2 + 0.05, hy = bottom + (H - bottom) * 0.45;
      if (file.doorHaze > 0) {
        // 只贴有脏的两片（整扇门都贴的话，透明阶段每个像素都要照一遍所有的灯）：把手周围、底下的水雾
        const zh = z0 + 0.0095, left = x + MULLION / 2;
        const patch = (x0: number, x1: number, y0: number, y1: number) => {
          const [a, b] = [Math.max(left, x0), Math.min(right, x1)], [c, d] = [Math.max(bottom, y0), Math.min(H, y1)];
          const u = (value: number) => (k + (value - left) / doorWidth) / doors, v = (value: number) => (H - value) / doorHeight;
          batch.hazeQuad([[a, c, zh], [b, c, zh], [b, d, zh], [a, d, zh]], [0, 0, 1], [u(a), v(d), u(b), v(c)]);
        };
        patch(hx - HAZE_HANDLE[0], hx + HAZE_HANDLE[0], hy - HAZE_HANDLE[1], hy + 0.45 + HAZE_HANDLE[1]);
        patch(left, right, bottom, bottom + HAZE_FOG);
        const random = seededRandom(hash32(file.seed, 7001 + k));
        hazes.push(`<g transform="translate(${k * cellW} 0)">${doorHazeShapes(random, cellW, cellH, (hx - left) * HAZE_PIXELS, (H - hy) * HAZE_PIXELS, file.doorHaze)}</g>`);
      }
      batch.box([hx - 0.009, hy, z1 + 0.012], [hx + 0.009, hy + 0.45, z1 + 0.03], HANDLE);
      batch.box([hx - 0.006, hy + 0.03, z1], [hx + 0.006, hy + 0.05, z1 + 0.012], HANDLE);
      batch.box([hx - 0.006, hy + 0.4, z1], [hx + 0.006, hy + 0.42, z1 + 0.012], HANDLE);
    }
  }
  // 门的上下框、顶盖、灯箱
  batch.box([-L, bottom - 0.03, z0 - 0.01], [L, bottom, z1], DOOR_BODY);
  batch.box([-L, H - 0.03, z0 - 0.01], [L, H, z1], DOOR_BODY);
  // 门下面压缩机那一格的前脸（和门一平）
  batch.box([-L, 0, zFar], [L, bottom - 0.03, z1], DOOR_BODY);
  batch.box([-L, H, -SPINE], [L, H + 0.04, z1], file.doorColor ? DOOR_BODY : FRAME);
  batch.box([-L, H + 0.04, z1 - 0.2], [L, H + HEADER, z1], file.doorColor ? DOOR_BODY : FRAME);
  const z = z1 + 0.001, y0 = H + 0.06, y1 = H + HEADER - 0.02;
  batch.quad([[-L, y0, z], [L, y0, z], [L, y1, z], [-L, y1, z]], [0, 0, 1], headerCell);
  if (hazes.length === 0) return undefined;
  const pixels: [number, number] = [cellW * doors, cellH];
  const defs = '<defs><radialGradient id="smudge"><stop offset="0" stop-color="#ffffff"/><stop offset="0.6" stop-color="#ffffff" stop-opacity="0.6"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="fog" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>';
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixels[0]} ${pixels[1]}" width="${pixels[0]}" height="${pixels[1]}">${defs}${hazes.join('')}</svg>`, pixels };
}

/** 玻璃门上那层脏的贴图每米几个像素（手印、水雾都是糊的，不用细）。 */
const HAZE_PIXELS = 600;
/** 贴脏的两片：把手周围（左右、上下各多出去多少米，把手 0.45 米长），底下水雾那一条的高（米）；doorHazeShapes 只画在这两片里。 */
const HAZE_HANDLE = [0.17, 0.1] as const, HAZE_FOG = 0.42;

/**
 * 一扇玻璃门上的脏（贴图里的一格，W × H 像素，y 朝下；handle 是把手在这格里的位置——横坐标、把手底的纵坐标，amount 是多脏）：
 * 把手那边一团手印（指头大的椭圆）和一两个掌印、零星的灰点，底下一截水雾（上沿起伏）和里面的水珠。都在 HAZE_HANDLE、HAZE_FOG 那两片里。
 */
function doorHazeShapes(random: () => number, W: number, H: number, handleX: number, handleY: number, amount: number): string {
  const m = HAZE_PIXELS, out: string[] = [];
  const n = (value: number) => svgNumber(value);
  // 手印：把手周围，竖着散在把手的高度上（把手 0.45 米长）
  const prints = Math.round(6 + 16 * amount);
  for (let i = 0; i < prints; i++) {
    const x = handleX + (random() - 0.5) * 0.2 * m, y = handleY + 0.04 * m - random() * 0.5 * m;
    const rx = (0.008 + random() * 0.01) * m, ry = rx * (1.2 + random() * 0.4), angle = (random() - 0.5) * 70;
    out.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" transform="rotate(${n(angle)} ${n(x)} ${n(y)})" fill="url(#smudge)" opacity="${n((0.25 + random() * 0.35) * amount)}"/>`);
  }
  // 掌印：把手旁边稍大的一两团
  for (let i = 0, palms = 1 + Math.floor(random() * 2); i < palms; i++) {
    const x = handleX + (random() - 0.5) * 0.16 * m, y = handleY - (0.1 + random() * 0.3) * m, r = (0.03 + random() * 0.02) * m;
    out.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(r)}" ry="${n(r * 1.25)}" fill="url(#smudge)" opacity="${n(0.18 * amount)}"/>`);
  }
  // 水雾：底下一截，上沿起伏；水珠在雾里和雾的上沿
  const fog = (0.08 + random() * 0.1) * m * (0.6 + amount * 0.8), top = H - fog;
  let edge = `M0 ${H}L0 ${n(top)}`;
  const waves = 5 + Math.floor(random() * 4);
  for (let i = 1; i <= waves; i++) edge += `Q${n((W * (i - 0.5)) / waves)} ${n(top + (random() - 0.5) * fog * 0.5)} ${n((W * i) / waves)} ${n(top + (random() - 0.5) * fog * 0.2)}`;
  out.push(`<path d="${edge}L${W} ${H}Z" fill="url(#fog)" opacity="${n(0.55 * amount)}"/>`);
  for (let i = 0, drops = Math.round(60 * amount); i < drops; i++) {
    const x = random() * W, y = H - random() * Math.min(fog * 1.2, HAZE_FOG * m), r = (0.0015 + random() * 0.003) * m;
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="#ffffff" opacity="${n(0.3 + random() * 0.3)}"/>`);
  }
  // 灰点：把手那一片里
  for (let i = 0, specks = Math.round(20 * amount); i < specks; i++) {
    const x = handleX + (random() - 0.5) * 2 * HAZE_HANDLE[0] * m, y = handleY + HAZE_HANDLE[1] * m - random() * (0.45 + 2 * HAZE_HANDLE[1]) * m;
    out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n((0.0006 + random() * 0.0012) * m)}" fill="#d8d8d4" opacity="0.5"/>`);
  }
  return out.join('');
}

/**
 * 一扇门上的广告贴：贴在玻璃外面（z），门的下面 STICKER_TOP 那么高一圈——上面横幅（图集的 cell 格）、下面一条（cell + 1 格）、
 * 两边纯色的边框。
 */
function doorSticker(batch: ProductBatch, sticker: NonNullable<Shelf['doorSticker']>, [x0, x1]: readonly [number, number], [bottom, top]: readonly [number, number], z: number, cell: number): void {
  const inset = 0.012, border = sticker.border;
  const left = x0 + inset, right = x1 - inset, y0 = bottom + 0.04, y1 = bottom + (top - bottom) * STICKER_TOP;
  const band = (y: number, height: number, slot: number) => batch.quad([[left, y, z], [right, y, z], [right, y + height, z], [left, y + height, z]], [0, 0, 1], slot);
  band(y1 - STICKER_TITLE, STICKER_TITLE, cell);
  band(y0, STICKER_SLOGAN, cell + 1);
  // 两边的边框：贴纸就半毫米厚
  batch.box([left, y0 + STICKER_SLOGAN, z - 0.0005], [left + border, y1 - STICKER_TITLE, z], STICKER);
  batch.box([right - border, y0 + STICKER_SLOGAN, z - 0.0005], [right, y1 - STICKER_TITLE, z], STICKER);
}

/** 卧式冰柜：四壁和槽底（槽里白的），柜沿深色，沿下一圈灯带，上面两块错开的玻璃推拉盖。 */
/**
 * 熟食柜：黑柜体到台面下，前面白石英台面（比托盘高一点、前沿出挑），后面一道白挡边，中间托盘下沉 DELI_SINK、黑色，托盘前沿
 * 一道金边；上方每盏保温灯是一根细吊杆、一个上小下大的金色灯罩、罩底一片发光的暖光。
 */
function deliBody(batch: ProductBatch, file: Shelf): void {
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

function freezerBody(batch: ProductBatch, file: Shelf): void {
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
