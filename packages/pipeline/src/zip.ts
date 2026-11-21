/**
 * 读 zip 包（只读，不写）：按中央目录列出文件，存储（不压缩）和 deflate 两种，用 node:zlib 解。SOG 泼溅（一个 zip 里放
 * meta.json 和几张 WebP）用；不支持 zip64 和加密。
 */
import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** zip 里的文件名 → 解开的内容（按需解：调用 read 时才解压）。 */
export interface ZipArchive {
  readonly names: readonly string[];
  /** 读一个文件；没有时返回 undefined。 */
  read(name: string): Uint8Array | undefined;
}

/** 打开一个 zip 包。不是 zip、是 zip64、用了别的压缩方法时报错（带 where）。 */
export function openZip(bytes: Uint8Array, where: string): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 目录尾在最后 22 字节加最多 64 KB 的注释里
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`${where}: not a zip archive`);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (offset === 0xffffffff || count === 0xffff) throw new Error(`${where}: zip64 archives are not supported`);
  const entries = new Map<string, { method: number; size: number; local: number }>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== DIRECTORY_ENTRY) throw new Error(`${where}: broken zip directory`);
    const nameLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { method: view.getUint16(offset + 10, true), size: view.getUint32(offset + 20, true), local: view.getUint32(offset + 42, true) });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      if (view.getUint32(entry.local, true) !== LOCAL_HEADER) throw new Error(`${where}: broken zip entry ${name}`);
      const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
      const data = bytes.subarray(start, start + entry.size);
      if (entry.method === 0) return data;
      if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`${where}: ${name} uses zip compression method ${entry.method} (only stored and deflate are supported)`);
    },
  };
}
