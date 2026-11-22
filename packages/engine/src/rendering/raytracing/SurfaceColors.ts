/**
 * 光追打到的表面是什么颜色（RayTracingScene 的 rtAlbedo、rtEmissive；路线图 R2）：WebGPU 没有无绑定的贴图，计算着色器里取不到
 * 每个材质的贴图、颜色树、节点图，所以把每个批（网格加材质）的平均漫反射色和自发光先烘出来：
 * - 每个批分一格（TILE 像素见方），批的第一个实例用网格着色器自己的材质代码（fsSurfaceBake：贴图、颜色树、材质层、节点图都算）
 *   按纹理坐标铺满那一格（vsSurfaceBake，纹理坐标按网格的范围归一），画进两张图集（漫反射色、自发光）；
 * - 一个计算着色器把每格盖到的像素求平均，写进 colors（每格两个 vec4：漫反射色和"有没有"、自发光）。没盖到像素的格（没有纹理
 *   坐标的网格）a 是 0，光追退回材质的颜色。
 * 批或者材质变了（版本号）才重烘，一次烘全部（几千个小三角形批，一两次绘制的量）。按纹理坐标平均不按表面积，铺得密的地方占得多：
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

/** 光追场景用的表面颜色（RayTracingScene 持有）：assign 分格，draw 在要重烘的帧烘、求平均。 */
export class SurfaceColors {
  readonly #device: GPUDevice;
  readonly #tiles = new Map<MeshBatch, number>();
  readonly #free: number[] = [];
  #used = 0;
  #capacity = 0;
  #albedo: GPUTexture | undefined;
  #emissive: GPUTexture | undefined;
  #colors: GPUBuffer;
  readonly #params: GPUBuffer;
  #reduce: GPUComputePipeline | undefined;
  #key = '';
  #pending = false;
  /** 烘焙的阶段：漫反射色和自发光两个目标。 */
  readonly stage = new RenderStage('SurfaceBake', { colorFormat: FORMAT, depthFormat: 'depth24plus', surfaceFormats: [FORMAT] }, { surfaceBake: true });

  constructor(device: GPUDevice) {
    this.#device = device;
    this.#colors = this.#createColors(1);
    this.#params = device.createBuffer({ label: 'SurfaceColors params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** 每格两个 vec4f（漫反射色和有没有、自发光）；格数变多时换新的（光追场景的绑定组跟着换）。 */
  get buffer(): GPUBuffer {
    return this.#colors;
  }

  /** 这一帧要重烘。 */
  get pending(): boolean {
    return this.#pending;
  }

  /** 这一帧光追的批：给新的批分格（批在的时候格不变）、去掉没了的；批或材质变了要重烘。 */
  assign(batches: readonly MeshBatch[]): void {
    const live = new Set(batches);
    for (const [batch, tile] of this.#tiles) {
      if (live.has(batch)) continue;
      this.#tiles.delete(batch);
      this.#free.push(tile);
    }
    for (const batch of batches) {
      if (this.#tiles.has(batch)) continue;
      this.#tiles.set(batch, this.#free.pop() ?? this.#used++);
    }
    if (this.#used > this.#capacity) this.#grow(this.#used);
    const key = batches.map((batch) => `${batch.mesh.id}:${batch.material.id}:${batch.material.version}:${this.#tiles.get(batch)}`).join(',');
    if (key !== this.#key) {
      this.#key = key;
      this.#pending = batches.length > 0;
    }
  }

  /** 批的格号（assign 过的）；没有时 undefined。 */
  tileOf(batch: MeshBatch): number | undefined {
    return this.#tiles.get(batch);
  }

  /** 要重烘时：画进图集、求平均（录进 encoder）。view 是这一帧写过常量的视图。 */
  draw(encoder: GPUCommandEncoder, view: RenderView, meshes: MeshRenderFeature): void {
    if (!this.#pending || !this.#albedo || !this.#emissive) return;
    this.#pending = false;
    const perRow = this.#perRow();
    const tiles = [...this.#tiles].map(([batch, tile]) => ({ batch, x: (tile % perRow) * TILE, y: Math.floor(tile / perRow) * TILE, size: TILE }));
    const pass = encoder.beginRenderPass({
      label: 'SurfaceBake',
      colorAttachments: [this.#albedo, this.#emissive].map((texture) => ({ view: texture.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' })),
    });
    meshes.bakeSurfaces(pass, view, this.stage, tiles);
    pass.end();
    const device = this.#device;
    this.#reduce ??= device.createComputePipeline({ label: 'SurfaceColors reduce', layout: 'auto', compute: { module: createCheckedShaderModule(device, 'SurfaceColors reduce', REDUCE_SHADER), entryPoint: 'reduce' } });
    device.queue.writeBuffer(this.#params, 0, new Uint32Array([this.#used, perRow, 0, 0]));
    const compute = encoder.beginComputePass({ label: 'SurfaceColors reduce' });
    compute.setPipeline(this.#reduce);
    compute.setBindGroup(0, device.createBindGroup({
      layout: this.#reduce.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.#albedo.createView() },
        { binding: 1, resource: this.#emissive.createView() },
        { binding: 2, resource: { buffer: this.#colors } },
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
    this.#colors.destroy();
    this.#colors = this.#createColors(this.#capacity);
    this.#key = '';
  }

  #createColors(tiles: number): GPUBuffer {
    return this.#device.createBuffer({ label: 'SurfaceColors colors', size: tiles * 32, usage: GPUBufferUsage.STORAGE });
  }

  destroy(): void {
    this.#albedo?.destroy();
    this.#emissive?.destroy();
    this.#colors.destroy();
    this.#params.destroy();
  }
}
