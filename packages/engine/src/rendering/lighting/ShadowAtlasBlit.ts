/**
 * 阴影图集里一块一块地清空、拷贝（缓存的阴影图，ShadowMapRenderer.ts）：图集跨帧留着，不能整张清空，也不按区域拷深度贴图，
 * 都用写深度的一遍全屏三角形做，视口限在那一块里。
 * - 清空：写远处的深度 1（阴影图是正向的深度）。
 * - 拷贝：从静态层的图集按偏移读深度写过来；一次通道里画好几块，每块一个实例，偏移在存储缓冲里按实例号取。
 */
import { pipelineCache } from '../../graphics/PipelineCache';

const FORMAT: GPUTextureFormat = 'depth32float';

const CODE = /* wgsl */ `
struct Varyings { @builtin(position) position: vec4f, @location(0) @interpolate(flat) copy: u32 };

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) copy: u32) -> Varyings {
  let uv = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return Varyings(vec4f(uv * 2.0 - 1.0, 0.0, 1.0), copy);
}

@fragment fn fsClear() -> @builtin(frag_depth) f32 {
  return 1.0;
}
`;

const COPY_CODE = /* wgsl */ `
${CODE}
/** 每块：xy 是从这里的像素到源图集的像素的偏移。 */
@group(0) @binding(0) var<storage, read> offsets: array<vec4i>;
@group(0) @binding(1) var source: texture_depth_2d;

@fragment fn fsCopy(in: Varyings) -> @builtin(frag_depth) f32 {
  return textureLoad(source, vec2i(in.position.xy) + offsets[in.copy].xy, 0);
}
`;

export interface BlitRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export class ShadowAtlasBlit {
  readonly #device: GPUDevice;
  #offsets: GPUBuffer | undefined;
  #bindGroup: { readonly buffer: GPUBuffer; readonly source: GPUTexture; readonly group: GPUBindGroup } | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 在后台编两条管线。 */
  warm(): Promise<void> {
    const cache = pipelineCache(this.#device);
    return Promise.all([cache.warmRender('Shadow atlas clear', () => this.#describe('clear')), cache.warmRender('Shadow atlas copy', () => this.#describe('copy'))]).then(() => undefined);
  }

  /** 把这几块清成远处（pass 是画进图集的通道）。 */
  clear(pass: GPURenderPassEncoder, rectangles: readonly BlitRectangle[]): void {
    if (rectangles.length === 0) return;
    pass.setPipeline(pipelineCache(this.#device).render('Shadow atlas clear', () => this.#describe('clear')));
    for (const r of rectangles) {
      pass.setViewport(r.x, r.y, r.width, r.height, 0, 1);
      pass.draw(3);
    }
  }

  /** 从 source（静态层的图集）拷到 pass 画的图集：每对是 [目标的块, 源的块]，大小相同。 */
  copy(pass: GPURenderPassEncoder, source: GPUTexture, pairs: readonly (readonly [BlitRectangle, BlitRectangle])[]): void {
    if (pairs.length === 0) return;
    const data = new Int32Array(pairs.length * 4);
    pairs.forEach(([to, from], i) => data.set([from.x - to.x, from.y - to.y], i * 4));
    if (!this.#offsets || this.#offsets.size < data.byteLength) {
      this.#offsets?.destroy();
      this.#offsets = this.#device.createBuffer({ label: 'Shadow atlas copy offsets', size: Math.max(256, data.byteLength * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    this.#device.queue.writeBuffer(this.#offsets, 0, data);
    const pipeline = pipelineCache(this.#device).render('Shadow atlas copy', () => this.#describe('copy'));
    if (this.#bindGroup?.buffer !== this.#offsets || this.#bindGroup.source !== source) {
      this.#bindGroup = {
        buffer: this.#offsets, source,
        group: this.#device.createBindGroup({ label: 'Shadow atlas copy', layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.#offsets } }, { binding: 1, resource: source.createView() }] }),
      };
    }
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.#bindGroup.group);
    pairs.forEach(([to], i) => {
      pass.setViewport(to.x, to.y, to.width, to.height, 0, 1);
      pass.draw(3, 1, 0, i);
    });
  }

  destroy(): void {
    this.#offsets?.destroy();
    this.#offsets = undefined;
    this.#bindGroup = undefined;
  }

  #describe(kind: 'clear' | 'copy'): GPURenderPipelineDescriptor {
    const module = this.#device.createShaderModule({ label: `Shadow atlas ${kind}`, code: kind === 'clear' ? CODE : COPY_CODE });
    return {
      label: `Shadow atlas ${kind}`,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: kind === 'clear' ? 'fsClear' : 'fsCopy', targets: [] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    };
  }
}
