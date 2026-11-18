/**
 * 截图对比用的 PNG 编解码（8 位 RGB/RGBA、不隔行，浏览器和 Stride 截图工具输出的都是这种）和逐像素比较。
 * 用 node:zlib，不依赖图像库。
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA，每像素 4 字节。 */
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(file: Uint8Array): Image {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const [bitDepth, , , , interlace] = [chunk[8], chunk[9], chunk[10], chunk[11], chunk[12]];
      colorType = chunk[9]!;
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) throw new Error(`unsupported PNG: bit depth ${bitDepth}, color type ${colorType}, interlace ${interlace}`);
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride, above = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels]! : 0;
      const b = y > 0 ? pixels[above + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[above + x - channels]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      pixels[row + x] = (line[x]! + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: pixels };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = pixels[i * 3]!;
    data[i * 4 + 1] = pixels[i * 3 + 1]!;
    data[i * 4 + 2] = pixels[i * 3 + 2]!;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function encodePng({ width, height, data }: Image): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Sub 滤波：截图里大片相近的颜色，比不滤波压得小
    raw[y * (stride + 1)] = 1;
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = (data[y * stride + x]! - (x >= 4 ? data[y * stride + x - 4]! : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ImageDiff {
  readonly width: number;
  readonly height: number;
  /** 每个像素取 RGB 三个通道里差得最多的那个（0..255），下面都按它算。 */
  readonly max: number;
  readonly mean: number;
  /** 每个通道 b 减 a 的平均（有符号），看整体偏亮还是偏暗、偏哪个颜色。 */
  readonly meanSignedRgb: readonly [number, number, number];
  /** 差超过 1、2、8、32 的像素数。 */
  readonly over: Readonly<Record<'1' | '2' | '8' | '32', number>>;
  /** 差超过 threshold 的像素的范围 [x, y, 宽, 高]，没有时为 null。 */
  readonly bounds: readonly [number, number, number, number] | null;
  /** 差放大 amplify 倍的图。 */
  readonly image: Image;
}

/** 逐像素比较两张同样大小的图（忽略 alpha），a 是参考。 */
export function diffImages(a: Image, b: Image, { threshold = 2, amplify = 16 } = {}): ImageDiff {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size differs: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const data = new Uint8Array(a.data.length);
  const over = { '1': 0, '2': 0, '8': 0, '32': 0 };
  let max = 0, sum = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const signed = [0, 0, 0];
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      signed[c]! += b.data[i + c]! - a.data[i + c]!;
      const channel = Math.abs(a.data[i + c]! - b.data[i + c]!);
      data[i + c] = Math.min(255, channel * amplify);
      d = Math.max(d, channel);
    }
    data[i + 3] = 255;
    max = Math.max(max, d);
    sum += d;
    if (d > 1) over['1']++;
    if (d > 2) over['2']++;
    if (d > 8) over['8']++;
    if (d > 32) over['32']++;
    if (d > threshold) {
      const x = p % a.width, y = Math.floor(p / a.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    width: a.width,
    height: a.height,
    max,
    mean: sum / (a.width * a.height),
    meanSignedRgb: signed.map((s) => s / (a.width * a.height)) as [number, number, number],
    over,
    bounds: maxX < 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1],
    image: { width: a.width, height: a.height, data },
  };
}
