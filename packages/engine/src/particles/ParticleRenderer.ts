/**
 * 画粒子（Stride 的 ParticleEmitterRenderFeature）：每帧在 CPU 上把每个发射器的粒子展开成四边形（形状见 shapes.ts），所有发射器的
 * 顶点放进一个缓冲、写一次，每个发射器画一次。材质的颜色树编译成着色器（material.ts），同样的树共用流水线。
 *
 * 颜色照 Stride 的 ParticleBase：材质的 materialColor（Stride 的 Shading()，一般是组件的颜色 × 颜色树），alpha 再乘 1 - AlphaAdditive
 * （1 就是加法混合）；混合是
 * 预乘 alpha，和深度比较但不写深度，不剔除背面。粒子系统从远到近画，同一个系统里的发射器按 DrawPriority；包围形状（BoundingBox、
 * BoundingSphere）在视锥外的系统不画（同 Stride 的剔除）。粒子的顺序：SortingPolicy 是 ByDepth 时从远到近，其余按池里的顺序。
 */
import { Matrix } from '../mathematics/Matrix';
import type { GpuResources } from '../rendering/GpuResources';
import { inRenderMask, type RenderView } from '../rendering/RenderSystem';
import { MATERIAL_STREAMS } from '../rendering/shaderClass';
import type { Vec3 } from './math';
import type { MaterialProgram } from './material';
import type { ParticleSystemComponent } from './ParticleSystemComponent';
import { drawOrder, VERTEX_FLOATS, VertexWriter, type CameraAxes } from './shapes';

/** 每次绘制的参数：视图投影 16、组件颜色 4、alpha 系数、时间（WGSL 里 96 字节）；按动态偏移的 256 字节对齐。 */
const UNIFORM_STRIDE = 256;
const UNIFORM_SIZE = 96;

const SHADER_HEAD = /* wgsl */ `
struct Draw {
  viewProjection: mat4x4f,
  colorScale: vec4f,
  alphaFactor: f32,
  time: f32,
};
@group(0) @binding(0) var<uniform> draw: Draw;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) uv1: vec2f,
  @location(2) color: vec4f,
};
${MATERIAL_STREAMS}
@vertex fn vs(@location(0) position: vec3f, @location(1) uv: vec2f, @location(2) uv1: vec2f, @location(3) color: vec4f) -> Varyings {
  var out: Varyings;
  out.position = draw.viewProjection * vec4f(position, 1.0);
  out.uv = uv;
  out.uv1 = uv1;
  out.color = color;
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  streams = MaterialStreams(in.uv, in.uv1, in.color, draw.colorScale, vec3f(0.0), draw.time);
  var color = materialColor();
  color.a *= draw.alphaFactor;
  return color;
}
`;

/** 一个发射器这一帧的绘制。 */
interface EmitterDraw {
  readonly firstQuad: number;
  readonly quads: number;
  readonly program: MaterialProgram;
  readonly uniformOffset: number;
}

