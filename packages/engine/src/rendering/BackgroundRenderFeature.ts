/**
 * 背景的根渲染特性（Stride 的 BackgroundRenderFeature）：第一个 Background 组件，画在网格没画到的地方，乘强度。
 * - 立方体贴图（SkyboxShaderCubemap 那条路）：每个像素的视线方向按背景实体的旋转转回去、z 取反后采样，和天空盒光照的约定一样。
 * - 平面图片（Is2D，Draw2D 那条路）：保持图片比例铺满视图，多出的部分两边对称裁掉；只采样第 0 级（Stride 的背景图不生成 mip）。
 * 画在网格之后（加到渲染系统里的顺序），深度测试 less-equal、不写深度，三角形在远平面上。
 */
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Background } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import { RootRenderFeature, type RenderContext, type RenderStage, type RenderView } from './RenderSystem';
import { Cubemap } from './Skybox';
import { Texture } from './Texture';

const SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}

// source：平面图片在贴图里取的矩形（UV 的起点 xy、大小 zw）
struct Uniforms {
  inverseViewProjection: mat4x4f,
  rotation: mat4x4f,
  eye: vec4f,
  source: vec4f,
  intensity: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var cubemap: texture_cube<f32>;
@group(0) @binding(2) var linearClamp: sampler;
@group(0) @binding(3) var image: texture_2d<f32>;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let far = uniforms.inverseViewProjection * vec4f(in.ndc, 1.0, 1.0);
  let direction = far.xyz / far.w - uniforms.eye.xyz;
  let rotation = mat3x3f(uniforms.rotation[0].xyz, uniforms.rotation[1].xyz, uniforms.rotation[2].xyz);
  let d = normalize(direction * rotation);
  let color = textureSample(cubemap, linearClamp, vec3f(d.xy, -d.z)).rgb;
  return vec4f(color * uniforms.intensity, 1.0);
}

