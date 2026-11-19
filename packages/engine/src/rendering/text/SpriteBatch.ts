/**
 * 屏幕上的 2D 批量绘制（Stride 的 SpriteBatch）：贴图（带源矩形、颜色、旋转、原点）和文字（drawString）。坐标是虚拟分辨率
 * （没设时就是渲染目标的像素），(0, 0) 在左上角，y 向下。按提交的顺序画（Stride 的 Deferred），连着的同一种东西一次绘制。
 *
 * 照 Stride：
 * - 颜色当 sRGB 给，转成线性再乘（BatchBase 在线性色彩空间用 SpriteBatchShader<TSRgb>），混合是预乘 alpha；
 * - 文字的位置先取整到真实像素；运行时字体的字号乘上 真实 / 虚拟 的比例（字按真实像素的大小排版、栅格化），编译期字体按自己的
 *   字号画、不跟着虚拟分辨率缩放；每个字的原点取整到真实像素（SpriteFont.InternalDrawGlyph）。
 * 和 Stride 不同：
 * - 字不是位图，是从轮廓逐像素算覆盖率（Slug，见 slug.ts），任何缩放、旋转都清晰；没有 SpriteEffects 的镜像。
 * - drawString 的原点是虚拟坐标（和 measureString 量出来的一样）。Stride 把它直接当字体像素用，窗口和虚拟分辨率不一样大时
 *   旋转中心就偏了（SpriteFonts 的动画那屏）。
 * - 做字距（见 layout.ts）。
 */
import { srgbToLinear } from '../../mathematics/vectors';
import type { GpuResources } from '../GpuResources';
import { Texture } from '../Texture';
import { GlyphStore } from './GlyphStore';
import { glyphScale, layoutText, measureText, type FontSize, type TextAlignment } from './layout';
import { SLUG_WGSL } from './slug';
import type { SpriteFont } from './SpriteFont';

export type Vec2 = readonly [number, number];
export type Rect = readonly [x: number, y: number, width: number, height: number];
export type Color = readonly [number, number, number, number];
/** 二维仿射矩阵 [a, b, c, d, e, f]（同 UI 的 Matrix2D）。 */
export type Matrix2DLike = readonly [number, number, number, number, number, number];

export interface DrawOptions {
  /** 贴图上的区域（像素）；不给时是整张。 */
  readonly source?: Rect;
  /** sRGB 的颜色，乘在贴图上；默认白色。 */
  readonly color?: Color;
  /** 绕 position 转的角度（弧度，顺时针）。 */
  readonly rotation?: number;
  /** 旋转和定位的原点，源矩形里的像素。 */
  readonly origin?: Vec2;
}

export interface DrawStringOptions {
  /** 字号（像素）；默认是字体的 size。 */
  readonly fontSize?: number;
  readonly color?: Color;
  readonly rotation?: number;
  /** 旋转、缩放的原点，相对文字左上角的虚拟坐标（measureString 量出来的那种）。 */
  readonly origin?: Vec2;
  readonly scale?: Vec2;
  readonly alignment?: TextAlignment;
}

/** UI 的一个四边形：左上角和两条边，虚拟坐标（Stride 的 UIBatch 画元素时用世界矩阵乘上大小）。 */
export interface Quad {
  readonly origin: Vec2;
  readonly axisX: Vec2;
  readonly axisY: Vec2;
}

/** drawText 的选项（Stride 的 SpriteFont.InternalUIDrawCommand）。 */
export interface DrawTextOptions {
  /** 要的字号，虚拟像素（TextBlock.ActualTextSize）。 */
  readonly fontSize: number;
  readonly color?: Color;
  readonly alignment?: TextAlignment;
  /** 对齐用的框宽，虚拟像素（元素的宽）。 */
  readonly boxWidth?: number;
  /** 文字和每个字的原点对齐到真实像素（Stride 的 SnapText，全屏的 UI 默认开）。 */
  readonly snap?: boolean;
}

