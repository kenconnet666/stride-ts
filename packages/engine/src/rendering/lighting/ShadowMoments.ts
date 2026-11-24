/**
 * 局部光阴影的矩图（指数方差阴影图 EVSM，Lauritzen 2008；宽半影的软阴影用，docs/realtime.md 第 4b 步）：和采样的阴影图集一样
 * 大的一张 rgba16float，每个点光、聚光、面光源的块按深度存四个矩（正、负两种指数变换的一次、二次矩），带 mip。着色时找完遮挡物
 * 算出半影，用 textureSampleGrad 按发光面的两条半轴投到图上的大小取一次（硬件的各向异性过滤按这个椭圆取平均），切比雪夫
 * 不等式给出可见度：半影多宽都是一次采样，不出 PCSS 采样不够时的方块。
 *
 * 只在块变了的帧重算（缓存的阴影图拷过、画过动的投影者的块，ShadowMapRenderer 给）：先按深度算第 0 级，再一级一级 2×2 平均。
 * 伙伴分配的块是 2 的幂、按大小对齐的，每一级在图集里还是对齐的一块，不会混进别的块。
 *
 * 深度先换成线性的 t = 距离 / 远平面 = (1 − A) / (d − A)（阴影图的深度是 A + B / 距离），x = 2t − 1，存
 * (e^{cx}, e^{2cx}, −e^{−cx}, e^{−2cx})，c = EVSM_EXPONENT（半精度放得下 e^{2c}）。
 */
import { pipelineCache } from '../../graphics/PipelineCache';

/** EVSM 的指数（rgba16float 最大 65504，e^{2c} 要放得下）。 */
export const EVSM_EXPONENT = 5;
const FORMAT: GPUTextureFormat = 'rgba16float';
/** 一次最多算多少块（超过的下一帧接着算）。 */
const MAX_TILES = 256;

const MOMENTS_CODE = /* wgsl */ `
/** 一块：x、y、边长（图集像素），w 是这盏光深度的 A（bitcast 的 f32）。 */
@group(0) @binding(0) var<storage, read> tiles: array<vec4u>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var moments: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let tile = tiles[id.z];
  if (id.x >= tile.z || id.y >= tile.z) { return; }
  let p = vec2u(tile.x + id.x, tile.y + id.y);
  let a = bitcast<f32>(tile.w);
  let d = textureLoad(depth, p, 0);
  // 线性的 t = 距离 / 远平面；清空的（远处）是 1
  let t = select(saturate((1.0 - a) / min(d - a, -1e-6)), 1.0, d >= 1.0);
  let x = t * 2.0 - 1.0;
  let positive = exp(${EVSM_EXPONENT}.0 * x);
  let negative = -exp(-${EVSM_EXPONENT}.0 * x);
  textureStore(moments, p, vec4f(positive, positive * positive, negative, negative * negative));
}
`;

const DOWNSAMPLE_CODE = /* wgsl */ `
/** 一块在这一级的 x、y、边长（已经按级缩过）。 */
@group(0) @binding(0) var<storage, read> tiles: array<vec4u>;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var destination: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let tile = tiles[id.z];
  if (id.x >= tile.z || id.y >= tile.z) { return; }
  let p = vec2u(tile.x + id.x, tile.y + id.y);
  let s = p * 2u;
  let sum = textureLoad(source, s, 0) + textureLoad(source, s + vec2u(1u, 0u), 0) + textureLoad(source, s + vec2u(0u, 1u), 0) + textureLoad(source, s + vec2u(1u, 1u), 0);
  textureStore(destination, p, sum * 0.25);
}
`;

export interface MomentTile {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** 这盏光阴影深度的 A（深度 = A + B / 距离）。 */
  readonly depthA: number;
}

export class ShadowMoments {
  readonly #device: GPUDevice;
  #texture: GPUTexture | undefined;
  #levels = 0;
  /** 每一级一个缓冲（块按级缩过）。 */
  #buffers: GPUBuffer[] = [];

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 矩图（和阴影图集一样大）；atlasSize 变了重建（里面的作废，块会重算）。 */
  texture(atlasSize: number): GPUTexture {
    if (this.#texture?.width !== atlasSize) {
      this.#texture?.destroy();
      this.#levels = Math.min(Math.log2(atlasSize) + 1, 12);
      this.#texture = this.#device.createTexture({
        label: `Shadow moments ${atlasSize}x${atlasSize}`, size: [atlasSize, atlasSize], format: FORMAT, mipLevelCount: this.#levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    }
    return this.#texture;
  }

  /** 在后台编两条管线。 */
  warm(): Promise<void> {
    const cache = pipelineCache(this.#device);
    return Promise.all([cache.warmCompute('Shadow moments', () => this.#describe('moments')), cache.warmCompute('Shadow moments downsample', () => this.#describe('downsample'))]).then(() => undefined);
  }

  /** 录进 encoder：这些块（变了的）从 depth（阴影图集）重算矩和各级 mip。 */
  record(encoder: GPUCommandEncoder, depth: GPUTexture, tiles: readonly MomentTile[]): void {
    if (tiles.length === 0) return;
    const texture = this.texture(depth.width);
    const list = tiles.slice(0, MAX_TILES);
    const cache = pipelineCache(this.#device);
    const momentsPipeline = cache.compute('Shadow moments', () => this.#describe('moments'));
    const downsamplePipeline = cache.compute('Shadow moments downsample', () => this.#describe('downsample'));
    const pass = encoder.beginComputePass({ label: 'Shadow moments' });
    for (let level = 0; level < this.#levels; level++) {
      const scaled = list.filter((tile) => tile.size >> level >= 1);
      if (scaled.length === 0) break;
      const words = new Uint32Array(scaled.length * 4), floats = new Float32Array(words.buffer);
      scaled.forEach((tile, i) => {
        words.set([tile.x >> level, tile.y >> level, tile.size >> level], i * 4);
        floats[i * 4 + 3] = tile.depthA;
      });
      const buffer = this.#buffer(level, words.byteLength);
      this.#device.queue.writeBuffer(buffer, 0, words);
      const largest = Math.max(...scaled.map((tile) => tile.size >> level));
      const target = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      if (level === 0) {
        pass.setPipeline(momentsPipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({ layout: momentsPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: depth.createView() }, { binding: 2, resource: target }] }));
      } else {
        pass.setPipeline(downsamplePipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({ layout: downsamplePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer } }, { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) }, { binding: 2, resource: target }] }));
      }
      pass.dispatchWorkgroups(Math.ceil(largest / 8), Math.ceil(largest / 8), scaled.length);
    }
    pass.end();
  }

  destroy(): void {
    this.#texture?.destroy();
    this.#texture = undefined;
    for (const buffer of this.#buffers) buffer.destroy();
    this.#buffers = [];
  }

  #buffer(level: number, bytes: number): GPUBuffer {
    let buffer = this.#buffers[level];
    if (!buffer || buffer.size < bytes) {
      buffer?.destroy();
      buffer = this.#buffers[level] = this.#device.createBuffer({ label: `Shadow moments tiles ${level}`, size: Math.max(256, MAX_TILES * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    return buffer;
  }

  #describe(kind: 'moments' | 'downsample'): GPUComputePipelineDescriptor {
    const module = this.#device.createShaderModule({ label: `Shadow ${kind}`, code: kind === 'moments' ? MOMENTS_CODE : DOWNSAMPLE_CODE });
    return { label: `Shadow ${kind}`, layout: 'auto', compute: { module, entryPoint: 'main' } };
  }
}
