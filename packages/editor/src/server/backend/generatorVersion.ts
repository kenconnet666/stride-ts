/**
 * 生成资源的代码的版本：引擎里生成模型的代码（`modeling/`）、内容格式（`content/formats/`）、pipeline 的烘焙、编辑器的烘焙表的源文件，
 * 加上装着的原生包的位置（换了预发行版，路径里的哈希就变）的哈希。烘焙记录的哈希带上它：代码改了，按旧代码烘的生成物都算过期，
 * 打开工程、再存同样内容时补烘（出过：改了货架、杂物的图集大小，源文件没变，旧的大图集一直留着）。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 这个进程加载的代码的版本：启动后算一次（进程里加载了的代码不会变）。 */
let version: Promise<string> | undefined;

export function generatorVersion(): Promise<string> {
  return (version ??= compute());
}

/** 磁盘上现在的代码的版本（最近一次算的，一秒内不重算：一次要读几百个源文件，八十毫秒上下）。 */
let onDisk: { readonly at: number; readonly version: Promise<string> } | undefined;

/**
 * 进程加载的生成代码已经旧了：磁盘上的源文件在进程起来以后改过。旧代码烘出来的会盖掉新代码烘的（出过：开发服务器开着时改了
 * 货架的生成器，MCP 服务用新代码烘了货架，开发服务器看见商品文件变了，用它加载的旧代码把用着商品的货架又烘了一遍）。
 */
export async function generatorCodeIsStale(): Promise<boolean> {
  const now = Date.now();
  if (!onDisk || now - onDisk.at > 1000) onDisk = { at: now, version: compute() };
  return (await onDisk.version) !== (await generatorVersion());
}

async function compute(): Promise<string> {
  const hash = createHash('sha1');
  const file = (specifier: string) => fileURLToPath(import.meta.resolve(specifier));
  const folders = [path.dirname(file('@stride-ts/engine/modeling')), path.dirname(file('@stride-ts/engine/content-format')), path.dirname(file('@stride-ts/pipeline'))];
  for (const folder of folders) {
    for (const name of (await readdir(folder, { recursive: true })).filter((entry) => /\.[cm]?[jt]s$/.test(entry)).sort()) {
      hash.update(name).update(await readFile(path.join(folder, name)));
    }
  }
  hash.update(await readFile(fileURLToPath(new URL('./bakers.ts', import.meta.url))));
  hash.update(file('@stride-ts/native/tools'));
  return hash.digest('hex').slice(0, 16);
}
