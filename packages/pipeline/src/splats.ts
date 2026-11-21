/**
 * 把高斯泼溅的 .ply 转成运行时的 .splat（引擎 content/splatFile.ts）：编辑器把 .ply 拖进资源浏览器时调用。认两种 .ply：
 * - 标准的 3DGS（Kerbl 等 2023 的训练输出）：x y z、scale_0..2（对数）、rot_0..3（wxyz）、f_dc_0..2（球谐的 0 阶）、opacity
 *   （sigmoid 之前）；只有 red green blue 的普通点云也行（缩放给一个小的默认值）。
 * - SuperSplat、PlayCanvas 的压缩 .ply（element chunk 加 packed_*）：每 256 个泼溅一块，位置、缩放（对数）、颜色在块的最小、
 *   最大值之间量化，旋转是"最大的分量 2 位加另外三个各 10 位"。照 PlayCanvas 的 gsplat-compressed-data.js 解。
 * 高阶的球谐（视角相关的颜色）：标准的读 f_rest_*（按通道排，个数 9、24、45 对着 1、2、3 阶），压缩的读 element sh 的 uchar
 * （v · 8 / 255 − 4，同 PlayCanvas）。
 */
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { encodeSplats, type SplatSource } from '@stride-ts/engine/splats';

/** 球谐 0 阶的系数（f_dc 换成颜色：0.5 + SH_C0 · f_dc）。 */
const SH_C0 = 0.28209479177387814;
/** 普通点云没有缩放时每个点的半轴长（米）。 */
const POINT_SCALE = 0.01;

const TYPE_SIZES: Readonly<Record<string, number>> = {
  char: 1, int8: 1, uchar: 1, uint8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

interface PlyElement {
  readonly name: string;
  readonly count: number;
  readonly properties: readonly { readonly name: string; readonly type: string }[];
}

/** 编辑器能导入的泼溅文件（扩展名）。 */
export const SPLAT_SOURCE_EXTENSIONS = ['.ply', '.spz'] as const;

/** .ply 或 .spz 的字节 → .splat 文件的字节和泼溅个数（按 where 的扩展名分）。格式不认时报错（带 where）。 */
export function convertSplats(bytes: Uint8Array, where: string): { readonly bytes: Uint8Array; readonly count: number } {
  const source = where.toLowerCase().endsWith('.spz') ? readSpzSplats(bytes, where) : readPlySplats(bytes, where);
  return { bytes: encodeSplats(source), count: source.count };
}

const SPZ_MAGIC = 0x5053474e;
/** SPZ 里每个阶数的每个通道的球谐系数个数（到 4 阶）。 */
const SPZ_SH_DIM = [0, 3, 8, 15, 24];
/** RUB 换 RDF（y、z 取反）时 1～3 阶的每个基函数变不变号：(−1) 的 y、z 次数之和次方（基函数依次是 y z x、xy yz z² xz x²−y²、……）。 */
const SPZ_SH_FLIP = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];

/**
 * Niantic 的 SPZ（Scaniverse 等导出的开放格式）：版本 2、3 是整个文件 gzip，版本 4 是每段单独 zstd（前面一张目录）。解开以后
 * 16 字节的头（魔数 NGSP、版本、个数、球谐阶数、定点的小数位、标志），再依次是位置（每个分量 24 位有符号定点）、不透明度
 * （8 位）、颜色（8 位，0 阶球谐按 0.15 缩放过）、缩放（8 位，exp(b / 16 − 10)）、旋转（版本 2 是 xyz 各 8 位，3 起是最小三分量
 * 一个 u32）、球谐（每个系数 RGB 交错各 8 位，(b − 128) / 128）。照 PlayCanvas 的 spz-parser 和 Niantic 的 spz 库。4 阶的
 * 球谐截到 3 阶。SPZ 的坐标是 RUB（右、上、后），3DGS 的 .ply 是 RDF（右、下、前）：读出来绕 X 转半圈换成 .ply 的，同一个场景两种
 * 文件导入后一样（PlayCanvas 示例里的 biker.spz 和 biker.compressed.ply 对过）。
 */
