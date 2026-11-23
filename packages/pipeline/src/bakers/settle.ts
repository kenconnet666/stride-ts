/**
 * 合成商品的烘焙共用的几步（货架、物理堆放、地上的杂物）：读商品文件，按商品要排的字取字体的子集，跑物理让摆好的东西落定。
 * 物理用原生的 Jolt：板（或者器皿）是静态的，东西是动态的凸包（少分段的网格，点数抽到 64 个以内），步进到都睡着（最多 20 秒）。
 * 器皿里落下去的菜（ProductFood.dropped）也在这里落定（settleFood）。
 */
import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { EXTENSIONS, parseJsonc, type ProductFile } from '@stride-ts/engine/content-format';
import { foodPieces, foodSpawn, productDesign, productMesh, productText, type FoodPiecePose, type PileBoard, type PlacedProduct, type TextFont } from '@stride-ts/engine/modeling';
import { loadTextFont } from './textFont.ts';

/** 一步的时长（秒）、最多跑几步（20 秒）。 */
const STEP = 1 / 60;
const MAX_STEPS = 1200;
/** 凸包最多几个点。 */
const HULL_POINTS = 64;

let native: Promise<StrideNative> | undefined;

/** 烘焙共用的运行时原生模块（带物理）：跑物理、解压别的模型（decodeMeshoptBatch）用，第一次用到时建。 */
export function runtimeNative(): Promise<StrideNative> {
  return (native ??= createStrideNative({ features: [physics] }));
}

/** 读这些商品文件（内容路径，去重）；读不到、不是 JSON 时报错。 */
export async function readProducts(paths: Iterable<string>, readContent: (path: string) => Promise<Uint8Array>, where: string): Promise<Map<string, ProductFile>> {
  const products = new Map<string, ProductFile>();
  for (const path of paths) {
    if (products.has(path)) continue;
    try {
      products.set(path, parseJsonc(new TextDecoder().decode(await readContent(path + EXTENSIONS.product)), path + EXTENSIONS.product) as ProductFile);
    } catch (error) {
      throw new Error(`${where}: cannot read the product ${path}: ${(error as Error).message}`, { cause: error });
    }
  }
  return products;
}

/** 每个字体要排的字：商品（几个变体）的品牌、品类、角标，加上 extra 里给的（价签的数字）。 */
export function productFontTexts(items: Iterable<readonly [ProductFile, number]>, extra: Iterable<readonly [string | undefined, string]> = []): Map<string, string> {
  const texts = new Map<string, string>();
  const want = (font: string | undefined, text: string) => {
    if (font) texts.set(font, (texts.get(font) ?? '') + text);
  };
  for (const [product, variants] of items) {
    for (let k = 0; k < Math.max(1, Math.round(variants)); k++) want(product.font, productText(productDesign(product, k)));
  }
  for (const [font, text] of extra) want(font, text);
  return texts;
}

/** 按 productFontTexts 的字取字体的子集。 */
export async function loadFonts(texts: ReadonlyMap<string, string>, readContent: (path: string) => Promise<Uint8Array>, where: string): Promise<Map<string, TextFont>> {
  const fonts = new Map<string, TextFont>();
  for (const [font, text] of texts) fonts.set(font, await loadTextFont(font, text, readContent, where));
  return fonts;
}

/** 跑物理：boards 是静态的板，spawn 里的东西是动态的凸包，步进到都睡着；返回停下的位姿（顺序同 spawn）。 */
export async function settleProducts(boards: readonly PileBoard[], products: ReadonlyMap<string, ProductFile>, spawn: readonly PlacedProduct[]): Promise<PlacedProduct[]> {
  if (spawn.length === 0) return [];
  const settled = await settle(
    spawn.length,
    (world) => world.addBodies(boards.map((board) => ({ shapes: [{ type: 'box' as const, size: [...board.size] as [number, number, number] }], position: [...board.center] as [number, number, number], friction: 0.7 }))),
    (world) => {
      const hulls = new Map([...products].map(([path, product]) => [path, world.createHull(hullPoints(productMesh(product, path, 8).vertices))]));
      return spawn.map((item) => ({ hull: hulls.get(item.product)!, position: item.position, rotation: item.rotation }));
    },
  );
  return spawn.map((item, i) => ({ ...item, ...settled[i]! }));
}

