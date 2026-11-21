/**
 * 在 GPU 上生成 2D 贴图的 mip：从第 0 级开始，每一级用一次全屏绘制，线性采样上一级（输出纹素的中心正好在上一级
 * 2x2 个纹素中间，一次采样就是平均）。sRGB 格式的视图读的时候解码、写的时候编码，平均在线性空间里做。
 * 做法同 PlayCanvas 的 WebgpuMipmapRenderer（盒式滤波那条路）。贴图要带 RENDER_ATTACHMENT 用途。
 */
import { FULLSCREEN_VERTEX } from '../rendering/wgsl';

const SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  return textureSampleLevel(source, linearClamp, in.uv, 0.0);
}`;

export class MipmapGenerator {
  readonly #device: GPUDevice;
  readonly #module: GPUShaderModule;
  readonly #sampler: GPUSampler;
  readonly #pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#module = device.createShaderModule({ label: 'MipmapGenerator', code: SHADER });
    this.#sampler = device.createSampler({ label: 'MipmapGenerator', minFilter: 'linear', magFilter: 'linear' });
  }

  /**
   * 由第 0 级生成其余各级。给了 into 时录进那个编码器（第 0 级是同一个编码器里前面画的，比如平面反射），否则自己建一个、
   * 马上提交到设备队列上。
   */
  generate(texture: GPUTexture, into?: GPUCommandEncoder): void {
    if (texture.mipLevelCount <= 1) return;
    const pipeline = this.#pipelineFor(texture.format);
    const encoder = into ?? this.#device.createCommandEncoder({ label: `mipmaps ${texture.label}` });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const pass = encoder.beginRenderPass({
        label: `mipmaps ${texture.label} level ${level}`,
        colorAttachments: [{ view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.#device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.#sampler },
        ],
      }));
      pass.draw(3);
      pass.end();
    }
    if (!into) this.#device.queue.submit([encoder.finish()]);
  }

  #pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.#pipelines.get(format);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: `MipmapGenerator ${format}`,
        layout: 'auto',
        vertex: { module: this.#module, entryPoint: 'fullscreenVertex' },
        fragment: { module: this.#module, entryPoint: 'fs', targets: [{ format }] },
      });
      this.#pipelines.set(format, pipeline);
    }
    return pipeline;
  }
}