@fragment fn fs2D(in: FullscreenVaryings) -> @location(0) vec4f {
  let screen = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  let color = textureSampleLevel(image, linearClamp, uniforms.source.xy + screen * uniforms.source.zw, 0.0).rgb;
  return vec4f(color * uniforms.intensity, 1.0);
}`;

/** inverseViewProjection 16、rotation 16、eye 4、source 4、intensity 1，补齐到 16 字节。 */
const UNIFORM_FLOATS = 44;

interface Gpu {
  readonly buffer: GPUBuffer;
  readonly layout: GPUBindGroupLayout;
  readonly module: GPUShaderModule;
  readonly pipelines: Map<string, GPURenderPipeline>;
}

export class BackgroundRenderFeature extends RootRenderFeature {
  readonly name = 'BackgroundRenderFeature';
  /** 这一帧的背景（两个都没有时不画）。 */
  #cubemap: Cubemap | undefined;
  #image: Texture | undefined;
  #intensity = 1;
  readonly #rotation = Matrix.identity();
  readonly #uniforms = new Float32Array(UNIFORM_FLOATS);
  #gpu: Gpu | undefined;
  #bindGroup: GPUBindGroup | undefined;
  #bound: GPUTexture | undefined;

  readonly #extractSystem = system('BackgroundRenderFeature.extract', {
    with: { background: Background, transform: Transform },
    update: ({ background, transform, count }) => {
      if (this.#cubemap || this.#image || count === 0) return;
      this.#image = Texture.byId(background.image[0]!);
      this.#cubemap = this.#image ? undefined : Cubemap.byId(background.texture[0]!);
      this.#intensity = background.intensity[0]!;
      Matrix.rotationOf(this.#rotation, transform.world, transform.slot[0]! * 16);
    },
  });

  override extract(context: RenderContext): void {
    this.#cubemap = this.#image = undefined;
    context.game.entities.run(this.#extractSystem, context.time);
  }

  override prepare(): void {
    if (!this.#cubemap && !this.#image) return;
    const gpu = (this.#gpu ??= this.#createGpu());
    const resources = this.system.resources;
    // 用不到的那个贴图位置绑一张占位的
    const texture = this.#image ? resources.texture(this.#image) : resources.cubemap(this.#cubemap!);
    if (texture !== this.#bound) {
      this.#bound = texture;
      this.#bindGroup = this.system.device.createBindGroup({
        label: 'BackgroundRenderFeature',
        layout: gpu.layout,
        entries: [
          { binding: 0, resource: { buffer: gpu.buffer } },
          { binding: 1, resource: (this.#image ? resources.blackCube : texture).createView({ dimension: 'cube' }) },
          { binding: 2, resource: resources.linearClamp },
          { binding: 3, resource: (this.#image ? texture : resources.white).createView() },
        ],
      });
    }
    const view = this.system.views[0];
    if (!view) return;
    const uniforms = this.#uniforms;
    uniforms.set(view.inverseViewProjection, 0);
    uniforms.set(this.#rotation, 16);
    uniforms.set([view.eye.x, view.eye.y, view.eye.z, 1], 32);
    uniforms.set(this.#image ? coverSource(this.#image.data.width, this.#image.data.height, view.width, view.height) : [0, 0, 1, 1], 36);
    uniforms[40] = this.#intensity;
    this.system.device.queue.writeBuffer(gpu.buffer, 0, uniforms);
  }

  override draw(_context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    // 只画在主视图上；只有深度的阶段（阴影投射）没有颜色可画
    const colorFormat = stage.output.colorFormat;
    if ((!this.#cubemap && !this.#image) || !this.#bindGroup || view.index !== 0 || !colorFormat) return;
    pass.setPipeline(this.#pipelineFor(stage, colorFormat, this.#image ? 'fs2D' : 'fs'));
    pass.setBindGroup(0, this.#bindGroup);
    pass.draw(3);
  }

  override destroy(): void {
    this.#gpu?.buffer.destroy();
    this.#gpu = undefined;
  }

  #createGpu(): Gpu {
    const device = this.system.device;
    const layout = device.createBindGroupLayout({
      label: 'BackgroundRenderFeature',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    // 每个视图一块 uniform：现在只有一个视图
    const buffer = device.createBuffer({ label: 'BackgroundRenderFeature', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { buffer, layout, module: device.createShaderModule({ label: 'BackgroundRenderFeature', code: SHADER }), pipelines: new Map() };
  }

  #pipelineFor(stage: RenderStage, colorFormat: GPUTextureFormat, entryPoint: 'fs' | 'fs2D'): GPURenderPipeline {
    const gpu = this.#gpu!;
    const { depthFormat } = stage.output;
    const key = `${stage.name}:${colorFormat}:${depthFormat}:${entryPoint}`;
    let pipeline = gpu.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.system.device.createRenderPipeline({
        label: `BackgroundRenderFeature ${stage.name} ${entryPoint}`,
        layout: this.system.device.createPipelineLayout({ bindGroupLayouts: [gpu.layout] }),
        vertex: { module: gpu.module, entryPoint: 'fullscreenVertex' },
        fragment: { module: gpu.module, entryPoint, targets: [{ format: colorFormat }] },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      gpu.pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}

/**
 * 平面背景在贴图里取的矩形（UV：起点 x、y，大小 x、y）：保持比例铺满 width x height 的视图，多出的部分两边对称裁掉
 * （Stride 的 BackgroundRenderFeature.Draw2D）。
 */
export function coverSource(imageWidth: number, imageHeight: number, width: number, height: number): [number, number, number, number] {
  const ratio = Math.min(imageWidth / width, imageHeight / height);
  const sizeX = (width * ratio) / imageWidth, sizeY = (height * ratio) / imageHeight;
  return [(1 - sizeX) / 2, (1 - sizeY) / 2, sizeX, sizeY];
}
