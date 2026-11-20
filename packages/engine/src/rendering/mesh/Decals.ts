/**
 * 贴花（Decal 组件；Stride 没有，做法照 Godot 的 Decal）：一个盒子（实体的位置、旋转，size 是三边长），沿本地的 -Y 往下投，
 * 盒子里的不透明、透明表面着色时换上贴花的颜色和法线。网格着色器逐像素查（meshShader.ts 的 applyDecals）；分簇以后只查
 * 像素所在那一簇的。
 *
 * - 贴图放进一张图集（2D 贴图数组，第 0 层颜色、第 1 层法线；只占一个贴图绑定，网格着色器的贴图绑定离默认上限 16 个只差
 *   几个了）。颜色层是 rgba8unorm，存 sRGB 编码过的值、着色器里解码（数组的各层格式一样，法线层不能是 sRGB 的）。
 *   每张贴图最长边缩到 MAX_TILE 以内，按行装箱，四周留 PADDING 像素重复边缘的颜色（mip 不串色）；装不下时图集翻倍，到
 *   MAX_ATLAS 还装不下的贴花跳过并警告一次。贴图的集合变了才重建图集。
 * - 每个贴花 DECAL_FLOATS 个数：世界到盒子（-1..1）的矩阵、颜色和法线在图集里的位置、颜色乘数和不透明度、几种淡出、
 *   盒子的三个轴（世界里，法线贴图的切线空间）。个数不设上限，缓冲按 2 的幂变大；内容没变时不重传。
 * - 分簇（lighting/Clusters.ts）：每个要着色的视图里像素只看所在那一簇的贴花。
 * - 没做：只投到某些渲染组上（Godot 的 cull mask）、粗糙度和金属度的
 *   贴图、自发光、按距离淡出。
 */
import { Matrix, type Matrix4 } from '../../data/Matrix';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import type { GpuResources } from '../../graphics/GpuResources';
import { Texture } from '../../graphics/Texture';
import { Decal } from '../components';
import type { RenderContext } from '../RenderSystem';
import { FULLSCREEN_VERTEX } from '../wgsl';

/** 每个贴花的数（12 个 vec4，见文件头）。 */
export const DECAL_FLOATS = 48;
const MIN_ATLAS = 1024;
const MAX_ATLAS = 4096;
const MAX_TILE = 512;
const PADDING = 8;
/** 图集的 mip 级数（PADDING 是 8：到第 4 级四周还留 1 个像素）。 */
const ATLAS_LEVELS = 4;
const FORMAT: GPUTextureFormat = 'rgba8unorm';

/** 一块在图集里的位置（贴图坐标：左上角和大小，0..1）。 */
export type AtlasRect = readonly [u: number, v: number, width: number, height: number];

/**
 * 按行装箱：贴图按高度从高到低排，一行一行往下放，每块四周留 padding。返回每张贴图的位置（像素：x、y、宽、高，不含留边），
 * 放不下时返回 undefined。
 */
export function packAtlas(sizes: readonly (readonly [number, number])[], atlasSize: number, padding: number): ([number, number, number, number] | undefined)[] | undefined {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b]![1] - sizes[a]![1]);
  const out: ([number, number, number, number] | undefined)[] = new Array(sizes.length);
  let x = 0, y = 0, row = 0;
  for (const i of order) {
    const [w, h] = sizes[i]!;
    const pw = w + 2 * padding, ph = h + 2 * padding;
    if (pw > atlasSize) return undefined;
    if (x + pw > atlasSize) {
      x = 0;
      y += row;
      row = 0;
    }
    if (y + ph > atlasSize) return undefined;
    out[i] = [x + padding, y + padding, w, h];
    x += pw;
    row = Math.max(row, ph);
  }
  return out;
}

/** 贴图放进图集时的大小：最长边缩到 MAX_TILE 以内，保持比例。 */
export function tileSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, MAX_TILE / Math.max(width, height, 1));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** 贴花的这一帧数据（组件的值加世界矩阵）；单测直接用 packDecal。 */
export interface DecalInstance {
  readonly world: Readonly<Matrix4>;
  readonly size: readonly [number, number, number];
  readonly albedo: AtlasRect | undefined;
  readonly normal: AtlasRect | undefined;
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly albedoMix: number;
  readonly normalFade: number;
  readonly upperFade: number;
  readonly lowerFade: number;
}

