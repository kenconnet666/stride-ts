/**
 * 材质节点图每个节点的预览（编辑器的节点图面板用，同 Substance Designer 的节点缩略图）：在 0..1 的 UV 平面上把整张图算一遍，
 * 每格显示一个节点的第一个输出——数是灰度，二维、三维（法线）按 0.5 偏移成颜色，颜色从线性换成 sRGB。所有节点一次画进一张图集
 * （每个节点一个实例、一格），读回来按节点切开。
 *
 *   const previewer = new MaterialGraphPreviewer(device, { loadImage: (path) => fetchBitmap(path) });
 *   const images = await previewer.render(graph);   // 节点 id → ImageData（64 × 64）
 *
 * 平面上的材质流同滤镜的烘焙（materialGraphBake.ts 的 uvPlaneStreams）：uv 是格子里的 0..1，世界位置是 (u, 0, v) · 2 米、法线朝上，
 * 时间 0；屏幕空间遮蔽当作没遮住，相机在 10 米高处。贴图节点用 loadImage 加载的图（没有时是品红），滤镜节点先烘（同材质里的烘法，
 * 按上游的内容缓存：改了别处的参数不重烘）。
 */
import type { GraphFile, GraphNodeFile, PortType } from '../../content/formats/nodeGraph';
import { BAKED_NODE_TYPES, bakedTextureKey, convertGraphValue, emitMaterialGraphNodes, materialGraphTextures } from './materialGraph';
import { MaterialGraphBaker, UV_PLANE_DECLARATIONS, bakedMaterialGraphNodes, uvPlaneStreams } from './materialGraphBake';

/** 预览一格的边长（像素） */
export const MATERIAL_PREVIEW_SIZE = 64;
/** 图集一行几格 */
const COLUMNS = 16;
/** 管线留最近几个：参数直接写进着色器，改一次参数就是一份新代码（拖数值时一直在变） */
const PIPELINE_CACHE = 8;

/** 预览着色器：WGSL、每格对应的节点（按实例号）、用到的贴图（按绑定顺序） */
export interface MaterialGraphPreviewShader {
  readonly code: string;
  readonly nodes: readonly string[];
  readonly textures: readonly string[];
}

/** 一种输出在预览里怎么显示成颜色（rgb，0..1） */
const DISPLAY: Readonly<Record<PortType, (expr: string) => string>> = {
  float: (expr) => `vec3f(${expr})`,
  vec2: (expr) => `vec3f(${expr}, 0.0)`,
  vec3: (expr) => `(${expr} * 0.5 + 0.5)`,
  color: (expr) => `linearToSrgb(${expr}.rgb)`,
};

/** 生成预览的着色器；节点图有错（认不出的节点、接错的端口）时抛错，消息以 where 开头。 */
export function materialGraphPreviewShader(graph: GraphFile, where: string): MaterialGraphPreviewShader {
  const functions = new Map<string, string>();
  const textures: string[] = [];
  const sample = (texture: string, uv: string) => {
    let index = textures.indexOf(texture);
    if (index < 0) index = textures.push(texture) - 1;
    return `textureSample(previewTexture${index}, previewSampler, ${uv})`;
  };
  const { lines, values } = emitMaterialGraphNodes(graph, { addFunction: (name, code) => void functions.set(name, code) }, sample, where, { all: true });
  const nodes = graph.nodes.map((node) => node.id).filter((id) => values.has(`${id}:`));
  const cases = nodes.map((id, i) => {
    const value = values.get(`${id}:`)!;
    // 滤镜节点（输出是颜色）按接进来的值显示：烘的是灰度的数就还显示成灰度
    const link = graph.nodes.find((node) => node.id === id && BAKED_NODE_TYPES.has(node.type))?.inputs?.['value'];
    const shown = (link && values.get(`${link.node}:${link.output ?? ''}`)?.type) ?? value.type;
    return `    case ${i}u: { shown = ${DISPLAY[shown](convertGraphValue(value, shown))}; }`;
  });
  const bindings = textures.map((_, i) => `@group(0) @binding(${i + 1}) var previewTexture${i}: texture_2d<f32>;`).join('\n');
  const code = /* wgsl */ `
${UV_PLANE_DECLARATIONS}
@group(0) @binding(0) var previewSampler: sampler;
${bindings}

fn linearToSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

${[...functions.values()].join('\n')}

struct PreviewVaryings {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) tile: u32,
};

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) tile: u32) -> PreviewVaryings {
  let corner = vec2f(f32(vertex & 1u), f32(vertex >> 1u));
  let cell = vec2f(f32(tile % ${COLUMNS}u), f32(tile / ${COLUMNS}u));
  let grid = vec2f(${COLUMNS}.0, f32((arrayLength(&previewTiles) + ${COLUMNS - 1}u) / ${COLUMNS}u));
  let at = (cell + corner) / grid;
  var out: PreviewVaryings;
  out.position = vec4f(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0, 0.0, 1.0);
  out.uv = corner;
  out.tile = tile;
  return out;
}

// 只是让顶点着色器知道一共几格（arrayLength）：内容不用
@group(0) @binding(${textures.length + 1}) var<storage, read> previewTiles: array<u32>;

@fragment fn fs(in: PreviewVaryings) -> @location(0) vec4f {
${uvPlaneStreams('in.uv')}
${lines.join('\n')}
  var shown = vec3f(0.0);
  switch in.tile {
${cases.join('\n')}
    default: {}
  }
  return vec4f(shown, 1.0);
}
`;
  return { code, nodes, textures };
}

