/**
 * 高斯泼溅的运行时文件（`.splat`，资源种类 splats）：编辑器从 3DGS 的 .ply 导入时写（pipeline/src/splats.ts），运行时原样上传进
 * 存储缓冲（rendering/splats/SplatRenderer.ts）。纯函数，引擎、编辑器后端、测试都用。
 *
 * 布局（小端）：48 字节的头——魔数 'SPLT'、版本、个数、球谐的阶数（0..3），包围盒的 min、max（各 3 个 f32），球谐系数的量化
 * 范围（f32，系数在 ±它之间），1 个保留的 u32；后面每个泼溅 SPLAT_WORDS 个 u32：位置 3 个 f32；缩放 3 个 f16（线性的半轴长，
 * 米）占两个字；旋转 4 个 snorm8（四元数 xyzw，w ≥ 0）；颜色 rgba8（rgb 是显示空间的 sRGB——球谐的 0 阶，a 是不透明度）。
 * 一个泼溅 28 字节，标准的 .ply 是 56 到 248 字节。
 *
 * 有高阶球谐（视角相关的颜色）时后面再接一段：每个泼溅 shWords(阶数) 个 u32，系数按通道排（r 的 1..n 个、g 的、b 的，
 * n = 3、8、15），每个 8 位：round((系数 / 范围 · 0.5 + 0.5) · 255)。3 阶时一个泼溅多 48 字节。版本 1 的文件没有这一段。
 */

export const SPLAT_MAGIC = 0x544c5053;
export const SPLAT_VERSION = 2;
export const SPLAT_HEADER_BYTES = 48;
/** 一个泼溅几个 u32。 */
export const SPLAT_WORDS = 7;

/** 每个通道的高阶球谐系数个数（1、2、3 阶）。 */
export function shCoefficients(bands: number): number {
  return [0, 3, 8, 15][bands] ?? 0;
}

/** 一个泼溅的高阶球谐占几个 u32（三个通道，每个系数 8 位）。 */
export function shWords(bands: number): number {
  return Math.ceil((shCoefficients(bands) * 3) / 4);
}

/** 导入器给的泼溅（每个泼溅的值连着放）。 */
export interface SplatSource {
  readonly count: number;
  /** xyz。 */
  readonly positions: Float32Array;
  /** 三个半轴长（线性，米）。 */
  readonly scales: Float32Array;
  /** 四元数 xyzw（不必单位化）。 */
  readonly rotations: Float32Array;
  /** rgb 是显示空间的颜色（0..1，球谐的 0 阶），a 是不透明度（0..1）。 */
  readonly colors: Float32Array;
  /** 高阶球谐的阶数（0 是没有）。 */
  readonly shBands?: number;
  /** 高阶球谐的系数：每个泼溅 shCoefficients(shBands) · 3 个，按通道排（r 的、g 的、b 的）。 */
  readonly sh?: Float32Array;
}

export interface DecodedSplats {
  readonly count: number;
  /** 每个泼溅 SPLAT_WORDS 个字（直接上传进存储缓冲）。 */
  readonly words: Uint32Array;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** 高阶球谐的阶数（0 是没有）。 */
  readonly shBands: number;
  /** 系数的量化范围：8 位的 0..255 对着 -shRange..shRange。 */
  readonly shRange: number;
  /** 每个泼溅 shWords(shBands) 个字（直接上传进存储缓冲）；没有时是空的。 */
  readonly sh: Uint32Array;
}

