// CI 的 content 缓存键：导入（tools/import-all.ps1 → 各样例的 scripts/import.ts → packages/pipeline）实际读到的文件的哈希。
// 引擎只算导入器 import 到的那几个文件（顺着 import 找，连同它们再 import 的），引擎里别的改动不让缓存失效、不重新导入。
//   node tools/content-key.ts            打印哈希
//   node tools/content-key.ts --list     打印算进去的文件
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (file: string) => path.relative(root, file).replaceAll('\\', '/');

/** 目录下的全部文件（递归）。 */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? (d.name === 'node_modules' ? [] : walk(full)) : [full];
  });
}

/** 工作区包的子路径（'@stride-ts/engine/content-format'）→ 文件，按包的 package.json 的 exports；不是工作区里的包时是 undefined。 */
function resolvePackage(specifier: string): string | undefined {
  const match = /^@stride-ts\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return undefined;
  const dir = path.join(root, 'packages', match[1]!);
  if (!existsSync(path.join(dir, 'package.json'))) return undefined;
  const exports = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string> }).exports ?? {};
  const target = exports[`.${match[2] ?? ''}`];
  return target ? path.join(dir, target) : undefined;
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  return [base, `${base}.ts`, path.join(base, 'index.ts')].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** 从 entries 顺着静态和动态 import 找到的仓库里的 .ts 文件（第三方包不算，锁文件管它们的版本）。 */
function importGraph(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const resolved = specifier!.startsWith('.') ? resolveRelative(file, specifier!) : resolvePackage(specifier!);
      if (resolved) pending.push(resolved);
    }
  }
  return seen;
}

const importScripts = readdirSync(path.join(root, 'apps')).map((app) => path.join(root, 'apps', app, 'scripts', 'import.ts')).filter(existsSync);
const files = new Set([
  // 导入器整个算上：它可能按路径读自己目录里的数据文件
  ...walk(path.join(root, 'packages', 'pipeline', 'src')),
  ...importGraph([path.join(root, 'packages', 'pipeline', 'src', 'cli.ts'), ...importScripts]),
  ...readdirSync(path.join(root, 'apps')).flatMap((app) => walk(path.join(root, 'apps', app, 'content-overrides'))),
  path.join(root, 'tools', 'import-all.ps1'),
  // 原生包（贴图转码、meshopt）的版本在 pnpm-workspace.yaml 的 override 里，第三方包的版本在锁文件里
  path.join(root, 'pnpm-lock.yaml'),
  path.join(root, 'pnpm-workspace.yaml'),
]);
const sorted = [...files].map(rel).sort();
if (process.argv.includes('--list')) {
  console.log(sorted.join('\n'));
} else {
  const hash = createHash('sha256');
  // 换行统一成 LF：Windows 上的检出是 CRLF，键要和 CI 上算的一样
  for (const file of sorted) hash.update(`${file}\0`).update(readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n')).update('\0');
  console.log(hash.digest('hex').slice(0, 32));
}