/** MaterialGraphPreviewer 的选项 */
export interface MaterialGraphPreviewerOptions {
  /** 加载贴图节点用的图（内容路径）；没有或加载不了时是 undefined，那一格显示品红 */
  readonly loadImage?: (path: string) => Promise<ImageBitmap | undefined>;
  /** 一格的边长（像素），默认 64 */
  readonly size?: number;
}

/**
 * 在一个 GPU 设备上画节点图的预览：管线按代码缓存（留最近几个），贴图按路径缓存。同一张图重画约 2 毫秒；参数直接写进着色器，
 * 改了参数要重新编管线，约 120～150 毫秒（这台机器，campsite 的石头材质），编辑器里合并连着的修改再画。
 */
export class MaterialGraphPreviewer {
  readonly #device: GPUDevice;
  readonly #options: MaterialGraphPreviewerOptions;
  readonly #pipelines = new Map<string, { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout }>();
  readonly #textures = new Map<string, Promise<GPUTexture>>();
  /** 烘好的滤镜（按上游的内容）：每次只留这一次用到的 */
  #baked = new Map<string, GPUTexture>();
  readonly #sampler: GPUSampler;

  constructor(device: GPUDevice, options: MaterialGraphPreviewerOptions = {}) {
    this.#device = device;
    this.#options = options;
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  }

