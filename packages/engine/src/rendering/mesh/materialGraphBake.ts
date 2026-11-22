/**
 * 材质节点图的滤镜节点（materialGraph.ts 的 BAKED_NODE_TYPES：烘焙、模糊、扭曲）怎么烘：节点 value 输入的上游在 0..1 的 UV
 * 平面上画进一张贴图（rgba16float，边长是节点的 resolution，带完整的 mip），模糊再在 GPU 上横竖各做一遍。上游里还有滤镜的，
 * 先烘上游的（烘焙着色器里它是一次采样）。
 *
 *   // 加载材质：每个滤镜节点一张贴图，第一次用到时在那个设备上烘（GpuResources.texture 调 generate）
 *   const texture = bakedMaterialGraphTexture(graph, 'blur1', (key) => textures.get(key), 'material Rock');
 *   // 节点图面板的预览：直接烘
 *   const gpu = MaterialGraphBaker.for(device).bake(graph, 'blur1', (key) => gpuTextures.get(key)!, 'material Rock');
 *
 * 平面上的材质流同节点的预览（materialGraphPreview.ts 也用这里的 UV_PLANE_DECLARATIONS、uvPlaneStreams）：uv 是 0..1，世界位置是
 * (u, 0, v) · 2 米、法线朝上，时间 0；屏幕空间遮蔽当作没遮住，相机在 10 米高处。所以滤镜的上游按 UV 空间算才和不烘时一样。
 */
import type { GraphFile, GraphLink, GraphNodeFile } from '../../content/formats/nodeGraph';
import { MipmapGenerator } from '../../graphics/MipmapGenerator';
import { Texture } from '../../graphics/Texture';
import { MATERIAL_STREAMS } from '../shaderClass';
import { FULLSCREEN_VERTEX } from '../wgsl';
import { BAKED_NODE_TYPES, MATERIAL_GRAPH_OUTPUTS, convertGraphValue, emitMaterialGraphNodes, type MaterialGraphOutput, type MaterialGraphValue } from './materialGraph';

/** 烘好的贴图的格式：数、法线、高度都要比 8 位细（模糊过的高度算法线时看得出台阶）。 */
const BAKED_FORMAT: GPUTextureFormat = 'rgba16float';
/** 模糊在哪一级 mip 上做：半径超过这么多像素就往小一级挪（每级减半），开销不随半径涨。 */
const BLUR_MAX_RADIUS = 24;
/** 管线按代码缓存，留最近几个。 */
const PIPELINE_CACHE = 16;

/** UV 平面上求值要的声明：材质流、相机和屏幕空间遮蔽的替身。 */
export const UV_PLANE_DECLARATIONS = /* wgsl */ `
${MATERIAL_STREAMS}
struct PlaneView { eye: vec4f };
var<private> view: PlaneView;
// 网格着色器里屏幕空间遮蔽的替身：平面上没有画面，当作没遮住
fn screenAmbient(position: vec4f) -> vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
`;

/** 片元着色器开头：把平面上 uv 处的材质流填好。 */
export function uvPlaneStreams(uv: string): string {
  return `  streams.uv = ${uv};
  streams.uv1 = ${uv};
  streams.color = vec4f(1.0);
  streams.colorScale = vec4f(1.0);
  streams.position = vec3f(${uv}.x, 0.0, ${uv}.y) * 2.0;
  streams.world = streams.position;
  streams.normal = vec3f(0.0, 1.0, 0.0);
  streams.time = 0.0;
  streams.pixel = vec2f(-1.0);
  view.eye = vec4f(1.0, 10.0, 1.0, 1.0);`;
}

/** 图里的滤镜节点（按节点的顺序）。 */
export function bakedMaterialGraphNodes(graph: GraphFile): string[] {
  return graph.nodes.filter((node) => BAKED_NODE_TYPES.has(node.type)).map((node) => node.id);
}

/** 节点烘出来的贴图的边长：resolution，模糊半径大时是在小一级 mip 上模糊的那一级的大小；level 是那一级。 */
export function bakedSize(node: GraphNodeFile): { readonly resolution: number; readonly level: number; readonly size: number; readonly radius: number } {
  const resolution = Number(node.params?.['resolution'] ?? 512) || 512;
  if (node.type !== 'blur') return { resolution, level: 0, size: resolution, radius: 0 };
  const radius = Math.max(0, Number(node.params?.['radius'] ?? 0.02)) * resolution;
  const level = radius > BLUR_MAX_RADIUS ? Math.ceil(Math.log2(radius / BLUR_MAX_RADIUS)) : 0;
  return { resolution, level, size: Math.max(1, resolution >> level), radius: radius / 2 ** level };
}

