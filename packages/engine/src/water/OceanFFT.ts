/**
 * FFT 的海浪（W6；Tessendorf 2001 "Simulating Ocean Water"，WickedEngine 的 ocean、Unity HDRP 的水同一套思路）：
 * - 三级级联：一块（平铺的单元）的边长是 patch、patch/6、patch/36，各 256 × 256 个格子；每级只留自己那一段波数（大块管长浪、小块
 *   管碎浪），合起来近处细、远处不重复。
 * - 初始频谱 h₀(k)：方向的 Phillips 谱、按种子的高斯随机数，在 CPU 上算一次（oceanSpectrum，设置变了才重算），浪高按方差归一到
 *   有效波高（4 倍均方根）。
 * - 每帧在 GPU 上：频谱 h(k, t) = h₀(k)·e^{iωt} + h₀*(−k)·e^{−iωt}（深水色散 ω = √(g·|k|)，按 LOOP 秒量化成整周期：时间取模
 *   以后相位还是精确的、不跳），同时得到水平位移、斜率和位移的导数；八个实数信号两两拼成一个复数（结果是实的，实部虚部各是一个），
 *   两张 rgba32float × 三级；逆 FFT 一行一个工作组，共享内存里 radix-2 的蝶形（先行后列）；收尾翻回中心化频谱的符号、乘尖度，写
 *   位移图（dx、dy、dz、∂dx/∂z）和导数图（∂y/∂x、∂y/∂z、∂dx/∂x、∂dz/∂z），再出 mip。
 * - 水面（water/Water.ts）按世界坐标平铺着取：顶点取位移，片元取斜率算法线、按雅可比（< 1 是浪尖挤在一起）起白沫。
 */

/** 一级多少个格子：256 × 256。 */
export const OCEAN_SIZE = 256;
/** 几级级联。 */
export const OCEAN_CASCADES = 3;
/** 相邻两级的边长比。 */
export const OCEAN_CASCADE_RATIO = 6;
/** 频谱的周期（秒）：角频率量化成 2π/LOOP 的整数倍，时间按它取模。 */
export const OCEAN_LOOP = 600;
const LOG_SIZE = 8;
const MIPS = LOG_SIZE + 1;
const GRAVITY = 9.81;
/** 下一级（更小的一块）从它自己的第几个谐波开始管。 */
const BAND_START = 6;