// 每项 16 个 float：贴图是 原点、x 边、y 边、UV、颜色；字形是 原点、x 轴、y 轴、em 范围、字形下标和是否锯齿、颜色
const ITEM_FLOATS = 16;
const WHITE: Color = [1, 1, 1, 1];

const SHADER = /* wgsl */ `
struct Item {
  a: vec4f,
  b: vec4f,
  c: vec4f,
  color: vec4f,
};
@group(0) @binding(0) var<storage, read> items: array<Item>;
@group(0) @binding(1) var<uniform> virtualSize: vec4f;

fn toClip(p: vec2f) -> vec4f {
  return vec4f(p.x / virtualSize.x * 2.0 - 1.0, 1.0 - p.y / virtualSize.y * 2.0, 0.0, 1.0);
}

// 贴图：a = 左上角、x 边，b.xy = y 边，c = UV 的起点和大小
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;
@group(1) @binding(1) var spriteSampler: sampler;

struct SpriteVaryings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex fn vsSprite(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> SpriteVaryings {
  let item = items[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  var out: SpriteVaryings;
  out.position = toClip(item.a.xy + item.a.zw * corner.x + item.b.xy * corner.y);
  out.uv = item.c.xy + item.c.zw * corner;
  out.color = item.color;
  return out;
}

@fragment fn fsSprite(in: SpriteVaryings) -> @location(0) vec4f {
  // 贴图按 Stride 的预乘 alpha 用（见 SpriteRenderFeature）
  let texel = textureSample(spriteTexture, spriteSampler, in.uv);
  return vec4f(texel.rgb * texel.a, texel.a) * in.color;
}

// 字形：a = em 原点在屏幕上的位置、em 的 x 轴，b = em 的 y 轴、em 范围的最小角，c = em 范围的最大角、字形下标、是否锯齿
${SLUG_WGSL}

struct GlyphVaryings {
  @builtin(position) position: vec4f,
  @location(0) em: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) glyph: vec2u,
};

@vertex fn vsGlyph(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GlyphVaryings {
  let item = items[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  let em = mix(item.b.zw, item.c.xy, corner);
  var out: GlyphVaryings;
  out.position = toClip(item.a.xy + item.a.zw * em.x + item.b.xy * em.y);
  out.em = em;
  out.color = item.color;
  out.glyph = vec2u(bitcast<u32>(item.c.z), bitcast<u32>(item.c.w));
  return out;
}

@fragment fn fsGlyph(in: GlyphVaryings) -> @location(0) vec4f {
  var coverage = slugCoverage(in.em, fwidth(in.em), in.glyph.x);
  // Aliased：没有抗锯齿，覆盖一半以上的像素才画
  if (in.glyph.y != 0u) {
    coverage = select(0.0, 1.0, coverage >= 0.5);
  }
  return in.color * coverage;
}
`;

interface Run {
  readonly kind: 'sprite' | 'glyph';
  readonly texture?: Texture;
  /** 裁剪矩形，真实像素；没有时是整个渲染目标。 */
  readonly scissor?: Rect;
  readonly first: number;
  count: number;
}

let whiteTexture: Texture | undefined;
/** 画纯色矩形用的 1x1 白色贴图。 */
function white(): Texture {
  return (whiteTexture ??= new Texture('white', { format: 'rgba8unorm', width: 1, height: 1, levels: [new Uint8Array([255, 255, 255, 255])] }));
}

