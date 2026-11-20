/**
 * 画粒子（Stride 的 ParticleEmitterRenderFeature）：每帧在 CPU 上把每个发射器的粒子展开成四边形（形状见 shapes.ts），所有发射器的
 * 顶点放进一个缓冲、写一次，每个发射器画一次。材质的颜色树编译成着色器（material.ts），同样的树共用流水线。
 *
 * 颜色照 Stride 的 ParticleBase：材质的 materialColor（Stride 的 Shading()，一般是组件的颜色 × 颜色树），alpha 再乘 1 - AlphaAdditive
 * （1 就是加法混合）；混合是
 * 预乘 alpha，和深度比较但不写深度，不剔除背面。粒子系统从远到近画，同一个系统里的发射器按 DrawPriority；包围形状（BoundingBox、
 * BoundingSphere）在视锥外的系统不画（同 Stride 的剔除）。粒子的顺序：SortingPolicy 是 ByDepth 时从远到近，其余按池里的顺序。
 *
 * 点选（ScenePicker）用另一个给了 pickId 的实例（缓冲和流水线自己一份，不改主画面这一帧写好的数据）：同样的四边形，写
 * pickId 给的编号；差不多看不见的地方不写（见 fsPick），深度照写，前后靠深度测试。
 */
import { Matrix } from '../mathematics/Matrix';
import type { GpuResources } from '../rendering/GpuResources';
import { inRenderMask, type RenderView } from '../rendering/RenderSystem';
import { MATERIAL_STREAMS } from '../rendering/shaderClass';
import type { Vec3 } from './math';
import type { MaterialProgram } from './material';
import type { ParticleSystemComponent } from './ParticleSystemComponent';
import { drawOrder, VERTEX_FLOATS, VertexWriter, type CameraAxes } from './shapes';
import { GPU_DRAW_WGSL, verticesPerParticle } from './gpu/draw';
import { gpuDrawLayout, type GpuEmitter } from './gpu/GpuEmitter';
import type { ParticleEmitter } from './ParticleEmitter';

/**
 * 每次绘制的参数：视图投影 16、组件颜色 4、alpha 系数、时间、点选的编号，GPU 粒子还要相机的三个轴、粒子系统的变换、环的头和
 * 容量（WGSL 里 192 字节）；按动态偏移的 256 字节对齐。
 */
const UNIFORM_STRIDE = 256;
const UNIFORM_SIZE = 192;

const SHADER_HEAD = /* wgsl */ `
struct Draw {
  viewProjection: mat4x4f,
  colorScale: vec4f,
  alphaFactor: f32,
  time: f32,
  // 点选的编号缓冲写的数：实体的变换槽位加一
  pickId: u32,
  // 以下只有 GPU 上的粒子用（particles/gpu/draw.ts）：相机的右、上、朝后，粒子系统的位置和统一缩放、旋转，环的头和容量
  cameraRight: vec4f,
  cameraUp: vec4f,
  cameraBack: vec4f,
  spacePosition: vec4f,
  spaceRotation: vec4f,
  ring: vec4u,
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

// 点选：颜色是预乘的，画上去加的是 rgb、挡住后面的是 a·alphaFactor，两样都差不多是 0 的地方看不见，点不到（加法混合的粒子靠 rgb）
@fragment fn fsPick(in: Varyings) -> @location(0) u32 {
  streams = MaterialStreams(in.uv, in.uv1, in.color, draw.colorScale, vec3f(0.0), draw.time);
  let color = materialColor();
  if (max(color.a * draw.alphaFactor, max(color.r, max(color.g, color.b))) < 0.1) {
    discard;
  }
  return draw.pickId;
}
`;

/** 一个发射器这一帧的绘制：CPU 上的是顶点缓冲里的一段四边形，GPU 上的是它的粒子缓冲。 */
interface EmitterDraw {
  readonly firstQuad: number;
  readonly quads: number;
  readonly program: MaterialProgram;
  readonly uniformOffset: number;
  readonly gpu?: GpuEmitter;
}