const SHADER = /* wgsl */ `
struct Params {
  // 时间（取模 LOOP 的秒）、尖度、0、0
  time: vec4f,
  // 各级一块的边长（米）
  tiles: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var h0: texture_2d_array<f32>;
@group(0) @binding(2) var outA: texture_storage_2d_array<rgba32float, write>;
@group(0) @binding(3) var outB: texture_storage_2d_array<rgba32float, write>;

const N = ${OCEAN_SIZE}u;
const PI = 3.14159265;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/** 两个结果是实数的频谱拼成一个：a + i·b。 */
fn pack(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x - b.y, a.y + b.x);
}

/** 这一刻的频谱：A = (dx + i·h, dz + i·∂dx/∂z)，B = (∂h/∂x + i·∂h/∂z, ∂dx/∂x + i·∂dz/∂z)。 */
@compute @workgroup_size(16, 16) fn spectrum(@builtin(global_invocation_id) id: vec3u) {
  let n = vec2f(id.xy) - f32(N) * 0.5;
  let k = 2.0 * PI * n / params.tiles[id.z];
  let kLength = max(length(k), 1e-6);
  // 量化成整周期：相位 = 2π · fract(周期数 · t / LOOP)
  let cycles = floor(sqrt(${GRAVITY} * kLength) * ${OCEAN_LOOP} / (2.0 * PI));
  let phase = 2.0 * PI * fract(cycles * params.time.x / ${OCEAN_LOOP});
  let e = vec2f(cos(phase), sin(phase));
  let s = textureLoad(h0, id.xy, id.z, 0);
  let h = cmul(s.xy, e) + cmul(s.zw, vec2f(e.x, -e.y));
  // −i·h = (h.y, −h.x)，i·h = (−h.y, h.x)
  let minusIH = vec2f(h.y, -h.x);
  let iH = vec2f(-h.y, h.x);
  let dx = minusIH * (k.x / kLength);
  let dz = minusIH * (k.y / kLength);
  let dxdz = h * (k.x * k.y / kLength);
  let dxdx = h * (k.x * k.x / kLength);
  let dzdz = h * (k.y * k.y / kLength);
  textureStore(outA, id.xy, id.z, vec4f(pack(dx, h), pack(dz, dxdz)));
  textureStore(outB, id.xy, id.z, vec4f(pack(iH * k.x, iH * k.y), pack(dxdx, dzdz)));
}

@group(0) @binding(4) var<uniform> direction: vec4u;
@group(0) @binding(5) var source: texture_2d_array<f32>;
@group(0) @binding(6) var destination: texture_storage_2d_array<rgba32float, write>;
var<workgroup> lines: array<array<vec4f, N>, 2>;

/** 两个复数（xy、zw）各乘 w。 */
fn twiddle(w: vec2f, b: vec4f) -> vec4f {
  return vec4f(cmul(w, b.xy), cmul(w, b.zw));
}

/** 一行（或一列）的逆 FFT：位反转着读进来，log₂N 级蝶形，写回去。工作组的 y 是第几级。 */
@compute @workgroup_size(${OCEAN_SIZE}) fn fft(@builtin(local_invocation_id) local: vec3u, @builtin(workgroup_id) group: vec3u) {
  let i = local.x;
  let at = select(vec2u(i, group.x), vec2u(group.x, i), direction.x == 1u);
  lines[0][reverseBits(i) >> (32u - ${LOG_SIZE}u)] = textureLoad(source, at, group.y, 0);
  workgroupBarrier();
  var ping = 0u;
  for (var stage = 1u; stage <= ${LOG_SIZE}u; stage++) {
    let size = 1u << stage;
    let half = size >> 1u;
    let k = i % size;
    let j = k % half;
    let start = i - k;
    let angle = 2.0 * PI * f32(j) / f32(size);
    let a = lines[ping][start + j];
    let wb = twiddle(vec2f(cos(angle), sin(angle)), lines[ping][start + j + half]);
    lines[1u - ping][i] = select(a + wb, a - wb, k >= half);
    workgroupBarrier();
    ping = 1u - ping;
  }
  textureStore(destination, at, group.y, lines[ping][i]);
}

@group(0) @binding(7) var resultA: texture_2d_array<f32>;
@group(0) @binding(8) var resultB: texture_2d_array<f32>;
@group(0) @binding(9) var displacement: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(10) var derivatives: texture_storage_2d_array<rgba16float, write>;

/** 收尾：翻回中心化的频谱的符号，水平位移和它的导数乘尖度。 */
@compute @workgroup_size(16, 16) fn finish(@builtin(global_invocation_id) id: vec3u) {
  let flip = select(1.0, -1.0, ((id.x + id.y) & 1u) == 1u);
  let a = textureLoad(resultA, id.xy, id.z, 0) * flip;
  let b = textureLoad(resultB, id.xy, id.z, 0) * flip;
  let chop = params.time.y;
  textureStore(displacement, id.xy, id.z, vec4f(a.x * chop, a.y, a.z * chop, a.w * chop));
  textureStore(derivatives, id.xy, id.z, vec4f(b.x, b.y, b.z * chop, b.w * chop));
}

@group(0) @binding(11) var finer: texture_2d_array<f32>;
@group(0) @binding(12) var coarser: texture_storage_2d_array<rgba16float, write>;

/** 下一级 mip：四个取平均（平铺的，不用管边）。 */
@compute @workgroup_size(8, 8) fn downsample(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(coarser);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let p = id.xy * 2u;
  let sum = textureLoad(finer, p, id.z, 0) + textureLoad(finer, p + vec2u(1u, 0u), id.z, 0)
    + textureLoad(finer, p + vec2u(0u, 1u), id.z, 0) + textureLoad(finer, p + vec2u(1u, 1u), id.z, 0);
  textureStore(coarser, id.xy, id.z, sum * 0.25);
}
`;

/** 海浪的参数：最大一块的边长（米）、风速（米每秒）、风向（弧度，世界的 xz）、有效波高（米）、尖度、种子。 */
export interface OceanSettings {
  readonly patch: number;
  readonly wind: number;
  readonly direction: number;
  readonly height: number;
  readonly choppiness: number;
  readonly seed: number;
}

/** 各级一块的边长（米）。 */
export function oceanPatches(patch: number): number[] {
  return Array.from({ length: OCEAN_CASCADES }, (_, c) => patch / OCEAN_CASCADE_RATIO ** c);
}

/** 只按风速估的有效波高（米）：Pierson–Moskowitz 的充分成长的海，0.21·V²/g。 */
export function windSeaHeight(wind: number): number {
  return (0.21 * wind * wind) / GRAVITY;
}

/**
 * 各级的初始频谱 h₀(k) 和 h₀*(−k)（每个格子 4 个 float，一级接一级），浪高按方差归一到 height（有效波高 = 4 倍均方根）。
 * 纯函数（测试用）：同样的设置同样的结果。
 */