export function readSpzSplats(bytes: Uint8Array, where: string): SplatSource {
  let header: { version: number; count: number; shDegree: number; fractionalBits: number };
  let streams: Uint8Array[];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizesFor = (count: number, version: number, shDegree: number) => [count * 9, count, count * 3, count * 3, count * (version >= 3 ? 4 : 3), count * SPZ_SH_DIM[shDegree]! * 3];
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const raw = gunzipSync(bytes);
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (v.getUint32(0, true) !== SPZ_MAGIC) throw new Error(`${where}: not an SPZ file`);
    header = { version: v.getUint32(4, true), count: v.getUint32(8, true), shDegree: v.getUint8(12), fractionalBits: v.getUint8(13) };
    if (header.shDegree >= SPZ_SH_DIM.length) throw new Error(`${where}: SPZ spherical harmonics degree ${header.shDegree}`);
    let offset = 16;
    streams = sizesFor(header.count, header.version, header.shDegree).map((size) => {
      if (offset + size > raw.length) throw new Error(`${where}: truncated SPZ`);
      const stream = raw.subarray(offset, offset + size);
      offset += size;
      return stream;
    });
  } else {
    if (bytes.length < 32 || view.getUint32(0, true) !== SPZ_MAGIC) throw new Error(`${where}: not an SPZ file`);
    header = { version: view.getUint32(4, true), count: view.getUint32(8, true), shDegree: view.getUint8(12), fractionalBits: view.getUint8(13) };
    if (header.version !== 4) throw new Error(`${where}: SPZ version ${header.version} without gzip (only version 4 stores separately compressed streams)`);
    if (header.shDegree >= SPZ_SH_DIM.length) throw new Error(`${where}: SPZ spherical harmonics degree ${header.shDegree}`);
    if (view.getUint8(14) & 0x2) throw new Error(`${where}: SPZ extensions are not supported`);
    const sizes = sizesFor(header.count, 4, header.shDegree).filter((size, i) => i < 5 || size > 0);
    const streamCount = view.getUint8(15), toc = view.getUint32(16, true);
    if (streamCount !== sizes.length) throw new Error(`${where}: SPZ has ${streamCount} streams, expected ${sizes.length}`);
    let offset = toc + streamCount * 16;
    streams = sizes.map((size, i) => {
      const compressed = Number(view.getBigUint64(toc + i * 16, true));
      const uncompressed = Number(view.getBigUint64(toc + i * 16 + 8, true));
      if (uncompressed !== size || offset + compressed > bytes.length) throw new Error(`${where}: SPZ stream ${i} has the wrong size`);
      const stream = new Uint8Array(zstdDecompressSync(bytes.subarray(offset, offset + compressed)));
      offset += compressed;
      return stream;
    });
  }
  const [position, alpha, color, scale, rotation, harmonics] = streams as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array | undefined];
  const { count, version } = header;
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), rotations = new Float32Array(count * 4), colors = new Float32Array(count * 4);
  const unit = 1 / (1 << header.fractionalBits);
  const colorScale = SH_C0 / 0.15;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const o = (i * 3 + k) * 3;
      positions[i * 3 + k] = (k === 0 ? unit : -unit) * (((position[o]! | (position[o + 1]! << 8) | (position[o + 2]! << 16)) << 8) >> 8);
      scales[i * 3 + k] = Math.exp(scale[i * 3 + k]! / 16 - 10);
      colors[i * 4 + k] = (color[i * 3 + k]! / 255 - 0.5) * colorScale + 0.5;
    }
    colors[i * 4 + 3] = alpha[i]! / 255;
    if (version >= 3) {
      let word = (rotation[i * 4]! | (rotation[i * 4 + 1]! << 8) | (rotation[i * 4 + 2]! << 16) | (rotation[i * 4 + 3]! << 24)) >>> 0;
      const largest = word >>> 30;
      const q = [0, 0, 0, 0];
      let sum = 0;
      for (let k = 3; k >= 0; k--) {
        if (k === largest) continue;
        const value = (word & 0x1ff) * (Math.SQRT1_2 / 511);
        q[k] = word & 0x200 ? -value : value;
        word >>>= 10;
        sum += q[k]! * q[k]!;
      }
      q[largest] = Math.sqrt(Math.max(0, 1 - sum));
      rotations.set([q[0]!, -q[1]!, -q[2]!, q[3]!], i * 4);
    } else {
      const q = [0, 1, 2].map((k) => rotation[i * 3 + k]! / 127.5 - 1);
      rotations.set([q[0]!, -q[1]!, -q[2]!, Math.sqrt(Math.max(0, 1 - q[0]! * q[0]! - q[1]! * q[1]! - q[2]! * q[2]!))], i * 4);
    }
  }
  // 球谐：SPZ 按系数交错 RGB，我们按通道排；4 阶截到 3 阶
  const dim = SPZ_SH_DIM[header.shDegree]!;
  const bands = Math.min(header.shDegree, 3);
  if (bands === 0 || !harmonics) return { count, positions, scales, rotations, colors };
  const kept = SPZ_SH_DIM[bands]!;
  const sh = new Float32Array(count * kept * 3);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < kept; k++) {
      for (let c = 0; c < 3; c++) sh[i * kept * 3 + c * kept + k] = SPZ_SH_FLIP[k]! * (harmonics[(i * dim + k) * 3 + c]! - 128) / 128;
    }
  }
  return { count, positions, scales, rotations, colors, shBands: bands, sh };
}