/** 烘焙着色器：WGSL 和用到的贴图（sample 的 key：内容路径或上游滤镜的 bakedTextureKey，按绑定的顺序）。 */
export interface MaterialGraphBakeShader {
  readonly code: string;
  readonly textures: readonly string[];
}

/** 一个滤镜节点 value 输入的上游画在 UV 平面上的着色器（输出线性的值，数是重复成颜色）。图有错时抛错，消息以 where 开头。 */
export function materialGraphBakeShader(graph: GraphFile, node: string, where: string): MaterialGraphBakeShader {
  const link = graph.nodes.find((n) => n.id === node)?.inputs?.['value'];
  return uvPlaneShader(graph, link, `${where}, baking node '${node}'`, `input value of node '${node}'`, (value) => (value ? convertGraphValue(value, 'color') : 'vec4f(0.0, 0.0, 0.0, 1.0)'));
}

/**
 * 材质的一个输出画在 UV 平面上、编码成 8 位贴图的着色器（导出贴图用）：颜色（基础色、自发光）换成 sRGB，法线按 0.5 偏移
 * （和材质的法线贴图一样，切线空间），数是灰度。没接的输出是 undefined。
 */
export function materialGraphOutputShader(graph: GraphFile, output: MaterialGraphOutput, where: string): MaterialGraphBakeShader | undefined {
  const link = graph.outputs[output];
  if (!link) return undefined;
  const type = MATERIAL_GRAPH_OUTPUTS[output];
  return uvPlaneShader(graph, link, `${where}, exporting ${output}`, `output ${output}`, (value) => {
    const v = convertGraphValue(value!, type);
    return type === 'color' ? `vec4f(linearToSrgb(${v}.rgb), 1.0)` : type === 'vec3' ? `vec4f(${v} * 0.5 + 0.5, 1.0)` : `vec4f(vec3f(${v}), 1.0)`;
  });
}

/** 线性颜色编码成 sRGB（预览、导出用），先夹到 0..1。 */
export const LINEAR_TO_SRGB = /* wgsl */ `
fn linearToSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}`;

/** link 接的值在 UV 平面上算出来、finish 换成要写的 vec4f 的着色器；what 是报错时说的"谁接错了"。 */
function uvPlaneShader(graph: GraphFile, link: GraphLink | undefined, where: string, what: string, finish: (value: MaterialGraphValue | undefined) => string): MaterialGraphBakeShader {
  const functions = new Map<string, string>();
  const textures: string[] = [];
  const sample = (texture: string, uv: string) => {
    let index = textures.indexOf(texture);
    if (index < 0) index = textures.push(texture) - 1;
    return `textureSample(bakeTexture${index}, bakeSampler, ${uv})`;
  };
  let lines: string[] = [];
  let value: MaterialGraphValue | undefined;
  if (link) {
    // 借材质的一个输出排出 link 的上游（只算它们）
    const emitted = emitMaterialGraphNodes({ nodes: graph.nodes, outputs: { baseColor: link } }, { addFunction: (name, code) => void functions.set(name, code) }, sample, where);
    value = emitted.values.get(`${link.node}:${link.output ?? ''}`);
    if (!value) throw new Error(`${where}: ${what} is linked to output '${link.output ?? ''}' of node '${link.node}', which it does not have`);
    lines = emitted.lines;
  }
  const result = finish(value);
  const code = /* wgsl */ `
${FULLSCREEN_VERTEX}
${UV_PLANE_DECLARATIONS}
${LINEAR_TO_SRGB}
@group(0) @binding(0) var bakeSampler: sampler;
${textures.map((_, i) => `@group(0) @binding(${i + 1}) var bakeTexture${i}: texture_2d<f32>;`).join('\n')}

${[...functions.values()].join('\n')}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
${uvPlaneStreams('in.uv')}
${lines.join('\n')}
  return ${result};
}
`;
  return { code, textures };
}

/**
 * 滤镜节点烘好的贴图（加载材质时建，GPU 上的内容第一次用到时在那个设备上烘）。lookup 按 sample 的 key 给上游的贴图（贴图资源、
 * 上游滤镜节点的这种贴图）。
 */
