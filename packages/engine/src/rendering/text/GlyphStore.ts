/**
 * 字形的 GPU 数据：所有字体下载过的码位块拼进三个存储缓冲——点（vec2f）、带（u32）、字形表（每个字形 8 个字：带的缩放和偏移，
 * 点和带在缓冲里的起点，横带、竖带的条数）。块第一次画的时候上传，缓冲不够时翻倍（旧内容在 GPU 上拷过去），之后 bindGroup
 * 换新的。只增不减：一个游戏用到的字形不多（CJK 字体也只下载用到的块）。
 */
import { GLYPH_RECORD, GLYPH_WORDS } from '../../content/format';
import type { FontGlyph, LoadedGlyphBlock } from './SpriteFont';

const GLYPH_ENTRY_WORDS = 8;
const INITIAL_BYTES = 64 * 1024;

interface GrowingBuffer {
  buffer: GPUBuffer;
  /** 已经用了的字节。 */
  used: number;
}

/** 绑定组的布局，同一个设备上的 GlyphStore 共用（SpriteBatch 的管线也就能共用）。 */
const layouts = new WeakMap<GPUDevice, GPUBindGroupLayout>();

function glyphLayout(device: GPUDevice): GPUBindGroupLayout {
  let layout = layouts.get(device);
  if (!layout) {
    const entry = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } });
    layouts.set(device, (layout = device.createBindGroupLayout({ label: 'GlyphStore', entries: [entry(0), entry(1), entry(2)] })));
  }
  return layout;
}

export class GlyphStore {
  readonly device: GPUDevice;
  readonly layout: GPUBindGroupLayout;
  readonly #points: GrowingBuffer;
  readonly #bands: GrowingBuffer;
  readonly #glyphs: GrowingBuffer;
  /** 块在字形表里的起点。 */
  readonly #blocks = new WeakMap<LoadedGlyphBlock, number>();
  #group: GPUBindGroup | undefined;

  constructor(device: GPUDevice) {
    this.device = device;
    const create = (label: string): GrowingBuffer => ({ buffer: this.#createBuffer(label, INITIAL_BYTES), used: 0 });
    this.#points = create('GlyphStore points');
    this.#bands = create('GlyphStore bands');
    this.#glyphs = create('GlyphStore glyphs');
    this.layout = glyphLayout(device);
  }

  /** 字形在字形表里的下标；所在的块还没上传时现在上传。 */
  glyphIndex(glyph: FontGlyph): number {
    let base = this.#blocks.get(glyph.block);
    if (base === undefined) {
      base = this.#upload(glyph.block);
      this.#blocks.set(glyph.block, base);
    }
    return base + glyph.index;
  }

  /** 字形表、点、带三个缓冲（绑定 0、1、2）。上传让缓冲变大以后是新的。 */
  bindGroup(): GPUBindGroup {
    return (this.#group ??= this.device.createBindGroup({
      label: 'GlyphStore',
      layout: this.layout,
      entries: [this.#glyphs, this.#points, this.#bands].map(({ buffer }, binding) => ({ binding, resource: { buffer } })),
    }));
  }

  destroy(): void {
    for (const { buffer } of [this.#points, this.#bands, this.#glyphs]) buffer.destroy();
  }

  #upload({ data }: LoadedGlyphBlock): number {
    const pointBase = this.#append(this.#points, data.points) / 8;
    const bandBase = this.#append(this.#bands, data.bands) / 4;
    const entries = new ArrayBuffer(data.glyphCount * GLYPH_ENTRY_WORDS * 4);
    const f32 = new Float32Array(entries);
    const u32 = new Uint32Array(entries);
    const records = new Uint32Array(data.glyphs);
    const recordFloats = new Float32Array(data.glyphs);
    for (let i = 0; i < data.glyphCount; i++) {
      const r = i * GLYPH_WORDS, e = i * GLYPH_ENTRY_WORDS;
      f32.set(recordFloats.subarray(r + GLYPH_RECORD.bandTransform, r + GLYPH_RECORD.bandTransform + 4), e);
      u32[e + 4] = pointBase + records[r + GLYPH_RECORD.pointStart]!;
      u32[e + 5] = bandBase + records[r + GLYPH_RECORD.bandStart]!;
      u32[e + 6] = records[r + GLYPH_RECORD.hBands]!;
      u32[e + 7] = records[r + GLYPH_RECORD.vBands]!;
    }
    return this.#append(this.#glyphs, new Uint32Array(entries)) / (GLYPH_ENTRY_WORDS * 4);
  }

  /** 把数据接在缓冲后面，返回它的字节偏移；不够时翻倍。 */
  #append(target: GrowingBuffer, data: Float32Array | Uint32Array): number {
    const offset = target.used;
    const needed = offset + data.byteLength;
    if (needed > target.buffer.size) {
      let size = target.buffer.size;
      while (size < needed) size *= 2;
      const grown = this.#createBuffer(target.buffer.label, size);
      const encoder = this.device.createCommandEncoder({ label: 'GlyphStore grow' });
      if (offset > 0) encoder.copyBufferToBuffer(target.buffer, 0, grown, 0, offset);
      this.device.queue.submit([encoder.finish()]);
      // destroy 等已经提交的拷贝做完才生效
      target.buffer.destroy();
      target.buffer = grown;
      this.#group = undefined;
    }
    if (data.byteLength > 0) this.device.queue.writeBuffer(target.buffer, offset, data.buffer, data.byteOffset, data.byteLength);
    target.used = needed;
    return offset;
  }

  #createBuffer(label: string, size: number): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  }
}