/** 解析 .ply 成泼溅（颜色是显示空间的 0..1，不透明度 0..1，缩放是线性的半轴长）。 */
export function readPlySplats(bytes: Uint8Array, where: string): SplatSource {
  const { elements, dataStart } = readHeader(bytes, where);
  const columns = readElements(bytes, dataStart, elements, where);
  const vertex = columns.get('vertex');
  if (!vertex) throw new Error(`${where}: the .ply has no vertex element`);
  const splats = columns.has('chunk') ? compressedSplats(columns.get('chunk')!, vertex, where) : standardSplats(vertex, where);
  // 压缩格式的球谐在单独的 sh 元素里（8 位），标准的在 vertex 里（f32）
  const sh = sphericalHarmonics(columns.get('sh') ?? vertex, columns.has('sh'), splats.count);
  return sh ? { ...splats, ...sh } : splats;
}

/** f_rest_0..n-1 → 高阶球谐（阶数按每个通道的系数个数定：3、8、15 是 1、2、3 阶）；没有时 undefined。 */
function sphericalHarmonics(columns: Map<string, Float64Array>, quantized: boolean, count: number): { shBands: number; sh: Float32Array } | undefined {
  let total = 0;
  while (columns.has(`f_rest_${total}`)) total++;
  const bands = ({ 9: 1, 24: 2, 45: 3 } as Record<number, number>)[total];
  if (!bands) return undefined;
  const rest = Array.from({ length: total }, (_, k) => columns.get(`f_rest_${k}`)!);
  if (rest[0]!.length !== count) return undefined;
  const sh = new Float32Array(count * total);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < total; k++) {
      const value = rest[k]![i]!;
      sh[i * total + k] = quantized ? value * (8 / 255) - 4 : value;
    }
  }
  return { shBands: bands, sh };
}

