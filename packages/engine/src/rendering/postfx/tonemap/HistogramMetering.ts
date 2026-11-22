/**
 * 按亮度直方图测光（ToneMap 的 metering = 'histogram'），见下面 HISTOGRAM_SHADER 的说明。结果写进 ToneMap 的适应亮度（和平均测光
 * 同一张 1x1），映射那一步不分两种测光。
 */
import { GpuProfiler } from '../../../graphics/GpuProfiler';
import { createCheckedShaderModule } from '../../../graphics/shaderModule';
import { isGraphTexture, type EffectFrame, type Image } from '../ImageEffect';

/** 直方图的格数：第 0 格是比范围暗的，其余按对数亮度均分范围。 */
const HISTOGRAM_BINS = 128;

/**
 * 按亮度直方图测光（metering = 'histogram'，照 Bevy 的 auto_exposure）：histogram 每个工作组在共享内存里数自己 32×32 个像素（隔一个取一个）
 * 落在哪一格（对数亮度），再加进全局的格子；average 去掉最暗、最亮的一部分（filter）求对数亮度的平均，按每秒几档的速度
 * 往它适应（变亮快、变暗慢，离得近时按指数慢下来），写进适应亮度（和平均测光同一张 1x1，映射那一步不用分），顺手清空格子。
 */
const HISTOGRAM_SHADER = /* wgsl */ `
struct Metering { minLog: f32, logRange: f32, low: f32, high: f32, speedBrighten: f32, speedDarken: f32, transition: f32, elapsed: f32, reset: f32 };
@group(0) @binding(0) var<uniform> metering: Metering;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> histogram: array<atomic<u32>, ${HISTOGRAM_BINS}>;
@group(0) @binding(3) var previous: texture_2d<f32>;
@group(0) @binding(4) var adapted: texture_storage_2d<r32float, write>;

var<workgroup> bins: array<atomic<u32>, ${HISTOGRAM_BINS}>;

fn binOf(color: vec3f) -> u32 {
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  if (!(luminance > exp2(metering.minLog))) { return 0u; }
  let t = saturate((log2(luminance) - metering.minLog) / metering.logRange);
  return 1u + min(u32(t * ${HISTOGRAM_BINS - 1}.0), ${HISTOGRAM_BINS - 2}u);
}

@compute @workgroup_size(16, 16)
fn histogramMain(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) index: u32) {
  if (index < ${HISTOGRAM_BINS}u) { atomicStore(&bins[index], 0u); }
  workgroupBarrier();
  // 每 2×2 个像素数一个：直方图是统计量，数四分之一的像素分布一样，4K 下省四分之三
  let pixel = id.xy * 2u;
  if (all(pixel < textureDimensions(hdr))) { atomicAdd(&bins[binOf(textureLoad(hdr, pixel, 0).rgb)], 1u); }
  workgroupBarrier();
  if (index < ${HISTOGRAM_BINS}u) {
    let count = atomicLoad(&bins[index]);
    if (count > 0u) { atomicAdd(&histogram[index], count); }
  }
}

/** 第 i 格的对数亮度（格子中间；第 0 格算范围的下限）。 */
fn binLog(i: u32) -> f32 {
  if (i == 0u) { return metering.minLog; }
  return metering.minLog + (f32(i) - 0.5) / ${HISTOGRAM_BINS - 1}.0 * metering.logRange;
}

@compute @workgroup_size(1)
fn averageMain() {
  var total = 0u;
  var cumulative: array<u32, ${HISTOGRAM_BINS}>;
  for (var i = 0u; i < ${HISTOGRAM_BINS}u; i++) {
    total += atomicLoad(&histogram[i]);
    cumulative[i] = total;
    atomicStore(&histogram[i], 0u);
  }
  // 累积的个数夹在 [first, last] 里：最暗的 low、最亮的 1 - high 那部分不算
  let first = u32(f32(total) * metering.low);
  let last = u32(f32(total) * metering.high);
  var counted = 0u;
  var sum = 0.0;
  var before = first;
  for (var i = 0u; i < ${HISTOGRAM_BINS}u; i++) {
    let upTo = clamp(cumulative[i], first, last);
    sum += f32(upTo - before) * binLog(i);
    counted += upTo - before;
    before = upTo;
  }
  let goal = select(metering.minLog, sum / f32(counted), counted > 0u);
  var current = log2(max(textureLoad(previous, vec2u(0u), 0).r, 1e-6));
  if (metering.reset > 0.5) {
    current = goal;
  } else {
    // 画面变亮（goal 大）按 speedBrighten，变暗按 speedDarken（档/秒）；离目标不到 transition 档时按指数慢下来
    let delta = goal - current;
    let speed = select(metering.speedDarken, metering.speedBrighten, delta > 0.0) * metering.elapsed;
    current += sign(delta) * min(speed, abs(delta) * speed / metering.transition);
  }
  textureStore(adapted, vec2u(0u), vec4f(exp2(current), 0.0, 0.0, 1.0));
}`;

