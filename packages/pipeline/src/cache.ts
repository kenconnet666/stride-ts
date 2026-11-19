/**
 * 派生数据缓存：导入里贵的结果（贴图编成 KTX2）按"做法加全部输入"的哈希存在本机目录里，同样的输入下次直接取。
 * 按内容寻址，所以不会过期，只会变多；整个目录随时可以删。
 *
 *   const cache = new DerivedDataCache(path.join(os.homedir(), '.stride-ts', 'cache', 'pipeline'));
 *   const ktx2 = await cache.get('basis-uastc/1', [pixels, '2048x2048', 'srgb'], () => encode(pixels));
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class DerivedDataCache {
  readonly #directory: string;
  /** 这个对象用到现在：直接取到的次数、现算的次数。 */
  hits = 0;
  misses = 0;

  constructor(directory: string) {
    this.#directory = directory;
  }

  /**
   * recipe 是做法的名字和版本（算法或参数的含义变了就换一个），inputs 是决定结果的全部输入。缓存里有就返回它，
   * 没有就调 compute 并存起来。
   */
  async get(recipe: string, inputs: readonly (string | Uint8Array)[], compute: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const hash = createHash('sha256').update(recipe);
    // 每个输入前面带上长度，相邻的输入怎么切都不会撞
    for (const input of inputs) hash.update(`\0${input.length}\0`).update(input);
    const key = hash.digest('hex');
    const file = path.join(this.#directory, key.slice(0, 2), key);
    try {
      const cached = await readFile(file);
      this.hits++;
      return cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await compute();
    this.misses++;
    await mkdir(path.dirname(file), { recursive: true });
    // 先写到临时文件再改名：几个导入同时跑时，别人读不到写了一半的文件
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, result);
    await rename(temporary, file);
    return result;
  }
}