export class SpriteBatch {
  /** 虚拟分辨率：坐标按它算，画的时候拉伸到渲染目标；不设时就是渲染目标的像素。 */
  virtualResolution: Vec2 | undefined;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #glyphs: GlyphStore;
  readonly #module: GPUShaderModule;
  readonly #itemLayout: GPUBindGroupLayout;
  readonly #textureLayout: GPUBindGroupLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #textureGroups = new Map<Texture, GPUBindGroup>();
  readonly #uniform: GPUBuffer;
  #items: GPUBuffer;
  #itemGroup: GPUBindGroup | undefined;
  #data = new Float32Array(ITEM_FLOATS * 256);
  /** 同一块内存按 u32 看：字形的下标和标志按位写（着色器里 bitcast 回来）。 */
  #bits = new Uint32Array(this.#data.buffer);
  #count = 0;
  #runs: Run[] = [];
  #pass: GPURenderPassEncoder | undefined;
  #format: GPUTextureFormat = 'bgra8unorm-srgb';
  #targetSize: Vec2 = [1, 1];
  #scissor: Rect | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#glyphs = new GlyphStore(device);
    this.#module = device.createShaderModule({ label: 'SpriteBatch', code: SHADER });
    this.#itemLayout = device.createBindGroupLayout({
      label: 'SpriteBatch items',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });
    this.#textureLayout = device.createBindGroupLayout({
      label: 'SpriteBatch texture',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#uniform = device.createBuffer({ label: 'SpriteBatch virtual size', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#items = this.#createItems(this.#data.byteLength);
  }

  /** 开始一批：之后的 draw、drawString 在 end() 时画进 pass（渲染目标 width x height，颜色格式 format）。 */
  begin(pass: GPURenderPassEncoder, width: number, height: number, format: GPUTextureFormat): void {
    if (this.#pass) throw new Error('SpriteBatch.begin called twice without end');
    this.#pass = pass;
    this.#targetSize = [width, height];
    this.#format = format;
    this.#count = 0;
    this.#runs = [];
    this.#scissor = undefined;
  }

  /** 之后画的东西裁到 rect（真实像素，整数）里；undefined 是不裁（UI 的 ClipToBounds）。 */
  setScissor(rect: Rect | undefined): void {
    this.#scissor = rect;
  }

  /** 画一个四边形（UI）：texture 的 uv 区域（0 到 1：u、v、宽、高）铺到 quad 上；texture 是 null 时画纯色。 */
  drawQuad(texture: Texture | null, quad: Quad, uv: Rect, color: Color): void {
    const at = this.#reserve('sprite', texture ?? white(), color);
    const d = this.#data;
    d[at] = quad.origin[0]; d[at + 1] = quad.origin[1]; d[at + 2] = quad.axisX[0]; d[at + 3] = quad.axisX[1];
    d[at + 4] = quad.axisY[0]; d[at + 5] = quad.axisY[1];
    d[at + 8] = uv[0]; d[at + 9] = uv[1]; d[at + 10] = uv[2]; d[at + 11] = uv[3];
  }

  /**
   * 画 UI 的文字（Stride 的 UIBatch.DrawString）：transform 把文字框的局部坐标（虚拟像素，左上角是原点）换到屏幕的虚拟坐标。
   * 运行时字体按 字号 · 真实 / 虚拟 排版（snap 时；不 snap 时按虚拟像素，同 Stride），编译期字体按要的字号；snap 时文字框的
   * 左上角和每个字的原点取整到真实像素。
   */
  drawText(font: SpriteFont, text: string, transform: Matrix2DLike, { fontSize, color = WHITE, alignment = 'left', boxWidth, snap = true }: DrawTextOptions): void {
    const ratio: Vec2 = font.isStatic || !snap ? [1, 1] : this.#ratio();
    const size: FontSize = [ratio[1] * fontSize, ratio[1] * fontSize];
    const emToFont = glyphScale(font, size);
    const [a, b, c, d, e, f] = transform;
    const screen = this.#ratio();
    // 文字框的左上角取整到真实像素
    const ox = snap ? Math.round(e * screen[0]) / screen[0] : e, oy = snap ? Math.round(f * screen[1]) / screen[1] : f;
    // 字体像素的 x、y 在屏幕虚拟坐标里的向量
    const ux = a / ratio[0], uy = b / ratio[0], vx = c / ratio[1], vy = d / ratio[1];
    const pixels = Math.min(Math.hypot(ux, uy) * screen[0], Math.hypot(vx, vy) * screen[1]) * Math.min(Math.abs(emToFont[0]), Math.abs(emToFont[1]));
    if (!(pixels > 0)) return;
    const dilation = 1 / pixels;
    const aliased = font.antiAlias === 'aliased' ? 1 : 0;
    const baseOffset = font.baseOffset(size[1]);
    // em 的 x 轴、y 轴（y 向上，所以取反）
    const ax = emToFont[0] * ux, ay = emToFont[0] * uy;
    const bx = -emToFont[1] * vx, by = -emToFont[1] * vy;
    const linear = toLinear(color);
    const box = boxWidth === undefined ? undefined : boxWidth * ratio[0];
    for (const { glyph, x, y } of layoutText(font, text, size, alignment, box)) {
      if (glyph.hBands === 0) continue;
      const gx = snap ? Math.round(x) : x, gy = snap ? Math.round(y + baseOffset) : y + baseOffset;
      const index = this.#glyphs.glyphIndex(glyph);
      const at = this.#reserve('glyph', undefined, linear, true);
      const data = this.#data, bounds = glyph.bounds;
      data[at] = ox + gx * ux + gy * vx; data[at + 1] = oy + gx * uy + gy * vy; data[at + 2] = ax; data[at + 3] = ay;
      data[at + 4] = bx; data[at + 5] = by; data[at + 6] = bounds[0] - dilation; data[at + 7] = bounds[1] - dilation;
      data[at + 8] = bounds[2] + dilation; data[at + 9] = bounds[3] + dilation;
      this.#bits[at + 10] = index;
      this.#bits[at + 11] = aliased;
    }
  }

  /** 画一张贴图到 destination（虚拟坐标的矩形）。 */
  draw(texture: Texture, destination: Rect, { source, color = WHITE, rotation = 0, origin = [0, 0] }: DrawOptions = {}): void {
    const { width, height } = texture.data;
    const [sx, sy, sw, sh] = source ?? [0, 0, width, height];
    const [x, y, w, h] = destination;
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    // 原点按 目标 / 源 的比例换到目标矩形里，矩形绕 (x, y) 转
    const ox = (origin[0] * w) / sw, oy = (origin[1] * h) / sh;
    const left = x - ox * cos + oy * sin, top = y - ox * sin - oy * cos;
    const at = this.#reserve('sprite', texture, color);
    const d = this.#data;
    d[at] = left; d[at + 1] = top; d[at + 2] = w * cos; d[at + 3] = w * sin;
    d[at + 4] = -h * sin; d[at + 5] = h * cos;
    d[at + 8] = sx / width; d[at + 9] = sy / height; d[at + 10] = sw / width; d[at + 11] = sh / height;
  }

  /** 画文字（Stride 的 DrawString）：position 是文字左上角（行顶）的虚拟坐标。 */
  drawString(font: SpriteFont, text: string, position: Vec2, { fontSize = font.size, color = WHITE, rotation = 0, origin = [0, 0], scale = [1, 1], alignment = 'left' }: DrawStringOptions = {}): void {
    const ratio = this.#ratio();
    const size = this.#fontPixels(font, fontSize, ratio);
    const emToFont = glyphScale(font, size);
    // 字体像素到虚拟坐标的缩放，位置先取整到真实像素
    const sx = scale[0] / ratio[0], sy = scale[1] / ratio[1];
    const px = Math.round(position[0] * ratio[0]) / ratio[0], py = Math.round(position[1] * ratio[1]) / ratio[1];
    const cos = Math.cos(rotation), sin = Math.sin(rotation);
    // 真实像素里一个 em 有多大：字形向外扩一个像素，抗锯齿的边不被裁掉
    const pixels = Math.min(Math.abs(emToFont[0] * sx * ratio[0]), Math.abs(emToFont[1] * sy * ratio[1]));
    if (!(pixels > 0)) return;
    const dilation = 1 / pixels;
    const aliased = font.antiAlias === 'aliased' ? 1 : 0;
    const baseOffset = font.baseOffset(size[1]);
    // em 的 x 轴、y 轴（y 向上，所以屏幕上朝上）在虚拟坐标里的向量，每个字都一样
    const ax = emToFont[0] * sx * cos, ay = emToFont[0] * sx * sin;
    const bx = emToFont[1] * sy * sin, by = -emToFont[1] * sy * cos;
    const linear = toLinear(color);
    for (const { glyph, x, y } of layoutText(font, text, size, alignment)) {
      // 空格这样没有轮廓的字不画
      if (glyph.hBands === 0) continue;
      // 字的原点相对文字原点（字体像素，字体像素就是真实像素），取整同 Stride
      const gx = Math.round(x - origin[0] * ratio[0]), gy = Math.round(y + baseOffset - origin[1] * ratio[1]);
      const index = this.#glyphs.glyphIndex(glyph);
      const at = this.#reserve('glyph', undefined, linear, true);
      const d = this.#data, bounds = glyph.bounds;
      d[at] = px + gx * sx * cos - gy * sy * sin; d[at + 1] = py + gx * sx * sin + gy * sy * cos; d[at + 2] = ax; d[at + 3] = ay;
      d[at + 4] = bx; d[at + 5] = by; d[at + 6] = bounds[0] - dilation; d[at + 7] = bounds[1] - dilation;
      d[at + 8] = bounds[2] + dilation; d[at + 9] = bounds[3] + dilation;
      this.#bits[at + 10] = index;
      this.#bits[at + 11] = aliased;
    }
  }

  /**
   * 文字在虚拟坐标里的大小（Stride 的 SpriteBatch.MeasureString）：按 targetSize（默认是 begin 时的渲染目标）和虚拟分辨率的比例
   * 换算，字号默认是字体的 size。
   */
  measureString(font: SpriteFont, text: string, fontSize = font.size, targetSize: Vec2 = this.#targetSize): [number, number] {
    if (text === '') return [0, 0];
    const ratio = this.#ratio(targetSize);
    const [w, h] = measureText(font, text, this.#fontPixels(font, fontSize, ratio));
    return [w / ratio[0], h / ratio[1]];
  }

  /** 排版用的字号（真实像素）：运行时字体是 字号 · 真实 / 虚拟；编译期字体总是自己的 size（同 Stride，不随虚拟分辨率缩放）。 */
  #fontPixels(font: SpriteFont, fontSize: number, ratio: Vec2): FontSize {
    return font.isStatic ? [font.size, font.size] : [fontSize * ratio[0], fontSize * ratio[1]];
  }

  /** 把这一批画进 begin 给的 pass。 */
  end(): void {
    const pass = this.#pass;
    if (!pass) throw new Error('SpriteBatch.end called without begin');
    this.#pass = undefined;
    if (this.#count === 0) return;
    const [vx, vy] = this.virtualResolution ?? this.#targetSize;
    this.#device.queue.writeBuffer(this.#uniform, 0, new Float32Array([vx, vy, 0, 0]));
    const bytes = this.#count * ITEM_FLOATS * 4;
    if (bytes > this.#items.size) {
      this.#items.destroy();
      this.#items = this.#createItems(Math.max(bytes, this.#items.size * 2));
      this.#itemGroup = undefined;
    }
    this.#device.queue.writeBuffer(this.#items, 0, this.#data.buffer, 0, bytes);
    this.#itemGroup ??= this.#device.createBindGroup({
      label: 'SpriteBatch items',
      layout: this.#itemLayout,
      entries: [{ binding: 0, resource: { buffer: this.#items } }, { binding: 1, resource: { buffer: this.#uniform } }],
    });
    pass.setBindGroup(0, this.#itemGroup);
    let scissor: Rect | undefined;
    for (const run of this.#runs) {
      if (run.scissor !== scissor) {
        // 剪裁矩形要在渲染目标里面
        const [tw, th] = this.#targetSize;
        const [x, y, w, h] = run.scissor ?? [0, 0, tw, th];
        const x0 = Math.min(Math.max(x, 0), tw), y0 = Math.min(Math.max(y, 0), th);
        pass.setScissorRect(x0, y0, Math.max(0, Math.min(x + w, tw) - x0), Math.max(0, Math.min(y + h, th) - y0));
        scissor = run.scissor;
      }
      pass.setPipeline(this.#pipeline(run.kind));
      pass.setBindGroup(1, run.kind === 'glyph' ? this.#glyphs.bindGroup() : this.#textureGroup(run.texture!));
      pass.draw(4, run.count, 0, run.first);
    }
    if (scissor) pass.setScissorRect(0, 0, this.#targetSize[0], this.#targetSize[1]);
  }

  destroy(): void {
    this.#items.destroy();
    this.#uniform.destroy();
    this.#glyphs.destroy();
  }

  /** 真实像素 / 虚拟坐标。 */
  #ratio([width, height]: Vec2 = this.#targetSize): Vec2 {
    const [vx, vy] = this.virtualResolution ?? [width, height];
    return [width / vx, height / vy];
  }

  /** 加一项，写好颜色，返回它在 #data 里的起点（几何由调用方写）。linear 为 true 时颜色已经是线性的。 */
  #reserve(kind: Run['kind'], texture: Texture | undefined, color: Color, linear = false): number {
    if (!this.#pass) throw new Error('SpriteBatch: call begin before drawing');
    const last = this.#runs.at(-1);
    const scissor = this.#scissor;
    if (last && last.kind === kind && last.texture === texture && last.scissor === scissor) last.count++;
    else this.#runs.push({ kind, ...(texture ? { texture } : {}), ...(scissor ? { scissor } : {}), first: this.#count, count: 1 });
    if ((this.#count + 1) * ITEM_FLOATS > this.#data.length) {
      const grown = new Float32Array(this.#data.length * 2);
      grown.set(this.#data);
      this.#data = grown;
      this.#bits = new Uint32Array(grown.buffer);
    }
    const at = this.#count * ITEM_FLOATS;
    this.#data.set(linear ? color : toLinear(color), at + 12);
    this.#count++;
    return at;
  }

  #pipeline(kind: Run['kind']): GPURenderPipeline {
    const key = `${kind}:${this.#format}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `SpriteBatch ${kind}`,
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#itemLayout, kind === 'glyph' ? this.#glyphs.layout : this.#textureLayout] }),
        vertex: { module: this.#module, entryPoint: kind === 'glyph' ? 'vsGlyph' : 'vsSprite' },
        fragment: {
          module: this.#module,
          entryPoint: kind === 'glyph' ? 'fsGlyph' : 'fsSprite',
          // 预乘 alpha（Stride 的 BlendStates.AlphaBlend）
          targets: [{ format: this.#format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-strip' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #textureGroup(texture: Texture): GPUBindGroup {
    let group = this.#textureGroups.get(texture);
    if (!group) {
      group = this.#device.createBindGroup({
        label: `SpriteBatch ${texture.name}`,
        layout: this.#textureLayout,
        entries: [
          { binding: 0, resource: this.#resources.texture(texture).createView() },
          { binding: 1, resource: this.#resources.linearClamp },
        ],
      });
      this.#textureGroups.set(texture, group);
    }
    return group;
  }

  #createItems(size: number): GPUBuffer {
    return this.#device.createBuffer({ label: 'SpriteBatch items', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}

/** 颜色当 sRGB 给（同 Stride 的 SpriteBatch），转成线性；alpha 不变。 */
function toLinear([r, g, b, a]: Color): Color {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a];
}
