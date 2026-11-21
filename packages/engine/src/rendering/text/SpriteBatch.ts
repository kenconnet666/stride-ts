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
 *
 * 放在 3D 里的 UI：transform 设成 虚拟坐标 → 裁剪空间 的矩阵，begin 时给深度格式就和场景的深度比较（不写深度）。
 *
 * 点选（ScenePicker）：设了 pickId 时画进编号缓冲（r32uint），画法和平常一样（贴图、字形的覆盖率），差不多全透明的地方不画，
 * 画到的写 pickId；自定义效果不用。clip 把整批限制在一块里（点选只画被点的那个像素）。
 */
import { srgbToLinear } from '../../data/vectors';
import type { GpuResources } from '../../graphics/GpuResources';
import { Texture } from '../../graphics/Texture';
import { GlyphStore } from './GlyphStore';
import { glyphScale, layoutText, measureText, type FontSize, type TextAlignment } from './layout';
import type { RichStyle } from './markdown';
import { lineOffset, SYNTHETIC_BOLD_EM, SYNTHETIC_ITALIC_SLANT, type RichTextLayout } from './richLayout';
import { SLUG_WGSL } from './slug';
import { SPRITE_EFFECT_PARAMETERS, spriteEffectShader, type SpriteEffect } from './SpriteEffect';
import type { FontGlyph, SpriteFont } from './SpriteFont';

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

/** drawRichText 的选项。 */
export interface DrawRichTextOptions {
  /** 一段文字的颜色（sRGB）：按样式选（链接、代码、写了颜色的）。下划线、删除线同色。 */
  readonly colorOf: (style: RichStyle) => Color;
  /** 行内代码的底色（sRGB）；没有时不画。 */
  readonly codeBackground?: Color | undefined;
  readonly alignment?: TextAlignment;
  /** 对齐用的框宽，虚拟像素；不给时是最宽那一行。 */
  readonly boxWidth?: number;
  /** 字的原点对齐到真实像素（同 drawText）。 */
  readonly snap?: boolean;
  /** 描边，同 drawText。 */
  readonly outline?: { readonly color: Color; readonly thickness: number } | undefined;
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
  /** 描边：字的轮廓往外 thickness（虚拟像素）以内涂上 color，画在字的下面。 */
  readonly outline?: { readonly color: Color; readonly thickness: number } | undefined;
  /** 选中的一段（文字里的码位，[start, end)）：每行在字的下面垫一块 color。 */
  readonly selection?: { readonly start: number; readonly end: number; readonly color: Color } | undefined;
}

// 每项 16 个 float：贴图是 原点、x 边、y 边、UV、颜色；字形是 原点、x 轴、y 轴、em 范围、字形下标（最高位是锯齿）、描边的半径、颜色
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
struct Batch {
  transform: mat4x4f,
  // 点选的编号缓冲写的数（SpriteBatch.pickId）
  pickId: u32,
};
@group(0) @binding(1) var<uniform> batch: Batch;

fn toClip(p: vec2f) -> vec4f {
  return batch.transform * vec4f(p, 0.0, 1.0);
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

// 点选：差不多全透明的地方点不到，会点到后面的东西（同 SpriteRenderFeature 的 fsPick）
@fragment fn fsSpritePick(in: SpriteVaryings) -> @location(0) u32 {
  if (textureSample(spriteTexture, spriteSampler, in.uv).a * in.color.a < 0.1) {
    discard;
  }
  return batch.pickId;
}

// 字形：a = em 原点在屏幕上的位置、em 的 x 轴，b = em 的 y 轴、em 范围的最小角，c = em 范围的最大角、字形下标（最高位：锯齿）、
// 描边的半径（em；大于 0 时这一项画的是字连同它的描边）
${SLUG_WGSL}

struct GlyphVaryings {
  @builtin(position) position: vec4f,
  @location(0) em: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) glyph: u32,
  @location(3) @interpolate(flat) outline: f32,
};