export class ParticleRenderer {
  /** 给了时画进点选的编号缓冲（颜色格式是 r32uint），每个粒子系统写它给的编号（大于 0）。 */
  readonly #pickId: ((component: ParticleSystemComponent) => number) | undefined;
  /** 在 GPU 上模拟的发射器的状态（ParticleSystems 管）。 */
  readonly #gpuOf: (emitter: ParticleEmitter) => GpuEmitter | undefined;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #drawLayout: GPUBindGroupLayout;
  /** 按贴图数的贴图绑定组布局和流水线布局。 */
  readonly #layouts = new Map<number, { textures: GPUBindGroupLayout; pipeline: GPUPipelineLayout }>();
  readonly #modules = new Map<string, GPUShaderModule>();
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  /** 正在后台编的 GPU 粒子的管线（键同 #pipelines）。 */
  readonly #warming = new Set<string>();
  readonly #textureGroups = new WeakMap<MaterialProgram, GPUBindGroup>();
  #vertices = new Float32Array(VERTEX_FLOATS * 4 * 1024);
  #vertexBuffer: GPUBuffer | undefined;
  #indexBuffer: GPUBuffer | undefined;
  #uniforms = new Float32Array((UNIFORM_STRIDE / 4) * 16);
  /** 同一块内存按 u32 看（pickId）。 */
  #uniformBits = new Uint32Array(this.#uniforms.buffer);
  #uniformBuffer: GPUBuffer | undefined;
  #drawGroup: GPUBindGroup | undefined;

