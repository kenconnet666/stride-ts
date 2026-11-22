/**
 * 物理堆放的烘焙（引擎 content/formats/pileFormat.ts 的 PileFile）：东西在容器上方摆好（引擎 modeling/pile.ts 的 pileSpawn），
 * 原生的 Jolt 让它们落下去、等都睡着（或者到时间），读回停下的位姿合成一个模型（pileModel），写成同名的四个文件：模型、颜色
 * 图集、表面图集、材质（同货架）。每种东西的碰撞形状是它的网格的凸包（少分段的那份，点数也抽到 64 个以内）。
 */
import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { EXTENSIONS, type PileFile, type ProductFile } from '@stride-ts/engine/content-format';
import { pileContainer, pileModel, pileSpawn, productDesign, productMesh, productText, type PlacedProduct, type TextFont } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import type { BakedFile } from './productModel.ts';
import { mergedFiles } from './mergedFiles.ts';
import { loadTextFont } from './textFont.ts';

/** 一步的时长（秒）、最多跑几步（20 秒）。 */
const STEP = 1 / 60;
const MAX_STEPS = 1200;
/** 凸包最多几个点。 */
const HULL_POINTS = 64;

let native: Promise<StrideNative> | undefined;

/** 生成 path（堆放的内容路径）同名的模型、两张图集和材质。商品读不到、容器不对时报错。 */
export async function bakePile(tools: StrideTools, file: PileFile, path: string, readContent: (path: string) => Promise<Uint8Array>, where = file.name): Promise<BakedFile[]> {
  const products = new Map<string, ProductFile>();
  for (const item of file.items) {
    if (products.has(item.product)) continue;
    try {
      products.set(item.product, JSON.parse(new TextDecoder().decode(await readContent(item.product + EXTENSIONS.product))) as ProductFile);
    } catch (error) {
      throw new Error(`${where}: cannot read the product ${item.product}: ${(error as Error).message}`, { cause: error });
    }
  }
  // 包装上的字（果蔬没有）
  const fonts = new Map<string, TextFont>();
  for (const item of file.items) {
    const product = products.get(item.product)!;
    if (!product.font || fonts.has(product.font)) continue;
    const text = Array.from({ length: Math.max(1, Math.round(item.variants ?? 3)) }, (_, k) => {
      return productText(productDesign(product, k));
    }).join('');
    fonts.set(product.font, await loadTextFont(product.font, text, readContent, where));
  }

  const settled = await settle(file, products, pileSpawn(file, products, where));
  return mergedFiles(tools, file.name, path, pileModel(file, { products, font: (font) => fonts.get(font) }, settled, where));
}

/** 跑物理：容器是静态的板，东西是动态的凸包，步进到都睡着；返回停下的位姿（顺序同 spawn）。 */
async function settle(file: PileFile, products: ReadonlyMap<string, ProductFile>, spawn: readonly PlacedProduct[]): Promise<PlacedProduct[]> {
  if (spawn.length === 0) return [];
  const runtime = await (native ??= createStrideNative({ features: [physics] }));
  const transforms = runtime.createTransforms(spawn.length + 1);
  // 物体对、接触的上限是容量的 8 倍：一堆紧挨着的小东西（核桃）每个碰到十来个邻居，容量按物体数的 4 倍开
  const world = runtime.createPhysicsWorld(4 * spawn.length + 16, { transforms });
  world.addBodies(pileContainer(file).map((board) => ({ shapes: [{ type: 'box' as const, size: [...board.size] as [number, number, number] }], position: [...board.center] as [number, number, number], friction: 0.7 })));
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
