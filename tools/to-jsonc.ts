/**
 * 把人写的 JSON 内容文件改成带注释的 `.jsonc`（用户 2026-11-23 定：以后默认 `.jsonc` 加有类型的模式）。只改进了 git 的文件（人写的
 * 源文件：场景、预制体、商品、货架、材质……）；烘焙、导入生成的（不进 git 的同名模型、材质、图集）不动。用 git mv，历史跟得上；
 * 资源之间按不带扩展名的路径引用，不用改引用。内容不变（改了扩展名的 JSON 本来就是合法的 `.jsonc`）。
 *
 *   node tools/to-jsonc.ts <目录>... [--dry]
 *   node tools/to-jsonc.ts apps/photoreal/public/content
 *
 * 改完看 .gitignore 里只放行 `*.<种类>.json` 的目录（生成的大文件和源文件放在一起的），要放行 `.jsonc`。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const dirs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (dirs.length === 0) {
  console.error('usage: node tools/to-jsonc.ts <dir>... [--dry]');
  process.exit(1);
}

/** 内容文件的种类扩展名：`<名字>.<种类>.json`（不算 package.json、tsconfig 这类工程文件）。 */
const CONTENT_JSON = /\.[a-zA-Z]+\.json$/;

const tracked = execFileSync('git', ['ls-files', '-z', '--', ...dirs], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const files = tracked.filter((file) => CONTENT_JSON.test(file));
let moved = 0;
for (const file of files) {
  const target = `${file}c`;
  if (existsSync(path.join(root, target))) {
    console.warn(`skip ${file}: ${target} already exists`);
    continue;
  }
  if (!dry) execFileSync('git', ['mv', file, target], { cwd: root });
  moved++;
}
console.log(`${dry ? 'would move' : 'moved'} ${moved} file(s) to .jsonc`);
