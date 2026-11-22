/**
 * 光追打到的表面是什么颜色（RayTracingScene 的 rtAlbedo、rtEmissive；路线图 R2）：WebGPU 没有无绑定的贴图，计算着色器里取不到
 * 每个材质的贴图、颜色树、节点图，所以把每个批（网格加材质）的平均漫反射色和自发光先烘出来：
 * - 每个表面分一格（TILE 像素见方）：普通的批一个表面（画第一个实例），地形块每块一个（同一个材质按坡度、高度混出来的颜色每块
 *   不一样）。用网格着色器自己的材质代码（fsSurfaceBake：贴图、颜色树、材质层、节点图都算）按纹理坐标铺满那一格（vsSurfaceBake，
 *   纹理坐标按网格的范围归一；地形块按格坐标），画进两张图集（漫反射色、自发光）；
 * - 一个计算着色器把每格盖到的像素求平均，写进 colors（每格两个 vec4：漫反射色和"有没有"、自发光）。没盖到像素的格（没有纹理
 *   坐标的网格）a 是 0，光追退回材质的颜色。
 * 表面或者材质变了（版本号）才重烘，一次烘全部（几千次小绘制）。按纹理坐标平均不按表面积，铺得密的地方占得多：
 * 给间接光用够了。
 */
import { RenderStage, type RenderView } from '../RenderSystem';
import type { MeshBatch, MeshRenderFeature } from '../mesh/MeshRenderFeature';
import { createCheckedShaderModule } from '../../graphics/shaderModule';

/** 一格多少像素见方。 */
const TILE = 16;
const FORMAT: GPUTextureFormat = 'rgba16float';

const REDUCE_SHADER = /* wgsl */ `
@group(0) @binding(0) var albedo: texture_2d<f32>;
@group(0) @binding(1) var emissive: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> colors: array<vec4f>;
// 格数、一行几格
@group(0) @binding(3) var<uniform> params: vec4u;

@compute @workgroup_size(64) fn reduce(@builtin(global_invocation_id) id: vec3u) {
  let tile = id.x;
  if (tile >= params.x) { return; }
  let origin = vec2u(tile % params.y, tile / params.y) * ${TILE}u;
  var a = vec3f(0.0);
  var e = vec3f(0.0);
  var covered = 0.0;
  for (var y = 0u; y < ${TILE}u; y++) {
    for (var x = 0u; x < ${TILE}u; x++) {
      let c = textureLoad(albedo, origin + vec2u(x, y), 0);
      if (c.a > 0.5) {
        a += c.rgb;
        e += textureLoad(emissive, origin + vec2u(x, y), 0).rgb;
        covered += 1.0;
      }
    }
  }
  let n = max(covered, 1.0);
  colors[tile * 2u] = vec4f(a / n, select(0.0, 1.0, covered > 0.0));
  colors[tile * 2u + 1u] = vec4f(e / n, 0.0);
}
`;

/** 一个要烘的表面：key 认它（普通的批是批本身，地形块是页和版本），画 batch 的 slot 那个实例。 */
export interface SurfaceItem {
  readonly key: object | string;
  readonly batch: MeshBatch;
  readonly slot: number;
}

