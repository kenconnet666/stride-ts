/**
 * 地上的碎石杂物的纯函数部分（`.debris.json`，格式见 content/formats/debrisFormat.ts）：落下之前每件东西的位置和朝向（debrisSpawn：
 * 靠边的那些按离边的距离越近越多），物理用的地面和四周挡着的矮墙（debrisBoards，只给物理，不画），落定以后合成一个模型
 * （debrisModel）。跑物理在 pipeline 的 bakers/debrisModel.ts（原生的 Jolt，同物理堆放）。
 */
import { DEBRIS, type Debris, type DebrisFile } from '../content/formats/debrisFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import { hash32, randomRotation, seededRandom } from '../data/hash.ts';
import type { PileBoard } from './pile.ts';
import { productFootprint } from './product.ts';
import { ProductBatch, type MergedProducts, type PlacedProduct, type ProductSources } from './productBatch.ts';


/** 检查范围和东西；不对时报错（where 是报错的前缀）。 */
export function checkDebris(input: DebrisFile, products: ReadonlyMap<string, ProductFile>, where = input.name): void {
  checkParsed(DEBRIS.parse(input, where), products, where);
}

function checkParsed(file: Debris, products: ReadonlyMap<string, ProductFile>, where: string): void {
  const [w, d] = file.area;
  if (!(w > 0 && d > 0)) throw new Error(`${where}: area needs a width and a depth greater than 0`);
  for (const item of file.items) {
    if (!products.has(item.product)) throw new Error(`${where}: unknown product ${item.product}`);
    if (!(item.count >= 0)) throw new Error(`${where}: ${item.product} needs a count of 0 or more`);
  }
}

/**
 * 落下之前的位置：每件东西在范围里挑一点（靠边的按离边的距离的平方根分布：越近越密），离地按它外接球的半径再高一点、随机转，
 * 种类和变体打乱了放。
 */
export function debrisSpawn(input: DebrisFile, products: ReadonlyMap<string, ProductFile>, where = input.name): PlacedProduct[] {
  const file = DEBRIS.parse(input, where);
  checkParsed(file, products, where);
  const random = seededRandom(hash32(file.seed, 11));
  const [w, d] = file.area;
  // 没写 edges 时都均匀撒；写了的宽、比例没写时由模式补上
  const edges = file.edges, sides = edges?.sides ?? [], width = edges ? Math.max(0, edges.width) : 0, share = edges && sides.length > 0 ? Math.min(1, Math.max(0, edges.share)) : 0;
  return file.items.flatMap((item) => {
    const footprint = productFootprint(products.get(item.product)!), radius = Math.hypot(...footprint) / 2;
    const margin = Math.min(Math.max(footprint[0], footprint[2]) / 2, w / 2, d / 2);
    return Array.from({ length: Math.round(item.count) }, (): PlacedProduct => {
      let x = (random() - 0.5) * (w - 2 * margin), z = (random() - 0.5) * (d - 2 * margin);
      if (random() < share) {
        const side = sides[Math.floor(random() * sides.length)]!, inward = margin + Math.min(width, side === 'back' || side === 'front' ? d : w) * random() ** 2;
        if (side === 'back') z = -d / 2 + inward;
        else if (side === 'front') z = d / 2 - inward;
        else if (side === 'left') x = -w / 2 + inward;
        else x = w / 2 - inward;
      }
      return {
        product: item.product, variant: Math.floor(random() * Math.max(1, Math.round(item.variants))),
        // 3 厘米以下的（砂粒、石子、烟头）用少分段的网格：几百件，近看也看不出棱
        position: [x, radius + 0.005 + random() * 0.03, z], rotation: randomRotation(random), fine: Math.max(...footprint) >= 0.03,
      };
    });
  });
}

/** 物理用的板：地面（y = 0 往下）和四周 0.2 米高的矮墙（东西弹不出范围）。只给物理，模型里不画。 */
export function debrisBoards(input: DebrisFile): PileBoard[] {
  const file = DEBRIS.parse(input, input.name);
  const [w, d] = file.area, t = 0.05, h = 0.2;
  return [
    { center: [0, -t / 2, 0], size: [w + 2 * t, t, d + 2 * t] },
    { center: [-(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [0, h / 2, -(d + t) / 2], size: [w, h, t] },
    { center: [0, h / 2, (d + t) / 2], size: [w, h, t] },
  ];
}

/** 落定的东西（settled，物理跑完的位姿）合成一个模型；落到范围外面、掉到地下的不要。 */
export function debrisModel(input: DebrisFile, sources: ProductSources, settled: readonly PlacedProduct[], where = input.name): MergedProducts & { readonly items: number } {
  const file = DEBRIS.parse(input, where);
  const [w, d] = file.area;
  const inside = settled.filter(({ position: [x, y, z] }) => Math.abs(x) <= w / 2 + 0.01 && Math.abs(z) <= d / 2 + 0.01 && y >= -0.02);
  // 杂物远看就行：标签每毫米 2 个像素
  return { ...new ProductBatch(sources, where, inside, { maxDensity: 2 }).finish(), items: inside.length };
}
