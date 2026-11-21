/**
 * 精灵的根渲染特性（Stride 的 SpriteRenderFeature 加 Sprite3DBatch）：带 Sprite 和 Transform 的实体，画在透明阶段。
 * - 位置和 Stride 一样在 CPU 上算：普通精灵用实体的世界矩阵；billboard 用相机的世界矩阵（去掉相机的缩放、乘上实体的
 *   缩放、换成实体的位置）；再按 center 把矩形移开，宽高是贴图（精灵表的精灵是它的区域）尺寸除以 pixelsPerUnit。
 * - 每个视图按到相机的深度从远到近排（Stride 透明阶段的 BackToFrontSortMode），一个精灵一次绘制（4 个顶点的三角形带），
 *   实例数据（四个角的原点、两条边、颜色、UV）放在存储缓冲里，按视图分段。
 * - 混合同 Stride：auto 在贴图透明时是 alphaBlend，否则不混合；alphaBlend 按 premultipliedAlpha 选预乘或不预乘的
 *   混合；additiveBlend 是 src·alpha + dst。深度测试并写入，ignoreDepth 时都不做；不剔背面。
 * 和 Stride 不同（暂时）：没有 Swizzle、billboard 的 RotationEulerZ 和精灵的九宫格边框（Borders）。
 */
import type { SceneEntityFile } from '../content/format';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Matrix } from '../data/Matrix';
import { srgbToLinear } from '../data/vectors';
import { Sprite } from './components';
import { inRenderMask, RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';
import { SpriteSheet } from './SpriteSheet';
import { Texture } from '../graphics/Texture';

const SHADER = /* wgsl */ `
struct SpriteInstance {
  origin: vec4f,
  axisX: vec4f,
  axisY: vec4f,
  color: vec4f,
  // xy：UV 的起点，zw：UV 的大小
  uv: vec4f,
  // x：alpha 低于 0.1 的不画；y：实体的变换槽位加一（点选的编号缓冲写它）
  flags: vec4f,
};
@group(0) @binding(0) var<storage, read> sprites: array<SpriteInstance>;
@group(0) @binding(1) var<uniform> viewProjection: mat4x4f;
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;
@group(1) @binding(1) var spriteSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) instance: u32,
};

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let sprite = sprites[instance];
  // 三角形带：左上、右上、左下、右下（Stride 的 leftTopCorner 在 (-0.5, 0.5)，UV 的 v 向下）
  let corner = vec2f(f32(vertex & 1u) - 0.5, 0.5 - f32(vertex >> 1u));
  let world = sprite.origin.xyz + sprite.axisX.xyz * corner.x + sprite.axisY.xyz * corner.y;
  var out: Varyings;
  out.position = viewProjection * vec4f(world, 1.0);
  out.uv = sprite.uv.xy + vec2f(corner.x + 0.5, 0.5 - corner.y) * sprite.uv.zw;
  out.instance = instance;
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let sprite = sprites[in.instance];
  // Stride 编译贴图时预乘 alpha（ColorTextureType.PremultiplyAlpha 默认开，在线性空间乘），我们的贴图存的是直通 alpha，采样后乘上
  let texel = textureSample(spriteTexture, spriteSampler, in.uv);
  let color = vec4f(texel.rgb * texel.a, texel.a) * sprite.color;
  if (sprite.flags.x != 0.0 && color.a < 0.1) {
    discard;
  }
  return color;
}

/** 点选的编号缓冲（ScenePicker）：写变换槽位加一；差不多全透明的地方点不到，会点到后面的东西。 */
@fragment fn fsPick(in: Varyings) -> @location(0) u32 {
  let sprite = sprites[in.instance];
  if (textureSample(spriteTexture, spriteSampler, in.uv).a * sprite.color.a < 0.1) {
    discard;
  }
  return u32(sprite.flags.y);
}`;

/** 一个实例：origin、axisX、axisY、color、uv、flags 各 4 个 float。 */
const INSTANCE_FLOATS = 24;
/** 视图的 uniform 按 256 字节对齐（动态偏移）。 */
const VIEW_STRIDE = 256;
/** 最多几个视图（同 MeshRenderFeature）。 */

type Blend = 'none' | 'premultiplied' | 'nonPremultiplied' | 'additive' | 'noColor';

/** 提取出来的一个精灵。 */
interface SpriteItem {
  texture: Texture;
  renderGroup: number;
  /** 贴图上要画的区域，按贴图尺寸归一化：u、v、宽、高。 */
  readonly uv: [number, number, number, number];
  /** 区域的像素宽高。 */
  width: number;
  height: number;
  slot: number;
  pixelsPerUnit: number;
  centerX: number;
  centerY: number;
  centerFromMiddle: boolean;
  billboard: boolean;
  /** 线性的颜色乘强度。 */
  readonly color: [number, number, number, number];
  blend: Blend;
  ignoreDepth: boolean;
  alphaCutoff: boolean;
  sampler: 'linearClamp' | 'pointClamp' | 'anisotropicClamp';
}

const BLENDS: Record<Exclude<Blend, 'none'>, GPUBlendState | undefined> = {
  premultiplied: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
  nonPremultiplied: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' } },
  additive: { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'src-alpha', dstFactor: 'one' } },
  noColor: undefined,
};