export function bakedMaterialGraphTexture(graph: GraphFile, node: string, lookup: (key: string) => Texture | undefined, where: string): Texture {
  const file = graph.nodes.find((n) => n.id === node);
  if (!file) throw new Error(`${where}: no node '${node}' to bake`);
  const { size } = bakedSize(file);
  return new Texture(`${where} ${node}`, {
    format: BAKED_FORMAT, width: size, height: size, levels: [],
    generate: (resources) => MaterialGraphBaker.for(resources.device).bake(graph, node, (key) => {
      const texture = lookup(key);
      if (!texture) throw new Error(`${where}: baking node '${node}' needs '${key}', which was not loaded`);
      return resources.texture(texture);
    }, where),
  });
}

const BLUR_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
struct BlurParams { direction: vec2i, radius: f32, _pad: f32 };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: BlurParams;

// 一个方向的高斯模糊（半径 = 2σ），越过边的按平铺从另一边接上（烘的图都是平铺的）
@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  let center = vec2i(in.position.xy);
  let sigma = max(params.radius * 0.5, 0.5);
  let taps = i32(ceil(params.radius));
  var sum = vec4f(0.0);
  var weight = 0.0;
  for (var i = -taps; i <= taps; i++) {
    let w = exp(-f32(i * i) / (2.0 * sigma * sigma));
    let at = ((center + params.direction * i) % size + size) % size;
    sum += textureLoad(source, at, 0) * w;
    weight += w;
  }
  return sum / weight;
}`;

const bakers = new WeakMap<GPUDevice, MaterialGraphBaker>();

/**
 * 一个设备上的烘焙器：管线按代码缓存。bake 是同步的（建管线、录命令、提交），烘 512² 的一张在这台机器上是几毫秒，第一次编着色器
 * 另算。
 */
export class MaterialGraphBaker {
  readonly #device: GPUDevice;
  readonly #mipmaps: MipmapGenerator;
  readonly #sampler: GPUSampler;
  readonly #pipelines = new Map<string, { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout }>();
  #blur: GPURenderPipeline | undefined;

  /** 这个设备上的烘焙器（第一次要时建）。 */
  static for(device: GPUDevice): MaterialGraphBaker {
    let baker = bakers.get(device);
    if (!baker) bakers.set(device, (baker = new MaterialGraphBaker(device)));
    return baker;
  }

  private constructor(device: GPUDevice) {
    this.#device = device;
    this.#mipmaps = new MipmapGenerator(device);
    this.#sampler = device.createSampler({ label: 'material graph bake', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  }

  /** 烘一个滤镜节点：返回新建的贴图（带完整的 mip），用完由调用方销毁。textureOf 按 sample 的 key 给上游的贴图。 */
  bake(graph: GraphFile, node: string, textureOf: (key: string) => GPUTexture, where: string): GPUTexture {
    const file = graph.nodes.find((n) => n.id === node);
    if (!file || !BAKED_NODE_TYPES.has(file.type)) throw new Error(`${where}: node '${node}' is not a filter node to bake`);
    const shader = materialGraphBakeShader(graph, node, where);
    const { resolution, level, size, radius } = bakedSize(file);
    const device = this.#device;
    const plane = this.#target(`${where} ${node}`, resolution);
    const encoder = device.createCommandEncoder({ label: `bake ${where} ${node}` });
    this.#drawPlane(encoder, shader, textureOf, plane.createView({ baseMipLevel: 0, mipLevelCount: 1 }), BAKED_FORMAT);
    this.#mipmaps.generate(plane, encoder);
    if (file.type !== 'blur' || radius <= 0) {
      device.queue.submit([encoder.finish()]);
      return plane;
    }
    // 模糊：在第 level 级上横着、竖着各一遍，结果再出 mip
    const blurred = this.#target(`${where} ${node} blurred`, size);
    const between = device.createTexture({ label: `${where} ${node} blur`, size: [size, size], format: BAKED_FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    const uniforms: GPUBuffer[] = [];
    const blurPass = (source: GPUTextureView, target: GPUTextureView, direction: [number, number]) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const data = new ArrayBuffer(16);
      new Int32Array(data, 0, 2).set(direction);
      new Float32Array(data, 8, 1)[0] = radius;
      device.queue.writeBuffer(buffer, 0, data);
      uniforms.push(buffer);
      const blur = this.#blurPipeline();
      const group = device.createBindGroup({ layout: blur.getBindGroupLayout(0), entries: [{ binding: 0, resource: source }, { binding: 1, resource: { buffer } }] });
      const p = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      p.setPipeline(blur);
      p.setBindGroup(0, group);
      p.draw(3);
      p.end();
    };
    blurPass(plane.createView({ baseMipLevel: level, mipLevelCount: 1 }), between.createView(), [1, 0]);
    blurPass(between.createView(), blurred.createView({ baseMipLevel: 0, mipLevelCount: 1 }), [0, 1]);
    this.#mipmaps.generate(blurred, encoder);
    device.queue.submit([encoder.finish()]);
    // 提交了的命令做完以后才真的释放
    plane.destroy();
    between.destroy();
    for (const buffer of uniforms) buffer.destroy();
    return blurred;
  }

  /**
   * 把材质的各个输出（接了的）画在 UV 平面上、读回成 8 位的 RGBA（size × size，一行紧挨一行）：导出贴图用，编码见
   * materialGraphOutputShader。textureOf 同 bake。
   */
  async exportOutputs(graph: GraphFile, outputs: readonly MaterialGraphOutput[], size: number, textureOf: (key: string) => GPUTexture, where: string): Promise<Map<MaterialGraphOutput, Uint8Array>> {
    const device = this.#device;
    const bytesPerRow = Math.ceil((size * 4) / 256) * 256;
    const jobs = outputs.flatMap((output) => {
      const shader = materialGraphOutputShader(graph, output, where);
      return shader ? [{ output, shader }] : [];
    });
    const target = device.createTexture({ label: `${where} export`, size: [size, size], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const readback = device.createBuffer({ label: `${where} export`, size: bytesPerRow * size * Math.max(1, jobs.length), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const result = new Map<MaterialGraphOutput, Uint8Array>();
    try {
      const encoder = device.createCommandEncoder({ label: `export ${where}` });
      jobs.forEach(({ shader }, i) => {
        this.#drawPlane(encoder, shader, textureOf, target.createView(), 'rgba8unorm');
        encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, offset: i * bytesPerRow * size, bytesPerRow }, [size, size]);
      });
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      jobs.forEach(({ output }, i) => {
        const rgba = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) rgba.set(bytes.subarray(i * bytesPerRow * size + y * bytesPerRow, i * bytesPerRow * size + y * bytesPerRow + size * 4), y * size * 4);
        result.set(output, rgba);
      });
      readback.unmap();
    } finally {
      target.destroy();
      readback.destroy();
    }
    return result;
  }

  /** 一遍全屏的绘制：着色器在 UV 平面上算，画进 target。 */
  #drawPlane(encoder: GPUCommandEncoder, shader: MaterialGraphBakeShader, textureOf: (key: string) => GPUTexture, target: GPUTextureView, format: GPUTextureFormat): void {
    const { pipeline, layout } = this.#pipeline(shader.code, shader.textures.length, format);
    const bindGroup = this.#device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: this.#sampler }, ...shader.textures.map((key, i) => ({ binding: i + 1, resource: textureOf(key).createView() }))],
    });
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  #target(label: string, size: number): GPUTexture {
    return this.#device.createTexture({
      label, size: [size, size], format: BAKED_FORMAT, mipLevelCount: Math.floor(Math.log2(size)) + 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** 烘焙的管线按代码缓存；绑定布局按贴图数写明（同预览：没有贴图时采样器用不到，'auto' 的布局里就没有它）。 */
  #pipeline(code: string, textureCount: number, format: GPUTextureFormat = BAKED_FORMAT): { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout } {
    const key = `${format}\n${code}`;
    const cached = this.#pipelines.get(key);
    if (cached) {
      this.#pipelines.delete(key);
      this.#pipelines.set(key, cached);
      return cached;
    }
    const device = this.#device;
    const layout = device.createBindGroupLayout({
      label: 'material graph bake',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ...Array.from({ length: textureCount }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
      ],
    });
    const module = device.createShaderModule({ label: 'material graph bake', code });
    const pipeline = device.createRenderPipeline({
      label: 'material graph bake',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    });
    const entry = { pipeline, layout };
    this.#pipelines.set(key, entry);
    if (this.#pipelines.size > PIPELINE_CACHE) this.#pipelines.delete(this.#pipelines.keys().next().value!);
    return entry;
  }

  #blurPipeline(): GPURenderPipeline {
    if (!this.#blur) {
      const module = this.#device.createShaderModule({ label: 'material graph blur', code: BLUR_SHADER });
      this.#blur = this.#device.createRenderPipeline({
        label: 'material graph blur', layout: 'auto',
        vertex: { module, entryPoint: 'fullscreenVertex' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: BAKED_FORMAT }] },
      });
    }
    return this.#blur;
  }
}