export class ParticleRenderer {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #drawLayout: GPUBindGroupLayout;
  /** 按贴图数的贴图绑定组布局和流水线布局。 */
  readonly #layouts = new Map<number, { textures: GPUBindGroupLayout; pipeline: GPUPipelineLayout }>();
  readonly #modules = new Map<string, GPUShaderModule>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #textureGroups = new WeakMap<MaterialProgram, GPUBindGroup>();
  #vertices = new Float32Array(VERTEX_FLOATS * 4 * 1024);
  #vertexBuffer: GPUBuffer | undefined;
  #indexBuffer: GPUBuffer | undefined;
  #uniforms = new Float32Array((UNIFORM_STRIDE / 4) * 16);
  #uniformBuffer: GPUBuffer | undefined;
  #drawGroup: GPUBindGroup | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#drawLayout = device.createBindGroupLayout({
      label: 'Particles draw',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_SIZE } }],
    });
  }

  /** 把 components 的粒子画进 pass（颜色格式 colorFormat、深度格式 depthFormat），按 view 的相机。 */
  draw(pass: GPURenderPassEncoder, view: RenderView, components: readonly ParticleSystemComponent[], colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, time: number): void {
    const cameraWorld = new Float32Array(16);
    if (!Matrix.invert(cameraWorld, view.view)) return;
    const right: Vec3 = [cameraWorld[0]!, cameraWorld[1]!, cameraWorld[2]!];
    const up: Vec3 = [cameraWorld[4]!, cameraWorld[5]!, cameraWorld[6]!];
    const camera: CameraAxes = { right, up, back: [cameraWorld[8]!, cameraWorld[9]!, cameraWorld[10]!], viewProjection: view.viewProjection };
    const eye: Vec3 = [cameraWorld[12]!, cameraWorld[13]!, cameraWorld[14]!];
    // 粒子系统从远到近
    const systems = components
      .filter((component) => component.enabled && inRenderMask(view.cullingMask, component.renderGroup) && inFrustum(component.particleSystem.worldBounds(), view.frustumPlanes))
      .map((component) => ({ component, distance: Math.hypot(...component.particleSystem.translation.map((t, i) => t - eye[i]!)) }))
      .sort((a, b) => b.distance - a.distance);

    const draws: EmitterDraw[] = [];
    let quads = 0;
    for (const { component } of systems) {
      const emitters = [...component.particleSystem.emitters].filter((emitter) => emitter.enabled).sort((a, b) => a.drawPriority - b.drawPriority);
      for (const emitter of emitters) {
        const { shape, program, pool } = emitter;
        if (!shape || !program || pool.living === 0) continue;
        this.#reserve((quads + pool.living * shape.quadsPerParticle) * 4 * VERTEX_FLOATS);
        const order = drawOrder(emitter, camera);
        const writer = new VertexWriter(emitter, this.#vertices, quads * 4 * VERTEX_FLOATS, program);
        shape.build(emitter, camera, order, writer);
        // 形状写的四边形不能超过留的空间（每个粒子 quadsPerParticle 个）
        const end = Math.min(writer.at, (quads + pool.living * shape.quadsPerParticle) * 4 * VERTEX_FLOATS);
        const firstQuad = quads;
        quads = end / (4 * VERTEX_FLOATS);
        this.#writeUniforms(draws.length, view, component, program, time);
        draws.push({ firstQuad, quads: quads - firstQuad, program, uniformOffset: draws.length * UNIFORM_STRIDE });
      }
    }
    if (draws.length === 0) return;
    this.#upload(quads, draws.length);
    pass.setVertexBuffer(0, this.#vertexBuffer!);
    pass.setIndexBuffer(this.#indexBuffer!, 'uint32');
    for (const { firstQuad, quads: count, program, uniformOffset } of draws) {
      pass.setPipeline(this.#pipeline(program, colorFormat, depthFormat));
      pass.setBindGroup(0, this.#drawGroup!, [uniformOffset]);
      pass.setBindGroup(1, this.#textureGroup(program));
      pass.drawIndexed(count * 6, 1, firstQuad * 6);
    }
  }

  destroy(): void {
    this.#vertexBuffer?.destroy();
    this.#indexBuffer?.destroy();
    this.#uniformBuffer?.destroy();
  }

  /** 第 index 次绘制的参数。 */
  #writeUniforms(index: number, view: RenderView, component: ParticleSystemComponent, program: MaterialProgram, time: number): void {
    const floats = UNIFORM_STRIDE / 4;
    if ((index + 1) * floats > this.#uniforms.length) {
      const grown = new Float32Array(this.#uniforms.length * 2);
      grown.set(this.#uniforms);
      this.#uniforms = grown;
    }
    const u = this.#uniforms, at = index * floats;
    u.set(view.viewProjection, at);
    u.set(component.color, at + 16);
    u[at + 20] = program.alphaFactor;
    u[at + 21] = time;
  }

  #reserve(floats: number): void {
    if (floats <= this.#vertices.length) return;
    const grown = new Float32Array(Math.max(floats, this.#vertices.length * 2));
    grown.set(this.#vertices);
    this.#vertices = grown;
  }

  /** 顶点、下标、参数写进缓冲（不够大时重建）。 */
  #upload(quads: number, draws: number): void {
    const device = this.#device;
    const vertexBytes = quads * 4 * VERTEX_FLOATS * 4;
    if (!this.#vertexBuffer || this.#vertexBuffer.size < vertexBytes) {
      this.#vertexBuffer?.destroy();
      this.#vertexBuffer = device.createBuffer({ label: 'Particles vertices', size: Math.max(vertexBytes, this.#vertices.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    device.queue.writeBuffer(this.#vertexBuffer, 0, this.#vertices.buffer, 0, vertexBytes);
    const indexCount = quads * 6;
    if (!this.#indexBuffer || this.#indexBuffer.size < indexCount * 4) {
      this.#indexBuffer?.destroy();
      const capacity = Math.max(quads, 1024) * 2;
      const indices = new Uint32Array(capacity * 6);
      for (let q = 0; q < capacity; q++) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      this.#indexBuffer = device.createBuffer({ label: 'Particles indices', size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(this.#indexBuffer, 0, indices);
    }
    const uniformBytes = draws * UNIFORM_STRIDE;
    if (!this.#uniformBuffer || this.#uniformBuffer.size < uniformBytes) {
      this.#uniformBuffer?.destroy();
      this.#uniformBuffer = device.createBuffer({ label: 'Particles draws', size: Math.max(uniformBytes, this.#uniforms.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.#drawGroup = device.createBindGroup({ layout: this.#drawLayout, entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer, size: UNIFORM_SIZE } }] });
    }
    device.queue.writeBuffer(this.#uniformBuffer, 0, this.#uniforms.buffer, 0, uniformBytes);
  }

  #layout(textureCount: number): { textures: GPUBindGroupLayout; pipeline: GPUPipelineLayout } {
    let layout = this.#layouts.get(textureCount);
    if (!layout) {
      const textures = this.#device.createBindGroupLayout({
        label: `Particles ${textureCount} textures`,
        entries: Array.from({ length: textureCount }, (_, i) => [
          { binding: i * 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: i * 2 + 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ]).flat(),
      });
      layout = { textures, pipeline: this.#device.createPipelineLayout({ bindGroupLayouts: [this.#drawLayout, textures] }) };
      this.#layouts.set(textureCount, layout);
    }
    return layout;
  }

  #pipeline(program: MaterialProgram, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): GPURenderPipeline {
    const key = `${colorFormat}:${depthFormat}:${program.code}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      let module = this.#modules.get(program.code);
      if (!module) this.#modules.set(program.code, (module = this.#device.createShaderModule({ label: 'Particles', code: SHADER_HEAD + program.code })));
      pipeline = this.#device.createRenderPipeline({
        label: 'Particles',
        layout: this.#layout(program.textures.length).pipeline,
        vertex: {
          module,
          entryPoint: 'vs',
          buffers: [{
            arrayStride: VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
              { shaderLocation: 2, offset: 20, format: 'float32x2' },
              { shaderLocation: 3, offset: 28, format: 'float32x4' },
            ],
          }],
        },
        fragment: {
          module,
          entryPoint: 'fs',
          // 预乘 alpha（Stride 的 BlendStates.AlphaBlend）
          targets: [{ format: colorFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less-equal' },
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  #textureGroup(program: MaterialProgram): GPUBindGroup {
    let group = this.#textureGroups.get(program);
    if (!group) {
      group = this.#device.createBindGroup({
        layout: this.#layout(program.textures.length).textures,
        entries: program.textures.flatMap(({ texture, sampler }, i) => [
          { binding: i * 2, resource: this.#resources.texture(texture).createView() },
          { binding: i * 2 + 1, resource: this.#resources.sampler(sampler) },
        ]),
      });
      this.#textureGroups.set(program, group);
    }
    return group;
  }
}

/** 包围盒和视锥相交（没有包围盒时算相交）：对每个平面取最靠里的角，在平面外面就不相交。 */
function inFrustum(bounds: [Vec3, Vec3] | undefined, planes: Readonly<Float32Array>): boolean {
  if (!bounds) return true;
  const [min, max] = bounds;
  for (let o = 0; o < 24; o += 4) {
    const nx = planes[o]!, ny = planes[o + 1]!, nz = planes[o + 2]!;
    const distance = nx * (nx > 0 ? max[0] : min[0]) + ny * (ny > 0 ? max[1] : min[1]) + nz * (nz > 0 ? max[2] : min[2]) + planes[o + 3]!;
    if (distance < 0) return false;
  }
  return true;
}
