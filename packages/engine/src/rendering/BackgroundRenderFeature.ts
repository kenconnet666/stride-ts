/**
 * 背景的根渲染特性（Stride 的 BackgroundRenderFeature 画立方体贴图的那条路，SkyboxShaderCubemap）：第一个
 * Background 组件的立方体贴图乘强度，画在网格没画到的地方。每个像素的视线方向按背景实体的旋转转回去、z 取反后采样，
 * 和天空盒光照的约定一样。画在网格之后（加到渲染系统里的顺序），深度测试 less-equal、不写深度，三角形在远平面上。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Background } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import { RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';
import { Cubemap } from './Skybox';

const SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}

struct Uniforms {
  inverseViewProjection: mat4x4f,
  rotation: mat4x4f,
  eye: vec4f,
  intensity: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var cubemap: texture_cube<f32>;
@group(0) @binding(2) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let far = uniforms.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = far.xyz / far.w - uniforms.eye.xyz;
  let rotation = mat3x3f(uniforms.rotation[0].xyz, uniforms.rotation[1].xyz, uniforms.rotation[2].xyz);
  let d = normalize(direction * rotation);
  let color = textureSample(cubemap, linearClamp, vec3f(d.xy, -d.z)).rgb;
  return vec4f(color * uniforms.intensity, 1.0);
}`;

/** inverseViewProjection 16、rotation 16、eye 4、intensity 1，补齐到 16 字节。 */
const UNIFORM_FLOATS = 40;

export class BackgroundRenderFeature extends RootRenderFeature {
  /** 这一帧的背景；没有 Background 组件时不画。 */
  #cubemap: Cubemap | undefined;
  #intensity = 1;
  readonly #rotation = Matrix.identity();
  readonly #uniforms = new Float32Array(UNIFORM_FLOATS);
  #gpu: { buffer: GPUBuffer; layout: GPUBindGroupLayout; module: GPUShaderModule; pipelines: Map<string, GPURenderPipeline> } | undefined;
  #bindGroup: GPUBindGroup | undefined;
  #boundTexture: GPUTexture | undefined;

  readonly #extractSystem = system('BackgroundRenderFeature.extract', {
    with: { background: Background, transform: Transform },
    update: ({ background, transform, count }) => {
      if (this.#cubemap || count === 0) return;
      const cubemap = Cubemap.byId(background.texture[0]!);
      if (!cubemap) return;
      this.#cubemap = cubemap;
      this.#intensity = background.intensity[0]!;
      Matrix.rotationOf(this.#rotation, transform.world, transform.slot[0]! * 16);
    },
  });

  override extract(context: RenderContext): void {
    this.#cubemap = undefined;
    context.game.entities.run(this.#extractSystem, context.time);
  }

  override prepare(): void {
    if (!this.#cubemap) return;
    const device = this.system.device;
    if (!this.#gpu) {
      const layout = device.createBindGroupLayout({
        label: 'BackgroundRenderFeature',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
      });
      // 每个视图一块 uniform：现在只有一个视图
      const buffer = device.createBuffer({ label: 'BackgroundRenderFeature', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#gpu = { buffer, layout, module: device.createShaderModule({ label: 'BackgroundRenderFeature', code: SHADER }), pipelines: new Map() };
    }
    const texture = this.system.resources.cubemap(this.#cubemap);
    if (texture !== this.#boundTexture) {
      this.#boundTexture = texture;
      this.#bindGroup = device.createBindGroup({
        label: 'BackgroundRenderFeature',
        layout: this.#gpu.layout,
        entries: [
          { binding: 0, resource: { buffer: this.#gpu.buffer } },
          { binding: 1, resource: texture.createView({ dimension: 'cube' }) },
          { binding: 2, resource: this.system.resources.linearClamp },
        ],
      });
    }
    const view = this.system.views[0];
    if (!view) return;
    const uniforms = this.#uniforms;
    uniforms.set(view.inverseViewProjection, 0);
    uniforms.set(this.#rotation, 16);
    uniforms.set([view.eye.x, view.eye.y, view.eye.z, 1, this.#intensity], 32);
    device.queue.writeBuffer(this.#gpu.buffer, 0, uniforms);
  }

  override draw(_context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    if (!this.#cubemap || !this.#gpu || !this.#bindGroup || view.index !== 0) return;
    pass.setPipeline(this.#pipelineFor(stage));
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
  }

  override destroy(): void {
    this.#gpu?.buffer.destroy();
    this.#gpu = undefined;
  }

  #pipelineFor(stage: RenderStage): GPURenderPipeline {
    const gpu = this.#gpu!;
    const { colorFormat, depthFormat } = stage.output;
    const key = `${stage.name}:${colorFormat}:${depthFormat}`;
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.system.device.createRenderPipeline({
        label: `BackgroundRenderFeature ${stage.name}`,
        layout: this.system.device.createPipelineLayout({ bindGroupLayouts: [gpu.layout] }),
        vertex: { module: gpu.module, entryPoint: 'fullscreenVertex' },
        fragment: { module: gpu.module, entryPoint: 'fs', targets: [{ format: colorFormat }] },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      gpu.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
