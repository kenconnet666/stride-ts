/**
 * 物理堆放的纯函数部分（`.pile.json`，格式见 content/formats/pileFormat.ts）：容器的几块板（物理和画共用），倒进去之前每件东西
 * 的位置和朝向（pileSpawn），落定以后合成一个模型（pileModel）。跑物理在 pipeline 的 bakers/pileModel.ts（原生的 Jolt）。
 */
import type { PileFile } from '../content/formats/pileFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { productFootprint } from './product.ts';
import { ProductBatch, type MergedProducts, type PlacedProduct, type ProductSources } from './productBatch.ts';

/** 容器的一块板（轴对齐的盒子）：中心、边长。 */
export interface PileBoard {
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

const DEFAULT_WALL = 0.015;

/** 容器的底和四壁。 */
export function pileContainer(file: PileFile): PileBoard[] {
  const [w, h, d] = file.container.size, t = file.container.wall ?? DEFAULT_WALL;
  return [
    { center: [0, -t / 2, 0], size: [w + 2 * t, t, d + 2 * t] },
    { center: [-(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [0, h / 2, -(d + t) / 2], size: [w, h, t] },
    { center: [0, h / 2, (d + t) / 2], size: [w, h, t] },
  ];
}

/** 检查容器和东西；不对时报错（where 是报错的前缀）。 */
export function checkPile(file: PileFile, products: ReadonlyMap<string, ProductFile>, where = file.name): void {
  const [w, h, d] = file.container.size;
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`${where}: the container needs a width, height and depth greater than 0`);
  for (const item of file.items) {
    if (!products.has(item.product)) throw new Error(`${where}: cannot find the product ${item.product}`);
    if (!(item.count >= 0)) throw new Error(`${where}: the count of ${item.product} must not be negative`);
  }
}

/**
 * 倒进去之前的位置：按最大的那件东西的大小在容器上方排成一层层的格子（错开一点、随机转），种类和变体打乱了放；从壁高往上
 * 摞，所以先落下去的在下面。
 */
export function pileSpawn(file: PileFile, products: ReadonlyMap<string, ProductFile>, where = file.name): PlacedProduct[] {
  checkPile(file, products, where);
  const random = seededRandom(hash32(file.seed ?? 1, 7));
  const list = file.items.flatMap((item) => Array.from({ length: Math.round(item.count) }, () => ({
    product: item.product, variant: Math.floor(random() * Math.max(1, Math.round(item.variants ?? 3))),
  })));
  // 打乱
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  const [w, h, d] = file.container.size;
  const cell = Math.max(...file.items.map((item) => Math.max(...productFootprint(products.get(item.product)!)))) * 1.15;
  const columns = Math.max(1, Math.floor(w / cell)), rows = Math.max(1, Math.floor(d / cell)), perLayer = columns * rows;
  return list.map((entry, i) => {
    const layer = Math.floor(i / perLayer), k = i % perLayer, column = k % columns, row = Math.floor(k / columns);
    const jitter = () => (random() - 0.5) * cell * 0.3;
    const x = (column + 0.5) * (w / columns) - w / 2 + jitter(), z = (row + 0.5) * (d / rows) - d / 2 + jitter();
    const y = h + 0.02 + layer * cell;
    return { ...entry, position: [x, y, z] as const, rotation: randomRotation(random), fine: true };
  });
}

/** 均匀分布的随机朝向（Shoemake）。 */
function randomRotation(random: () => number): [number, number, number, number] {
  const u1 = random(), u2 = random() * 2 * Math.PI, u3 = random() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

/** 落定的东西（settled，物理跑完的位姿）连同容器合成一个模型；落到容器外面的不要。 */
export function pileModel(file: PileFile, sources: ProductSources, settled: readonly PlacedProduct[], where = file.name): MergedProducts & { readonly items: number } {
  const [w, , d] = file.container.size;
  const inside = settled.filter(({ position: [x, y, z] }) => Math.abs(x) <= w / 2 + 0.01 && Math.abs(z) <= d / 2 + 0.01 && y >= -0.05);
  // 埋在下面、看不见的那些给少一点面：上面那层（离最高的不到两件东西高）照常细
  const top = Math.max(0, ...inside.map((item) => item.position[1]));
  const size = Math.max(...file.items.map((item) => Math.max(...productFootprint(sources.products.get(item.product)!))));
  const batch = new ProductBatch(sources, where, inside.map((item) => ({ ...item, fine: item.position[1] > top - 2 * size })), {
    solids: [{ color: file.container.color ?? '#3d4044', roughness: 0.55, metalness: 0 }],
  });
  for (const board of pileContainer(file)) {
    const min = board.center.map((c, i) => c - board.size[i]! / 2), max = board.center.map((c, i) => c + board.size[i]! / 2);
    batch.box(min, max, 0);
  }
  return { ...batch.finish(), items: inside.length };
}