/**
 * 器皿里落下去的菜（ProductFood.dropped）：器皿连菜面是静态的三角网格，每块菜是动态的凸包，分批从菜面上方落下、步进到都睡着。
 * 返回商品路径 → 停在器皿里的那些块的位姿（弹出去的不要；交给 ProductSources.food、productMesh）；没有要落的菜的商品不在里面。
 */
export async function settleFood(products: ReadonlyMap<string, ProductFile>): Promise<Map<string, FoodPiecePose[]>> {
  const result = new Map<string, FoodPiecePose[]>();
  for (const [path, product] of products) {
    const pieces = foodPieces(product);
    if (pieces.length === 0) continue;
    // 同一份商品文件落出来一样：编辑器后端改货架的参数、重烘时不重跑物理（一样菜几秒）
    const key = JSON.stringify(product), cached = settledFood.get(key);
    if (cached) {
      result.set(path, cached);
      continue;
    }
    const spawn = foodSpawn(product, pieces);
    const ware = productMesh(product, path);
    const positions = new Float32Array(ware.vertices.length / 8 * 3);
    for (let i = 0, j = 0; i < ware.vertices.length; i += 8, j += 3) positions.set(ware.vertices.subarray(i, i + 3), j);
    const rim = product.size[0] / 2;
    const settled = await settle(
      pieces.length,
      (world) => world.addBodies([{ shapes: [{ type: 'mesh' as const, mesh: world.createMesh(positions, ware.indices) }], friction: 0.9 }]),
      (world) => pieces.map((piece, i) => ({ hull: world.createHull(Float32Array.from(piece.triangles)), position: spawn[i]!.position, rotation: spawn[i]!.rotation, wave: spawn[i]!.wave, radius: boundingRadius(piece.triangles) })),
    );
    const kept = settled.flatMap((pose, piece) => (Math.hypot(pose.position[0], pose.position[2]) <= rim && pose.position[1] >= 0 ? [{ piece, ...pose }] : []));
    settledFood.set(key, kept);
    result.set(path, kept);
  }
  return result;
}

/** 落定过的菜（商品文件的 JSON → 停下的位姿），这个进程里共用；生成的代码改了进程会重开。 */
const settledFood = new Map<string, FoodPiecePose[]>();

type World = ReturnType<StrideNative['createPhysicsWorld']>;

/** 一批放下去以后隔几步放下一批（1/3 秒）。 */
const WAVE_STEPS = 20;

/** 落定的一个动态物体：凸包（在这个世界里建）、开始的位姿、第几批放（没写是第 0 批，一开始就放）、外接球的半径（分批时用）。 */
interface SettleBody {
  readonly hull: ReturnType<World['createHull']>;
  readonly position: readonly number[];
  readonly rotation: readonly number[];
  readonly wave?: number;
  readonly radius?: number;
}

/**
 * 落定的共用部分：count 是动态物体的个数，addStatic 加静态的物体，bodies 给动态的物体；第 k 批在第 k × WAVE_STEPS 步放，放之前
 * 整批抬到已经放下的东西的最高处以上（不和落着的叠在一起）。全放下以后步进到都睡着（或者到 MAX_STEPS），返回停下的位姿（顺序同
 * bodies）。世界和变换用完就释放。
 */