  constructor(device: GPUDevice, resources: GpuResources, { pickId, gpu }: { pickId?: (component: ParticleSystemComponent) => number; gpu?: (emitter: ParticleEmitter) => GpuEmitter | undefined } = {}) {
    this.#pickId = pickId;
    this.#gpuOf = gpu ?? (() => undefined);
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
        if (!shape || !program) continue;
        if (emitter.onGpu) {
          const gpu = this.#gpuOf(emitter);
          if (!gpu) continue;
          this.#writeUniforms(draws.length, view, component, program, time, camera, gpu);
          draws.push({ firstQuad: 0, quads: 0, program, uniformOffset: draws.length * UNIFORM_STRIDE, gpu });
          continue;
        }
        if (pool.living === 0) continue;
        this.#reserve((quads + pool.living * shape.quadsPerParticle) * 4 * VERTEX_FLOATS);
        const order = drawOrder(emitter, camera);
        const writer = new VertexWriter(emitter, this.#vertices, quads * 4 * VERTEX_FLOATS, program);
        shape.build(emitter, camera, order, writer);
        // 形状写的四边形不能超过留的空间（每个粒子 quadsPerParticle 个）
        const end = Math.min(writer.at, (quads + pool.living * shape.quadsPerParticle) * 4 * VERTEX_FLOATS);
        const firstQuad = quads;
        quads = end / (4 * VERTEX_FLOATS);
        this.#writeUniforms(draws.length, view, component, program, time, camera);
        draws.push({ firstQuad, quads: quads - firstQuad, program, uniformOffset: draws.length * UNIFORM_STRIDE });
      }
    }
    if (draws.length === 0) return;
    this.#upload(quads, draws.length);
    pass.setVertexBuffer(0, this.#vertexBuffer!);
    pass.setIndexBuffer(this.#indexBuffer!, 'uint32');
    for (const { firstQuad, quads: count, program, uniformOffset, gpu } of draws) {
      const pipeline = this.#pipeline(program, colorFormat, depthFormat, gpu !== undefined);
      if (!pipeline) continue;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.#drawGroup!, [uniformOffset]);
      pass.setBindGroup(1, this.#textureGroup(program));
      if (gpu) {
        // 每个槽一个实例，死了的在顶点着色器里扔掉
        pass.setBindGroup(2, gpu.drawGroup);
        pass.draw(verticesPerParticle(gpu.emitter), gpu.capacity);
      } else {
        pass.drawIndexed(count * 6, 1, firstQuad * 6);
      }
    }
  }

  destroy(): void {
    this.#vertexBuffer?.destroy();
    this.#indexBuffer?.destroy();
    this.#uniformBuffer?.destroy();
  }

  /** 第 index 次绘制的参数（gpu 给了时加上 GPU 粒子要的相机、变换和环）。 */
  #writeUniforms(index: number, view: RenderView, component: ParticleSystemComponent, program: MaterialProgram, time: number, camera: CameraAxes, gpu?: GpuEmitter): void {
    const floats = UNIFORM_STRIDE / 4;
    if ((index + 1) * floats > this.#uniforms.length) {
      const grown = new Float32Array(this.#uniforms.length * 2);
      grown.set(this.#uniforms);
      this.#uniforms = grown;
      this.#uniformBits = new Uint32Array(grown.buffer);
    }
    const u = this.#uniforms, at = index * floats;
    u.set(view.viewProjection, at);
    u.set(component.color, at + 16);
    u[at + 20] = program.alphaFactor;
    u[at + 21] = time;
    this.#uniformBits[at + 22] = this.#pickId?.(component) ?? 0;
    if (!gpu) return;
    u.set(camera.right, at + 24);
    u.set(camera.up, at + 28);
    u.set(camera.back, at + 32);
    const space = gpu.emitter.drawTransform;
    u.set(space.worldPosition, at + 36);
    u[at + 39] = space.worldScale[0];
    u.set(space.worldRotation, at + 40);
    this.#uniformBits.set([gpu.ring.head, gpu.capacity, 0, 0], at + 44);
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

  /**
   * gpu：画 GPU 上的粒子（顶点着色器读粒子缓冲，见 particles/gpu/draw.ts），片元着色器同一份。GPU 的这条在后台编
   * （createRenderPipelineAsync），编好之前是 undefined、这个发射器先不画：切到 GPU 时不卡那一帧。点选是一次性的请求、
   * 等不了，点选用的当场编。
   */
  #pipeline(program: MaterialProgram, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, gpu = false): GPURenderPipeline | undefined {
    const key = `${colorFormat}:${depthFormat}:${gpu}:${program.code}`;
    const found = this.#pipelines.get(key);
    if (found) return found;
    if (!gpu || this.#pickId !== undefined) {
      const pipeline = this.#device.createRenderPipeline(this.#descriptor(program, colorFormat, depthFormat, gpu));
      this.#pipelines.set(key, pipeline);
      return pipeline;
    }
    if (!this.#warming.has(key)) {
      this.#warming.add(key);
      void this.#device.createRenderPipelineAsync(this.#descriptor(program, colorFormat, depthFormat, true)).then((pipeline) => this.#pipelines.set(key, pipeline));
    }
    return undefined;
  }

  #descriptor(program: MaterialProgram, colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat, gpu: boolean): GPURenderPipelineDescriptor {
    const code = gpu ? SHADER_HEAD + GPU_DRAW_WGSL + program.code : SHADER_HEAD + program.code;
    let module = this.#modules.get(code);
    if (!module) this.#modules.set(code, (module = this.#device.createShaderModule({ label: gpu ? 'GPU particles' : 'Particles', code })));
    const picking = this.#pickId !== undefined;
    const layouts = this.#layout(program.textures.length);
    return {
      label: `${gpu ? 'GPU particles' : 'Particles'}${picking ? ' picking' : ''}`,
      layout: gpu ? this.#device.createPipelineLayout({ bindGroupLayouts: [this.#drawLayout, layouts.textures, gpuDrawLayout(this.#device)] }) : layouts.pipeline,
      vertex: gpu ? { module, entryPoint: 'vsGpu' } : {
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
      fragment: picking ? { module, entryPoint: 'fsPick', targets: [{ format: colorFormat }] } : {
        module,
        entryPoint: 'fs',
        // 预乘 alpha（Stride 的 BlendStates.AlphaBlend）
        targets: [{ format: colorFormat, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // 点选时写深度：后画的 UI、别的粒子系统和它比远近
      depthStencil: { format: depthFormat, depthWriteEnabled: picking, depthCompare: 'less-equal' },
    };
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
