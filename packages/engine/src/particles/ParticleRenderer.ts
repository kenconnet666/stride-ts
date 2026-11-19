/**
 * 画粒子（Stride 的 ParticleEmitterRenderFeature 加各形状的 ShapeBuilder、ParticleMaterialComputeColor）：每帧在 CPU 上把每个
 * 发射器的粒子展开成四边形（Billboard 正对相机、Quad 按粒子的朝向平放、Hexagon 正对相机的六边形，两个四边形），
 * 翻页动画按剩下的寿命取帧，所有发射器的顶点放进一个缓冲、写一次，每个发射器画一次。
 *
 * 颜色照 Stride 的 ParticleComputeColorShader：组件的颜色 × 材质的颜色（贴图（按预乘 alpha 用，同 Stride 编译贴图时预乘）、
 * 粒子的颜色或常量），alpha 再乘 1 - AlphaAdditive（1 就是加法混合）；混合是预乘 alpha，和深度比较但不写深度，不剔除背面。
 * 粒子系统从远到近画，同一个系统里的发射器按 DrawPriority。粒子的顺序：SortingPolicy 是 ByDepth 时从远到近，其余按池里的顺序。
 */
import type { ParticleModuleFile } from '../content/format';
import { Matrix } from '../mathematics/Matrix';
import type { GpuResources } from '../rendering/GpuResources';
import type { RenderView } from '../rendering/RenderSystem';
import type { Texture } from '../rendering/Texture';
import { rotate, type Quat, type Vec3 } from './math';
import { value } from './modules';
import type { ParticleEmitter } from './ParticleEmitter';
import type { ParticleSystemComponent } from './ParticleSystemComponent';

/** 每个顶点：位置 3、UV 2、颜色 4。 */
const VERTEX_FLOATS = 9;
/** 每次绘制的参数（WGSL 里 128 字节）：视图投影 16、组件颜色 4、常量颜色 4、UV 的缩放和偏移 4、模式和 alpha 系数；按动态偏移的 256 字节对齐。 */
const UNIFORM_STRIDE = 256;
const SQRT3_HALF = 0.86602540378;

/** 材质颜色从哪来（着色器里的 mode）。 */
const ColorMode = { texture: 0, vertex: 1, constant: 2 } as const;

const SHADER = /* wgsl */ `
struct Draw {
  viewProjection: mat4x4f,
  colorScale: vec4f,
  constant: vec4f,
  uvTransform: vec4f,
  mode: u32,
  alphaFactor: f32,
};
@group(0) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(0) var colorTexture: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex fn vs(@location(0) position: vec3f, @location(1) uv: vec2f, @location(2) color: vec4f) -> Varyings {
  var out: Varyings;
  out.position = draw.viewProjection * vec4f(position, 1.0);
  out.uv = uv;
  out.color = color;
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let texel = textureSample(colorTexture, colorSampler, in.uv * draw.uvTransform.xy + draw.uvTransform.zw);
  var base = draw.constant;
  if (draw.mode == 0u) {
    base = vec4f(texel.rgb * texel.a, texel.a);
  } else if (draw.mode == 1u) {
    base = in.color;
  }
  var color = draw.colorScale * base;
  color.a *= draw.alphaFactor;
  return color;
}
`;

/** 一个发射器这一帧的绘制。 */
interface EmitterDraw {
  readonly firstQuad: number;
  readonly quads: number;
  readonly texture: Texture | undefined;
  readonly uniformOffset: number;
}