async function settle(count: number, addStatic: (world: World) => void, bodies: (world: World) => SettleBody[]): Promise<Pick<PlacedProduct, 'position' | 'rotation'>[]> {
  const runtime = await runtimeNative();
  using transforms = runtime.createTransforms(count + 1);
  // 物体对、接触的上限是容量的 8 倍：一堆紧挨着的小东西（核桃、碗里的豆子）每个碰到十来个邻居、器皿的几个三角形，容量按物体数的
  // 8 倍开
  using world = runtime.createPhysicsWorld(8 * count + 16, { transforms });
  addStatic(world);
  const items = bodies(world);
  const slots = transforms.allocate(items.length);
  slots.forEach((slot, i) => {
    const s = slot as unknown as number, item = items[i]!;
    transforms.position.set(item.position, s * 3);
    transforms.rotation.set(item.rotation, s * 4);
  });
  const waves = Math.max(0, ...items.map((item) => item.wave ?? 0)) + 1;
  const added: ReturnType<World['addBodies']> = [];
  const placed: number[] = [];
  const release = (wave: number) => {
    const batch = items.flatMap((item, i) => ((item.wave ?? 0) === wave ? [i] : []));
    if (batch.length === 0) return;
    // 抬到已经放下的最高的那件以上：两件的中心隔开两个外接球的半径还多一点
    const y = (i: number) => transforms.position[(slots[i] as unknown as number) * 3 + 1]!;
    const radius = Math.max(...[...batch, ...placed].map((i) => items[i]!.radius ?? 0));
    const lowest = Math.min(...batch.map((i) => items[i]!.position[1]!)), highest = placed.length > 0 ? Math.max(...placed.map(y)) : -Infinity;
    const lift = Math.max(0, highest + 2.2 * radius - lowest);
    for (const i of batch) transforms.position[(slots[i] as unknown as number) * 3 + 1] = items[i]!.position[1]! + lift;
    // 连续碰撞检测：碗里的菜块、豆子只有一两厘米，落得快时一步走的比自己还长，会穿过薄薄的菜面、碗壁
    added.push(...world.addBodies(batch.map((i) => ({ motion: 'dynamic' as const, transform: slots[i]!, shapes: [{ type: 'convexHull' as const, hull: items[i]!.hull }], friction: 0.7, continuous: true }))));
    placed.push(...batch);
  };
  // 最后一批放下以后再最多跑 MAX_STEPS 步
  for (let step = 0, end = (waves - 1) * WAVE_STEPS + MAX_STEPS; step < end; step++) {
    if (step % WAVE_STEPS === 0 && step / WAVE_STEPS < waves) release(step / WAVE_STEPS);
    world.step(STEP);
    if (step / WAVE_STEPS >= waves && step > 30 && step % 15 === 0 && added.every((body) => !world.isAwake(body))) break;
  }
  return items.map((_, i) => {
    const s = slots[i]! as unknown as number;
    return {
      position: [transforms.position[s * 3]!, transforms.position[s * 3 + 1]!, transforms.position[s * 3 + 2]!] as const,
      rotation: [transforms.rotation[s * 4]!, transforms.rotation[s * 4 + 1]!, transforms.rotation[s * 4 + 2]!, transforms.rotation[s * 4 + 3]!] as const,
    };
  });
}

/** 中心在原点的一组点（每 3 个数一个）的外接球半径。 */
function boundingRadius(points: readonly number[]): number {
  let r = 0;
  for (let i = 0; i < points.length; i += 3) r = Math.max(r, Math.hypot(points[i]!, points[i + 1]!, points[i + 2]!));
  return r;
}

/** 网格顶点的位置，去重、均匀抽到 HULL_POINTS 个以内。 */
function hullPoints(vertices: Float32Array): Float32Array {
  const unique = new Map<string, [number, number, number]>();
  for (let i = 0; i < vertices.length; i += 8) {
    const p: [number, number, number] = [vertices[i]!, vertices[i + 1]!, vertices[i + 2]!];
    unique.set(p.map((v) => Math.round(v * 1e5)).join(','), p);
  }
  const points = [...unique.values()], stride = Math.max(1, points.length / HULL_POINTS);
  const picked: number[] = [];
  for (let k = 0; k < points.length && picked.length / 3 < HULL_POINTS; k = Math.floor(k + stride)) picked.push(...points[Math.floor(k)]!);
  return Float32Array.from(picked);
}
