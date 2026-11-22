/**
 * 合成商品的烘焙共用的几步（货架、物理堆放、地上的杂物）：读商品文件，按商品要排的字取字体的子集，跑物理让摆好的东西落定。
 * 物理用原生的 Jolt：板是静态的盒子，东西是动态的凸包（少分段的网格，点数抽到 64 个以内），步进到都睡着（最多 20 秒）。
 */
import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { EXTENSIONS, type ProductFile } from '@stride-ts/engine/content-format';
import { productDesign, productMesh, productText, type PileBoard, type PlacedProduct, type TextFont } from '@stride-ts/engine/modeling';
import { loadTextFont } from './textFont.ts';

/** 一步的时长（秒）、最多跑几步（20 秒）。 */
const STEP = 1 / 60;
const MAX_STEPS = 1200;
/** 凸包最多几个点。 */
const HULL_POINTS = 64;

let native: Promise<StrideNative> | undefined;

/** 读这些商品文件（内容路径，去重）；读不到、不是 JSON 时报错。 */
export async function readProducts(paths: Iterable<string>, readContent: (path: string) => Promise<Uint8Array>, where: string): Promise<Map<string, ProductFile>> {
  const products = new Map<string, ProductFile>();
  for (const path of paths) {
    if (products.has(path)) continue;
    try {
      products.set(path, JSON.parse(new TextDecoder().decode(await readContent(path + EXTENSIONS.product))) as ProductFile);
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
  const runtime = await (native ??= createStrideNative({ features: [physics] }));
  const transforms = runtime.createTransforms(spawn.length + 1);
  // 物体对、接触的上限是容量的 8 倍：一堆紧挨着的小东西（核桃）每个碰到十来个邻居，容量按物体数的 4 倍开
  const world = runtime.createPhysicsWorld(4 * spawn.length + 16, { transforms });
  world.addBodies(boards.map((board) => ({ shapes: [{ type: 'box' as const, size: [...board.size] as [number, number, number] }], position: [...board.center] as [number, number, number], friction: 0.7 })));
  const hulls = new Map([...products].map(([path, product]) => [path, world.createHull(hullPoints(productMesh(product, path, 8).vertices))]));
  const slots = transforms.allocate(spawn.length);
  slots.forEach((slot, i) => {
    const s = slot as unknown as number, item = spawn[i]!;
    transforms.position.set(item.position, s * 3);
    transforms.rotation.set(item.rotation, s * 4);
  });
  const bodies = world.addBodies(spawn.map((item, i) => ({ motion: 'dynamic' as const, transform: slots[i]!, shapes: [{ type: 'convexHull' as const, hull: hulls.get(item.product)! }], friction: 0.7 })));
  for (let step = 0; step < MAX_STEPS; step++) {
    world.step(STEP);
    if (step > 30 && step % 15 === 0 && bodies.every((body) => !world.isAwake(body))) break;
  }
  return spawn.map((item, i) => {
    const s = slots[i]! as unknown as number;
    return {
      ...item,
      position: [transforms.position[s * 3]!, transforms.position[s * 3 + 1]!, transforms.position[s * 3 + 2]!] as const,
      rotation: [transforms.rotation[s * 4]!, transforms.rotation[s * 4 + 1]!, transforms.rotation[s * 4 + 2]!, transforms.rotation[s * 4 + 3]!] as const,
    };
  });
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
