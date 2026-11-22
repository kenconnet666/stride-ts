// 货架生成的统计（几件商品、几个顶点和三角形、图集多大）：node tools/dev/shelf-stats.ts <工程的内容目录> <货架的内容路径>...
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProductFile, ShelfFile } from '../../packages/engine/src/content/formats/format.ts';
import { shelfModel } from '../../packages/engine/src/modeling/shelf.ts';

const [content, ...shelves] = process.argv.slice(2);
if (!content || shelves.length === 0) {
  console.error('usage: node tools/dev/shelf-stats.ts <content dir> <shelf path>...');
  process.exit(2);
}
const read = <T>(file: string) => JSON.parse(readFileSync(path.join(content, file), 'utf8')) as T;
for (const shelf of shelves) {
  const file = read<ShelfFile>(`${shelf}.shelf.json`);
  const products = new Map((file.stock?.products ?? []).map((product) => [product, read<ProductFile>(`${product}.product.json`)]));
  const start = performance.now();
  const model = shelfModel(file, { products, font: () => undefined });
  console.log(`${shelf}: ${model.items} items, ${model.vertices.length / 8} vertices, ${model.indices.length / 3} triangles, ${Math.round(performance.now() - start)} ms`);
}