const NONE: AtlasRect = [0, 0, 0, 0];

/** 贴花盒子的包围球：球心是实体的位置，半径是盒子（带实体的缩放）半个对角线。 */
export function decalBounds(world: Readonly<Matrix4>, size: readonly [number, number, number]): [number, number, number, number] {
  const out = new Float32Array(4);
  writeDecalBounds(world, size, out, 0);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}

/** 包围球写进 out[offset..offset + 4]（每帧给所有贴花算，不分配）。 */
function writeDecalBounds(world: Readonly<Matrix4>, size: readonly [number, number, number], out: Float32Array, offset: number): void {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const half = (size[axis]! / 2) * Math.hypot(world[axis * 4]!, world[axis * 4 + 1]!, world[axis * 4 + 2]!);
    squared += half * half;
  }
  out[offset] = world[12]!;
  out[offset + 1] = world[13]!;
  out[offset + 2] = world[14]!;
  out[offset + 3] = Math.sqrt(squared);
}

// packDecal 的临时矩阵（每帧给所有贴花算，不分配）
const INVERSE = Matrix.identity();
const SCALE = Matrix.identity();
const TO_BOX = Matrix.identity();

/** 一个贴花写进 out[offset..]（布局见 meshShader.ts 的 struct Decal）。 */
export function packDecal(decal: DecalInstance, out: Float32Array, offset: number): void {
  Matrix.invert(INVERSE, decal.world);
  // 盒子是本地 ±size/2：再缩到 ±1
  const [x, y, z] = decal.size;
  Matrix.scaleTranslation(SCALE, 2 / Math.max(x, 1e-4), 2 / Math.max(y, 1e-4), 2 / Math.max(z, 1e-4), 0, 0, 0);
  out.set(Matrix.multiply(TO_BOX, SCALE, INVERSE), offset);
  out.set(decal.albedo ?? NONE, offset + 16);
  out.set(decal.normal ?? NONE, offset + 20);
  out[offset + 24] = decal.color[0];
  out[offset + 25] = decal.color[1];
  out[offset + 26] = decal.color[2];
  out[offset + 27] = decal.opacity;
  out[offset + 28] = decal.albedoMix;
  out[offset + 29] = decal.normalFade;
  out[offset + 30] = decal.upperFade;
  out[offset + 31] = decal.lowerFade;
  // 盒子的轴（世界，单位向量）：x 是贴图的 u，y 是投影的反方向（贴花的"上"），z 是贴图的 v
  const w = decal.world;
  for (let axis = 0; axis < 3; axis++) {
    const x = w[axis * 4]!, y = w[axis * 4 + 1]!, z = w[axis * 4 + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    out[offset + 32 + axis * 4] = x / length;
    out[offset + 33 + axis * 4] = y / length;
    out[offset + 34 + axis * 4] = z / length;
    out[offset + 35 + axis * 4] = 0;
  }
  out.fill(0, offset + 44, offset + DECAL_FLOATS);
}

/** 把一张贴图画进图集的一块（颜色层编码成 sRGB）、按上一级生成 mip。 */
const BLIT_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
// uv 的缩放和偏移：画到含留边的一块时 uv 超出 0..1，采样器是 clamp，留边里就是边缘的颜色
struct Blit { uvScale: vec2f, uvOffset: vec2f, encodeSrgb: u32, pad0: u32, pad1: u32, pad2: u32 };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;
@group(0) @binding(2) var<uniform> blit: Blit;

fn encodeSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let c = textureSampleLevel(source, linearClamp, in.uv * blit.uvScale + blit.uvOffset, 0.0);
  return select(c, vec4f(encodeSrgb(max(c.rgb, vec3f(0.0))), c.a), blit.encodeSrgb == 1u);
}`;

/** 一个找到的贴花（组件的值、世界矩阵、它的贴图在图集里的位置）。 */
interface FoundDecal extends DecalInstance {
  readonly world: Float32Array;
  readonly size: [number, number, number];
  readonly color: [number, number, number];
  albedoId: number;
  normalId: number;
  albedo: AtlasRect | undefined;
  normal: AtlasRect | undefined;
  opacity: number;
  albedoMix: number;
  normalFade: number;
  upperFade: number;
  lowerFade: number;
  /** 和上一帧比变了，要重新打包。 */
  dirty: boolean;
}

function createFoundDecal(): FoundDecal {
  return { world: new Float32Array(16), size: [0, 0, 0], color: [0, 0, 0], albedoId: 0, normalId: 0, albedo: undefined, normal: undefined, opacity: 0, albedoMix: 0, normalFade: 0, upperFade: 0, lowerFade: 0, dirty: true };
}

interface Entry {
  readonly texture: Texture;
  readonly layer: 0 | 1;
}

/** 场景里的贴花（渲染系统一份）：前向渲染器收集光照时 apply，网格特性着色时绑 buffer 和 atlas。 */
export class Decals {
  /** 这一帧的贴花个数。 */
  count = 0;
  /** 每个贴花的包围球（世界坐标的球心、半径，4 个数一个，前 count 个有效；分簇用）。贴花多了换成更大的数组。 */
  bounds = new Float32Array(64 * 4);
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  #data = new Float32Array(64 * DECAL_FLOATS);
  /** 上一次打包的贴花个数（个数变了，下标对应的实体可能都换了：全部重新打包）。 */
  #packedCount = 0;
  #buffer: GPUBuffer | undefined;
  #atlas: GPUTexture | undefined;
  /** 还没有贴花时绑的：1x1x2 的空图集、一个贴花大小的空缓冲。 */
  #emptyAtlas: GPUTexture | undefined;
  #emptyBuffer: GPUBuffer | undefined;
  /** 图集里的贴图（颜色、法线分开记：同一张贴图两种用法各放一块）→ 位置；贴图的集合变了才重建。 */
  #rects = new Map<string, AtlasRect>();
  #atlasKey = '';
  #pipeline: GPURenderPipeline | undefined;
  /** 这一帧找到的贴花：前 #foundCount 个有效，记录跨帧复用（每帧给所有贴花填一遍，不分配）。 */
  readonly #found: FoundDecal[] = [];
  #foundCount = 0;

  readonly #collect = system('Decals.collect', {
    with: { decal: Decal, transform: Transform },
    update: ({ decal, transform, count }) => {
      // 列在循环外取一次（列的属性是取值函数）
      const { slot, world } = transform;
      const { size, color, albedo, normal, opacity, albedoMix, normalFade, upperFade, lowerFade } = decal;
      for (let i = 0; i < count; i++) {
        const found = (this.#found[this.#foundCount++] ??= createFoundDecal());
        // 和上一帧这个位置的贴花比：一样就不重新打包（没变就不做）
        let changed = false;
        const w = slot[i]! * 16;
        for (let k = 0; k < 16; k++) {
          if (found.world[k] !== world[w + k]) {
            found.world[k] = world[w + k]!;
            changed = true;
          }
        }
        for (let c = 0; c < 3; c++) {
          if (found.size[c] !== size[i * 3 + c] || found.color[c] !== color[i * 3 + c]) {
            found.size[c] = size[i * 3 + c]!;
            found.color[c] = color[i * 3 + c]!;
            changed = true;
          }
        }
        if (found.albedoId !== albedo[i] || found.normalId !== normal[i] || found.opacity !== opacity[i] || found.albedoMix !== albedoMix[i]
          || found.normalFade !== normalFade[i] || found.upperFade !== upperFade[i] || found.lowerFade !== lowerFade[i]) {
          found.albedoId = albedo[i]!;
          found.normalId = normal[i]!;
          found.opacity = opacity[i]!;
          found.albedoMix = albedoMix[i]!;
          found.normalFade = normalFade[i]!;
          found.upperFade = upperFade[i]!;
          found.lowerFade = lowerFade[i]!;
          changed = true;
        }
        if (changed) found.dirty = true;
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 贴花的缓冲（还没有贴花时是一个空的小缓冲）；贴花多了换成更大的，用它的绑定组要重建（看 buffer 变没变）。 */
  get buffer(): GPUBuffer {
    return this.#buffer ?? (this.#emptyBuffer ??= this.#device.createBuffer({ label: 'Decals empty', size: DECAL_FLOATS * 4, usage: GPUBufferUsage.STORAGE }));
  }

  /** 图集（2D 贴图数组，两层）；还没有贴花时是 1x1 的空图集。换了网格特性要重建绑定组。 */
  get atlas(): GPUTexture {
    return this.#atlas ?? (this.#emptyAtlas ??= this.#device.createTexture({ label: 'Decals empty atlas', size: [1, 1, 2], format: FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING }));
  }

  /** @internal 前向渲染器每帧收集光照时调用：找贴花、需要时重建图集、内容变了才上传。 */
  apply(context: RenderContext): void {
    this.#foundCount = 0;
    context.game.entities.run(this.#collect, context.time);
    const count = (this.count = this.#foundCount);
    if (count === 0) {
      this.#packedCount = 0;
      return;
    }
    // 用到的贴图（颜色、法线各一层）：贴图的种类远少于贴花，按键去重
    const entries: Entry[] = [], seen = new Set<number>();
    for (let i = 0; i < count; i++) {
      const decal = this.#found[i]!;
      for (const layer of [0, 1] as const) {
        const id = layer === 0 ? decal.albedoId : decal.normalId;
        if (!id || seen.has(id * 2 + layer)) continue;
        seen.add(id * 2 + layer);
        const texture = Texture.byId(id);
        if (texture) entries.push({ texture, layer });
      }
    }
    // 图集重建了：贴图的位置都可能变了，全部重新打包
    const atlasChanged = this.#ensureAtlas(entries);
    let all = atlasChanged || count !== this.#packedCount;
    if (count * DECAL_FLOATS > this.#data.length) {
      const capacity = 2 ** Math.ceil(Math.log2(count));
      this.#data = new Float32Array(capacity * DECAL_FLOATS);
      this.bounds = new Float32Array(capacity * 4);
      this.#buffer?.destroy();
      this.#buffer = undefined;
      all = true;
    }
    let first = count, last = -1;
    for (let i = 0; i < count; i++) {
      const decal = this.#found[i]!;
      if (!decal.dirty && !all) continue;
      decal.dirty = false;
      decal.albedo = decal.albedoId ? this.#rects.get(`0:${decal.albedoId}`) : undefined;
      decal.normal = decal.normalId ? this.#rects.get(`1:${decal.normalId}`) : undefined;
      packDecal(decal, this.#data, i * DECAL_FLOATS);
      writeDecalBounds(decal.world, decal.size, this.bounds, i * 4);
      first = Math.min(first, i);
      last = i;
    }
    this.#packedCount = count;
    this.#buffer ??= this.#device.createBuffer({ label: 'Decals', size: this.#data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // 只传变了的那一段
    if (last >= first) this.#device.queue.writeBuffer(this.#buffer, first * DECAL_FLOATS * 4, this.#data, first * DECAL_FLOATS, (last - first + 1) * DECAL_FLOATS);
  }

  destroy(): void {
    for (const resource of [this.#buffer, this.#atlas, this.#emptyAtlas, this.#emptyBuffer]) resource?.destroy();
  }

  /** 图集里放着这些贴图；集合变了才重建（重新装箱、画进去、生成 mip），返回重建了没有。 */
  #ensureAtlas(entries: readonly Entry[]): boolean {
    const key = entries.map((e) => `${e.layer}:${e.texture.id}`).sort().join(',');
    if (key === this.#atlasKey && (this.#atlas || entries.length === 0)) return false;
    this.#atlasKey = key;
    this.#rects.clear();
    if (entries.length === 0) return true;
    const sizes = entries.map((e) => tileSize(e.texture.data.width, e.texture.data.height));
    // 两层各自装箱，图集的大小取两层都装得下的
    let size = MIN_ATLAS, placed: ([number, number, number, number] | undefined)[] = [];
    for (; size <= MAX_ATLAS; size *= 2) {
      placed = new Array(entries.length);
      let fits = true;
      for (const layer of [0, 1] as const) {
        const indices = entries.map((e, i) => (e.layer === layer ? i : -1)).filter((i) => i >= 0);
        const packed = packAtlas(indices.map((i) => sizes[i]!), size, PADDING);
        if (!packed) {
          fits = false;
          break;
        }
        indices.forEach((index, k) => (placed[index] = packed[k]));
      }
      if (fits) break;
    }
    if (size > MAX_ATLAS) {
      size = MAX_ATLAS;
      console.warn(`Decals: the decal textures do not fit into a ${MAX_ATLAS}x${MAX_ATLAS} atlas; some decals are drawn without them`);
    }
    if (this.#atlas?.width !== size) {
      this.#atlas?.destroy();
      this.#atlas = this.#device.createTexture({
        label: 'Decals atlas', size: [size, size, 2], format: FORMAT, mipLevelCount: ATLAS_LEVELS,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    this.#draw(entries, placed, size);
    return true;
  }

  /** 每张贴图画进它的那块（连同留边：边缘的颜色往外延），再逐级生成 mip。 */
  #draw(entries: readonly Entry[], placed: readonly ([number, number, number, number] | undefined)[], size: number): void {
    const device = this.#device, atlas = this.#atlas!;
    const pipeline = (this.#pipeline ??= device.createRenderPipeline({
      label: 'Decals atlas', layout: 'auto',
      vertex: { module: device.createShaderModule({ label: 'Decals atlas', code: BLIT_SHADER }), entryPoint: 'fullscreenVertex' },
      fragment: { module: device.createShaderModule({ label: 'Decals atlas', code: BLIT_SHADER }), entryPoint: 'fs', targets: [{ format: FORMAT }] },
    }));
    // 每次画一个参数缓冲（只在重建图集时画，次数不多）：同一个编码器里的几遍不能共用一个中途改写的缓冲
    const uniforms: GPUBuffer[] = [];
    const encoder = device.createCommandEncoder({ label: 'Decals atlas' });
    const blit = (target: GPUTextureView, source: GPUTextureView, encode: boolean, viewport?: readonly [number, number, number, number], uv: readonly [number, number, number, number] = [1, 1, 0, 0], first = false) => {
      const uniform = device.createBuffer({ label: 'Decals blit', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(32);
      new Float32Array(data, 0, 4).set(uv);
      new Uint32Array(data, 16, 4).set([encode ? 1 : 0, 0, 0, 0]);
      device.queue.writeBuffer(uniform, 0, data);
      uniforms.push(uniform);
      const pass = encoder.beginRenderPass({ label: 'Decals atlas', colorAttachments: [{ view: target, loadOp: first ? 'clear' : 'load', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: source }, { binding: 1, resource: this.#resources.linearClamp }, { binding: 2, resource: { buffer: uniform } }],
      }));
      if (viewport) pass.setViewport(viewport[0], viewport[1], viewport[2], viewport[3], 0, 1);
      pass.draw(3);
      pass.end();
    };
    const levelView = (layer: number, level: number) => atlas.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: level, mipLevelCount: 1 });
    // 先清空两层的第 0 级
    for (const layer of [0, 1]) encoder.beginRenderPass({ colorAttachments: [{ view: levelView(layer, 0), loadOp: 'clear', storeOp: 'store' }] }).end();
    entries.forEach((entry, i) => {
      const at = placed[i];
      if (!at) return;
      const [x, y, w, h] = at;
      // 画到含留边的一块，uv 往外扩到留边（clamp 采样，留边里是边缘的颜色）；记下的是不含留边的那块
      const source = this.#resources.texture(entry.texture).createView({ dimension: '2d' });
      const sx = (w + 2 * PADDING) / w, sy = (h + 2 * PADDING) / h;
      blit(levelView(entry.layer, 0), source, entry.layer === 0, [x - PADDING, y - PADDING, w + 2 * PADDING, h + 2 * PADDING], [sx, sy, -PADDING / w, -PADDING / h]);
      this.#rects.set(`${entry.layer}:${entry.texture.id}`, [x / size, y / size, w / size, h / size]);
    });
    for (const layer of [0, 1]) {
      for (let level = 1; level < ATLAS_LEVELS; level++) blit(levelView(layer, level), levelView(layer, level - 1), false, undefined, undefined, true);
    }
    device.queue.submit([encoder.finish()]);
    for (const buffer of uniforms) buffer.destroy();
  }
}