function readHeader(bytes: Uint8Array, where: string): { elements: PlyElement[]; dataStart: number } {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = head.indexOf('end_header');
  if (!head.startsWith('ply') || end < 0) throw new Error(`${where}: not a .ply file`);
  const newline = head.indexOf('\n', end);
  const lines = head.slice(0, end).split(/\r?\n/);
  if (!lines.some((line) => line.trim() === 'format binary_little_endian 1.0')) throw new Error(`${where}: only binary little-endian .ply files are supported`);
  const elements: { name: string; count: number; properties: { name: string; type: string }[] }[] = [];
  for (const line of lines) {
    const words = line.trim().split(/\s+/);
    if (words[0] === 'element') elements.push({ name: words[1]!, count: Number(words[2]), properties: [] });
    else if (words[0] === 'property') {
      if (words[1] === 'list') throw new Error(`${where}: list properties (faces) are not supported in a splat .ply`);
      if (!(words[1]! in TYPE_SIZES)) throw new Error(`${where}: unknown property type ${words[1]}`);
      elements.at(-1)?.properties.push({ type: words[1]!, name: words[2]! });
    }
  }
  return { elements, dataStart: newline + 1 };
}

/** 每个元素的每个属性读成 Float64Array 一列（按名字）。 */
function readElements(bytes: Uint8Array, start: number, elements: readonly PlyElement[], where: string): Map<string, Map<string, Float64Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map<string, Map<string, Float64Array>>();
  let offset = start;
  for (const element of elements) {
    const stride = element.properties.reduce((sum, property) => sum + TYPE_SIZES[property.type]!, 0);
    if (offset + stride * element.count > bytes.length) throw new Error(`${where}: truncated (${element.name})`);
    const columns = new Map(element.properties.map((property) => [property.name, new Float64Array(element.count)] as const));
    const readers = element.properties.map((property) => {
      const column = columns.get(property.name)!;
      const read = reader(view, property.type);
      return { column, read, size: TYPE_SIZES[property.type]! };
    });
    for (let i = 0; i < element.count; i++) {
      for (const { column, read, size } of readers) {
        column[i] = read(offset);
        offset += size;
      }
    }
    result.set(element.name, columns);
  }
  return result;
}

function reader(view: DataView, type: string): (offset: number) => number {
  switch (type) {
    case 'char': case 'int8': return (o) => view.getInt8(o);
    case 'uchar': case 'uint8': return (o) => view.getUint8(o);
    case 'short': case 'int16': return (o) => view.getInt16(o, true);
    case 'ushort': case 'uint16': return (o) => view.getUint16(o, true);
    case 'int': case 'int32': return (o) => view.getInt32(o, true);
    case 'uint': case 'uint32': return (o) => view.getUint32(o, true);
    case 'double': case 'float64': return (o) => view.getFloat64(o, true);
    default: return (o) => view.getFloat32(o, true);
  }
}

function standardSplats(vertex: Map<string, Float64Array>, where: string): SplatSource {
  const column = (name: string) => vertex.get(name);
  const x = column('x'), y = column('y'), z = column('z');
  if (!x || !y || !z) throw new Error(`${where}: the vertices have no x, y, z`);
  const count = x.length;
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), rotations = new Float32Array(count * 4), colors = new Float32Array(count * 4);
  const [s0, s1, s2] = ['scale_0', 'scale_1', 'scale_2'].map(column);
  const [r0, r1, r2, r3] = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(column);
  const [d0, d1, d2] = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map(column);
  const [red, green, blue] = ['red', 'green', 'blue'].map(column);
  const opacity = column('opacity');
  for (let i = 0; i < count; i++) {
    positions.set([x[i]!, y[i]!, z[i]!], i * 3);
    scales.set(s0 && s1 && s2 ? [Math.exp(s0[i]!), Math.exp(s1[i]!), Math.exp(s2[i]!)] : [POINT_SCALE, POINT_SCALE, POINT_SCALE], i * 3);
    // .ply 的 rot_0 是 w；没有时是单位旋转
    rotations.set(r0 && r1 && r2 && r3 ? [r1[i]!, r2[i]!, r3[i]!, r0[i]!] : [0, 0, 0, 1], i * 4);
    const rgb = d0 && d1 && d2 ? [0.5 + SH_C0 * d0[i]!, 0.5 + SH_C0 * d1[i]!, 0.5 + SH_C0 * d2[i]!] : red && green && blue ? [red[i]! / 255, green[i]! / 255, blue[i]! / 255] : [1, 1, 1];
    colors.set([...rgb, opacity ? 1 / (1 + Math.exp(-opacity[i]!)) : 1], i * 4);
  }
  return { count, positions, scales, rotations, colors };
}

