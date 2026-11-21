/**
 * 画物理天空的根渲染特性（Atmosphere.ts 的大气）。单独一个文件：RenderSystem 引用 Atmosphere，这个类在模块加载时要继承
 * RenderSystem 的 RootRenderFeature，放在一起会循环引用。
 */
import type { SceneEntityFile } from '../../content/format';
import { pipelineCache } from '../../graphics/PipelineCache';
import type { AtmosphereGpu } from './Atmosphere';
import { colorTargets, RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from '../RenderSystem';
/** 每个视图一块 uniform（视图投影的逆、相机位置），动态偏移按 256 字节对齐；视图多了缓冲跟着变大（不设上限）。 */
const VIEW_STRIDE = 256;

/** 画天空的根渲染特性：大气开着时画在网格没画到的地方（同 BackgroundRenderFeature：远平面上、深度 less-equal、不写深度）。 */
export class AtmosphereRenderFeature extends RootRenderFeature {
  readonly name = 'AtmosphereRenderFeature';
  #views = new Float32Array(0);
  #viewBuffer: GPUBuffer | undefined;
  #viewBindGroup: GPUBindGroup | undefined;

  override extract(): void {}

  override prepare(): void {
    const atmosphere = this.system.atmosphere;
    // 先让云准备：环境光里的云重画了的话，大气这一帧就跟着重算环境光
    this.system.clouds.prepare();
    atmosphere.update();
    const gpu = atmosphere.gpu;
    if (!gpu) return;
    const device = this.system.device;
    const views = this.system.views;
    if (!this.#viewBuffer || views.length * (VIEW_STRIDE / 4) > this.#views.length) {
      const capacity = 2 ** Math.ceil(Math.log2(Math.max(views.length, 8)));
      this.#views = new Float32Array((VIEW_STRIDE / 4) * capacity);
      this.#viewBuffer?.destroy();
      this.#viewBuffer = device.createBuffer({ label: 'AtmosphereRenderFeature views', size: VIEW_STRIDE * capacity, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#viewBindGroup = device.createBindGroup({ layout: gpu.viewLayout, entries: [{ binding: 0, resource: { buffer: this.#viewBuffer, size: 80 } }] });
    }
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
    if (!gpu || !this.#viewBindGroup || !colorFormat || stage.transparent) return;
    pass.setPipeline(this.#pipelineFor(gpu, stage, colorFormat));
    pass.setBindGroup(0, gpu.skyBindGroup);
    pass.setBindGroup(1, this.#viewBindGroup, [view.index * VIEW_STRIDE]);
    pass.draw(3);
  }

  override destroy(): void {
    this.#viewBuffer?.destroy();
  }

  /**
   * 加载有物理天空的场景时在后台编它要的管线：大气的查找表和合成、画天空的（每个不透明的阶段）、体积云的（场景里有体积云时），
   * 第一帧不用当场编译（以前十几条，见 decisions.md）。
   */
  override warmFiles(files: readonly SceneEntityFile[], stages: readonly RenderStage[]): Promise<void>[] {
    if (!files.some((file) => file.components.skyAtmosphere)) return [];
    const clouds = files.some((file) => file.components.volumetricClouds);
    const atmosphere = this.system.atmosphere;
    const pending: (Promise<void> | undefined)[] = [];
    for (const stage of stages) {
      const colorFormat = stage.output.colorFormat;
      if (!colorFormat || stage.transparent) continue;
      const gpu = atmosphere.warmGpu();
      pending.push(gpu.warm(colorFormat), pipelineCache(this.system.device).warmRender(...this.#skyPipeline(gpu, stage, colorFormat)));
      if (clouds) pending.push(this.system.clouds.warm(colorFormat));
    }
    return pending.filter((promise) => promise !== undefined);
  }

  #pipelineFor(gpu: AtmosphereGpu, stage: RenderStage, colorFormat: GPUTextureFormat): GPURenderPipeline {
    return pipelineCache(this.system.device).render(...this.#skyPipeline(gpu, stage, colorFormat));
  }

  #skyPipeline(gpu: AtmosphereGpu, stage: RenderStage, colorFormat: GPUTextureFormat): [string, () => GPURenderPipelineDescriptor] {
    const label = `AtmosphereRenderFeature ${stage.name}`;
    return [`${label} ${colorFormat} ${stage.output.depthFormat}`, () => ({
      label,
      layout: this.system.device.createPipelineLayout({ bindGroupLayouts: [gpu.skyLayout, gpu.viewLayout] }),
      vertex: { module: gpu.skyModule, entryPoint: 'fullscreenVertex' },
      fragment: { module: gpu.skyModule, entryPoint: 'fs', targets: colorTargets(stage, { format: colorFormat }) },
      depthStencil: { format: stage.output.depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
    })];
  }
}