interface Gpu {
  readonly module: GPUShaderModule;
  readonly instanceLayout: GPUBindGroupLayout;
  readonly textureLayout: GPUBindGroupLayout;
  readonly pipelineLayout: GPUPipelineLayout;
  views: GPUBuffer;
  readonly samplers: Record<SpriteItem['sampler'], GPUSampler>;
  readonly pipelines: Map<string, GPURenderPipeline>;
  /** 正在后台编的（warmFiles）。 */
  readonly warming: Map<string, Promise<void>>;
  readonly textureGroups: Map<string, GPUBindGroup>;
  instances: GPUBuffer | undefined;
  instanceGroup: GPUBindGroup | undefined;
  /** 每个视图能放几个实例。 */
  capacity: number;
  /** 能放几个视图（实例缓冲、视图缓冲按视图的下标分段；视图多了跟着变大，不设上限）。 */
  viewCapacity: number;
}

function createViewBuffer(device: GPUDevice, views: number): GPUBuffer {
  return device.createBuffer({ label: 'SpriteRenderFeature views', size: VIEW_STRIDE * Math.max(views, 1), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
}

export class SpriteRenderFeature extends RootRenderFeature {
  readonly name = 'SpriteRenderFeature';
  readonly #items: SpriteItem[] = [];
  #count = 0;
  #gpu: Gpu | undefined;
  #instanceData = new Float32Array(0);
  #viewData = new Float32Array(0);
  readonly #cameraWorld = new Float32Array(16);
  #drawCalls = 0;

  readonly #extractSystem = system('SpriteRenderFeature.extract', {
    with: { sprite: Sprite, transform: Transform },
    update: ({ sprite, transform, count }) => {
      for (let i = 0; i < count; i++) {
        if (sprite.enabled[i] === 0) continue;
        // 精灵表：用第 frame 个精灵的贴图、区域和设置；否则是一整张贴图
        const frame = sprite.sheet[i] !== 0 ? SpriteSheet.byId(sprite.sheet[i]!)?.frame(sprite.frame[i]!) : undefined;
        const texture = frame ? frame.texture : Texture.byId(sprite.texture[i]!);
        if (!texture) continue;
        const item = (this.#items[this.#count] ??= { color: [1, 1, 1, 1], uv: [0, 0, 1, 1] } as SpriteItem);
        this.#count++;
        item.texture = texture;
        item.slot = transform.slot[i]!;
        const { width, height } = texture.data;
        if (frame) {
          const [x, y, w, h] = frame.region;
          item.uv[0] = x / width;
          item.uv[1] = y / height;
          item.uv[2] = w / width;
          item.uv[3] = h / height;
          item.width = w;
          item.height = h;
          item.pixelsPerUnit = frame.pixelsPerUnit;
          [item.centerX, item.centerY] = frame.center;
          item.centerFromMiddle = frame.centerFromMiddle;
        } else {
          item.uv[0] = item.uv[1] = 0;
          item.uv[2] = item.uv[3] = 1;
          item.width = width;
          item.height = height;
          item.pixelsPerUnit = sprite.pixelsPerUnit[i]!;
          item.centerX = sprite.centerX[i]!;
          item.centerY = sprite.centerY[i]!;
          item.centerFromMiddle = sprite.centerFromMiddle[i] !== 0;
        }
        item.billboard = sprite.type[i] === 'billboard';
        // 同 Stride：颜色乘强度（四个分量都乘），着色器里按 sRGB 转成线性
        const intensity = sprite.intensity[i]!;
        for (let c = 0; c < 4; c++) {
          const value = sprite.color[i * 4 + c]!;
          item.color[c] = (c < 3 ? srgbToLinear(value) : value) * intensity;
        }
        item.blend = blendOf(sprite.blendMode[i]!, sprite.isTransparent[i] !== 0, sprite.premultipliedAlpha[i] !== 0);
        item.ignoreDepth = sprite.ignoreDepth[i] !== 0;
        item.alphaCutoff = sprite.isAlphaCutoff[i] !== 0;
        item.sampler = sprite.sampler[i]!;
        item.renderGroup = sprite.renderGroup[i]!;
      }
    },
  });

  override extract(context: RenderContext): void {
    this.#count = 0;
    this.#drawCalls = 0;
    context.game.entities.run(this.#extractSystem, context.time);
  }

  override stats(): Record<string, number> {
    return { sprites: this.#count, drawCalls: this.#drawCalls };
  }

  override prepare(): void {
    if (this.#count === 0) return;
    const gpu = (this.#gpu ??= this.#createGpu());
    const views = this.system.views;
    // 视图缓冲按这一帧的视图数增长
    if (gpu.viewCapacity < views.length) {
      gpu.viewCapacity = 2 ** Math.ceil(Math.log2(Math.max(views.length, 8)));
      gpu.views.destroy();
      gpu.views = createViewBuffer(this.system.device, gpu.viewCapacity);
      this.#viewData = new Float32Array((VIEW_STRIDE / 4) * gpu.viewCapacity);
      gpu.capacity = 0;
    }
    // 实例缓冲按这一帧的精灵数和视图数增长（只在 prepare 里重建：draw 时已经有绘制引用着它）
    if (gpu.capacity < this.#count) {
      gpu.capacity = 2 ** Math.ceil(Math.log2(this.#count));
      gpu.instances?.destroy();
      gpu.instances = this.system.device.createBuffer({ label: 'SpriteRenderFeature instances', size: gpu.capacity * gpu.viewCapacity * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      gpu.instanceGroup = this.system.device.createBindGroup({
        label: 'SpriteRenderFeature instances',
        layout: gpu.instanceLayout,
        entries: [{ binding: 0, resource: { buffer: gpu.instances } }, { binding: 1, resource: { buffer: gpu.views, size: 64 } }],
      });
      this.#instanceData = new Float32Array(gpu.capacity * INSTANCE_FLOATS);
    }
    for (const view of views) this.#viewData.set(view.viewProjection, view.index * (VIEW_STRIDE / 4));
    if (views.length > 0) this.system.device.queue.writeBuffer(gpu.views, 0, this.#viewData, 0, views.length * (VIEW_STRIDE / 4));
  }

  override get supportsPicking(): boolean {
    return true;
  }

  override draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.#gpu;
    const colorFormat = stage.output.colorFormat;
    if (!gpu || this.#count === 0 || !(stage.transparent || stage.picking) || !colorFormat) return;
    const order = this.#writeInstances(context.game.transforms.renderWorld, view);
    const first = view.index * gpu.capacity;
    this.system.device.queue.writeBuffer(gpu.instances!, first * INSTANCE_FLOATS * 4, this.#instanceData, 0, this.#count * INSTANCE_FLOATS);
    pass.setBindGroup(0, gpu.instanceGroup!, [view.index * VIEW_STRIDE]);
    let pipeline: GPURenderPipeline | undefined, textureGroup: GPUBindGroup | undefined;
    order.forEach((index, drawn) => {
      const item = this.#items[index]!;
      if (!inRenderMask(view.cullingMask, item.renderGroup)) return;
      const nextPipeline = this.#pipelineFor(gpu, colorFormat, stage.output.depthFormat, item, stage.picking);
      if (nextPipeline !== pipeline) pass.setPipeline((pipeline = nextPipeline));
      const nextGroup = this.#textureGroup(gpu, item);
      if (nextGroup !== textureGroup) pass.setBindGroup(1, (textureGroup = nextGroup));
      pass.draw(4, 1, 0, first + drawn);
      this.#drawCalls++;
    });
  }

  override destroy(): void {
    this.#gpu?.views.destroy();
    this.#gpu?.instances?.destroy();
    this.#gpu = undefined;
  }

  /** 按这个视图算出所有精灵的实例数据（从远到近排好），返回排好的精灵下标。 */
  #writeInstances(world: Float32Array, view: RenderView): number[] {
    const camera = this.#cameraWorld;
    if (!Matrix.invert(camera, view.view)) Matrix.setIdentity(camera);
    // 相机看向本地 -Z
    const fx = -camera[8]!, fy = -camera[9]!, fz = -camera[10]!;
    const depths: number[] = [];
    const data = this.#instanceData;
    for (let i = 0; i < this.#count; i++) {
      const item = this.#items[i]!;
      const o = i * INSTANCE_FLOATS;
      spriteQuad(data, o, world, item.slot * 16, item.billboard ? camera : undefined, item.width, item.height, item);
      const ox = data[o]!, oy = data[o + 1]!, oz = data[o + 2]!;
      data.set(item.color, o + 12);
      data.set(item.uv, o + 16);
      data.set([item.alphaCutoff ? 1 : 0, item.slot + 1, 0, 0], o + 20);
      depths[i] = (ox - view.eye.x) * fx + (oy - view.eye.y) * fy + (oz - view.eye.z) * fz;
    }
    const order = Array.from({ length: this.#count }, (_, i) => i).sort((a, b) => depths[b]! - depths[a]!);
    // 实例按画的顺序放：第 n 次绘制用第 n 个实例
    const sorted = new Float32Array(this.#count * INSTANCE_FLOATS);
    order.forEach((index, n) => sorted.set(data.subarray(index * INSTANCE_FLOATS, (index + 1) * INSTANCE_FLOATS), n * INSTANCE_FLOATS));
    data.set(sorted);
    return order;
  }

  /** picking：画进点选的编号缓冲（不混合，写编号）。预热过的（warmFiles）直接用，没有的当场建。 */
  #pipelineFor(gpu: Gpu, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, item: SpriteItem, picking: boolean): GPURenderPipeline {
    const key = pipelineKey(colorFormat, depthFormat, picking ? 'pick' : item.blend, item.ignoreDepth);
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.system.device.createRenderPipeline(this.#pipelineDescriptor(gpu, colorFormat, depthFormat, picking ? 'pick' : item.blend, item.ignoreDepth));
      gpu.pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #pipelineDescriptor(gpu: Gpu, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, blendOrPick: Blend | 'pick', ignoreDepth: boolean): GPURenderPipelineDescriptor {
    const blend = blendOrPick === 'none' || blendOrPick === 'pick' ? undefined : BLENDS[blendOrPick];
    return {
      label: `SpriteRenderFeature ${blendOrPick}${ignoreDepth ? ' ignoreDepth' : ''}`,
      layout: gpu.pipelineLayout,
      vertex: { module: gpu.module, entryPoint: 'vs' },
      fragment: blendOrPick === 'pick' ? { module: gpu.module, entryPoint: 'fsPick', targets: [{ format: colorFormat }] } : {
        module: gpu.module,
        entryPoint: 'fs',
        targets: [{ format: colorFormat, ...(blend ? { blend } : {}), ...(blendOrPick === 'noColor' ? { writeMask: 0 } : {}) }],
      },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: ignoreDepth
        ? { format: depthFormat, depthWriteEnabled: false, depthCompare: 'always' }
        : { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less-equal' },
    };
  }

  /**
   * 场景文件里的精灵要用的管线在后台编好：混合方式由文件里的 blendMode、isTransparent、premultipliedAlpha 定（同 draw 时的 blendOf），
   * 画在透明阶段。脚本运行中换的贴图、改的设置照旧当场建。
   */
  override warmFiles(files: readonly SceneEntityFile[], stages: readonly RenderStage[]): Promise<void>[] {
    const variants = new Map<string, readonly [Blend, boolean]>();
    for (const { components: { sprite } } of files) {
      if (!sprite) continue;
      const blend = blendOf(sprite.blendMode, sprite.isTransparent, sprite.premultipliedAlpha);
      variants.set(`${blend}:${sprite.ignoreDepth}`, [blend, sprite.ignoreDepth]);
    }
    if (variants.size === 0) return [];
    const gpu = (this.#gpu ??= this.#createGpu());
    const pending: Promise<void>[] = [];
    for (const stage of stages) {
      const colorFormat = stage.output.colorFormat;
      if (!colorFormat || !stage.transparent || stage.picking) continue;
      for (const [blend, ignoreDepth] of variants.values()) {
        const key = pipelineKey(colorFormat, stage.output.depthFormat, blend, ignoreDepth);
        if (gpu.pipelines.has(key) || gpu.warming.has(key)) continue;
        const warming = this.system.device.createRenderPipelineAsync(this.#pipelineDescriptor(gpu, colorFormat, stage.output.depthFormat, blend, ignoreDepth)).then((pipeline) => {
          gpu.warming.delete(key);
          if (!gpu.pipelines.has(key)) gpu.pipelines.set(key, pipeline);
        });
        gpu.warming.set(key, warming);
        pending.push(warming);
      }
    }
    return pending;
  }

  #textureGroup(gpu: Gpu, item: SpriteItem): GPUBindGroup {
    const key = `${item.texture.id}:${item.sampler}`;
    let group = gpu.textureGroups.get(key);
    if (!group) {
      group = this.system.device.createBindGroup({
        label: `SpriteRenderFeature ${item.texture.name}`,
        layout: gpu.textureLayout,
        entries: [
          { binding: 0, resource: this.system.resources.texture(item.texture).createView() },
          { binding: 1, resource: gpu.samplers[item.sampler] },
        ],
      });
      gpu.textureGroups.set(key, group);
    }
    return group;
  }

  #createGpu(): Gpu {
    const device = this.system.device;
    const instanceLayout = device.createBindGroupLayout({
      label: 'SpriteRenderFeature instances',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ],
    });
    const textureLayout = device.createBindGroupLayout({
      label: 'SpriteRenderFeature texture',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    return {
      module: device.createShaderModule({ label: 'SpriteRenderFeature', code: SHADER }),
      instanceLayout,
      textureLayout,
      pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [instanceLayout, textureLayout] }),
      views: createViewBuffer(device, 0),
      samplers: {
        linearClamp: this.system.resources.linearClamp,
        pointClamp: device.createSampler({ label: 'point clamp', magFilter: 'nearest', minFilter: 'nearest', mipmapFilter: 'nearest' }),
        anisotropicClamp: device.createSampler({ label: 'anisotropic clamp', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16 }),
      },
      pipelines: new Map(),
      warming: new Map(),
      textureGroups: new Map(),
      instances: undefined,
      instanceGroup: undefined,
      capacity: 0,
      viewCapacity: 0,
    };
  }
}

/** spriteQuad 要的精灵参数。 */
export interface SpriteShape {
  readonly pixelsPerUnit: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly centerFromMiddle: boolean;
}

/**
 * 精灵的矩形（同 Stride 的 SpriteRenderFeature 加 Sprite3DBatch）写进 out[offset..offset+12)：矩形中心、X 边、Y 边
 * （各 4 个 float，四个角是 中心 ± X/2 ± Y/2）。world[w..w+16) 是实体的世界矩阵；camera 是相机的世界矩阵，给了就是
 * billboard（用相机的 X、Y 轴，长度换成实体的缩放）。宽高是贴图尺寸除以 pixelsPerUnit，实体位置落在贴图的 center 像素上。
 */
export function spriteQuad(out: Float32Array, offset: number, world: Float32Array, w: number, camera: Float32Array | undefined, width: number, height: number, shape: SpriteShape): void {
  let ax = world[w]!, ay = world[w + 1]!, az = world[w + 2]!;
  let bx = world[w + 4]!, by = world[w + 5]!, bz = world[w + 6]!;
  if (camera) {
    const scaleX = Math.hypot(ax, ay, az) / (Math.hypot(camera[0]!, camera[1]!, camera[2]!) || 1);
    const scaleY = Math.hypot(bx, by, bz) / (Math.hypot(camera[4]!, camera[5]!, camera[6]!) || 1);
    [ax, ay, az] = [camera[0]! * scaleX, camera[1]! * scaleX, camera[2]! * scaleX];
    [bx, by, bz] = [camera[4]! * scaleY, camera[5]! * scaleY, camera[6]! * scaleY];
  }
  const sizeX = width / shape.pixelsPerUnit, sizeY = height / shape.pixelsPerUnit;
  const centerX = shape.centerX + (shape.centerFromMiddle ? width / 2 : 0);
  const centerY = shape.centerY + (shape.centerFromMiddle ? height / 2 : 0);
  // 实体位置是贴图上 center 那个像素：矩形中心从那里移开
  const offsetX = (centerX / width - 0.5) * sizeX, offsetY = (0.5 - centerY / height) * sizeY;
  const px = world[w + 12]!, py = world[w + 13]!, pz = world[w + 14]!;
  out.set([
    px - offsetX * ax - offsetY * bx, py - offsetX * ay - offsetY * by, pz - offsetX * az - offsetY * bz, 1,
    ax * sizeX, ay * sizeX, az * sizeX, 0,
    bx * sizeY, by * sizeY, bz * sizeY, 0,
  ], offset);
}

function pipelineKey(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, blendOrPick: Blend | 'pick', ignoreDepth: boolean): string {
  return `${colorFormat}:${depthFormat}:${blendOrPick}:${ignoreDepth}`;
}

/** Stride 的 SpriteBlend 换成混合方式：auto 看贴图透不透明，alphaBlend 看是不是预乘的。 */
function blendOf(mode: 'auto' | 'none' | 'alphaBlend' | 'additiveBlend' | 'noColor', isTransparent: boolean, premultiplied: boolean): Blend {
  const resolved = mode === 'auto' ? (isTransparent ? 'alphaBlend' : 'none') : mode;
  if (resolved === 'alphaBlend') return premultiplied ? 'premultiplied' : 'nonPremultiplied';
  if (resolved === 'additiveBlend') return 'additive';
  return resolved;
}