export function oceanSpectrum(settings: OceanSettings, size = OCEAN_SIZE): Float32Array {
  const { wind, direction, seed } = settings;
  const windX = Math.cos(direction), windZ = Math.sin(direction);
  const largest = (wind * wind) / GRAVITY;
  // 比最大的浪短一千倍的去掉（Tessendorf 的 l）
  const smallest = largest * 0.001;
  const phillips = (kx: number, kz: number) => {
    const k2 = kx * kx + kz * kz;
    if (k2 < 1e-12) return 0;
    const k = Math.sqrt(k2);
    const align = (kx * windX + kz * windZ) / k;
    // 顺风的浪 cos²，逆风的再压小
    const along = align * align * (align < 0 ? 0.07 : 1);
    return (Math.exp(-1 / (k2 * largest * largest)) / (k2 * k2)) * along * Math.exp(-k2 * smallest * smallest);
  };
  let state = Math.imul(seed | 0, 2654435761) >>> 0 || 1;
  const uniform = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state + 0.5) / 4294967296;
  };
  // Box–Muller
  const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const patches = oceanPatches(settings.patch);
  const cells = size * size;
  const h0 = new Float32Array(cells * 2 * OCEAN_CASCADES);
  let variance = 0;
  patches.forEach((patch, c) => {
    // 这一级管的波数段：从上一级交过来的地方到下一级接走的地方
    const low = c === 0 ? 0 : (2 * Math.PI * BAND_START) / patch;
    const high = c + 1 < OCEAN_CASCADES ? (2 * Math.PI * BAND_START) / patches[c + 1]! : Infinity;
    const dk = (2 * Math.PI) / patch;
    for (let m = 0; m < size; m++) {
      for (let n = 0; n < size; n++) {
        const kx = dk * (n - size / 2), kz = dk * (m - size / 2), k = Math.hypot(kx, kz);
        // 连续的谱按格子的面积 dk² 离散
        const amplitude = k >= low && k < high ? Math.sqrt((phillips(kx, kz) * dk * dk) / 2) : 0;
        const i = (c * cells + m * size + n) * 2;
        h0[i] = gauss() * amplitude;
        h0[i + 1] = gauss() * amplitude;
        variance += h0[i]! * h0[i]! + h0[i + 1]! * h0[i + 1]!;
      }
    }
  });
  // h(x) 的方差 ≈ Σ |h₀(k)|² + |h₀(−k)|² = 2 Σ |h₀|²
  const scale = variance > 0 ? settings.height / (4 * Math.sqrt(2 * variance)) : 0;
  const out = new Float32Array(cells * 4 * OCEAN_CASCADES);
  for (let c = 0; c < OCEAN_CASCADES; c++) {
    for (let m = 0; m < size; m++) {
      for (let n = 0; n < size; n++) {
        const i = (c * cells + m * size + n) * 2;
        // −k 的格子：中心化的下标关于 N/2 对称
        const j = (c * cells + ((size - m) % size) * size + ((size - n) % size)) * 2;
        const o = (c * cells + m * size + n) * 4;
        out[o] = h0[i]! * scale;
        out[o + 1] = h0[i + 1]! * scale;
        out[o + 2] = h0[j]! * scale;
        out[o + 3] = -h0[j + 1]! * scale;
      }
    }
  }
  return out;
}

/** 一片 FFT 海浪：每帧 simulate 一次，位移图、导数图（三层的数组，带 mip）给水面取。 */
export class OceanFFT {
  readonly displacement: GPUTexture;
  readonly derivatives: GPUTexture;
  readonly #device: GPUDevice;
  readonly #h0: GPUTexture;
  readonly #spectra: readonly [GPUTexture, GPUTexture];
  readonly #temp: GPUTexture;
  readonly #params: GPUBuffer;
  readonly #directions: readonly GPUBuffer[];
  readonly #pipelines: Record<'spectrum' | 'fft' | 'finish' | 'downsample', GPUComputePipeline>;
  readonly #groups: { spectrum: GPUBindGroup; fft: GPUBindGroup[]; finish: GPUBindGroup; mips: GPUBindGroup[] };
  readonly #data = new Float32Array(8);
  #settings = '';

