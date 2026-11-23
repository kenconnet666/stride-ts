/**
 * 生成资源的代码的版本：引擎里生成模型的代码（`modeling/`）、内容格式（`content/formats/`）、pipeline 的烘焙、编辑器的烘焙表的源文件，
 * 加上装着的原生包的位置（换了预发行版，路径里的哈希就变）的哈希。烘焙记录的哈希带上它：代码改了，按旧代码烘的生成物都算过期，
 * 打开工程、再存同样内容时补烘（出过：改了货架、杂物的图集大小，源文件没变，旧的大图集一直留着）。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 算一次（进程里的代码不会变）。 */
let version: Promise<string> | undefined;

export function generatorVersion(): Promise<string> {
  return (version ??= compute());
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