/** 光追场景用的表面颜色（RayTracingScene 持有）：assign 分格，draw 在要重烘的帧烘、求平均。 */
export class SurfaceColors {
  readonly #device: GPUDevice;
  readonly #tiles = new Map<object | string, { tile: number; item: SurfaceItem }>();
  readonly #free: number[] = [];
  #used = 0;
  #capacity = 0;
  #albedo: GPUTexture | undefined;
  #emissive: GPUTexture | undefined;
  #colors: GPUBuffer | undefined;
  #params: GPUBuffer | undefined;
  #reduce: GPUComputePipeline | undefined;
  #key = '';
  #pending = false;
  /** 第几次换了表面：后台编好管线回来时只认最新的那次。 */
  #warming = 0;
  /** 烘焙的阶段：漫反射色和自发光两个目标。 */
  readonly stage = new RenderStage('SurfaceBake', { colorFormat: FORMAT, depthFormat: 'depth24plus', surfaceFormats: [FORMAT] }, { surfaceBake: true });

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 每格两个 vec4f（漫反射色和有没有、自发光）；格数变多时换新的（光追场景的绑定组跟着换）。第一次用到光追时才建。 */
  get buffer(): GPUBuffer {
    return (this.#colors ??= this.#createColors(Math.max(this.#capacity, 1)));
  }

  /** 这一帧要重烘。 */
  get pending(): boolean {
    return this.#pending;
  }

  /**
   * 这一帧光追的表面：给新的分格（在的时候格不变）、去掉没了的；表面或材质变了要重烘。烘的管线先在后台编（meshes.warm），编好了才
   * pending（不在帧里同步编管线，不卡顿）。
   */
  assign(items: readonly SurfaceItem[], meshes: MeshRenderFeature): void {
    const live = new Set(items.map((item) => item.key));
    for (const [key, { tile }] of this.#tiles) {
      if (live.has(key)) continue;
      this.#tiles.delete(key);
      this.#free.push(tile);
    }
    for (const item of items) {
      const entry = this.#tiles.get(item.key);
      if (entry) entry.item = item;
      else this.#tiles.set(item.key, { tile: this.#free.pop() ?? this.#used++, item });
    }
    if (this.#used > this.#capacity) this.#grow(this.#used);
    const key = items.map(({ key, batch }) => `${typeof key === 'string' ? key : batch.mesh.id}:${batch.material.id}:${batch.material.version}:${this.#tiles.get(key)!.tile}`).join(',');
    if (key !== this.#key) {
      this.#key = key;
      this.#pending = false;
      if (items.length === 0) return;
      const token = ++this.#warming;
      const device = this.#device;
      const reduce = this.#reduce ? Promise.resolve(this.#reduce) : device.createComputePipelineAsync({ label: 'SurfaceColors reduce', layout: 'auto', compute: { module: createCheckedShaderModule(device, 'SurfaceColors reduce', REDUCE_SHADER), entryPoint: 'reduce' } });
      Promise.all([reduce, ...items.map(({ batch }) => meshes.warm(batch.mesh, batch.material, false, false, [this.stage]))]).then(([pipeline]) => {
        this.#reduce = pipeline;
        if (token === this.#warming) this.#pending = true;
      }, (error: unknown) => console.error('SurfaceColors: compiling the bake pipelines failed', error));
    }
  }

  /** 表面的格号（assign 过的）；没有时 undefined。 */
  tileOf(key: object | string): number | undefined {
    return this.#tiles.get(key)?.tile;
  }

  /** 要重烘时：画进图集、求平均（录进 encoder）。view 是这一帧写过常量的视图。 */
  draw(encoder: GPUCommandEncoder, view: RenderView, meshes: MeshRenderFeature): void {
    if (!this.#pending || !this.#albedo || !this.#emissive || !this.#reduce) return;
    this.#pending = false;
    const perRow = this.#perRow();
    const tiles = [...this.#tiles.values()].map(({ tile, item }) => ({ batch: item.batch, slot: item.slot, x: (tile % perRow) * TILE, y: Math.floor(tile / perRow) * TILE, size: TILE }));
    const pass = encoder.beginRenderPass({
      label: 'SurfaceBake',
      colorAttachments: [this.#albedo, this.#emissive].map((texture) => ({ view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' })),
    });
    meshes.bakeSurfaces(pass, view, this.stage, tiles);
    pass.end();
    const device = this.#device;
    this.#params ??= device.createBuffer({ label: 'SurfaceColors params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.#params, 0, new Uint32Array([this.#used, perRow, 0, 0]));
    const compute = encoder.beginComputePass({ label: 'SurfaceColors reduce' });
    compute.setPipeline(this.#reduce);
    compute.setBindGroup(0, device.createBindGroup({
      layout: this.#reduce.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#albedo.createView() },
        { binding: 1, resource: this.#emissive.createView() },
        { binding: 2, resource: { buffer: this.buffer } },
        { binding: 3, resource: { buffer: this.#params } },
      ],
    }));
    compute.dispatchWorkgroups(Math.ceil(this.#used / 64));
    compute.end();
  }

  #perRow(): number {
    return Math.ceil(Math.sqrt(this.#capacity));
  }

  /** 格数按 2 的幂长：图集、颜色表换新的，全部重烘。 */
  #grow(needed: number): void {
    this.#capacity = 2 ** Math.ceil(Math.log2(Math.max(needed, 64)));
    const side = this.#perRow() * TILE;
    this.#albedo?.destroy();
    this.#emissive?.destroy();
    const create = (label: string) => this.#device.createTexture({ label: `SurfaceColors ${label}`, size: [side, side], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.#albedo = create('albedo');
    this.#emissive = create('emissive');
    this.#colors?.destroy();
    this.#colors = this.#createColors(this.#capacity);
    this.#key = '';
  }

  #createColors(tiles: number): GPUBuffer {
    return this.#device.createBuffer({ label: 'SurfaceColors colors', size: tiles * 32, usage: GPUBufferUsage.STORAGE });
  }

  destroy(): void {
    this.#albedo?.destroy();
    this.#emissive?.destroy();
    this.#colors?.destroy();
    this.#params?.destroy();
  }
}