  constructor(device: GPUDevice) {
    this.#device = device;
    const texture = (label: string, format: GPUTextureFormat, usage: number, mipLevelCount = 1) =>
      device.createTexture({ label: `Ocean ${label}`, size: [OCEAN_SIZE, OCEAN_SIZE, OCEAN_CASCADES], format, usage, mipLevelCount });
    const storage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    this.#h0 = texture('h0', 'rgba32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    this.#spectra = [texture('spectrum A', 'rgba32float', storage), texture('spectrum B', 'rgba32float', storage)];
    this.#temp = texture('temp', 'rgba32float', storage);
    this.displacement = texture('displacement', 'rgba16float', storage, MIPS);
    this.derivatives = texture('derivatives', 'rgba16float', storage, MIPS);
    this.#params = device.createBuffer({ label: 'Ocean params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 横着、竖着两趟逆 FFT 的方向
    this.#directions = [0, 1].map((vertical) => {
      const buffer = device.createBuffer({ label: `Ocean FFT ${vertical ? 'columns' : 'rows'}`, size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(buffer.getMappedRange()).set([vertical, 0, 0, 0]);
      buffer.unmap();
      return buffer;
    });
    const module = device.createShaderModule({ label: 'Ocean FFT', code: SHADER });
    const make = (entryPoint: 'spectrum' | 'fft' | 'finish' | 'downsample') => device.createComputePipeline({ label: `Ocean ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    this.#pipelines = { spectrum: make('spectrum'), fft: make('fft'), finish: make('finish'), downsample: make('downsample') };
    const array = (t: GPUTexture, mip = 0) => t.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });
    const params = { binding: 0, resource: { buffer: this.#params } };
    const [a, b] = this.#spectra;
    // 每个频谱：横着从它到 temp，竖着从 temp 回到它
    const fft = (vertical: number, source: GPUTexture, target: GPUTexture) => device.createBindGroup({
      layout: this.#pipelines.fft.getBindGroupLayout(0),
      entries: [{ binding: 4, resource: { buffer: this.#directions[vertical]! } }, { binding: 5, resource: array(source) }, { binding: 6, resource: array(target) }],
    });
    this.#groups = {
      spectrum: device.createBindGroup({
        layout: this.#pipelines.spectrum.getBindGroupLayout(0),
        entries: [params, { binding: 1, resource: array(this.#h0) }, { binding: 2, resource: array(a) }, { binding: 3, resource: array(b) }],
      }),
      fft: this.#spectra.flatMap((spectrum) => [fft(0, spectrum, this.#temp), fft(1, this.#temp, spectrum)]),
      finish: device.createBindGroup({
        layout: this.#pipelines.finish.getBindGroupLayout(0),
        entries: [params, { binding: 7, resource: array(a) }, { binding: 8, resource: array(b) }, { binding: 9, resource: array(this.displacement) }, { binding: 10, resource: array(this.derivatives) }],
      }),
      mips: [this.displacement, this.derivatives].flatMap((t) => Array.from({ length: MIPS - 1 }, (_, i) => device.createBindGroup({
        layout: this.#pipelines.downsample.getBindGroupLayout(0),
        entries: [{ binding: 11, resource: array(t, i) }, { binding: 12, resource: array(t, i + 1) }],
      }))),
    };
  }

  /** 录进编码器：settings 的海在 time 秒（游戏时间，双精度）时的样子；设置变了先重算初始频谱。 */
  simulate(encoder: GPUCommandEncoder, settings: OceanSettings, time: number, timestampWrites?: GPUComputePassTimestampWrites): void {
    const key = JSON.stringify([settings.patch, settings.wind, settings.direction, settings.height, settings.seed]);
    if (key !== this.#settings) {
      this.#settings = key;
      this.#device.queue.writeTexture({ texture: this.#h0 }, oceanSpectrum(settings), { bytesPerRow: OCEAN_SIZE * 16, rowsPerImage: OCEAN_SIZE }, [OCEAN_SIZE, OCEAN_SIZE, OCEAN_CASCADES]);
    }
    const data = this.#data;
    data.set([((time % OCEAN_LOOP) + OCEAN_LOOP) % OCEAN_LOOP, settings.choppiness, 0, 0], 0);
    data.set(oceanPatches(settings.patch), 4);
    this.#device.queue.writeBuffer(this.#params, 0, data);
    const pass = encoder.beginComputePass({ label: 'Ocean FFT', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(this.#pipelines.spectrum);
    pass.setBindGroup(0, this.#groups.spectrum);
    pass.dispatchWorkgroups(OCEAN_SIZE / 16, OCEAN_SIZE / 16, OCEAN_CASCADES);
    pass.setPipeline(this.#pipelines.fft);
    for (const group of this.#groups.fft) {
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(OCEAN_SIZE, OCEAN_CASCADES);
    }
    pass.setPipeline(this.#pipelines.finish);
    pass.setBindGroup(0, this.#groups.finish);
    pass.dispatchWorkgroups(OCEAN_SIZE / 16, OCEAN_SIZE / 16, OCEAN_CASCADES);
    pass.setPipeline(this.#pipelines.downsample);
    this.#groups.mips.forEach((group, i) => {
      const size = Math.max(1, OCEAN_SIZE >> ((i % (MIPS - 1)) + 1));
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), OCEAN_CASCADES);
    });
    pass.end();
  }

  destroy(): void {
    for (const texture of [this.#h0, ...this.#spectra, this.#temp, this.displacement, this.derivatives]) texture.destroy();
    for (const buffer of [this.#params, ...this.#directions]) buffer.destroy();
  }
}