@vertex fn vsGlyph(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> GlyphVaryings {
  let item = items[instance];
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  let em = mix(item.b.zw, item.c.xy, corner);
  var out: GlyphVaryings;
  out.position = toClip(item.a.xy + item.a.zw * em.x + item.b.xy * em.y);
  out.em = em;
  out.color = item.color;
  out.glyph = bitcast<u32>(item.c.z);
  out.outline = item.c.w;
  return out;
}

fn glyphCoverage(in: GlyphVaryings) -> f32 {
  let emsPerPixel = fwidth(in.em);
  let glyph = in.glyph & 0x7fffffffu;
  var coverage = slugCoverage(in.em, emsPerPixel, glyph);
  // 描边：离轮廓不到半径的地方也算覆盖，边上按距离过渡一个像素
  if (in.outline > 0.0 && coverage < 1.0) {
    let pixel = max(emsPerPixel.x, emsPerPixel.y);
    let distance = slugDistance(in.em, in.outline + pixel, glyph);
    coverage = max(coverage, saturate((in.outline - distance) / pixel + 0.5));
  }
  // Aliased：没有抗锯齿，覆盖一半以上的像素才画
  if (in.glyph >= 0x80000000u) {
    coverage = select(0.0, 1.0, coverage >= 0.5);
  }
  return coverage;
}

@fragment fn fsGlyph(in: GlyphVaryings) -> @location(0) vec4f {
  return in.color * glyphCoverage(in);
}

@fragment fn fsGlyphPick(in: GlyphVaryings) -> @location(0) u32 {
  if (in.color.a * glyphCoverage(in) < 0.1) {
    discard;
  }
  return batch.pickId;
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

/**
 * 同一个设备上所有 SpriteBatch 共用的：着色器模块、绑定组布局、建好的管线（UI 每个组件一个 SpriteBatch，点选又各有一个，
 * 各建一套一样的管线是白费，而且是当场同步编的）。缓冲、绑定组、字形是每个 SpriteBatch 自己的（同一帧里各写各的数据）。
 */
interface SharedGpu {
  readonly module: GPUShaderModule;
  readonly itemLayout: GPUBindGroupLayout;
  readonly textureLayout: GPUBindGroupLayout;
  readonly effectLayout: GPUBindGroupLayout;
  readonly pipelines: Map<string, GPURenderPipeline>;
  readonly effectModules: Map<string, GPUShaderModule>;
}

const shared = new WeakMap<GPUDevice, SharedGpu>();

function sharedGpu(device: GPUDevice): SharedGpu {
  let gpu = shared.get(device);
  if (!gpu) {
    const layout = (label: string, entries: GPUBindGroupLayoutEntry[]) => device.createBindGroupLayout({ label, entries });
    gpu = {
      module: device.createShaderModule({ label: 'SpriteBatch', code: SHADER }),
      itemLayout: layout('SpriteBatch items', [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ]),
      textureLayout: layout('SpriteBatch texture', [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ]),
      effectLayout: layout('SpriteBatch effect', [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ]),
      pipelines: new Map(),
      effectModules: new Map(),
    };
    shared.set(device, gpu);
  }
  return gpu;
}

export class SpriteBatch {
  /** 虚拟分辨率：坐标按它算，画的时候拉伸到渲染目标；不设时就是渲染目标的像素。 */
  virtualResolution: Vec2 | undefined;
  /** 虚拟坐标到裁剪空间的矩阵（列主序）；不设时按虚拟分辨率铺满渲染目标。 */
  transform: Float32Array | undefined;
  /** 设了 transform 时，一个虚拟单位大约多少真实像素（文字的抗锯齿边要多宽）；不设时按渲染目标和虚拟分辨率算。 */
  pixelRatio: Vec2 | undefined;
  /** 自定义效果（见 SpriteEffect）：begin 时取，这一批的贴图都用它画；没有时照常画。 */
  effect: SpriteEffect | undefined;
  /** 设了时画进点选的编号缓冲（颜色格式 r32uint）：画到的像素写这个数（大于 0），不混合；begin 时取。 */
  pickId: number | undefined;
  /** 整批的剪裁矩形（真实像素，整数）：元素的剪裁矩形和它取交集，end 后恢复成它；不设时是整个渲染目标。 */
  clip: Rect | undefined;
  #activePickId: number | undefined;
  #activeEffect: SpriteEffect | undefined;
  readonly #effectLayout: GPUBindGroupLayout;
  readonly #effectBuffer: GPUBuffer;
  readonly #effectModules: Map<string, GPUShaderModule>;
  readonly #effectGroups = new WeakMap<SpriteEffect, GPUBindGroup>();
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #glyphs: GlyphStore;
  readonly #module: GPUShaderModule;
  readonly #itemLayout: GPUBindGroupLayout;
  readonly #textureLayout: GPUBindGroupLayout;
  readonly #pipelines: Map<string, GPURenderPipeline>;
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
  #depthFormat: GPUTextureFormat | undefined;
  #targetSize: Vec2 = [1, 1];
  #scissor: Rect | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#glyphs = new GlyphStore(device);
    const shared = sharedGpu(device);
    this.#module = shared.module;
    this.#itemLayout = shared.itemLayout;
    this.#textureLayout = shared.textureLayout;
    this.#effectLayout = shared.effectLayout;
    this.#pipelines = shared.pipelines;
    this.#effectModules = shared.effectModules;
    // Batch：变换矩阵 64 字节、pickId，按 16 字节对齐
    this.#uniform = device.createBuffer({ label: 'SpriteBatch transform', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#effectBuffer = device.createBuffer({ label: 'SpriteBatch effect parameters', size: SPRITE_EFFECT_PARAMETERS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#items = this.#createItems(this.#data.byteLength);
  }

  /**
   * 开始一批：之后的 draw、drawString 在 end() 时画进 pass（渲染目标 width x height，颜色格式 format）。pass 带着深度缓冲时
   * 给它的格式 depthFormat：画的东西被深度更近的挡住。
   */
  begin(pass: GPURenderPassEncoder, width: number, height: number, format: GPUTextureFormat, depthFormat?: GPUTextureFormat): void {
    if (this.#pass) throw new Error('SpriteBatch.begin called twice without end');
    this.#pass = pass;
    this.#targetSize = [width, height];
    this.#format = format;
    this.#depthFormat = depthFormat;
    this.#count = 0;
    this.#runs = [];
    this.#scissor = undefined;
    this.#activePickId = this.pickId;
    this.#activeEffect = this.pickId === undefined ? this.effect : undefined;
  }

  /** 之后画的东西裁到 rect（真实像素，整数）里；undefined 是不裁（UI 的 ClipToBounds）。 */
  setScissor(rect: Rect | undefined): void {
    this.#scissor = rect;
  }

  /** quad 在渲染目标上的包围盒（真实像素，向外取整）；有角落在相机后面时是整个渲染目标。 */
  screenBounds(quad: Quad): Rect {
    const [tw, th] = this.#targetSize;
    const corners: Vec2[] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, v] of corners) {
      const pixel = this.#toPixels(quad.origin[0] + quad.axisX[0] * u + quad.axisY[0] * v, quad.origin[1] + quad.axisX[1] * u + quad.axisY[1] * v);
      if (!pixel) return [0, 0, tw, th];
      x0 = Math.min(x0, pixel[0]); y0 = Math.min(y0, pixel[1]); x1 = Math.max(x1, pixel[0]); y1 = Math.max(y1, pixel[1]);
    }
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    return [x0, y0, Math.ceil(x1) - x0, Math.ceil(y1) - y0];
  }

  /** 虚拟坐标在渲染目标上的真实像素；在相机后面时是 undefined。 */
  #toPixels(x: number, y: number): Vec2 | undefined {
    const [tw, th] = this.#targetSize;
    const m = this.transform;
    if (!m) {
      const [vx, vy] = this.virtualResolution ?? this.#targetSize;
      return [(x * tw) / vx, (y * th) / vy];
    }
    const w = m[3]! * x + m[7]! * y + m[15]!;
    if (!(w > 0)) return undefined;
    const cx = (m[0]! * x + m[4]! * y + m[12]!) / w, cy = (m[1]! * x + m[5]! * y + m[13]!) / w;
    return [((cx + 1) / 2) * tw, ((1 - cy) / 2) * th];
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
  drawText(font: SpriteFont, text: string, transform: Matrix2DLike, { fontSize, color = WHITE, alignment = 'left', boxWidth, snap = true, outline, selection }: DrawTextOptions): void {
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
    const aliased = font.antiAlias === 'aliased';
    const baseOffset = font.baseOffset(size[1]);
    // em 的 x 轴、y 轴（y 向上，所以取反）
    const axes = [emToFont[0] * ux, emToFont[0] * uy, -emToFont[1] * vx, -emToFont[1] * vy] as const;
    const box = boxWidth === undefined ? undefined : boxWidth * ratio[0];
    const glyphs = layoutText(font, text, size, alignment, box);
    if (selection) {
      // 选中的字每行并成一块（字体像素里的矩形换到虚拟坐标）
      const lineHeight = font.totalLineSpacing(size[1]);
      const selected = glyphs.filter(({ index }) => index >= selection.start && index < selection.end);
      for (let i = 0; i < selected.length;) {
        let j = i;
        while (j + 1 < selected.length && selected[j + 1]!.y === selected[i]!.y) j++;
        const x = selected[i]!.x, y = selected[i]!.y, width = selected[j]!.nextX - x;
        this.drawQuad(null, { origin: [ox + x * ux + y * vx, oy + x * uy + y * vy], axisX: [width * ux, width * uy], axisY: [lineHeight * vx, lineHeight * vy] }, [0, 0, 1, 1], selection.color);
        i = j + 1;
      }
    }
    // radius：描边的半径（em），0 是字本身
    const emit = (linear: Color, radius: number): void => {
      for (const { glyph, x, y } of glyphs) {
        if (glyph.hBands === 0) continue;
        const gx = snap ? Math.round(x) : x, gy = snap ? Math.round(y + baseOffset) : y + baseOffset;
        this.#glyphItem(glyph, ox + gx * ux + gy * vx, oy + gx * uy + gy * vy, axes, dilation + radius, aliased, linear, radius);
      }
    };
    // 整段文字的描边都画在字的下面：先画完所有字的描边，再画字（相邻的字的描边不盖住前一个字）
    const emSize = Math.min(Math.hypot(axes[0], axes[1]), Math.hypot(axes[2], axes[3]));
    if (outline && outline.thickness > 0 && outline.color[3] > 0 && emSize > 0) emit(toLinear(outline.color), outline.thickness / emSize);
    emit(toLinear(color), 0);
  }

  /**
   * 画排好的富文本（richLayout.ts）：transform 同 drawText，把文字框的局部坐标（虚拟像素，左上角是原点）换到屏幕的虚拟坐标。
   * 每个字按自己的字体和字号画；合成的粗体是轮廓往外扩（和描边同一套，按到轮廓的距离），合成的斜体是把字的 y 轴往右斜切。
   * 先画代码的底色，再画描边、字，最后画下划线和删除线。
   */
  drawRichText(layout: RichTextLayout, transform: Matrix2DLike, { colorOf, codeBackground, alignment = 'left', boxWidth, snap = true, outline }: DrawRichTextOptions): void {
    const [a, b, c, d, e, f] = transform;
    const screen = this.#ratio();
    const ox = snap ? Math.round(e * screen[0]) / screen[0] : e, oy = snap ? Math.round(f * screen[1]) / screen[1] : f;
    const offsets = layout.lines.map((line) => lineOffset(line, alignment, boxWidth ?? layout.size[0]));
    // 文字框里的矩形（虚拟像素）换到屏幕
    const rect = (x: number, y: number, width: number, height: number, color: Color) =>
      this.drawQuad(null, { origin: [ox + x * a + y * c, oy + x * b + y * d], axisX: [width * a, width * b], axisY: [height * c, height * d] }, [0, 0, 1, 1], color);
    if (codeBackground && codeBackground[3] > 0) {
      for (const deco of layout.decorations) if (deco.kind === 'code') rect(deco.x + offsets[deco.line]!, deco.y, deco.width, deco.height, codeBackground);
    }
    const linear = new Map<RichStyle, Color>();
    const colorFor = (style: RichStyle): Color => {
      let color = linear.get(style);
      if (!color) linear.set(style, (color = toLinear(colorOf(style))));
      return color;
    };
    // radius：描边的半径（虚拟像素），0 是字本身
    const emit = (outlineColor: Color | undefined, radius: number): void => {
      for (const glyph of layout.glyphs) {
        if (glyph.glyph.hBands === 0) continue;
        const { font, fontPx, unit } = glyph;
        const emToFont = glyphScale(font, [fontPx, fontPx]);
        const ux = a * unit, uy = b * unit, vx = c * unit, vy = d * unit;
        const axes: [number, number, number, number] = [emToFont[0] * ux, emToFont[0] * uy, -emToFont[1] * vx, -emToFont[1] * vy];
        if (glyph.syntheticItalic) {
          axes[2] += SYNTHETIC_ITALIC_SLANT * emToFont[0] * ux;
          axes[3] += SYNTHETIC_ITALIC_SLANT * emToFont[0] * uy;
        }
        const pixels = Math.min(Math.hypot(ux, uy) * screen[0], Math.hypot(vx, vy) * screen[1]) * Math.min(Math.abs(emToFont[0]), Math.abs(emToFont[1]));
        if (!(pixels > 0)) continue;
        const emSize = Math.min(Math.hypot(axes[0], axes[1]), Math.hypot(axes[2], axes[3]));
        const bold = glyph.syntheticBold ? SYNTHETIC_BOLD_EM : 0;
        const outlineEm = radius > 0 && emSize > 0 ? radius / emSize : 0;
        if (radius > 0 && outlineEm === 0) continue;
        // 合成粗体往两边各扩 bold em，前进宽度里多算了两份：字往右挪一份居中
        let x = glyph.x + offsets[glyph.line]! + bold * emToFont[0] * unit, y = glyph.y;
        // 原点按字体像素取整（同 drawText；运行时字体的字体像素就是真实像素）
        if (snap) {
          x = Math.round(x / unit) * unit;
          y = Math.round(y / unit) * unit;
        }
        const total = bold + outlineEm;
        this.#glyphItem(glyph.glyph, ox + x * a + y * c, oy + x * b + y * d, axes, 1 / pixels + total, font.antiAlias === 'aliased', outlineColor ?? colorFor(glyph.style), total);
      }
    };
    if (outline && outline.thickness > 0 && outline.color[3] > 0) emit(toLinear(outline.color), outline.thickness);
    emit(undefined, 0);
    for (const deco of layout.decorations) {
      if (deco.kind === 'code') continue;
      // 线至少一个真实像素粗
      rect(deco.x + offsets[deco.line]!, deco.y, deco.width, Math.max(deco.height, 1 / screen[1]), colorOf(deco.style));
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
    const aliased = font.antiAlias === 'aliased';
    const baseOffset = font.baseOffset(size[1]);
    // em 的 x 轴、y 轴（y 向上，所以屏幕上朝上）在虚拟坐标里的向量，每个字都一样
    const axes = [emToFont[0] * sx * cos, emToFont[0] * sx * sin, emToFont[1] * sy * sin, -emToFont[1] * sy * cos] as const;
    const linear = toLinear(color);
    for (const { glyph, x, y } of layoutText(font, text, size, alignment)) {
      // 空格这样没有轮廓的字不画
      if (glyph.hBands === 0) continue;
      // 字的原点相对文字原点（字体像素，字体像素就是真实像素），取整同 Stride
      const gx = Math.round(x - origin[0] * ratio[0]), gy = Math.round(y + baseOffset - origin[1] * ratio[1]);
      this.#glyphItem(glyph, px + gx * sx * cos - gy * sy * sin, py + gx * sx * sin + gy * sy * cos, axes, dilation, aliased, linear);
    }
  }

  /**
   * 一个字形的一项：em 原点的位置、em 的 x 轴和 y 轴（虚拟坐标），em 范围向外扩 margin（抗锯齿的边、描边不被裁掉）。
   * outlineRadius（em）大于 0 时这一项画的是字连同它的描边。
   */
  #glyphItem(glyph: FontGlyph, x: number, y: number, axes: readonly [number, number, number, number], margin: number, aliased: boolean, linear: Color, outlineRadius = 0): void {
    const index = this.#glyphs.glyphIndex(glyph);
    const at = this.#reserve('glyph', undefined, linear, true);
    const d = this.#data, bounds = glyph.bounds;
    d[at] = x; d[at + 1] = y; d[at + 2] = axes[0]; d[at + 3] = axes[1];
    d[at + 4] = axes[2]; d[at + 5] = axes[3]; d[at + 6] = bounds[0] - margin; d[at + 7] = bounds[1] - margin;
    d[at + 8] = bounds[2] + margin; d[at + 9] = bounds[3] + margin;
    this.#bits[at + 10] = (index | (aliased ? 0x80000000 : 0)) >>> 0;
    d[at + 11] = outlineRadius;
  }

  /**
   * 文字在虚拟坐标里的大小（Stride 的 SpriteBatch.MeasureString）：按 targetSize（默认是 begin 时的渲染目标）和虚拟分辨率的比例
   * 换算，字号默认是字体的 size。
   */
  measureString(font: SpriteFont, text: string, fontSize = font.size, targetSize?: Vec2): [number, number] {
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
    this.#device.queue.writeBuffer(this.#uniform, 0, this.transform ?? this.#screenTransform());
    this.#device.queue.writeBuffer(this.#uniform, 64, new Uint32Array([this.#activePickId ?? 0]));
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
    const effect = this.#activeEffect;
    if (effect) {
      this.#device.queue.writeBuffer(this.#effectBuffer, 0, effect.parameters);
      pass.setBindGroup(2, this.#effectGroup(effect));
    }
    // 剪裁矩形要在整批的 clip 里（clip 默认是整个渲染目标）；pass 开始时的剪裁矩形就是 clip
    const clip = this.#clip();
    let scissor: Rect | undefined;
    for (const run of this.#runs) {
      if (run.scissor !== scissor) {
        pass.setScissorRect(...intersect(run.scissor ?? clip, clip));
        scissor = run.scissor;
      }
      pass.setPipeline(this.#pipeline(run.kind));
      pass.setBindGroup(1, run.kind === 'glyph' ? this.#glyphs.bindGroup() : this.#textureGroup(run.texture!));
      pass.draw(4, run.count, 0, run.first);
    }
    if (scissor) pass.setScissorRect(...clip);
  }

  /** 整批的剪裁矩形，限制在渲染目标里。 */
  #clip(): [number, number, number, number] {
    const [tw, th] = this.#targetSize;
    const target: Rect = [0, 0, tw, th];
    return this.clip ? intersect(this.clip, target) : [0, 0, tw, th];
  }

  destroy(): void {
    this.#items.destroy();
    this.#uniform.destroy();
    this.#effectBuffer.destroy();
    this.#glyphs.destroy();
  }

  /** 铺满渲染目标：虚拟坐标 (0, 0) 在左上角，y 向下。 */
  #screenTransform(): Float32Array {
    const [vx, vy] = this.virtualResolution ?? this.#targetSize;
    const m = new Float32Array(16);
    m[0] = 2 / vx; m[5] = -2 / vy; m[10] = 1; m[12] = -1; m[13] = 1; m[15] = 1;
    return m;
  }

  /** 真实像素 / 虚拟坐标；没给 targetSize 且设了 pixelRatio 时是 pixelRatio。 */
  #ratio(targetSize?: Vec2): Vec2 {
    if (!targetSize && this.pixelRatio) return this.pixelRatio;
    const [width, height] = targetSize ?? this.#targetSize;
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
    const depthFormat = this.#depthFormat;
    // 自定义效果只换贴图的片元着色器，文字照常画
    const effect = kind === 'sprite' ? this.#activeEffect : undefined;
    const picking = this.#activePickId !== undefined;
    const key = `${kind}:${this.#format}:${depthFormat ?? ''}:${picking ? 'pick' : ''}:${effect ? `${effect.blend}:${effect.code}` : ''}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      const groups = [this.#itemLayout, kind === 'glyph' ? this.#glyphs.layout : this.#textureLayout, ...(effect ? [this.#effectLayout] : [])];
      // 预乘 alpha（Stride 的 BlendStates.AlphaBlend）；效果可以要 NonPremultiplied（颜色乘源的 alpha）
      const source: GPUBlendFactor = effect?.blend === 'nonPremultiplied' ? 'src-alpha' : 'one';
      pipeline = this.#device.createRenderPipeline({
        label: `SpriteBatch ${kind}${effect ? ' effect' : ''}${picking ? ' picking' : ''}`,
        layout: this.#device.createPipelineLayout({ bindGroupLayouts: groups }),
        vertex: { module: this.#module, entryPoint: kind === 'glyph' ? 'vsGlyph' : 'vsSprite' },
        fragment: picking ? { module: this.#module, entryPoint: kind === 'glyph' ? 'fsGlyphPick' : 'fsSpritePick', targets: [{ format: this.#format }] } : {
          module: effect ? this.#effectModule(effect) : this.#module,
          entryPoint: kind === 'glyph' ? 'fsGlyph' : effect ? 'fsEffect' : 'fsSprite',
          targets: [{ format: this.#format, blend: { color: { srcFactor: source, dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-strip' },
        ...(depthFormat ? { depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' } } : {}),
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #effectModule(effect: SpriteEffect): GPUShaderModule {
    let module = this.#effectModules.get(effect.code);
    if (!module) {
      module = this.#device.createShaderModule({ label: 'SpriteBatch effect', code: SHADER + spriteEffectShader(effect) });
      this.#effectModules.set(effect.code, module);
    }
    return module;
  }

  #effectGroup(effect: SpriteEffect): GPUBindGroup {
    let group = this.#effectGroups.get(effect);
    if (!group) {
      group = this.#device.createBindGroup({
        label: 'SpriteBatch effect',
        layout: this.#effectLayout,
        entries: [{ binding: 0, resource: { buffer: this.#effectBuffer } }, { binding: 1, resource: this.#resources.sampler(effect.sampler) }],
      });
      this.#effectGroups.set(effect, group);
    }
    return group;
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

/** 两个矩形（x、y、宽、高）的交集；不相交时宽或高是 0，位置仍在 b 里（剪裁矩形不能超出渲染目标）。 */
function intersect([x, y, w, h]: Rect, [bx, by, bw, bh]: Rect): [number, number, number, number] {
  const x0 = Math.min(Math.max(x, bx), bx + bw), y0 = Math.min(Math.max(y, by), by + bh);
  return [x0, y0, Math.max(0, Math.min(x + w, bx + bw) - x0), Math.max(0, Math.min(y + h, by + bh) - y0)];
}

/** 颜色当 sRGB 给（同 Stride 的 SpriteBatch），转成线性；alpha 不变。 */
function toLinear([r, g, b, a]: Color): Color {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a];
}
