/**
 * 后端写文件、查内容路径的小工具：先写临时文件再改名（读的人不会读到写了一半的），内容路径不许跑出内容目录，资源内容的哈希。
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './http.ts';

/** 内容路径（相对内容目录、正斜杠、不带扩展名）不能是空的，不能跑出内容目录。 */
export function checkContentPath(assetPath: string): string {
  if (typeof assetPath !== 'string' || assetPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') || /[\\:]/.test(assetPath)) {
    throw new HttpError(400, `'${assetPath}' is not a content path`);
  }
  return assetPath;
}

let atomicWrites = 0;

/**
 * 先写到旁边的临时文件再改名：读的人（开发服务器、游戏页面）不会读到写了一半的。临时文件每次一个名字（同一个文件连着写时
 * 不互相盖），改名没成就删掉它，不留在内容目录里。
 */
export async function writeAtomically(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${++atomicWrites}.tmp`;
  await writeFile(temporary, content);
  try {
    await renameRetrying(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Windows 上目标文件正被别的进程打开着（开发服务器在读它烘模型、监视文件的、杀毒扫刚写的大文件）时改名报 EPERM、EBUSY：等一下
 * 再试，等的间隔翻倍、最长半秒，最多等 RENAME_PATIENCE 毫秒（同 graceful-fs 的做法；杀毒扫一个几十 MB 的泼溅文件一秒多也是有的）。
 */
async function renameRetrying(from: string, to: string): Promise<void> {
  const start = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (performance.now() - start > RENAME_PATIENCE || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, 10 * 2 ** attempt)));
    }
  }
}

/** 改名最多等多久（毫秒）。 */
const RENAME_PATIENCE = 10_000;

/** 资源内容的哈希（解析过的 JSON 重新序列化：空白、换行不算改了）。 */
export function contentHash(content: unknown): string {
  return createHash('sha1').update(JSON.stringify(content)).digest('hex');
}
