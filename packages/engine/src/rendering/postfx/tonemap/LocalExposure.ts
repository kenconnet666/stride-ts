/**
 * 局部曝光（照 UE5 的 Local Exposure）的网格：每帧从 HDR 画面建双边网格和大半径的亮度模糊（见下面的着色器），ToneMap 映射时按
 * 像素自己的亮度在网格里取局部的底（ToneMap.ts 的 localExposure）。
 */
import { GpuProfiler } from '../../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../../graphics/shaderModule';
import { isGraphTexture, type EffectFrame, type Image } from '../ImageEffect';

/** 局部曝光的网格：一格管 32×32 个像素，对数亮度分 16 层。 */
export const LOCAL_CELL = 32;
export const LOCAL_SLICES = 16;
/** 双边网格的模糊半径（格）和大半径的亮度模糊的半径（格）。 */
const LOCAL_GRID_RADIUS = 2;
const LOCAL_WIDE_RADIUS = 8;

/**
 * 局部曝光（照 UE5 的 Local Exposure）的网格：grid 每个工作组管一格，把格子里的像素（隔一个取一个）按对数亮度分进 16 层，
 * 每层存（平均亮度 × 权重，权重），权重是这一层的像素占这一格的比例，各层加起来的那一列另存一张二维的图；blur 在网格上按高斯
 * 模糊（xy 5×5、层 3，一个线程一格一层），wide 把各列按大半径模糊（不分亮度的"大致多亮"）。亮度存成范围里的 0..1
 * （histogramRange）。
 */
const LOCAL_GRID_SHADER = /* wgsl */ `
struct Range { minLog: f32, logRange: f32 };
@group(0) @binding(0) var<uniform> range: Range;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var grid: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var columns: texture_storage_2d<rgba16float, write>;

var<workgroup> sums: array<atomic<u32>, ${LOCAL_SLICES}>;
var<workgroup> counts: array<atomic<u32>, ${LOCAL_SLICES}>;

@compute @workgroup_size(16, 16)
fn gridMain(@builtin(workgroup_id) cell: vec3u, @builtin(local_invocation_id) local: vec3u, @builtin(local_invocation_index) index: u32) {
  if (index < ${LOCAL_SLICES}u) { atomicStore(&sums[index], 0u); atomicStore(&counts[index], 0u); }
  workgroupBarrier();
  let pixel = cell.xy * ${LOCAL_CELL}u + local.xy * 2u;
  if (all(pixel < textureDimensions(hdr))) {
    let luminance = max(dot(textureLoad(hdr, pixel, 0).rgb, vec3f(0.2126, 0.7152, 0.0722)), 1e-8);
    let t = saturate((log2(luminance) - range.minLog) / range.logRange);
    let slice = min(u32(t * ${LOCAL_SLICES}.0), ${LOCAL_SLICES - 1}u);
    atomicAdd(&sums[slice], u32(t * 65535.0 + 0.5));
    atomicAdd(&counts[slice], 1u);
  }
  workgroupBarrier();
  if (index < ${LOCAL_SLICES}u) {
    let count = f32(atomicLoad(&counts[index]));
    let mean = select(0.0, f32(atomicLoad(&sums[index])) / 65535.0 / count, count > 0.0);
    let weight = count / 256.0;
    textureStore(grid, vec3u(cell.xy, index), vec4f(mean * weight, weight, 0.0, 0.0));
  }
  if (index == 0u) {
    var column = vec2f(0.0);
    for (var i = 0u; i < ${LOCAL_SLICES}u; i++) {
      column += vec2f(f32(atomicLoad(&sums[i])) / 65535.0, f32(atomicLoad(&counts[i]))) / 256.0;
    }
    textureStore(columns, cell.xy, vec4f(column, 0.0, 0.0));
  }
}`;

const LOCAL_BLUR_SHADER = /* wgsl */ `
@group(0) @binding(0) var grid: texture_3d<f32>;
@group(0) @binding(1) var blurred: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var columns: texture_2d<f32>;
@group(0) @binding(3) var wide: texture_storage_2d<rgba16float, write>;

fn gaussian(d: f32, radius: f32) -> f32 {
  let sigma = radius * 0.5 + 0.5;
  return exp(-d * d / (2.0 * sigma * sigma));
}

@compute @workgroup_size(4, 4, 4)
fn blurMain(@builtin(global_invocation_id) id: vec3u) {
  let size = vec3i(textureDimensions(grid));
  let cell = vec3i(id);
  if (any(cell >= size)) { return; }
  var sum = vec2f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = cell.z + dz;
    if (z < 0 || z >= size.z) { continue; }
    for (var dy = -${LOCAL_GRID_RADIUS}; dy <= ${LOCAL_GRID_RADIUS}; dy++) {
      for (var dx = -${LOCAL_GRID_RADIUS}; dx <= ${LOCAL_GRID_RADIUS}; dx++) {
        let p = clamp(cell.xy + vec2i(dx, dy), vec2i(0), size.xy - 1);
        let w = gaussian(length(vec2f(f32(dx), f32(dy))), ${LOCAL_GRID_RADIUS}.0) * gaussian(f32(dz), 1.0);
        sum += textureLoad(grid, vec3i(p, z), 0).xy * w;
      }
    }
  }
  textureStore(blurred, cell, vec4f(sum, 0.0, 0.0));
}

@compute @workgroup_size(8, 8)
fn wideMain(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(columns));
  let center = vec2i(id.xy);
  if (any(center >= size)) { return; }
  var total = vec2f(0.0);
  for (var dy = -${LOCAL_WIDE_RADIUS}; dy <= ${LOCAL_WIDE_RADIUS}; dy++) {
    for (var dx = -${LOCAL_WIDE_RADIUS}; dx <= ${LOCAL_WIDE_RADIUS}; dx++) {
      let p = center + vec2i(dx, dy);
      if (any(p < vec2i(0)) || any(p >= size)) { continue; }
      total += textureLoad(columns, p, 0).xy * gaussian(length(vec2f(f32(dx), f32(dy))), ${LOCAL_WIDE_RADIUS}.0);
    }
  }
  textureStore(wide, center, vec4f(total, 0.0, 0.0));
}`;