  /** 画所有节点的预览：节点 id → 一格的图。节点图有错时抛错。 */
  async render(graph: GraphFile, where = 'material graph'): Promise<Map<string, ImageData>> {
    const shader = materialGraphPreviewShader(graph, where);
    const result = new Map<string, ImageData>();
    if (shader.nodes.length === 0) return result;
    const size = this.#options.size ?? MATERIAL_PREVIEW_SIZE;
    const device = this.#device;
    const { pipeline, layout } = await this.#pipeline(shader.code, shader.textures.length);
    const textures = shader.textures.map(await this.#resolver(graph, where));
    const rows = Math.ceil(shader.nodes.length / COLUMNS);
    const width = COLUMNS * size, height = rows * size;
    const target = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const tiles = device.createBuffer({ size: shader.nodes.length * 4, usage: GPUBufferUsage.STORAGE });
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const bindGroup = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: this.#sampler },
          ...textures.map((texture, i) => ({ binding: i + 1, resource: texture.createView() })),
          { binding: textures.length + 1, resource: { buffer: tiles } },
        ],
      });
      const encoder = device.createCommandEncoder({ label: 'material graph preview' });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(4, shader.nodes.length);
      pass.end();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      shader.nodes.forEach((id, tile) => {
        const image = new ImageData(size, size);
        const x0 = (tile % COLUMNS) * size, y0 = Math.floor(tile / COLUMNS) * size;
        for (let y = 0; y < size; y++) {
          const from = (y0 + y) * bytesPerRow + x0 * 4;
          image.data.set(bytes.subarray(from, from + size * 4), y * size * 4);
        }
        result.set(id, image);
      });
      readback.unmap();
    } finally {
      target.destroy();
      tiles.destroy();
      readback.destroy();
    }
    return result;
  }

  /** 不再用了：贴图、管线放掉 */
  destroy(): void {
    for (const texture of this.#textures.values()) void texture.then((t) => t.destroy());
    for (const texture of this.#baked.values()) texture.destroy();
    this.#textures.clear();
    this.#baked.clear();
    this.#pipelines.clear();
  }

  /**
   * 按 sample 的 key 找 GPU 贴图：贴图资源先都加载好，滤镜节点按依赖烘（同样的上游烘过就直接用）。上一次烘的、这次没用到的放掉。
   */
  async #resolver(graph: GraphFile, where: string): Promise<(key: string) => GPUTexture> {
    const images = new Map(await Promise.all(materialGraphTextures(graph).map(async (path) => [path, await this.#texture(path)] as const)));
    const filters = new Map(bakedMaterialGraphNodes(graph).map((node) => [bakedTextureKey(node), node]));
    const previous = this.#baked;
    const baked = new Map<string, GPUTexture>();
    const resolve = (key: string): GPUTexture => {
      const node = filters.get(key);
      if (node === undefined) return images.get(key)!;
      const content = upstreamKey(graph, node);
      let texture = baked.get(content) ?? previous.get(content);
      if (!texture) texture = MaterialGraphBaker.for(this.#device).bake(graph, node, resolve, where);
      baked.set(content, texture);
      return texture;
    };
    for (const key of filters.keys()) resolve(key);
    for (const [content, texture] of previous) if (!baked.has(content)) texture.destroy();
    this.#baked = baked;
    return resolve;
  }

  /**
   * 管线按代码缓存。绑定布局按贴图数写明（不用 'auto'：没有贴图节点时采样器用不到，自动推导的布局里就没有它，绑定组对不上）。
   */
  async #pipeline(code: string, textureCount: number): Promise<{ readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout }> {
    const cached = this.#pipelines.get(code);
    if (cached) {
      // 挪到最后：最近用过的留着
      this.#pipelines.delete(code);
      this.#pipelines.set(code, cached);
      return cached;
    }
    const device = this.#device;
    const layout = device.createBindGroupLayout({
      label: 'material graph preview',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ...Array.from({ length: textureCount }, (_, i) => ({ binding: i + 1, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
        { binding: textureCount + 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' as const } },
      ],
    });
    const module = device.createShaderModule({ label: 'material graph preview', code });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'material graph preview',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-strip' },
    });
    const entry = { pipeline, layout };
    this.#pipelines.set(code, entry);
    if (this.#pipelines.size > PIPELINE_CACHE) this.#pipelines.delete(this.#pipelines.keys().next().value!);
    return entry;
  }

  #texture(path: string): Promise<GPUTexture> {
    let texture = this.#textures.get(path);
    if (!texture) {
      texture = (async () => {
        const image = await this.#options.loadImage?.(path).catch(() => undefined);
        const device = this.#device;
        if (!image) {
          // 品红一个像素：没有这张图
          const missing = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
          device.queue.writeTexture({ texture: missing }, new Uint8Array([255, 0, 255, 255]), {}, [1, 1]);
          return missing;
        }
        const loaded = device.createTexture({ size: [image.width, image.height], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        device.queue.copyExternalImageToTexture({ source: image }, { texture: loaded }, [image.width, image.height]);
        return loaded;
      })();
      this.#textures.set(path, texture);
    }
    return texture;
  }
}

/** 一个节点连同它所有上游的内容（id、种类、参数、连线）：一样就是同一张烘出来的图。 */
function upstreamKey(graph: GraphFile, node: string): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Map<string, GraphNodeFile>();
  const visit = (id: string) => {
    const found = byId.get(id);
    if (!found || seen.has(id)) return;
    seen.set(id, found);
    for (const link of Object.values(found.inputs ?? {})) visit(link.node);
  };
  visit(node);
  return JSON.stringify([node, [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, type, params, inputs }) => [id, type, params, inputs])]);
}
