// 生成模型的资源从改参数到出文件要多久（全实时的路线第 0 步，docs/realtime.md）：把样例里每个生成资源用编辑器后端的烘焙表
// 原样烘一遍（不写文件），按种类报次数、中位数、最慢的和最慢的那个资源。页面热重载、加载模型的时间不在里面。
//   node packages/editor/experiments/generator-latency.ts [apps/<工程> ...]（默认所有样例）
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStrideTools } from '@stride-ts/native/tools';
import { EXTENSIONS } from '@stride-ts/engine/content-format';
import { parseJsonc } from '../../engine/src/data/jsonc.ts';
import { GENERATORS } from '../src/server/backend/bakers.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const apps = process.argv.length > 2 ? process.argv.slice(2).map((app) => path.resolve(app)) : (await readdir(path.join(repo, 'apps'))).map((app) => path.join(repo, 'apps', app));
const tools = await createStrideTools();
const kinds = Object.keys(GENERATORS) as (keyof typeof GENERATORS)[];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const samples = new Map<string, { ms: number; asset: string }[]>();
for (const app of apps) {
  const content = path.join(app, 'public', 'content');
  const read = (file: string) => readFile(path.join(content, file)).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' || !file.endsWith('.json')) throw error;
    return readFile(path.join(content, `${file}c`));
  });
  for await (const file of walk(content)) {
    const relative = path.relative(content, file).replaceAll('\\', '/');
    const kind = kinds.find((k) => {
      const extension = (EXTENSIONS as Record<string, string>)[k];
      return extension !== undefined && (relative.endsWith(extension) || relative.endsWith(`${extension}c`));
    });
    if (!kind) continue;
    const extension = (EXTENSIONS as Record<string, string>)[kind]!;
    const assetPath = relative.slice(0, relative.lastIndexOf(extension));
    const where = `${path.basename(app)}/${assetPath}`;
    try {
      const parsed = parseJsonc(await readFile(file, 'utf8'), where);
      const start = performance.now();
      await GENERATORS[kind].bake({ tools, read }, parsed, assetPath, where);
      const ms = performance.now() - start;
      samples.set(kind, [...(samples.get(kind) ?? []), { ms, asset: where }]);
    } catch (error) {
      console.warn(`${where}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
}

console.log('kind'.padEnd(12), 'count'.padStart(6), 'median ms'.padStart(10), 'max ms'.padStart(9), '  slowest');
for (const [kind, list] of [...samples].sort((a, b) => Math.max(...b[1].map((s) => s.ms)) - Math.max(...a[1].map((s) => s.ms)))) {
  const sorted = list.toSorted((a, b) => a.ms - b.ms);
  const median = sorted[Math.floor(sorted.length / 2)]!.ms, slowest = sorted.at(-1)!;
  console.log(kind.padEnd(12), String(list.length).padStart(6), median.toFixed(0).padStart(10), slowest.ms.toFixed(0).padStart(9), `  ${slowest.asset}`);
}
process.exit(0);
