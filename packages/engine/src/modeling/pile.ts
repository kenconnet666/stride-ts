/**
 * 物理堆放的纯函数部分（`.pile.json`，格式见 content/formats/pileFormat.ts）：容器的几块板（物理和画共用，分格时有隔板），
 * 倒进去之前每件东西的位置和朝向（pileSpawn，倒进各自的那一格），落定以后合成一个模型（pileModel：加上细粒的堆、掀开的
 * 透明盖）。跑物理在 pipeline 的 bakers/pileModel.ts（原生的 Jolt）。
 */
import type { PileFile, PileHeapFile } from '../content/formats/pileFormat.ts';
import type { ProductFile } from '../content/formats/productFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { productFootprint, svgNumber } from './product.ts';
import { ProductBatch, type Cell, type MergedProducts, type PlacedProduct, type ProductSources } from './productBatch.ts';

/** 容器的一块板（轴对齐的盒子）：中心、边长。 */
export interface PileBoard {
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

const DEFAULT_WALL = 0.015;
/** 透明盖往后掀开的角度（弧度）。 */
const LID_OPEN = (60 * Math.PI) / 180;

/** 容器的底、四壁和隔板。 */
export function pileContainer(file: PileFile): PileBoard[] {
  const [w, h, d] = file.container.size, t = file.container.wall ?? DEFAULT_WALL;
  const [columns, rows] = file.container.cells ?? [1, 1];
  const boards: PileBoard[] = [
    { center: [0, -t / 2, 0], size: [w + 2 * t, t, d + 2 * t] },
    { center: [-(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [(w + t) / 2, h / 2, 0], size: [t, h, d + 2 * t] },
    { center: [0, h / 2, -(d + t) / 2], size: [w, h, t] },
    { center: [0, h / 2, (d + t) / 2], size: [w, h, t] },
  ];
  for (let c = 1; c < columns; c++) boards.push({ center: [-w / 2 + (w * c) / columns, h / 2, 0], size: [t, h, d] });
  for (let r = 1; r < rows; r++) boards.push({ center: [0, h / 2, -d / 2 + (d * r) / rows], size: [w, h, t] });
  return boards;
}

/** 第 cell 格里面的范围（米：x0、x1、z0、z1，扣掉隔板的一半）；格子从左后往右前编号，没分格时是整个容器。 */
export function pileCell(file: PileFile, cell: number | undefined): readonly [number, number, number, number] {
  const [w, , d] = file.container.size, t = file.container.wall ?? DEFAULT_WALL;
  const [columns, rows] = file.container.cells ?? [1, 1];
  if (cell === undefined || columns * rows === 1) return [-w / 2, w / 2, -d / 2, d / 2];
  const c = cell % columns, r = Math.floor(cell / columns);
  const x0 = -w / 2 + (w * c) / columns, x1 = -w / 2 + (w * (c + 1)) / columns, z0 = -d / 2 + (d * r) / rows, z1 = -d / 2 + (d * (r + 1)) / rows;
  return [x0 + (c > 0 ? t / 2 : 0), x1 - (c < columns - 1 ? t / 2 : 0), z0 + (r > 0 ? t / 2 : 0), z1 - (r < rows - 1 ? t / 2 : 0)];
}

/** 检查容器和东西；不对时报错（where 是报错的前缀）。 */
export function checkPile(file: PileFile, products: ReadonlyMap<string, ProductFile>, where = file.name): void {
  const [w, h, d] = file.container.size;
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`${where}: the container needs a width, height and depth greater than 0`);
  const [columns, rows] = file.container.cells ?? [1, 1];
  if (!(Number.isInteger(columns) && Number.isInteger(rows) && columns >= 1 && rows >= 1)) throw new Error(`${where}: cells must be two whole numbers of at least 1`);
  const checkCell = (cell: number | undefined, what: string) => {
    if (cell !== undefined && !(Number.isInteger(cell) && cell >= 0 && cell < columns * rows)) throw new Error(`${where}: ${what} goes into cell ${cell}, but there are only ${columns * rows}`);
  };
  for (const item of file.items) {
    if (!products.has(item.product)) throw new Error(`${where}: cannot find the product ${item.product}`);
    if (!(item.count >= 0)) throw new Error(`${where}: the count of ${item.product} must not be negative`);
    checkCell(item.cell, item.product);
  }
  for (const heap of file.heaps ?? []) checkCell(heap.cell, 'a heap');
}

/**
 * 倒进去之前的位置：按最大的那件东西的大小在容器上方排成一层层的格子（错开一点、随机转），种类和变体打乱了放；从壁高往上
 * 摞，所以先落下去的在下面。
 */
export function pileSpawn(file: PileFile, products: ReadonlyMap<string, ProductFile>, where = file.name): PlacedProduct[] {
  checkPile(file, products, where);
  const random = seededRandom(hash32(file.seed ?? 1, 7));
  const h = file.container.size[1];
  // 按格子分组，每格在自己上方排
  const groups = new Map<number | undefined, PileFile['items'][number][]>();
  for (const item of file.items) groups.set(item.cell, [...(groups.get(item.cell) ?? []), item]);
  return [...groups].flatMap(([cell, items]) => {
    const list = items.flatMap((item) => Array.from({ length: Math.round(item.count) }, () => ({
      product: item.product, variant: Math.floor(random() * Math.max(1, Math.round(item.variants ?? 3))),
    })));
    // 打乱
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    const [x0, x1, z0, z1] = pileCell(file, cell), w = x1 - x0, d = z1 - z0;
    const size = Math.max(...items.map((item) => Math.max(...productFootprint(products.get(item.product)!)))) * 1.15;
    const columns = Math.max(1, Math.floor(w / size)), rows = Math.max(1, Math.floor(d / size)), perLayer = columns * rows;
    return list.map((entry, i) => {
      const layer = Math.floor(i / perLayer), k = i % perLayer, column = k % columns, row = Math.floor(k / columns);
      const jitter = () => (random() - 0.5) * size * 0.3;
      const x = x0 + (column + 0.5) * (w / columns) + jitter(), z = z0 + (row + 0.5) * (d / rows) + jitter();
      return { ...entry, position: [x, h + 0.02 + layer * size, z] as const, rotation: randomRotation(random), fine: true };
    });
  });
}

/** 均匀分布的随机朝向（Shoemake）。 */
export function randomRotation(random: () => number): [number, number, number, number] {
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
  const size = Math.max(0, ...file.items.map((item) => Math.max(...productFootprint(sources.products.get(item.product)!))));
  const heaps = file.heaps ?? [];
  const batch = new ProductBatch(sources, where, inside.map((item) => ({ ...item, fine: item.position[1] > top - 2 * size })), {
    solids: [{ color: file.container.color ?? '#3d4044', roughness: 0.55, metalness: 0 }],
    cells: heaps.map((heap) => {
      const [x0, x1, z0, z1] = pileCell(file, heap.cell);
      return { size: [(x1 - x0) * 1000, (z1 - z0) * 1000] as const, color: heap.color, roughness: 0.8, metalness: 0, draw: (cell: Cell) => grainShapes(heap, cell, [(x1 - x0) * 1000, (z1 - z0) * 1000]) };
    }),
  });
  for (const board of pileContainer(file)) {
    const min = board.center.map((c, i) => c - board.size[i]! / 2), max = board.center.map((c, i) => c + board.size[i]! / 2);
    batch.box(min, max, 0);
  }
  heaps.forEach((heap, i) => {
    const mesh = heapMesh(file, heap);
    batch.mesh(mesh.vertices, mesh.indices, i);
  });
  // 掀开的透明盖：每格一块，铰链在这一格的后沿顶上，往上翻开
  if (file.container.lids) {
    const h = file.container.size[1], [columns, rows] = file.container.cells ?? [1, 1];
    for (let cell = 0; cell < columns * rows; cell++) {
      const [x0, x1, z0, z1] = pileCell(file, cell), length = z1 - z0;
      const front = [z0 + length * Math.cos(LID_OPEN), h + length * Math.sin(LID_OPEN)] as const;
      batch.glassQuad([[x0, h, z0], [x1, h, z0], [x1, front[1], front[0]], [x0, front[1], front[0]]]);
    }
  }
  return { ...batch.finish(), items: inside.length };
}

/** 一格里的细粒的堆：格子里铺一张网格，边上在 level 的高，中间鼓起来（格子短边的 15%），加一点起伏；UV 是格子里的位置。 */
function heapMesh(file: PileFile, heap: PileHeapFile): { vertices: number[]; indices: number[] } {
  const [x0, x1, z0, z1] = pileCell(file, heap.cell), h = file.container.size[1];
  const base = Math.min(1, Math.max(0, heap.level ?? 0.8)) * h, rise = 0.15 * Math.min(x1 - x0, z1 - z0);
  const n = 16, seed = hash32(file.seed ?? 1, heap.cell + 100);
  const height = (u: number, v: number) => {
    const r = Math.min(1, Math.hypot(u * 2 - 1, v * 2 - 1));
    const ripple = (hash32(seed, Math.round(u * n) * 31 + Math.round(v * n)) / 4294967296 - 0.5) * rise * 0.12;
    return base + rise * (1 - r * r) + (r < 0.95 ? ripple : 0);
  };
  const vertices: number[] = [], indices: number[] = [], e = 1 / n;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n, v = j / n, x = x0 + u * (x1 - x0), z = z0 + v * (z1 - z0), y = height(u, v);
      // 法线用相邻两点的高度差
      const dx = (height(Math.min(1, u + e), v) - height(Math.max(0, u - e), v)) / (2 * e * (x1 - x0));
      const dz = (height(u, Math.min(1, v + e)) - height(u, Math.max(0, v - e))) / (2 * e * (z1 - z0));
      const l = Math.hypot(dx, 1, dz);
      vertices.push(x, y, z, -dx / l, 1 / l, -dz / l, u, v);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      // 从上往下看逆时针（法线朝 +Y）
      indices.push(a, c, b, b, c, d);
    }
  }
  return { vertices, indices };
}

