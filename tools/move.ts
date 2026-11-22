/**
 * 挪包里的文件，改写所有受影响的相对导入（import、export from、import()、vi.mock，保留 ?raw 这类后缀；原来写了 .ts 扩展名的
 * 照旧写；挪走的文件里 import.meta.glob 的相对目录也重算），包的 package.json 里指向它们的 exports、bin 跟着改。用 git mv，历史跟得上；挪走后空下来的目录一并删掉。
 * 照 vue-tsx-pro 的 scripts/structure/move.mjs，换成任意的包。
 *
 * 用法：node tools/move.ts <包目录> <旧路径>=<新路径> …（路径相对包目录）
 *   node tools/move.ts packages/editor src/ui/Inspector.tsx=src/ui/panels/Inspector.tsx
 * 之后跑类型检查和测试。别的包经包名导入的不受影响（只改 exports 的指向）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const [packageArg, ...pairArgs] = process.argv.slice(2);
const pairs = pairArgs.map((arg) => arg.split('='));
if (!packageArg || pairs.length === 0 || pairs.some((pair) => pair.length !== 2)) {
  console.error('usage: node tools/move.ts <package dir> <old path>=<new path> ...');
  process.exit(1);
}
const packageDir = resolve(packageArg);

/** 旧绝对路径 → 新绝对路径。 */
const moves = new Map<string, string>();
for (const [from, to] of pairs as [string, string][]) {
  const source = join(packageDir, from), target = join(packageDir, to);
  if (!existsSync(source)) throw new Error(`no such file: ${from}`);
  if (existsSync(target)) throw new Error(`target exists: ${to}`);
  moves.set(source, target);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sources(path);
    return /\.(tsx?|mts)$/.test(entry.name) ? [path] : [];
  });
}

/** 相对导入指向的文件（补全扩展名）；不是文件时 undefined。 */
function resolveImport(importer: string, specifier: string): string | undefined {
  const base = resolve(dirname(importer), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/** 从 from 文件指向 to 文件的导入路径：原来没写扩展名的去掉 .ts、.tsx。 */
function specifierFor(from: string, to: string, keepExtension: boolean): string {
  let path = relative(dirname(from), to).split('\\').join('/');
  if (!keepExtension) path = path.replace(/\.tsx?$/, '');
  return path.startsWith('.') ? path : `./${path}`;
}

const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;

const GLOB = /(\bimport\.meta\.glob(?:<[^>]*>)?\(\s*)(['"])(\.{1,2}\/[^'"]*)\2/g;

const rewrites = new Map<string, string>();
for (const file of sources(packageDir)) {
  const text = readFileSync(file, 'utf8');
  const newFile = moves.get(file) ?? file;
  const next = text.replace(IMPORT, (whole, prefix: string, quote: string, specifier: string) => {
    const [path = '', query = ''] = specifier.split(/(?=\?)/);
    const target = resolveImport(file, path);
    if (!target) return whole;
    const newTarget = moves.get(target) ?? target;
    if (newTarget === target && newFile === file) return whole;
    return `${prefix}${quote}${specifierFor(newFile, newTarget, /\.tsx?$/.test(path))}${query}${quote}`;
  });
  // import.meta.glob 的相对路径：glob 前面那段目录照新位置重算（目录本身不挪）
  const globbed = newFile === file ? next : next.replace(GLOB, (whole, prefix: string, quote: string, pattern: string) => {
    const cut = pattern.slice(0, pattern.search(/[*{[]/) + 1 || pattern.length).lastIndexOf('/');
    const dir = resolve(dirname(file), pattern.slice(0, cut));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return whole;
    let base = relative(dirname(newFile), dir).split('\\').join('/');
    if (!base.startsWith('.')) base = `./${base}`;
    return `${prefix}${quote}${base}${pattern.slice(cut)}${quote}`;
  });
  if (globbed !== text) rewrites.set(file, globbed);
}

// package.json 的 exports、bin 指向挪走的文件时跟着改
const manifestFile = join(packageDir, 'package.json');
let manifest = existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : undefined;
if (manifest) {
  for (const [from, to] of moves) {
    const old = `./${relative(packageDir, from).split('\\').join('/')}`, next = `./${relative(packageDir, to).split('\\').join('/')}`;
    manifest = manifest.split(`"${old}"`).join(`"${next}"`);
  }
}

for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync('git', ['mv', from, to], { cwd: packageDir });
}
for (const [file, text] of rewrites) writeFileSync(moves.get(file) ?? file, text);
if (manifest !== undefined) writeFileSync(manifestFile, manifest);

for (const from of moves.keys()) {
  for (let dir = dirname(from); dir !== packageDir && existsSync(dir); dir = dirname(dir)) {
    if (readdirSync(dir).length > 0) break;
    rmdirSync(dir);
  }
}

console.log(`moved ${moves.size} files, rewrote imports in ${rewrites.size} files:\n${[...moves].map(([from, to]) => `  ${relative(packageDir, from)} -> ${relative(packageDir, to)}`).join('\n')}`);
