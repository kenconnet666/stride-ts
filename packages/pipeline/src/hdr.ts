/**
 * HDR 图像：读 DDS 里的浮点立方体贴图（Stride 的 HDR 天空盒用它），RGBA16F 或 RGBA32F，老式 FourCC 和 DX10 头都认，
 * 统一转成 RGBA32F；面的顺序和行的方向就是 DDS 的（+X -X +Y -Y +Z -Z，行从上到下），和 WebGPU 一致。
 * 再加上导出用的两种紧凑格式：半精度（RGBA16F）和 RGB9E5。
 */

export interface FloatCubemap {
  readonly size: number;
  /** 各级 mip（文件里有几级就是几级），每级 6 个面连续，RGBA32F。 */
  readonly levels: readonly Float32Array[];
}

const DDS_MAGIC = 0x20534444; // 'DDS '
const DDSCAPS2_CUBEMAP = 0x200;
const DDPF_FOURCC = 0x4;
/** 老式 FourCC 里的 D3DFMT 编号。 */
const D3DFMT_A16B16G16R16F = 113;
const D3DFMT_A32B32G32R32F = 116;
const FOURCC_DX10 = 0x30315844; // 'DX10'
const DXGI_R32G32B32A32_FLOAT = 2;
const DXGI_R16G16B16A16_FLOAT = 10;
const DDS_RESOURCE_MISC_TEXTURECUBE = 0x4;

export function readDdsCubemap(bytes: Uint8Array, source: string): FloatCubemap {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 128 || view.getUint32(0, true) !== DDS_MAGIC) throw new Error(`${source} is not a DDS file`);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const mipCount = Math.max(1, view.getUint32(28, true));
  const pixelFlags = view.getUint32(80, true);
  const fourCC = view.getUint32(84, true);
  let cube = (view.getUint32(112, true) & DDSCAPS2_CUBEMAP) !== 0;
  let dataStart = 128;
  let half: boolean;
  if (!(pixelFlags & DDPF_FOURCC)) throw new Error(`${source}: only floating-point DDS files are supported`);
  if (fourCC === FOURCC_DX10) {
    const dxgi = view.getUint32(128, true);
    cube ||= (view.getUint32(136, true) & DDS_RESOURCE_MISC_TEXTURECUBE) !== 0;
    dataStart = 148;
    if (dxgi !== DXGI_R16G16B16A16_FLOAT && dxgi !== DXGI_R32G32B32A32_FLOAT) throw new Error(`${source}: DXGI format ${dxgi} is not supported (need RGBA16F or RGBA32F)`);
    half = dxgi === DXGI_R16G16B16A16_FLOAT;
  } else {
    if (fourCC !== D3DFMT_A16B16G16R16F && fourCC !== D3DFMT_A32B32G32R32F) throw new Error(`${source}: format ${fourCC} is not supported (need RGBA16F or RGBA32F)`);
    half = fourCC === D3DFMT_A16B16G16R16F;
  }
  if (!cube || width !== height) throw new Error(`${source} is not a square cubemap`);

  // DDS 按面存：每个面的所有 mip 连续，再到下一个面；这里换成按级存
  const texelBytes = half ? 8 : 16;
  const levels = Array.from({ length: mipCount }, (_, level) => new Float32Array(6 * Math.max(1, width >> level) ** 2 * 4));
  let offset = dataStart;
  for (let face = 0; face < 6; face++) {
    for (let level = 0; level < mipCount; level++) {
      const edge = Math.max(1, width >> level);
      const floats = edge * edge * 4;
      if (offset + edge * edge * texelBytes > bytes.byteLength) throw new Error(`${source} is truncated`);
      const target = levels[level]!.subarray(face * floats, (face + 1) * floats);
      for (let i = 0; i < floats; i++) target[i] = half ? halfToFloat(view.getUint16(offset + i * 2, true)) : view.getFloat32(offset + i * 4, true);
      offset += edge * edge * texelBytes;
    }
  }
  return { size: width, levels };
}

export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** float 转半精度的位（舍入到最近），超出范围的变成无穷。 */
export function floatToHalf(value: number): number {
  FLOAT[0] = value;
  const bits = INT[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (((bits >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const m = (mantissa | 0x800000) >> (1 - exponent);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | ((exponent << 10) + ((mantissa + 0x1000) >> 13));
}

const FLOAT = new Float32Array(1);
const INT = new Uint32Array(FLOAT.buffer);

export function toHalf(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = floatToHalf(values[i]!);
  return out;
}

/**
 * RGBA32F 转 RGB9E5（三个 9 位尾数共用一个 5 位指数，丢掉 alpha），按 D3D/WebGPU 的 rgb9e5ufloat：
 * R 在低 9 位，然后 G、B，指数在最高 5 位。负数和 NaN 当 0，太大的截到最大值 65408。
 */
export function toRgb9e5(rgba: Float32Array): Uint32Array {
  const out = new Uint32Array(rgba.length / 4);
  const MANTISSA_BITS = 9, BIAS = 15, MAX = ((2 ** MANTISSA_BITS - 1) / 2 ** MANTISSA_BITS) * 2 ** (31 - BIAS);
  const clamp = (v: number) => (v > 0 ? Math.min(v, MAX) : 0);
  for (let i = 0; i < out.length; i++) {
    const r = clamp(rgba[i * 4]!), g = clamp(rgba[i * 4 + 1]!), b = clamp(rgba[i * 4 + 2]!);
    const max = Math.max(r, g, b);
    let exponent = Math.max(-BIAS - 1, Math.floor(Math.log2(max || 2 ** -(BIAS + 1)))) + 1 + BIAS;
    let scale = 2 ** (exponent - BIAS - MANTISSA_BITS);
    if (Math.floor(max / scale + 0.5) === 2 ** MANTISSA_BITS) {
      scale *= 2;
      exponent += 1;
    }
    const m = (v: number) => Math.floor(v / scale + 0.5);
    out[i] = (m(r) | (m(g) << 9) | (m(b) << 18) | (exponent << 27)) >>> 0;
  }
  return out;
}

/** RGB9E5 转回 RGB（测试和调试用）。 */
export function fromRgb9e5(packed: number): [number, number, number] {
  const scale = 2 ** ((packed >>> 27) - 15 - 9);
  return [(packed & 0x1ff) * scale, ((packed >>> 9) & 0x1ff) * scale, ((packed >>> 18) & 0x1ff) * scale];
}
