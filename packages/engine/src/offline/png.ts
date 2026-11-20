/**
 * PNG 编码（图像序列导出用）：8 位 RGBA，每行按 Paeth 过滤，zlib 压缩用浏览器和 Node 都有的 CompressionStream('deflate')。
 * 不用 OffscreenCanvas.convertToBlob：窗口被挡住时浏览器把它节流到每张约一秒。
 */

/** 把一行紧挨一行的 RGBA 编成 PNG。 */
export async function encodePng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array<ArrayBuffer>> {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: expected ${width * height * 4} bytes for ${width}x${height}, got ${rgba.length}`);
  const row = width * 4;
  // 每行前面一个字节的过滤类型（4 = Paeth）
  const filtered = new Uint8Array((row + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (row + 1), at = y * row, above = at - row;
    filtered[out] = 4;
    for (let i = 0; i < row; i++) {
      const a = i >= 4 ? rgba[at + i - 4]! : 0;
      const b = y > 0 ? rgba[above + i]! : 0;
      const c = i >= 4 && y > 0 ? rgba[above + i - 4]! : 0;
      filtered[out + 1 + i] = (rgba[at + i]! - paeth(a, b, c)) & 0xff;
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([filtered]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 位、RGBA、deflate、标准过滤、不隔行
  return concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0)));
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