/** 一帧的设置：对数亮度范围、参加平均的那一段、适应速度（档/秒）、这一帧的秒数、要不要直接跳到目标。 */
export interface MeteringSettings {
  readonly range: readonly [min: number, max: number];
  readonly filter: readonly [low: number, high: number];
  readonly speedBrighten: number;
  readonly speedDarken: number;
  readonly elapsed: number;
  readonly reset: boolean;
}

export class HistogramMetering {
  readonly #device: GPUDevice;
  /** 格子和设置，第一次 record 时建。 */
  #buffers: { readonly bins: GPUBuffer; readonly uniform: GPUBuffer } | undefined;
  #pipelines: { readonly histogram: GPUComputePipeline; readonly average: GPUComputePipeline } | Promise<void> | undefined;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  /** 管线编好了没有：第一次问时在后台开始编，编好以前返回 false（这几帧照平均测光量，不卡帧）。 */
  ready(): boolean {
    const state = this.#pipelines;
    if (state && !(state instanceof Promise)) return true;
    if (!state) {
      const module = createCheckedShaderModule(this.#device, 'ToneMap histogram', HISTOGRAM_SHADER);
      const create = (entryPoint: string) => this.#device.createComputePipelineAsync({ label: `ToneMap ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
      // 编不出来时留着这个 Promise，不再重试（错误在着色器模块的编译信息里报过了）
      this.#pipelines = Promise.all([create('histogramMain'), create('averageMain')]).then(
        ([histogram, average]) => { this.#pipelines = { histogram, average }; },
        (error: unknown) => console.warn('ToneMap histogram: building the pipelines failed', error),
      );
    }
    return false;
  }

  /** 数 input 的格子、按格子求平均并适应：读 previous（上一帧的适应亮度），写 next。要先 ready()。 */
  record(frame: EffectFrame, input: Image, previous: GPUTexture, next: GPUTexture, settings: MeteringSettings): void {
    const pipelines = this.#pipelines;
    if (!pipelines || pipelines instanceof Promise) throw new Error('HistogramMetering.record: the pipelines are not ready (call ready() first)');
    const device = this.#device;
    const { bins, uniform } = this.#buffers ??= {
      bins: device.createBuffer({ label: 'ToneMap histogram', size: HISTOGRAM_BINS * 4, usage: GPUBufferUsage.STORAGE }),
      uniform: device.createBuffer({ label: 'ToneMap metering', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    };
    const [min, max] = settings.range;
    // 离目标 1.5 档以内按指数慢下来（Bevy 的 exponential_transition_distance）
    device.queue.writeBuffer(uniform, 0, new Float32Array([
      min, Math.max(max - min, 1e-3), ...settings.filter, settings.speedBrighten, settings.speedDarken, 1.5, settings.elapsed, settings.reset ? 1 : 0,
    ]));
    // 写的是留到下一帧的适应亮度，渲染图看不见：算副作用
    frame.pass('ToneMap measure', (pass) => {
      if (isGraphTexture(input)) pass.read(input);
      pass.sideEffect();
    }, (real) => {
      const texture = isGraphTexture(input) ? real.texture(input) : input;
      const timestampWrites = GpuProfiler.of(device)?.passTimestamps('ToneMap histogram');
      const pass = frame.encoder.beginComputePass({ label: 'ToneMap histogram', ...(timestampWrites ? { timestampWrites } : {}) });
      pass.setPipeline(pipelines.histogram);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.histogram.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: texture.createView() }, { binding: 2, resource: { buffer: bins } }],
      }));
      pass.dispatchWorkgroups(Math.ceil(texture.width / 32), Math.ceil(texture.height / 32));
      pass.setPipeline(pipelines.average);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipelines.average.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 2, resource: { buffer: bins } },
          { binding: 3, resource: previous.createView() },
          { binding: 4, resource: next.createView() },
        ],
      }));
      pass.dispatchWorkgroups(1);
      pass.end();
    });
  }

  destroy(): void {
    this.#buffers?.bins.destroy();
    this.#buffers?.uniform.destroy();
  }
}
