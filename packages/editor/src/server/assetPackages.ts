/**
 * 共用资源的包（@stride-ts/assets 这类：字体、扫描材质这些不进主仓库 git 的资源，单独的仓库发成包，用户 2026-11-22 定）：
 * 包的 package.json 里 `stride.content` 指着包里的一个内容文件夹（比如 `content/Shared`）。工程依赖了这类包时，把那个文件夹同步
 * 成工程内容目录下同名的文件夹（`Shared/`），场景、材质照常按 `Shared/...` 引用；那个文件夹是生成的（样例的 .gitignore 里），
 * 改资源去改资源仓库。
 *
 * 开发服务器、编辑器后端（命令行、MCP）打开工程时、构建之前各调一次；包没换（按 pnpm 装的目录的真实路径，换了版本或临时版就变）
 * 时什么都不做。
 */
import { existsSync } from 'node:fs';
import { cp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 同步记录：同步进来的文件夹里放一份，记着是哪个包的哪一份。 */
const STAMP = '.package.json';

/** 把工程（root）依赖的资源包同步进内容目录（contentDir）；返回同步了的文件夹（没变的不算）。 */
export async function syncAssetPackages(root: string, contentDir: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const synced: string[] = [];
  const mounts = new Map<string, string>();
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const directory = path.join(root, 'node_modules', ...name.split('/'));
    if (!existsSync(path.join(directory, 'package.json'))) continue;
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { version?: string; stride?: { content?: string } };
    const content = pkg.stride?.content;
    if (!content) continue;
    const source = path.resolve(directory, content), folder = path.basename(source);
    if (mounts.has(folder)) throw new Error(`${root}: the asset packages ${mounts.get(folder)} and ${name} both provide the content folder '${folder}'`);
    mounts.set(folder, name);
    const target = path.join(contentDir, folder);
    // pnpm 装的目录的真实路径里带着包的哈希：换了版本、换了临时版都会变
    const stamp = JSON.stringify({ name, version: pkg.version, from: await realpath(source) });
    if ((await readFile(path.join(target, STAMP), 'utf8').catch(() => '')) === stamp) continue;
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    await writeFile(path.join(target, STAMP), stamp);
    synced.push(folder);
  }
  return synced;
}
