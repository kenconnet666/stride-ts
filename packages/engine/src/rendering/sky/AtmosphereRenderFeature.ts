/**
 * 画物理天空的根渲染特性（Atmosphere.ts 的大气）。单独一个文件：RenderSystem 引用 Atmosphere，这个类在模块加载时要继承
 * RenderSystem 的 RootRenderFeature，放在一起会循环引用。
 */
import type { AtmosphereGpu } from './Atmosphere';
import { colorTargets, RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from '../RenderSystem';
/** 每个视图一块 uniform（视图投影的逆、相机位置），动态偏移按 256 字节对齐。 */
const VIEW_STRIDE = 256;
const MAX_VIEWS = 8;

/** 画天空的根渲染特性：大气开着时画在网格没画到的地方（同 BackgroundRenderFeature：远平面上、深度 less-equal、不写深度）。 */
export class AtmosphereRenderFeature extends RootRenderFeature {
  readonly name = 'AtmosphereRenderFeature';
  readonly #views = new Float32Array((VIEW_STRIDE / 4) * MAX_VIEWS);
  #viewBuffer: GPUBuffer | undefined;
  #viewBindGroup: GPUBindGroup | undefined;
  readonly #pipelines = new Map<string, GPURenderPipeline>();

  override extract(): void {}

  override prepare(): void {
    const atmosphere = this.system.atmosphere;
    atmosphere.update();
    const gpu = atmosphere.gpu;
    if (!gpu) return;
    const device = this.system.device;
    if (!this.#viewBuffer) {
      this.#viewBuffer = device.createBuffer({ label: 'AtmosphereRenderFeature views', size: VIEW_STRIDE * MAX_VIEWS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#viewBindGroup = device.createBindGroup({ layout: gpu.viewLayout, entries: [{ binding: 0, resource: { buffer: this.#viewBuffer, size: 80 } }] });
    }
    const views = this.system.views.slice(0, MAX_VIEWS);
    for (const view of views) {
      const o = view.index * (VIEW_STRIDE / 4);
      this.#views.set(view.inverseViewProjection, o);
      this.#views.set([view.eye.x, view.eye.y, view.eye.z, 1], o + 16);
    }
    if (views.length > 0) device.queue.writeBuffer(this.#viewBuffer, 0, this.#views, 0, views.length * (VIEW_STRIDE / 4));
  }

  override draw(_context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    const gpu = this.system.atmosphere.gpu;
    const colorFormat = stage.output.colorFormat;
    if (!gpu || !this.#viewBindGroup || !colorFormat || stage.transparent || view.index >= MAX_VIEWS) return;
    pass.setPipeline(this.#pipelineFor(gpu, stage, colorFormat));
    pass.setBindGroup(0, gpu.skyBindGroup);
    pass.setBindGroup(1, this.#viewBindGroup, [view.index * VIEW_STRIDE]);
    pass.draw(3);
  }

  override destroy(): void {
    this.#viewBuffer?.destroy();
  }

  #pipelineFor(gpu: AtmosphereGpu, stage: RenderStage, colorFormat: GPUTextureFormat): GPURenderPipeline {
    const key = `${stage.name}:${colorFormat}:${stage.output.depthFormat}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.system.device.createRenderPipeline({
        label: `AtmosphereRenderFeature ${stage.name}`,
        layout: this.system.device.createPipelineLayout({ bindGroupLayouts: [gpu.skyLayout, gpu.viewLayout] }),
        vertex: { module: gpu.skyModule, entryPoint: 'fullscreenVertex' },
        fragment: { module: gpu.skyModule, entryPoint: 'fs', targets: colorTargets(stage, { format: colorFormat }) },
        depthStencil: { format: stage.output.depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