export class ParticleRenderer {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #module: GPUShaderModule;
  readonly #drawLayout: GPUBindGroupLayout;
  readonly #textureLayout: GPUBindGroupLayout;
  readonly #pipelineLayout: GPUPipelineLayout;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  readonly #textureGroups = new Map<GPUTexture, GPUBindGroup>();
  #vertices = new Float32Array(VERTEX_FLOATS * 4 * 1024);
  #vertexBuffer: GPUBuffer | undefined;
  #indexBuffer: GPUBuffer | undefined;
  #uniforms = new Float32Array((UNIFORM_STRIDE / 4) * 16);
  #uniformBuffer: GPUBuffer | undefined;
  #drawGroup: GPUBindGroup | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#module = device.createShaderModule({ label: 'Particles', code: SHADER });
    this.#drawLayout = device.createBindGroupLayout({
      label: 'Particles draw',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 128 } }],
    });
    this.#textureLayout = device.createBindGroupLayout({
      label: 'Particles texture',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.#drawLayout, this.#textureLayout] });
  }

  /** 把 components 的粒子画进 pass（颜色格式 colorFormat、深度格式 depthFormat），按 view 的相机。 */
  draw(pass: GPURenderPassEncoder, view: RenderView, components: readonly ParticleSystemComponent[], colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    const cameraWorld = new Float32Array(16);
    if (!Matrix.invert(cameraWorld, view.view)) return;
    const right: Vec3 = [cameraWorld[0]!, cameraWorld[1]!, cameraWorld[2]!];
    const up: Vec3 = [cameraWorld[4]!, cameraWorld[5]!, cameraWorld[6]!];
    const eye: Vec3 = [cameraWorld[12]!, cameraWorld[13]!, cameraWorld[14]!];
    // 粒子系统从远到近
    const systems = components
      .filter((component) => component.enabled)
      .map((component) => ({ component, distance: Math.hypot(...component.particleSystem.translation.map((t, i) => t - eye[i]!)) }))
      .sort((a, b) => b.distance - a.distance);

    const draws: EmitterDraw[] = [];
    let quads = 0;
    for (const { component } of systems) {
      const emitters = [...component.particleSystem.emitters].filter((emitter) => emitter.enabled).sort((a, b) => a.drawPriority - b.drawPriority);
      for (const emitter of emitters) {
        if (!emitter.shapeBuilder || !emitter.material || emitter.pool.living === 0) continue;
        const firstQuad = quads;
        quads = this.#buildVertices(emitter, right, up, quads);
        if (quads === firstQuad) continue;
        const uniformOffset = draws.length * UNIFORM_STRIDE;
        this.#writeUniforms(draws.length, view, component, emitter);
        draws.push({ firstQuad, quads: quads - firstQuad, texture: emitter.texture, uniformOffset });
      }
    }
    if (draws.length === 0) return;
    this.#upload(quads, draws.length);
    pass.setPipeline(this.#pipeline(colorFormat, depthFormat));
    pass.setVertexBuffer(0, this.#vertexBuffer!);
    pass.setIndexBuffer(this.#indexBuffer!, 'uint32');
    for (const { firstQuad, quads: count, texture, uniformOffset } of draws) {
      pass.setBindGroup(0, this.#drawGroup!, [uniformOffset]);
      pass.setBindGroup(1, this.#textureGroup(texture ? this.#resources.texture(texture) : this.#resources.white));
      pass.drawIndexed(count * 6, 1, firstQuad * 6);
    }
  }

  destroy(): void {
    this.#vertexBuffer?.destroy();
    this.#indexBuffer?.destroy();
    this.#uniformBuffer?.destroy();
  }

  /** 发射器的粒子展开成四边形，从第 firstQuad 个起写进顶点数组；返回写完后的四边形数。 */
  #buildVertices(emitter: ParticleEmitter, right: Readonly<Vec3>, up: Readonly<Vec3>, firstQuad: number): number {
    const pool = emitter.pool;
    const shape = emitter.shapeBuilder!.$type;
    const quadsPerParticle = shape === 'shapeBuilderHexagon' ? 2 : 1;
    if (shape !== 'shapeBuilderBillboard' && shape !== 'shapeBuilderQuad' && shape !== 'shapeBuilderHexagon') return firstQuad;
    this.#reserve((firstQuad + pool.living * quadsPerParticle) * 4 * VERTEX_FLOATS);
    const position = pool.field('position')!, size = pool.field('size'), angle = pool.field('rotation');
    const quaternion = pool.field('quaternion'), color = pool.field('color'), life = pool.field('life')!;
    // 局部模拟时粒子的位置按粒子系统的变换换到世界
    const local = emitter.simulationSpace === 'local';
    const space = emitter.drawTransform;
    const flipbook = emitter.material!['uvBuilder'] as ParticleModuleFile | null | undefined;
    const frames = flipbook?.$type === 'uvBuilderFlipbook' ? flipbookOf(flipbook) : undefined;
    const order = this.#order(emitter, right, up);
    const v = this.#vertices;
    let at = firstQuad * 4 * VERTEX_FLOATS;
    const vertex = (p: Readonly<Vec3>, u: number, w: number, rgba: readonly number[], uv: readonly number[]) => {
      v[at] = p[0]; v[at + 1] = p[1]; v[at + 2] = p[2];
      v[at + 3] = uv[0]! + uv[2]! * u; v[at + 4] = uv[1]! + uv[3]! * w;
      v[at + 5] = rgba[0]!; v[at + 6] = rgba[1]!; v[at + 7] = rgba[2]!; v[at + 8] = rgba[3]!;
      at += VERTEX_FLOATS;
    };
    const white = [1, 1, 1, 1];
    const fullUv = [0, 0, 1, 1];
    const center: Vec3 = [0, 0, 0];
    for (const i of order) {
      center[0] = position[i * 3]!; center[1] = position[i * 3 + 1]!; center[2] = position[i * 3 + 2]!;
      let half = (size ? size[i]! : 1) * 0.5;
      if (local) {
        rotate(space.worldRotation, center);
        for (let k = 0; k < 3; k++) center[k] = center[k]! * space.worldScale[0] + space.worldPosition[k]!;
        half *= space.worldScale[0];
      }
      let ux: Vec3, uy: Vec3;
      if (shape === 'shapeBuilderQuad') {
        ux = [1, 0, 0];
        uy = [0, 0, 1];
        if (quaternion) {
          const q = Array.from(quaternion.subarray(i * 4, i * 4 + 4)) as Quat;
          rotate(q, ux);
          rotate(q, uy);
        }
        if (local) {
          rotate(space.worldRotation, ux);
          rotate(space.worldRotation, uy);
        }
        ux = ux.map((c) => c * half) as Vec3;
        uy = uy.map((c) => c * half) as Vec3;
      } else {
        ux = right.map((c) => c * half) as Vec3;
        uy = up.map((c) => c * half) as Vec3;
        if (angle && angle[i] !== 0) {
          const cos = Math.cos(angle[i]!), sin = Math.sin(angle[i]!);
          const x = ux.map((c, k) => c * cos - uy[k]! * sin) as Vec3;
          uy = uy.map((c, k) => c * cos + ux[k]! * sin) as Vec3;
          ux = x;
        }
      }
      const rgba = color ? Array.from(color.subarray(i * 4, i * 4 + 4), (c) => Math.min(Math.max(c, 0), 1)) : white;
      const uv = frames ? frames(life[i]!) : fullUv;
      const p = (sx: number, sy: number): Vec3 => [center[0] + ux[0] * sx + uy[0] * sy, center[1] + ux[1] * sx + uy[1] * sy, center[2] + ux[2] * sx + uy[2] * sy];
      if (shape === 'shapeBuilderHexagon') {
        // 两个四边形拼成六边形（Stride 的 ShapeBuilderHexagon）：上半是梯形加中线，下半同样
        const top = 0.5 - SQRT3_HALF * 0.5;
        vertex(p(-0.5, SQRT3_HALF), 0.25, top, rgba, uv);
        vertex(p(0.5, SQRT3_HALF), 0.75, top, rgba, uv);
        vertex(p(1, 0), 1, 0.5, rgba, uv);
        vertex(p(-1, 0), 0, 0.5, rgba, uv);
        vertex(p(1, 0), 1, 0.5, rgba, uv);
        vertex(p(0.5, -SQRT3_HALF), 0.75, 1, rgba, uv);
        vertex(p(-0.5, -SQRT3_HALF), 0.25, 1, rgba, uv);
        vertex(p(-1, 0), 0, 0.5, rgba, uv);
      } else {
        vertex(p(-1, 1), 0, 0, rgba, uv);
        vertex(p(1, 1), 1, 0, rgba, uv);
        vertex(p(1, -1), 1, 1, rgba, uv);
        vertex(p(-1, -1), 0, 1, rgba, uv);
      }
    }
    return firstQuad + order.length * quadsPerParticle;
  }

  /** 画粒子的顺序：ByDepth 时从远到近（深度方向是相机的 Z 轴），其余按池里的顺序。 */
  #order(emitter: ParticleEmitter, right: Readonly<Vec3>, up: Readonly<Vec3>): number[] {
    const order = Array.from({ length: emitter.pool.living }, (_, i) => i);
    if (emitter.sortingPolicy !== 'byDepth') return order;
    const position = emitter.pool.field('position')!;
    const depth: Vec3 = [right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]];
    const key = (i: number) => position[i * 3]! * depth[0] + position[i * 3 + 1]! * depth[1] + position[i * 3 + 2]! * depth[2];
    return order.sort((a, b) => key(a) - key(b));
  }

  /** 第 index 次绘制的参数。 */
  #writeUniforms(index: number, view: RenderView, component: ParticleSystemComponent, emitter: ParticleEmitter): void {
    const material = emitter.material!;
    const floats = UNIFORM_STRIDE / 4;
    if ((index + 1) * floats > this.#uniforms.length) {
      const grown = new Float32Array(this.#uniforms.length * 2);
      grown.set(this.#uniforms);
      this.#uniforms = grown;
    }
    const u = this.#uniforms, at = index * floats;
    u.set(view.viewProjection, at);
    u.set(component.color, at + 16);
    const compute = material['computeColor'] as ParticleModuleFile | null | undefined;
    let mode: number = ColorMode.constant, constant = [1, 1, 1, 1], uvTransform = [1, 1, 0, 0];
    if (compute?.$type === 'computeTextureColor') {
      if (emitter.texture) {
        mode = ColorMode.texture;
        const [sx, sy] = value(compute, 'scale', [1, 1]), [ox, oy] = value(compute, 'offset', [0, 0]);
        uvTransform = [sx!, sy!, ox!, oy!];
      } else constant = value(value(compute, 'fallbackValue', {} as ParticleModuleFile), 'value', [1, 1, 1, 1]) as number[];
    } else if (compute?.$type === 'computeVertexStreamColor') mode = ColorMode.vertex;
    else if (compute?.$type === 'computeFloat4' || compute?.$type === 'computeColor') constant = [...value(compute, 'value', [1, 1, 1, 1])];
    u.set(constant, at + 20);
    u.set(uvTransform, at + 24);
    new Uint32Array(u.buffer, (at + 28) * 4, 1)[0] = mode;
    u[at + 29] = 1 - value(material, 'alphaAdditive', 0);
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
      this.#drawGroup = device.createBindGroup({ layout: this.#drawLayout, entries: [{ binding: 0, resource: { buffer: this.#uniformBuffer, size: 128 } }] });
    }
    device.queue.writeBuffer(this.#uniformBuffer, 0, this.#uniforms.buffer, 0, uniformBytes);
  }

  #pipeline(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): GPURenderPipeline {
    const key = `${colorFormat}:${depthFormat}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = this.#device.createRenderPipeline({
        label: 'Particles',
        layout: this.#pipelineLayout,
        vertex: {
          module: this.#module,
          entryPoint: 'vs',
          buffers: [{
            arrayStride: VERTEX_FLOATS * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x2' },
              { shaderLocation: 2, offset: 20, format: 'float32x4' },
            ],
          }],
        },
        fragment: {
          module: this.#module,
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

  #textureGroup(texture: GPUTexture): GPUBindGroup {
    let group = this.#textureGroups.get(texture);
    if (!group) {
      group = this.#device.createBindGroup({
        layout: this.#textureLayout,
        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: this.#resources.sampler({}) }],
      });
      this.#textureGroups.set(texture, group);
    }
    return group;
  }
}

/** 翻页动画（Stride 的 UVBuilderFlipbook）：按走过的寿命取第几帧，返回这一帧在贴图上的 [u, v, 宽, 高]。 */
export function flipbookOf(file: ParticleModuleFile): (remainingLife: number) => [number, number, number, number] {
  const x = Math.max(1, value(file, 'xDivisions', 4)), y = Math.max(1, value(file, 'yDivisions', 4));
  const start = Math.min(value(file, 'startingFrame', 0), x * y);
  const speed = value(file, 'animationSpeed', 16);
  return (remainingLife) => {
    const frame = start + Math.trunc((1 - remainingLife) * speed);
    return [(frame % x) / x, Math.floor(frame / x) / y, 1 / x, 1 / y];
  };
}