/** 细粒的贴图：一格里撒满颗粒（椭圆，颜色在 color 和 speckle 之间），size 是这一格的毫米大小。 */
function grainShapes(heap: PileHeapFile, [x, y, w, h]: Cell, [mmW, mmH]: readonly [number, number]): string {
  const random = seededRandom(hash32(heap.cell, 991));
  const grain = (heap.grain ?? 0.006) * 1000, count = Math.min(4000, Math.round((mmW * mmH) / (grain * grain) * 1.2));
  const speckle = heap.speckle ?? '#000000';
  const sx = w / mmW, sy = h / mmH;
  const shapes: string[] = [];
  for (let i = 0; i < count; i++) {
    const cx = x + random() * w, cy = y + random() * h, rx = (grain / 2) * sx * (0.7 + random() * 0.5), ry = (grain / 2) * sy * (0.45 + random() * 0.4);
    const angle = Math.round(random() * 180);
    shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber(cy)}" rx="${svgNumber(rx)}" ry="${svgNumber(ry)}" transform="rotate(${angle} ${svgNumber(cx)} ${svgNumber(cy)})" fill="${random() < 0.5 ? speckle : heap.color}" opacity="${svgNumber(0.25 + random() * 0.4)}"/>`);
  }
  return `<g>${shapes.join('')}</g>`;
}
