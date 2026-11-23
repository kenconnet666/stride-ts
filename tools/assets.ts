/**
 * 共用资源的包 @stride-ts/assets（单独的仓库 kenconnet666/world-engine-assets，用户 2026-11-22 定：字体、图片这类不适合进 git 的资源
 * 放单独的仓库，先用 GitHub Release 打包安装，同 vue-tsx-pro 的字体包）：
 *
 *   node tools/assets.ts build             照资源仓库的 sources/sources.json 用编辑器的导入器把源文件（ttf、扫描贴图）导入成
 *                                          content/Shared 下引擎能用的内容；源文件没变的跳过（哈希记在 sources/.built.json）
 *   node tools/assets.ts dev               资源仓库打包、发成预发行版 dev-<提交>（仓库要先提交推送），override 指过去，pnpm install
 *   node tools/assets.ts release <版本>    同上，发正式版 v<版本>（版本要和资源仓库 package.json 的一样）
 *
 * 资源仓库的位置可以用环境变量 STRIDE_ASSETS 改，默认 C:/code/stride-ts-assets。
 */
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EditorBackend, type MaterialCredit } from '@stride-ts/editor/server';

const root = path.resolve(import.meta.dirname, '..');
const assets = process.env['STRIDE_ASSETS'] ?? 'C:/code/stride-ts-assets';
const workspace = path.join(root, 'pnpm-workspace.yaml');
const OVERRIDE = /^( {2}'@stride-ts\/assets': ).*$/m;
const RELEASES = 'https://github.com/kenconnet666/world-engine-assets/releases/download';

interface Sources {
  readonly fonts: readonly { readonly file: string; readonly folder: string; readonly name: string }[];
  /** 一套扫描材质：parallaxDepth 是有高度贴图时视差的最深处（米，默认 1 厘米，按这套材质实际的起伏给）。 */
  readonly materials: readonly { readonly folder: string; readonly name: string; readonly files: readonly string[]; readonly credit?: MaterialCredit; readonly parallaxDepth?: number }[];
}

async function build(): Promise<void> {
  const sources = JSON.parse(readFileSync(path.join(assets, 'sources', 'sources.json'), 'utf8')) as Sources;
  const builtFile = path.join(assets, 'sources', '.built.json');
  const built = existsSync(builtFile) ? JSON.parse(readFileSync(builtFile, 'utf8')) as Record<string, string> : {};
  // 源文件和导入的选项（名字、署名、视差的深度）一起算：改了选项也重新导入
  const hashOf = (files: readonly string[], options: object = {}) => {
    const hash = createHash('sha256').update(JSON.stringify(options));
    for (const file of files) hash.update(readFileSync(path.join(assets, 'sources', file)));
    return hash.digest('hex');
  };
  // 重新导入前删掉上一次的输出：导入器遇到同名的会另起一个名字（"…2"），不覆盖
  const clear = (folder: string, name: string) => {
    const directory = path.join(assets, 'content', folder);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      if (entry === name || entry.startsWith(`${name}.`)) rmSync(path.join(directory, entry), { recursive: true, force: true });
    }
  };
  const pending = [...sources.fonts.map((font) => ({ key: `font:${font.folder}/${font.name}`, files: [font.file], ...font })), ...sources.materials.map((material) => ({ key: `material:${material.folder}/${material.name}`, ...material }))]
    .filter((item) => built[item.key] !== hashOf(item.files, item));
  for (const item of pending) clear(item.folder, item.name);
  const backend = await EditorBackend.open(assets, assets);
  for (const font of sources.fonts) {
    const key = `font:${font.folder}/${font.name}`, hash = hashOf([font.file], { key, files: [font.file], ...font });
    if (built[key] === hash) continue;
    const bytes = await readFile(path.join(assets, 'sources', font.file));
    const result = await backend.importFile(font.folder, font.name + path.extname(font.file), bytes);
    console.log(`${key}: ${result.asset.kind} ${result.asset.path}${result.warnings.length ? ` (${result.warnings.join('; ')})` : ''}`);
    built[key] = hash;
  }
  for (const material of sources.materials) {
    const key = `material:${material.folder}/${material.name}`, hash = hashOf(material.files, { key, ...material });
    if (built[key] === hash) continue;
    const files = await Promise.all(material.files.map(async (file) => ({ name: path.basename(file), bytes: await readFile(path.join(assets, 'sources', file)) })));
    const result = await backend.importMaterialSet(material.folder, files, { name: material.name, credit: material.credit, parallaxDepth: material.parallaxDepth });
    console.log(`${key}: ${result.asset.kind} ${result.asset.path}${result.warnings.length ? ` (${result.warnings.join('; ')})` : ''}`);
    built[key] = hash;
  }
  writeFileSync(builtFile, `${JSON.stringify(built, null, 1)}\n`);
}

/** 打包资源仓库、发 GitHub Release（tag 是标签，prerelease 是预发行版），返回 tgz 的下载地址。 */
function publish(tag: string, prerelease: boolean): string {
  const version = (JSON.parse(readFileSync(path.join(assets, 'package.json'), 'utf8')) as { version: string }).version;
  const dirty = execFileSync('git', ['-C', assets, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`${assets} has uncommitted changes; commit and push first:\n${dirty}`);
  // 参数是固定的词：Windows 上 npm 是 .cmd，经 shell 起
  const tgz = execSync('npm pack --silent', { cwd: assets, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1)!;
  if (tgz !== `stride-ts-assets-${version}.tgz`) throw new Error(`npm pack wrote ${tgz}`);
  const commit = execFileSync('git', ['-C', assets, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('gh', ['release', 'create', tag, path.join(assets, tgz), '--repo', 'kenconnet666/world-engine-assets', '--target', commit,
    '--title', tag, '--notes', prerelease ? `临时版（提交 ${commit.slice(0, 10)}）` : `@stride-ts/assets ${version}`, ...(prerelease ? ['--prerelease'] : [])], { stdio: 'inherit' });
  return `${RELEASES}/${tag}/${tgz}`;
}

function setOverride(target: string): void {
  const text = readFileSync(workspace, 'utf8');
  if (!OVERRIDE.test(text)) throw new Error(`no '@stride-ts/assets' override in ${workspace}`);
  writeFileSync(workspace, text.replace(OVERRIDE, `$1${target}`));
  execSync('pnpm install', { cwd: root, stdio: 'inherit' });
  console.log(`@stride-ts/assets → ${target}`);
}

const [command, version] = process.argv.slice(2);
if (command === 'build') {
  await build();
  process.exit(0);
} else if (command === 'dev') {
  const commit = execFileSync('git', ['-C', assets, 'rev-parse', '--short=10', 'HEAD'], { encoding: 'utf8' }).trim();
  setOverride(publish(`dev-${commit}`, true));
} else if (command === 'release' && version && /^\d+\.\d+\.\d+$/.test(version)) {
  setOverride(publish(`v${version}`, false));
} else {
  console.error('usage: node tools/assets.ts build | dev | release <version>');
  process.exit(2);
}