/** 映射时绑的：模糊过的三维网格、大半径模糊的二维图。 */
export interface LocalExposureBinding {
  readonly grid: GPUTexture;
  readonly wide: GPUTexture;
}

/** 跟着画面尺寸的网格：原始的、模糊过的（三维），各列加起来的、大半径模糊的（二维）。 */
interface GridTextures {
  readonly width: number;
  readonly height: number;
  readonly grid: GPUTexture;
  readonly blurred: GPUTexture;
  readonly columns: GPUTexture;
  readonly wide: GPUTexture;
}

interface Pipelines {
  readonly grid: GPUComputePipeline;
  readonly blur: GPUComputePipeline;
  readonly wide: GPUComputePipeline;
}

export class LocalExposure {
  readonly #device: GPUDevice;
  #pipelines: Pipelines | Promise<void> | undefined;
  #textures: GridTextures | undefined;
  #uniform: GPUBuffer | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 管线编好了没有：第一次问时在后台开始编，编好以前返回 false（这几帧不做局部曝光）。 */
  ready(): boolean {
    const state = this.#pipelines;
    if (state && !(state instanceof Promise)) return true;
    if (!state) {
      const create = (label: string, code: string, entryPoint: string) => this.#device.createComputePipelineAsync({
        label, layout: 'auto', compute: { module: createCheckedShaderModule(this.#device, label, code), entryPoint },
      });
      this.#pipelines = Promise.all([
        create('ToneMap local grid', LOCAL_GRID_SHADER, 'gridMain'),
        create('ToneMap local blur', LOCAL_BLUR_SHADER, 'blurMain'),
        create('ToneMap local wide', LOCAL_BLUR_SHADER, 'wideMain'),
      ]).then(
        ([grid, blur, wide]) => { this.#pipelines = { grid, blur, wide }; },
        (error: unknown) => console.warn('ToneMap local exposure: building the pipelines failed', error),
      );
    }
    return false;
  }

  /** 从 input 建这一帧的网格（对数亮度范围 [minLog, maxLog]），返回映射时要绑的。要先 ready()。 */
  record(frame: EffectFrame, input: Image, minLog: number, maxLog: number): LocalExposureBinding {
    const pipelines = this.#pipelines;
    if (!pipelines || pipelines instanceof Promise) throw new Error('LocalExposure.record: the pipelines are not ready (call ready() first)');
    const device = this.#device;
    const textures = this.#texturesFor(input.width, input.height);
    const uniform = this.#uniform ??= device.createBuffer({ label: 'ToneMap local exposure', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([minLog, Math.max(maxLog - minLog, 1e-3), 0, 0]));
    frame.pass('ToneMap local exposure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const texture = isGraphTexture(input) ? real.texture(input) : input;
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('ToneMap local exposure');
      const pass = frame.encoder.beginComputePass({ label: 'ToneMap local exposure', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipelines.grid);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.grid.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: textures.grid.createView() },
          { binding: 3, resource: textures.columns.createView() },
        ],
      }));
      const { width, height } = textures.grid;
      pass.dispatchWorkgroups(width, height);
      pass.setPipeline(pipelines.blur);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.blur.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: textures.grid.createView() }, { binding: 1, resource: textures.blurred.createView() }],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 4), Math.ceil(height / 4), LOCAL_SLICES / 4);
      pass.setPipeline(pipelines.wide);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.wide.getBindGroupLayout(0),
        entries: [{ binding: 2, resource: textures.columns.createView() }, { binding: 3, resource: textures.wide.createView() }],
      }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    });
    return { grid: textures.blurred, wide: textures.wide };
  }

  destroy(): void {
    this.#destroyTextures();
    this.#uniform?.destroy();
  }

  #destroyTextures(): void {
    const t = this.#textures;
    if (t) for (const texture of [t.grid, t.blurred, t.columns, t.wide]) texture.destroy();
  }

  #texturesFor(width: number, height: number): GridTextures {
    if (this.#textures?.width === width && this.#textures.height === height) return this.#textures;
    this.#destroyTextures();
    const columns = Math.ceil(width / LOCAL_CELL), rows = Math.ceil(height / LOCAL_CELL);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const grid = (label: string) => this.#device.createTexture({ label, size: [columns, rows, LOCAL_SLICES], dimension: '3d', format: 'rgba16float', usage });
    const flat = (label: string) => this.#device.createTexture({ label, size: [columns, rows], format: 'rgba16float', usage });
    return (this.#textures = {
      width, height,
      grid: grid('ToneMap local grid'), blurred: grid('ToneMap local grid blurred'),
      columns: flat('ToneMap local columns'), wide: flat('ToneMap local wide'),
    });
  }
}