function compressedSplats(chunk: Map<string, Float64Array>, vertex: Map<string, Float64Array>, where: string): SplatSource {
  const packed = ['packed_position', 'packed_rotation', 'packed_scale', 'packed_color'].map((name) => vertex.get(name));
  if (packed.some((value) => !value)) throw new Error(`${where}: a compressed .ply needs packed_position, packed_rotation, packed_scale and packed_color`);
  const [position, rotation, scale, color] = packed as Float64Array[];
  const bound = (name: string) => {
    const value = chunk.get(name);
    if (!value) throw new Error(`${where}: the chunks have no ${name}`);
    return value;
  };
  const [minX, minY, minZ, maxX, maxY, maxZ] = ['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z'].map(bound);
  const [minSX, minSY, minSZ, maxSX, maxSY, maxSZ] = ['min_scale_x', 'min_scale_y', 'min_scale_z', 'max_scale_x', 'max_scale_y', 'max_scale_z'].map(bound);
  // 颜色的范围是可选的（老的压缩格式没有，颜色直接是 0..1）
  const colorRange = ['min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b'].map((name) => chunk.get(name));
  const count = position!.length;
  const positions = new Float32Array(count * 3), scales = new Float32Array(count * 3), rotations = new Float32Array(count * 4), colors = new Float32Array(count * 4);
  const unorm = (value: number, bits: number) => (value & ((1 << bits) - 1)) / ((1 << bits) - 1);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let i = 0; i < count; i++) {
    const c = Math.floor(i / 256);
    const p = position![i]!;
    positions[i * 3] = lerp(minX![c]!, maxX![c]!, unorm(p >>> 21, 11));
    positions[i * 3 + 1] = lerp(minY![c]!, maxY![c]!, unorm(p >>> 11, 10));
    positions[i * 3 + 2] = lerp(minZ![c]!, maxZ![c]!, unorm(p, 11));
    const s = scale![i]!;
    scales[i * 3] = Math.exp(lerp(minSX![c]!, maxSX![c]!, unorm(s >>> 21, 11)));
    scales[i * 3 + 1] = Math.exp(lerp(minSY![c]!, maxSY![c]!, unorm(s >>> 11, 10)));
    scales[i * 3 + 2] = Math.exp(lerp(minSZ![c]!, maxSZ![c]!, unorm(s, 11)));
    // 最大的分量是第几个（最高 2 位），另外三个各 10 位、范围 ±1/√2
    const r = rotation![i]!;
    const a = (unorm(r >>> 20, 10) - 0.5) * Math.SQRT2, b = (unorm(r >>> 10, 10) - 0.5) * Math.SQRT2, d = (unorm(r, 10) - 0.5) * Math.SQRT2;
    const m = Math.sqrt(Math.max(0, 1 - (a * a + b * b + d * d)));
    const quaternion = [[a, b, d, m], [m, b, d, a], [b, m, d, a], [b, d, m, a]][r >>> 30]!;
    rotations.set(quaternion, i * 4);
    const k = color![i]!;
    const rgb = [unorm(k >>> 24, 8), unorm(k >>> 16, 8), unorm(k >>> 8, 8)];
    if (colorRange.every((value) => value)) {
      for (let j = 0; j < 3; j++) rgb[j] = lerp(colorRange[j]![c]!, colorRange[j + 3]![c]!, rgb[j]!);
    }
    colors.set([...rgb, unorm(k, 8)], i * 4);
  }
  return { count, positions, scales, rotations, colors };
}