/** 写成 .splat 文件的字节。 */
export function encodeSplats(source: SplatSource): Uint8Array {
  const { count, positions, scales, rotations, colors } = source;
  const bands = source.sh ? source.shBands ?? 0 : 0;
  const shPer = shWords(bands);
  const bytes = new Uint8Array(SPLAT_HEADER_BYTES + count * (SPLAT_WORDS + shPer) * 4);
  const header = new DataView(bytes.buffer);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const value = positions[i * 3 + k]!;
      min[k] = Math.min(min[k]!, value);
      max[k] = Math.max(max[k]!, value);
    }
  }
  if (count === 0) min.fill(0), max.fill(0);
  header.setUint32(0, SPLAT_MAGIC, true);
  header.setUint32(4, SPLAT_VERSION, true);
  header.setUint32(8, count, true);
  header.setUint32(12, bands, true);
  for (let k = 0; k < 3; k++) {
    header.setFloat32(16 + k * 4, min[k]!, true);
    header.setFloat32(28 + k * 4, max[k]!, true);
  }
  const floats = new Float32Array(bytes.buffer, SPLAT_HEADER_BYTES), words = new Uint32Array(bytes.buffer, SPLAT_HEADER_BYTES);
  for (let i = 0; i < count; i++) {
    const o = i * SPLAT_WORDS;
    floats[o] = positions[i * 3]!;
    floats[o + 1] = positions[i * 3 + 1]!;
    floats[o + 2] = positions[i * 3 + 2]!;
    words[o + 3] = (toHalf(scales[i * 3]!) | (toHalf(scales[i * 3 + 1]!) << 16)) >>> 0;
    words[o + 4] = toHalf(scales[i * 3 + 2]!);
    let [x, y, z, w] = [rotations[i * 4]!, rotations[i * 4 + 1]!, rotations[i * 4 + 2]!, rotations[i * 4 + 3]!];
    const length = Math.hypot(x, y, z, w) || 1;
    // q 和 -q 是同一个旋转：统一成 w ≥ 0
    const sign = w < 0 ? -1 : 1;
    [x, y, z, w] = [(x * sign) / length, (y * sign) / length, (z * sign) / length, (w * sign) / length];
    words[o + 5] = (snorm8(x) | (snorm8(y) << 8) | (snorm8(z) << 16) | (snorm8(w) << 24)) >>> 0;
    words[o + 6] = (unorm8(colors[i * 4]!) | (unorm8(colors[i * 4 + 1]!) << 8) | (unorm8(colors[i * 4 + 2]!) << 16) | (unorm8(colors[i * 4 + 3]!) << 24)) >>> 0;
  }
  if (bands > 0) {
    // 量化范围取所有系数绝对值的最大（至少 1e-6）：8 位在 ±它之间
    const sh = source.sh!;
    let range = 1e-6;
    for (const value of sh) range = Math.max(range, Math.abs(value));
    header.setFloat32(40, range, true);
    const per = shCoefficients(bands) * 3;
    const shBytes = new Uint8Array(bytes.buffer, SPLAT_HEADER_BYTES + count * SPLAT_WORDS * 4, count * shPer * 4);
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < per; k++) shBytes[i * shPer * 4 + k] = Math.round(Math.max(0, Math.min(1, (sh[i * per + k]! / range) * 0.5 + 0.5)) * 255);
    }
  }
  return bytes;
}

/** 读 .splat 文件；格式不对时报错（带 where）。 */
export function decodeSplats(buffer: ArrayBuffer, where = 'splats'): DecodedSplats {
  if (buffer.byteLength < SPLAT_HEADER_BYTES) throw new Error(`${where}: too short for a .splat file`);
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== SPLAT_MAGIC) throw new Error(`${where}: not a .splat file`);
  const version = header.getUint32(4, true);
  if (version !== 1 && version !== SPLAT_VERSION) throw new Error(`${where}: .splat version ${version}, expected ${SPLAT_VERSION}`);
  const count = header.getUint32(8, true);
  // 版本 1 没有球谐（那个字是保留的 0）
  const shBands = version === 1 ? 0 : header.getUint32(12, true);
  if (shBands > 3) throw new Error(`${where}: ${shBands} spherical harmonics bands (at most 3)`);
  const shPer = shWords(shBands);
  if (buffer.byteLength < SPLAT_HEADER_BYTES + count * (SPLAT_WORDS + shPer) * 4) throw new Error(`${where}: truncated (${count} splats)`);
  const vector = (offset: number) => [header.getFloat32(offset, true), header.getFloat32(offset + 4, true), header.getFloat32(offset + 8, true)] as const;
  return {
    count, words: new Uint32Array(buffer, SPLAT_HEADER_BYTES, count * SPLAT_WORDS), min: vector(16), max: vector(28),
    shBands, shRange: shBands > 0 ? header.getFloat32(40, true) : 0, sh: new Uint32Array(buffer, SPLAT_HEADER_BYTES + count * SPLAT_WORDS * 4, count * shPer),
  };
}

const snorm8 = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 127) & 0xff;
const unorm8 = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);

const halfFloat = new Float32Array(1), halfBits = new Uint32Array(halfFloat.buffer);

/** f32 → f16 的位（就近舍入，溢出成无穷，太小的成非规格化数或 0）。 */
function toHalf(value: number): number {
  halfFloat[0] = value;
  const bits = halfBits[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const m = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
}
