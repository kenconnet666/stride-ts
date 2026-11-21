// G 组（docs/roadmap.md 第二节"未来城市和现实仿真还缺什么"）的 WebGPU 实测：这台机器的浏览器里 WebGPU 能做到多少，帮着定取舍。
//   能力：适配器、特性、上限；
//   高斯泼溅：一间屋子的表面撒 N 个泼溅（3DGS 的格式：位置、缩放、旋转、不透明度、颜色），每帧按视深 16 位计数排序，
//     再按序混合着画（顶点着色器里照 3DGS 把三维协方差投成二维的椭圆），1080p，rgba16float；
//   群演：顶点动画贴图（VAT，位置和法线各一张）驱动的 N 个人，一个人 4000 个三角形，实例化一次画完，1080p；
//   视频贴图：WebCodecs 解 1080p 的码流有多快，每帧 importExternalTexture 再铺满 1080p 画一遍的 CPU 和 GPU 时间；
//   路径追踪：CPU 上按表面积启发式建 BVH（一座方块楼的城），计算着色器里遍历：每个像素主光线、一次漫反射反弹、各一条阴影光线。
// 时间都是 GPU 时间戳（一帧里第一个通道开始到最后一个通道结束），取中位数。
//   node tools/run-page.ts http://localhost:5182/capabilities.html capabilitiesResults --error capabilitiesError --out <json> --screenshot <png>
const WIDTH = 1920, HEIGHT = 1080;

const out = document.getElementById('out')!, lines: string[] = [], globals = globalThis as Record<string, unknown>;
function print(line: string): void {
  lines.push(line);
  out.textContent = lines.join('\n');
}

let device: GPUDevice;

// ---- 共用 ----

function upload(data: ArrayBufferView, usage: number): GPUBuffer {
  const buffer = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

interface PassWrites {
  /** 只记开始（多个通道的第一个）。 */
  readonly begin: GPUComputePassTimestampWrites;
  /** 只记结束（多个通道的最后一个）。 */
  readonly end: GPUComputePassTimestampWrites;
  /** 一个通道从头到尾。 */
  readonly both: GPUComputePassTimestampWrites;
}

let querySet: GPUQuerySet, resolveBuffer: GPUBuffer, readBuffer: GPUBuffer;

/** 录一帧（encode 把时间戳写进它的通道）、提交，返回 GPU 时间（毫秒）。 */
async function timed(encode: (encoder: GPUCommandEncoder, writes: PassWrites) => void): Promise<number> {
  const encoder = device.createCommandEncoder();
  encode(encoder, {
    begin: { querySet, beginningOfPassWriteIndex: 0 },
    end: { querySet, endOfPassWriteIndex: 1 },
    both: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
  });
  encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
  encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
  device.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(GPUMapMode.READ);
  const [begin, end] = new BigUint64Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  return Number(end! - begin!) / 1e6;
}

/** 先跑 3 帧预热，再跑 frames 帧，返回中位数（毫秒）。 */
async function median(frames: number, frame: (index: number) => Promise<number>): Promise<number> {
  for (let i = 0; i < 3; i++) await frame(i);
  const times: number[] = [];
  for (let i = 0; i < frames; i++) times.push(await frame(i + 3));
  return times.sort((a, b) => a - b)[times.length >> 1]!;
}

/** 校验错误（着色器编不过、绑定不对）变成异常，免得量出一个什么都没做的时间。 */
async function validated<T>(label: string, body: () => Promise<T>): Promise<T> {
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  const result = await body();
  const memory = await device.popErrorScope(), validation = await device.popErrorScope();
  const error = validation ?? memory;
  if (error) throw new Error(`${label}: ${error.message}`);
  return result;
}

type Vec3 = readonly [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

/** 右手系、看 -z 的观察矩阵（列主序）。 */
function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float32Array {
  const z = normalize(sub(eye, target)), x = normalize(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/** WebGPU 的透视投影（深度 0..1，列主序）。 */
function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[column * 4 + k]!;
      result[column * 4 + row] = sum;
    }
  }
  return result;
}

/** 可复现的随机数（mulberry32）。 */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function showPixels(pixels: Uint8Array, width: number, height: number, caption: string): void {
  const canvas = document.createElement('canvas');
  [canvas.width, canvas.height] = [width, height];
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  canvas.title = caption;
  document.body.append(canvas);
}

async function readTexture(texture: GPUTexture): Promise<Uint8Array> {
  const buffer = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: WIDTH * 4 }, [WIDTH, HEIGHT]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(buffer.getMappedRange().slice(0));
  buffer.destroy();
  return pixels;
}

// ---- 高斯泼溅 ----

/** 一个泼溅 12 个 32 位数：位置、不透明度、缩放、颜色（rgba8）、旋转（四元数 xyzw）。 */
const SPLAT_WORDS = 12;
const SPLAT_VIEW_BYTES = 160;

const SPLAT_COMMON = /* wgsl */ `
struct Splat { center: vec3f, opacity: f32, scale: vec3f, color: u32, rotation: vec4f };
struct View { view: mat4x4f, proj: mat4x4f, viewport: vec2f, focal: vec2f, count: u32, near: f32, far: f32, pad: f32 };
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> splats: array<Splat>;
`;

const SPLAT_SORT = /* wgsl */ `${SPLAT_COMMON}
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> bins: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;

@compute @workgroup_size(256) fn clear(@builtin(global_invocation_id) id: vec3u) {
  atomicStore(&bins[id.x], 0u);
}

// 远的键小、排在前面（从后往前混合）
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= view.count) { return; }
  let depth = -(view.view * vec4f(splats[i].center, 1.0)).z;
  let key = 65535u - u32(clamp((depth - view.near) / (view.far - view.near), 0.0, 1.0) * 65535.0);
  keys[i] = key;
  atomicAdd(&bins[key], 1u);
}

var<workgroup> sums: array<u32, 256>;

// 65536 个桶的前缀和：一个工作组，每个线程管连着的 256 个桶
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) t: u32) {
  var total = 0u;
  for (var k = 0u; k < 256u; k++) { total += atomicLoad(&bins[t * 256u + k]); }
  sums[t] = total;
  workgroupBarrier();
  for (var step = 1u; step < 256u; step <<= 1u) {
    var add = 0u;
    if (t >= step) { add = sums[t - step]; }
    workgroupBarrier();
    sums[t] += add;
    workgroupBarrier();
  }
  var running = sums[t] - total;
  for (var k = 0u; k < 256u; k++) {
    let c = atomicLoad(&bins[t * 256u + k]);
    atomicStore(&bins[t * 256u + k], running);
    running += c;
  }
}

@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= view.count) { return; }
  order[atomicAdd(&bins[keys[i]], 1u)] = i;
}
`;

const SPLAT_DRAW = /* wgsl */ `${SPLAT_COMMON}
@group(0) @binding(2) var<storage, read> order: array<u32>;

struct Varyings { @builtin(position) position: vec4f, @location(0) offset: vec2f, @location(1) color: vec4f };

@vertex fn vs(@builtin(vertex_index) corner: u32, @builtin(instance_index) instance: u32) -> Varyings {
  var out: Varyings;
  out.position = vec4f(0.0, 0.0, 2.0, 1.0);
  let s = splats[order[instance]];
  let p = (view.view * vec4f(s.center, 1.0)).xyz;
  let clip = view.proj * vec4f(p, 1.0);
  if (clip.w <= 0.01 || any(abs(clip.xy) > vec2f(1.2 * clip.w))) { return out; }
  let q = s.rotation;
  let r = mat3x3f(
    1.0 - 2.0 * (q.y * q.y + q.z * q.z), 2.0 * (q.x * q.y + q.w * q.z), 2.0 * (q.x * q.z - q.w * q.y),
    2.0 * (q.x * q.y - q.w * q.z), 1.0 - 2.0 * (q.x * q.x + q.z * q.z), 2.0 * (q.y * q.z + q.w * q.x),
    2.0 * (q.x * q.z + q.w * q.y), 2.0 * (q.y * q.z - q.w * q.x), 1.0 - 2.0 * (q.x * q.x + q.y * q.y));
  let m = r * mat3x3f(s.scale.x, 0.0, 0.0, 0.0, s.scale.y, 0.0, 0.0, 0.0, s.scale.z);
  let world = m * transpose(m);
  let w = mat3x3f(view.view[0].xyz, view.view[1].xyz, view.view[2].xyz);
  let z = -p.z;
  let j = mat3x3f(view.focal.x / z, 0.0, 0.0, 0.0, view.focal.y / z, 0.0, view.focal.x * p.x / (z * z), view.focal.y * p.y / (z * z), 0.0);
  let t = j * w;
  let screen = t * world * transpose(t);
  let a = screen[0][0] + 0.3;
  let b = screen[0][1];
  let c = screen[1][1] + 0.3;
  let mid = 0.5 * (a + c);
  let radius = sqrt(max(mid * mid - (a * c - b * b), 0.1));
  let major = mid + radius;
  let minor = max(mid - radius, 0.1);
  let axis = normalize(vec2f(b, major - a + 1e-6));
  let v1 = min(sqrt(2.0 * major), 1024.0) * axis;
  let v2 = min(sqrt(2.0 * minor), 1024.0) * vec2f(axis.y, -axis.x);
  let quad = vec2f(f32(corner & 1u), f32(corner >> 1u)) * 4.0 - 2.0;
  out.position = vec4f(clip.xy / clip.w + (quad.x * v1 + quad.y * v2) * 2.0 / view.viewport, 0.5, 1.0);
  out.offset = quad;
  out.color = vec4f(unpack4x8unorm(s.color).rgb, s.opacity);
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let power = -dot(in.offset, in.offset);
  if (power < -4.0) { discard; }
  let alpha = min(exp(power) * in.color.a, 0.99);
  return vec4f(in.color.rgb * alpha, alpha);
}
`;

/**
 * 一间 12 × 4 × 16 米的屋子：97% 的泼溅贴在地面、天花板和四面墙上（扁的，间距按数量算），3% 是屋里飘着的淡的泼溅
 * （真拍出来的泼溅场景里常有的"浮点"和体积感）。
 */
function roomSplats(count: number): ArrayBuffer {
  const data = new ArrayBuffer(count * SPLAT_WORDS * 4), f = new Float32Array(data), u = new Uint32Array(data), rand = random(count);
  const [sx, sy, sz] = [12, 4, 16];
  const faces = [
    { area: sx * sz, axis: 1, at: 0 }, { area: sx * sz, axis: 1, at: sy },
    { area: sy * sz, axis: 0, at: -sx / 2 }, { area: sy * sz, axis: 0, at: sx / 2 },
    { area: sx * sy, axis: 2, at: -sz / 2 }, { area: sx * sy, axis: 2, at: sz / 2 },
  ];
  const total = faces.reduce((sum, face) => sum + face.area, 0), surface = Math.floor(count * 0.97);
  const spacing = Math.sqrt(total / surface);
  for (let i = 0; i < count; i++) {
    const o = i * SPLAT_WORDS;
    const position = [(rand() - 0.5) * sx, rand() * sy, (rand() - 0.5) * sz];
    let scale: number[], color: number[], opacity: number;
    if (i < surface) {
      let pick = rand() * total, face = faces[0]!;
      for (const candidate of faces) {
        face = candidate;
        if ((pick -= candidate.area) <= 0) break;
      }
      position[face.axis] = face.at + (rand() - 0.5) * spacing * 0.2;
      scale = [0, 1, 2].map((axis) => spacing * (axis === face.axis ? 0.1 : 0.6 + rand() * 0.6));
      const checker = (Math.floor(position[0]! * 2) + Math.floor(position[2]! * 2) + Math.floor(position[1]! * 2)) & 1;
      const base = face.axis === 1 ? (checker ? [0.75, 0.72, 0.68] : [0.35, 0.3, 0.28]) : [0.55 + 0.1 * face.axis, 0.6, 0.65];
      color = base.map((c) => Math.min(1, c * (0.85 + rand() * 0.3)));
      opacity = 0.85 + rand() * 0.15;
    } else {
      scale = [0, 1, 2].map(() => spacing * (1 + rand()));
      color = [0.9, 0.85, 0.7];
      opacity = 0.03 + rand() * 0.1;
    }
    f.set(position, o);
    f[o + 3] = opacity;
    f.set(scale, o + 4);
    u[o + 7] = Math.round(color[0]! * 255) | (Math.round(color[1]! * 255) << 8) | (Math.round(color[2]! * 255) << 16) | (255 << 24);
    const q = [(rand() - 0.5) * 0.2, (rand() - 0.5) * 0.2, (rand() - 0.5) * 0.2, 1];
    const length = Math.hypot(...q);
    f.set(q.map((c) => c / length), o + 8);
  }
  return data;
}

interface SplatResult {
  readonly splats: number;
  readonly sortMs: number;
  readonly drawMs: number;
}

async function splatBench(counts: readonly number[]): Promise<SplatResult[]> {
  const max = Math.max(...counts);
  const splatBuffer = device.createBuffer({ size: max * SPLAT_WORDS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const keys = device.createBuffer({ size: max * 4, usage: GPUBufferUsage.STORAGE });
  const order = device.createBuffer({ size: max * 4, usage: GPUBufferUsage.STORAGE });
  const bins = device.createBuffer({ size: 65536 * 4, usage: GPUBufferUsage.STORAGE });
  const viewBuffer = device.createBuffer({ size: SPLAT_VIEW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  const storage = (type: GPUBufferBindingType) => ({ buffer: { type } });
  const sortLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, ...storage('read-only-storage') },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, ...storage('storage') },
    ],
  });
  const sortModule = device.createShaderModule({ code: SPLAT_SORT });
  const sortPipelines = Object.fromEntries(['clear', 'count', 'scan', 'scatter'].map((entryPoint) => [entryPoint, device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sortLayout] }),
    compute: { module: sortModule, entryPoint },
  })])) as Record<'clear' | 'count' | 'scan' | 'scatter', GPUComputePipeline>;
  const sortGroup = device.createBindGroup({
    layout: sortLayout,
    entries: [viewBuffer, splatBuffer, keys, bins, order].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });

  const drawModule = device.createShaderModule({ code: SPLAT_DRAW });
  const drawPipeline = (format: GPUTextureFormat) => device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: drawModule, entryPoint: 'vs' },
    fragment: {
      module: drawModule, entryPoint: 'fs',
      targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const hdr = drawPipeline('rgba16float'), preview = drawPipeline('rgba8unorm');
  const group = (pipeline: GPURenderPipeline) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [viewBuffer, splatBuffer, order].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const hdrGroup = group(hdr), previewGroup = group(preview);
  const hdrTarget = device.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const previewTarget = device.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });

  const fovY = Math.PI / 3, near = 0.1, far = 40;
  const viewData = new ArrayBuffer(SPLAT_VIEW_BYTES), viewFloats = new Float32Array(viewData), viewWords = new Uint32Array(viewData);
  viewFloats.set(lookAt([1.5, 1.6, 6.5], [-1, 1.2, -6]), 0);
  viewFloats.set(perspective(fovY, WIDTH / HEIGHT, near, far), 16);
  const focal = HEIGHT / 2 / Math.tan(fovY / 2);
  viewFloats.set([WIDTH, HEIGHT, focal, focal], 32);
  viewFloats.set([near, far], 37);

  const sort = (pass: GPUComputePassEncoder, count: number) => {
    pass.setBindGroup(0, sortGroup);
    pass.setPipeline(sortPipelines.clear);
    pass.dispatchWorkgroups(65536 / 256);
    pass.setPipeline(sortPipelines.count);
    pass.dispatchWorkgroups(Math.ceil(count / 256));
    pass.setPipeline(sortPipelines.scan);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(sortPipelines.scatter);
    pass.dispatchWorkgroups(Math.ceil(count / 256));
  };
  const draw = (encoder: GPUCommandEncoder, target: GPUTexture, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup, count: number, timestampWrites?: GPURenderPassTimestampWrites) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(4, count);
    pass.end();
  };

  const results: SplatResult[] = [];
  for (const count of counts) {
    device.queue.writeBuffer(splatBuffer, 0, roomSplats(count));
    viewWords[36] = count;
    device.queue.writeBuffer(viewBuffer, 0, viewData);
    const result = await validated(`splats ${count}`, async () => ({
      splats: count,
      sortMs: await median(10, () => timed((encoder, writes) => {
        const pass = encoder.beginComputePass({ timestampWrites: writes.both });
        sort(pass, count);
        pass.end();
      })),
      drawMs: await median(10, () => timed((encoder, writes) => draw(encoder, hdrTarget, hdr, hdrGroup, count, writes.both))),
    }));
    results.push(result);
    print(`  ${(count / 1e6).toFixed(1)}M splats: sort ${result.sortMs.toFixed(2)} ms, draw ${result.drawMs.toFixed(2)} ms (1080p rgba16float)`);
    if (count === counts[counts.length - 1]) {
      const encoder = device.createCommandEncoder();
      draw(encoder, previewTarget, preview, previewGroup, count);
      device.queue.submit([encoder.finish()]);
      showPixels(await readTexture(previewTarget), WIDTH, HEIGHT, `${count} splats`);
    }
  }
  for (const buffer of [splatBuffer, keys, order, bins, viewBuffer]) buffer.destroy();
  hdrTarget.destroy();
  previewTarget.destroy();
  return results;
}

// ---- 群演（顶点动画贴图） ----

const CROWD = /* wgsl */ `
struct Params { viewProj: mat4x4f, time: f32, frames: u32, pad: vec2f };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> people: array<vec4f>;
@group(0) @binding(2) var positions: texture_2d<f32>;
@group(0) @binding(3) var normals: texture_2d<f32>;

struct Varyings { @builtin(position) position: vec4f, @location(0) normal: vec3f, @location(1) tint: f32 };

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let person = people[instance];
  let frame = u32(params.time * 30.0 + person.w * f32(params.frames)) % params.frames;
  let local = textureLoad(positions, vec2u(vertex, frame), 0).xyz;
  let n = textureLoad(normals, vec2u(vertex, frame), 0).xyz;
  let c = cos(person.z);
  let s = sin(person.z);
  let world = vec3f(person.x + c * local.x + s * local.z, local.y, person.y - s * local.x + c * local.z);
  var out: Varyings;
  out.position = params.viewProj * vec4f(world, 1.0);
  out.normal = vec3f(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  out.tint = person.w;
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let light = max(dot(normalize(in.normal), normalize(vec3f(0.4, 1.0, 0.3))), 0.0) * 0.8 + 0.2;
  return vec4f(vec3f(0.4 + 0.5 * in.tint, 0.5, 0.9 - 0.5 * in.tint) * light, 1.0);
}
`;

interface CrowdResult {
  readonly people: number;
  readonly triangles: number;
  readonly ms: number;
}

async function crowdBench(counts: readonly number[]): Promise<CrowdResult[]> {
  // 一个人：拉长的椭球（经纬网格，40 圈 × 50 段 = 4000 个三角形），32 帧的摆动烘进两张 rgba32float（宽是顶点数，高是帧数）
  const rings = 40, segments = 50, frames = 32, columns = segments + 1, vertexCount = (rings + 1) * columns;
  const positions = new Float32Array(vertexCount * frames * 4), normals = new Float32Array(vertexCount * frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    const phase = (frame / frames) * Math.PI * 2;
    for (let ring = 0; ring <= rings; ring++) {
      const theta = (ring / rings) * Math.PI, y = 0.85 - Math.cos(theta) * 0.85;
      for (let segment = 0; segment <= segments; segment++) {
        const phi = (segment / segments) * Math.PI * 2, i = (frame * vertexCount + ring * columns + segment) * 4;
        const nx = Math.sin(theta) * Math.cos(phi), ny = -Math.cos(theta), nz = Math.sin(theta) * Math.sin(phi);
        positions.set([nx * 0.25 + 0.06 * Math.sin(phase + y * 2) * y, y, nz * 0.18 + 0.04 * Math.cos(phase + y * 3) * y, 1], i);
        normals.set([nx, ny, nz, 0], i);
      }
    }
  }
  const indices = new Uint32Array(rings * segments * 6);
  for (let ring = 0, k = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const a = ring * columns + segment, b = a + columns;
      indices.set([a, b, a + 1, a + 1, b, b + 1], k);
      k += 6;
    }
  }
  const texture = (data: Float32Array) => {
    const result = device.createTexture({ size: [vertexCount, frames], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: result }, data, { bytesPerRow: vertexCount * 16 }, [vertexCount, frames]);
    return result;
  };
  const positionTexture = texture(positions), normalTexture = texture(normals);
  const indexBuffer = upload(indices, GPUBufferUsage.INDEX);

  const max = Math.max(...counts), rand = random(7);
  const people = new Float32Array(max * 4);
  for (let i = 0; i < max; i++) people.set([(rand() - 0.5) * 80, -5 - rand() * 115, rand() * Math.PI * 2, rand()], i * 4);
  const peopleBuffer = upload(people, GPUBufferUsage.STORAGE);
  const paramsBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const params = new ArrayBuffer(80), paramFloats = new Float32Array(params), paramWords = new Uint32Array(params);
  paramFloats.set(multiply(perspective(Math.PI / 3, WIDTH / HEIGHT, 0.1, 300), lookAt([0, 6, 5], [0, 0, -40])), 0);
  paramWords[17] = frames;

  const module = device.createShaderModule({ code: CROWD });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: peopleBuffer } },
      { binding: 2, resource: positionTexture.createView() },
      { binding: 3, resource: normalTexture.createView() },
    ],
  });
  const color = device.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ size: [WIDTH, HEIGHT], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const draw = (encoder: GPUCommandEncoder, count: number, timestampWrites?: GPURenderPassTimestampWrites) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0.55, 0.6, 0.65, 1] }],
      depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 1 },
      ...(timestampWrites ? { timestampWrites } : {}),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(indices.length, count);
    pass.end();
  };

  const results: CrowdResult[] = [];
  for (const count of counts) {
    const ms = await validated(`crowd ${count}`, () => median(10, (frame) => {
      paramFloats[16] = frame / 30;
      device.queue.writeBuffer(paramsBuffer, 0, params);
      return timed((encoder, writes) => draw(encoder, count, writes.both));
    }));
    results.push({ people: count, triangles: count * (indices.length / 3), ms });
    print(`  ${count} people x ${indices.length / 3} triangles: ${ms.toFixed(2)} ms (${((count * indices.length) / 3 / 1e6 / ms).toFixed(0)} M triangles/ms)`);
  }
  const encoder = device.createCommandEncoder();
  draw(encoder, counts[counts.length - 1]!);
  device.queue.submit([encoder.finish()]);
  showPixels(await readTexture(color), WIDTH, HEIGHT, 'crowd');
  for (const resource of [positionTexture, normalTexture, indexBuffer, peopleBuffer, paramsBuffer, color, depth]) resource.destroy();
  return results;
}

// ---- 视频贴图 ----

const VIDEO_DRAW = /* wgsl */ `
@group(0) @binding(0) var video: texture_external;
@group(0) @binding(1) var linear: sampler;
struct Varyings { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> Varyings {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return Varyings(vec4f(corner * 2.0 - 1.0, 0.0, 1.0), vec2f(corner.x, 1.0 - corner.y));
}
@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(video, linear, in.uv);
}
`;

interface VideoResult {
  readonly codec: string;
  readonly frames: number;
  readonly decodeFps: number;
  readonly decodeAndDrawFps: number;
  /** 每帧 importExternalTexture、建绑定组、录命令、提交的 CPU 时间（毫秒，中位数）。 */
  readonly importCpuMs: number;
  /** 采视频铺满 1080p 画一遍的 GPU 时间（毫秒，中位数）。 */
  readonly drawGpuMs: number;
  readonly frameFormat: string;
}

async function videoBench(): Promise<VideoResult> {
  const frameCount = 120;
  const candidates = ['avc1.640028', 'avc1.42002a', 'vp09.00.40.08'];
  let codec: string | undefined;
  for (const candidate of candidates) {
    const support = await VideoEncoder.isConfigSupported({ codec: candidate, width: WIDTH, height: HEIGHT, bitrate: 12e6, framerate: 30 });
    if (support.supported) {
      codec = candidate;
      break;
    }
  }
  if (!codec) throw new Error(`no encoder for ${candidates.join(', ')}`);

  // 先用 2D 画布画 120 帧、编成码流（只是准备素材，不计时）
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT), context = canvas.getContext('2d')!;
  const chunks: EncodedVideoChunk[] = [];
  let decoderConfig: VideoDecoderConfig | undefined;
  let failure: unknown;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      chunks.push(chunk);
      if (metadata?.decoderConfig) decoderConfig = metadata.decoderConfig;
    },
    error: (error) => (failure = error),
  });
  encoder.configure({ codec, width: WIDTH, height: HEIGHT, bitrate: 12e6, framerate: 30 });
  for (let i = 0; i < frameCount; i++) {
    const gradient = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, `hsl(${i * 3}, 70%, 40%)`);
    gradient.addColorStop(1, `hsl(${i * 3 + 120}, 70%, 60%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = '#fff';
    context.font = 'bold 160px sans-serif';
    context.fillText(`LED ${i}`, 200 + i * 8, 600);
    const frame = new VideoFrame(canvas, { timestamp: i * 33333 });
    encoder.encode(frame, { keyFrame: i % 60 === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!decoderConfig) throw new Error('the encoder gave no decoder config');

  const decodeAll = async (onFrame: (frame: VideoFrame) => void) => {
    const decoder = new VideoDecoder({ output: onFrame, error: (error) => (failure = error) });
    decoder.configure({ ...decoderConfig!, hardwareAcceleration: 'prefer-hardware' });
    const start = performance.now();
    for (const chunk of chunks) decoder.decode(chunk);
    await decoder.flush();
    decoder.close();
    if (failure) throw failure;
    return performance.now() - start;
  };

  let frameFormat = '';
  const decodeMs = await decodeAll((frame) => {
    frameFormat ||= `${frame.format ?? 'opaque'} ${frame.codedWidth}x${frame.codedHeight}`;
    frame.close();
  });

  const module = device.createShaderModule({ code: VIDEO_DRAW });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const target = device.createTexture({ size: [WIDTH, HEIGHT], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const frameQueries = device.createQuerySet({ type: 'timestamp', count: frameCount * 2 });
  const cpuTimes: number[] = [], pending: Promise<void>[] = [];
  let drawn = 0;
  const drawMs = await decodeAll((frame) => {
    const start = performance.now(), slot = drawn++;
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: device.importExternalTexture({ source: frame }) }, { binding: 1, resource: sampler }],
    });
    const commands = device.createCommandEncoder();
    const pass = commands.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
      timestampWrites: { querySet: frameQueries, beginningOfPassWriteIndex: slot * 2, endOfPassWriteIndex: slot * 2 + 1 },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([commands.finish()]);
    cpuTimes.push(performance.now() - start);
    // 外部贴图在帧关掉时失效，GPU 用完再关
    pending.push(device.queue.onSubmittedWorkDone().then(() => frame.close()));
  });
  await Promise.all(pending);
  const resolved = device.createBuffer({ size: frameCount * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readable = device.createBuffer({ size: frameCount * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const commands = device.createCommandEncoder();
  commands.resolveQuerySet(frameQueries, 0, drawn * 2, resolved, 0);
  commands.copyBufferToBuffer(resolved, 0, readable, 0, drawn * 16);
  device.queue.submit([commands.finish()]);
  await readable.mapAsync(GPUMapMode.READ);
  const stamps = new BigUint64Array(readable.getMappedRange().slice(0, drawn * 16));
  readable.unmap();
  const gpuTimes = Array.from({ length: drawn }, (_, i) => Number(stamps[i * 2 + 1]! - stamps[i * 2]!) / 1e6).sort((a, b) => a - b);
  cpuTimes.sort((a, b) => a - b);
  showPixels(await readTexture(target), WIDTH, HEIGHT, 'last video frame');
  for (const resource of [target, resolved, readable, frameQueries]) resource.destroy();
  const result: VideoResult = {
    codec, frames: drawn, frameFormat,
    decodeFps: (frameCount / decodeMs) * 1000,
    decodeAndDrawFps: (frameCount / drawMs) * 1000,
    importCpuMs: cpuTimes[cpuTimes.length >> 1]!,
    drawGpuMs: gpuTimes[gpuTimes.length >> 1]!,
  };
  print(`  ${codec} 1080p (${frameFormat}): decode ${result.decodeFps.toFixed(0)} fps, decode + import + draw ${result.decodeAndDrawFps.toFixed(0)} fps; per frame CPU ${result.importCpuMs.toFixed(2)} ms, GPU ${result.drawGpuMs.toFixed(3)} ms`);
  return result;
}

// ---- 路径追踪 ----

/** 方块楼的城：side × side 个街区，每栋楼顶面和四个侧面 10 个三角形，加一块地面。返回每个三角形 9 个数。 */
function city(side: number): Float32Array {
  const rand = random(side), block = 12, tris: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  const extent = side * block;
  quad([0, 0, 0], [extent, 0, 0], [extent, 0, extent], [0, 0, extent]);
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const w = 4 + rand() * 6, d = 4 + rand() * 6, h = rand() < 0.05 ? 80 + rand() * 120 : 6 + rand() * 40;
      const x0 = i * block + (block - w) / 2, z0 = j * block + (block - d) / 2, x1 = x0 + w, z1 = z0 + d;
      quad([x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]);
      quad([x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]);
      quad([x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]);
      quad([x1, 0, z1], [x0, 0, z1], [x0, h, z1], [x1, h, z1]);
      quad([x0, 0, z1], [x0, 0, z0], [x0, h, z0], [x0, h, z1]);
    }
  }
  return new Float32Array(tris);
}

/**
 * 按表面积启发式（8 个桶）建二叉 BVH。节点 32 字节：最小角、左孩子或第一个三角形、最大角、三角形数（0 是内部节点，
 * 两个孩子挨着放）。返回节点和重排后的三角形（每个 v0、e1、e2 三个 vec4）。
 */
function buildBvh(source: Float32Array): { nodes: ArrayBuffer; nodeCount: number; triangles: Float32Array } {
  const count = source.length / 9, BINS = 8;
  const centroid = new Float32Array(count * 3), lo = new Float32Array(count * 3), hi = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let axis = 0; axis < 3; axis++) {
      const a = source[t * 9 + axis]!, b = source[t * 9 + 3 + axis]!, c = source[t * 9 + 6 + axis]!;
      lo[t * 3 + axis] = Math.min(a, b, c);
      hi[t * 3 + axis] = Math.max(a, b, c);
      centroid[t * 3 + axis] = (a + b + c) / 3;
    }
  }
  const index = new Uint32Array(count).map((_, i) => i);
  const nodes = new ArrayBuffer(count * 2 * 32), nf = new Float32Array(nodes), nu = new Uint32Array(nodes);
  let used = 1;
  nu[3] = 0;
  nu[7] = count;
  const area = (x: number, y: number, z: number) => (x > 0 ? x * y + y * z + z * x : 0);
  const binCount = new Uint32Array(BINS), binBox = new Float32Array(BINS * 6);
  const stack = [0];
  while (stack.length > 0) {
    const node = stack.pop()!, first = nu[node * 8 + 3]!, n = nu[node * 8 + 7]!;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], cbox = [...box];
    for (let k = first; k < first + n; k++) {
      const t = index[k]!;
      for (let axis = 0; axis < 3; axis++) {
        box[axis] = Math.min(box[axis]!, lo[t * 3 + axis]!);
        box[axis + 3] = Math.max(box[axis + 3]!, hi[t * 3 + axis]!);
        cbox[axis] = Math.min(cbox[axis]!, centroid[t * 3 + axis]!);
        cbox[axis + 3] = Math.max(cbox[axis + 3]!, centroid[t * 3 + axis]!);
      }
    }
    nf.set(box.slice(0, 3), node * 8);
    nf.set(box.slice(3), node * 8 + 4);
    if (n <= 2) continue;
    let bestCost = n * area(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!), bestAxis = -1, bestSplit = 0;
    for (let axis = 0; axis < 3; axis++) {
      const min = cbox[axis]!, extent = cbox[axis + 3]! - min;
      if (extent < 1e-6) continue;
      binCount.fill(0);
      for (let b = 0; b < BINS; b++) binBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], b * 6);
      const scale = BINS / extent;
      for (let k = first; k < first + n; k++) {
        const t = index[k]!, b = Math.min(BINS - 1, Math.floor((centroid[t * 3 + axis]! - min) * scale)), o = b * 6;
        binCount[b]!++;
        for (let a = 0; a < 3; a++) {
          if (lo[t * 3 + a]! < binBox[o + a]!) binBox[o + a] = lo[t * 3 + a]!;
          if (hi[t * 3 + a]! > binBox[o + 3 + a]!) binBox[o + 3 + a] = hi[t * 3 + a]!;
        }
      }
      const leftArea = new Float64Array(BINS - 1), leftCount = new Uint32Array(BINS - 1);
      const grow = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      let sum = 0;
      for (let b = 0; b < BINS - 1; b++) {
        sum += binCount[b]!;
        for (let a = 0; a < 3; a++) {
          grow[a] = Math.min(grow[a]!, binBox[b * 6 + a]!);
          grow[a + 3] = Math.max(grow[a + 3]!, binBox[b * 6 + 3 + a]!);
        }
        leftCount[b] = sum;
        leftArea[b] = area(grow[3]! - grow[0]!, grow[4]! - grow[1]!, grow[5]! - grow[2]!);
      }
      grow.splice(0, 6, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
      sum = 0;
      for (let b = BINS - 1; b > 0; b--) {
        sum += binCount[b]!;
        for (let a = 0; a < 3; a++) {
          grow[a] = Math.min(grow[a]!, binBox[b * 6 + a]!);
          grow[a + 3] = Math.max(grow[a + 3]!, binBox[b * 6 + 3 + a]!);
        }
        const cost = leftCount[b - 1]! * leftArea[b - 1]! + sum * area(grow[3]! - grow[0]!, grow[4]! - grow[1]!, grow[5]! - grow[2]!);
        if (cost < bestCost) [bestCost, bestAxis, bestSplit] = [cost, axis, b];
      }
    }
    if (bestAxis < 0) continue;
    const min = cbox[bestAxis]!, scale = BINS / (cbox[bestAxis + 3]! - min);
    let i = first, j = first + n - 1;
    while (i <= j) {
      const t = index[i]!;
      if (Math.min(BINS - 1, Math.floor((centroid[t * 3 + bestAxis]! - min) * scale)) < bestSplit) i++;
      else [index[i], index[j--]] = [index[j]!, t];
    }
    const leftN = i - first;
    if (leftN === 0 || leftN === n) continue;
    const left = used;
    used += 2;
    nu[left * 8 + 3] = first;
    nu[left * 8 + 7] = leftN;
    nu[(left + 1) * 8 + 3] = i;
    nu[(left + 1) * 8 + 7] = n - leftN;
    nu[node * 8 + 3] = left;
    nu[node * 8 + 7] = 0;
    stack.push(left, left + 1);
  }
  const triangles = new Float32Array(count * 12);
  for (let k = 0; k < count; k++) {
    const s = index[k]! * 9, o = k * 12;
    triangles.set([source[s]!, source[s + 1]!, source[s + 2]!, 0], o);
    triangles.set([source[s + 3]! - source[s]!, source[s + 4]! - source[s + 1]!, source[s + 5]! - source[s + 2]!, 0], o + 4);
    triangles.set([source[s + 6]! - source[s]!, source[s + 7]! - source[s + 1]!, source[s + 8]! - source[s + 2]!, 0], o + 8);
  }
  return { nodes: nodes.slice(0, used * 32), nodeCount: used, triangles };
}

const PATH_TRACE = /* wgsl */ `
struct Node { min: vec3f, leftFirst: u32, max: vec3f, count: u32 };
struct Camera { origin: vec3f, pad0: f32, forward: vec3f, pad1: f32, right: vec3f, pad2: f32, up: vec3f, frame: u32, sun: vec3f, pad3: f32, size: vec2u, pad4: vec2u };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<storage, read> nodes: array<Node>;
@group(0) @binding(2) var<storage, read> tris: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> image: array<u32>;
@group(0) @binding(4) var<storage, read_write> rayCount: atomic<u32>;

const INF = 1e30;
const MISS = 0xffffffffu;
struct Hit { t: f32, tri: u32 };

fn hitBox(o: vec3f, inv: vec3f, node: Node, tmax: f32) -> f32 {
  let t0 = (node.min - o) * inv;
  let t1 = (node.max - o) * inv;
  let lo = min(t0, t1);
  let hi = max(t0, t1);
  let near = max(max(lo.x, lo.y), max(lo.z, 0.0));
  let far = min(min(hi.x, hi.y), min(hi.z, tmax));
  return select(INF, near, near <= far);
}

fn hitTri(o: vec3f, d: vec3f, tri: u32, tmax: f32) -> f32 {
  let v0 = tris[tri * 3u].xyz;
  let e1 = tris[tri * 3u + 1u].xyz;
  let e2 = tris[tri * 3u + 2u].xyz;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-12) { return INF; }
  let inv = 1.0 / det;
  let s = o - v0;
  let u = dot(s, p) * inv;
  if (u < 0.0 || u > 1.0) { return INF; }
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) { return INF; }
  let t = dot(e2, q) * inv;
  return select(INF, t, t > 1e-4 && t < tmax);
}

fn trace(o: vec3f, d: vec3f, anyHit: bool) -> Hit {
  let inv = 1.0 / select(d, vec3f(1e-9), abs(d) < vec3f(1e-9));
  var hit = Hit(INF, MISS);
  var stack: array<u32, 48>;
  var sp = 0u;
  var node = 0u;
  loop {
    let current = nodes[node];
    if (current.count > 0u) {
      for (var i = 0u; i < current.count; i++) {
        let t = hitTri(o, d, current.leftFirst + i, hit.t);
        if (t < hit.t) {
          hit = Hit(t, current.leftFirst + i);
          if (anyHit) { return hit; }
        }
      }
      if (sp == 0u) { break; }
      sp--;
      node = stack[sp];
      continue;
    }
    var a = current.leftFirst;
    var b = a + 1u;
    var da = hitBox(o, inv, nodes[a], hit.t);
    var db = hitBox(o, inv, nodes[b], hit.t);
    if (da > db) {
      let swapNode = a; a = b; b = swapNode;
      let swapT = da; da = db; db = swapT;
    }
    if (da == INF) {
      if (sp == 0u) { break; }
      sp--;
      node = stack[sp];
      continue;
    }
    node = a;
    if (db != INF) { stack[sp] = b; sp++; }
  }
  return hit;
}

fn rand(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 747796405u + 2891336453u;
  var w = ((*seed >> ((*seed >> 28u) + 4u)) ^ *seed) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn sky(d: vec3f) -> vec3f {
  return mix(vec3f(0.9, 0.9, 0.95), vec3f(0.35, 0.55, 0.95), clamp(d.y, 0.0, 1.0));
}

var<workgroup> groupRays: atomic<u32>;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u, @builtin(local_invocation_index) local: u32) {
  var rays = 0u;
  if (all(id.xy < camera.size)) {
    let uv = (vec2f(id.xy) + 0.5) / vec2f(camera.size) * 2.0 - 1.0;
    let aspect = f32(camera.size.x) / f32(camera.size.y);
    var o = camera.origin;
    var d = normalize(camera.forward + uv.x * aspect * 0.577 * camera.right - uv.y * 0.577 * camera.up);
    var seed = id.x * 1973u + id.y * 9277u + camera.frame * 26699u;
    var throughput = vec3f(1.0);
    var color = vec3f(0.0);
    for (var bounce = 0u; bounce < 2u; bounce++) {
      let hit = trace(o, d, false);
      rays++;
      if (hit.tri == MISS) {
        color += throughput * sky(d);
        break;
      }
      var n = normalize(cross(tris[hit.tri * 3u + 1u].xyz, tris[hit.tri * 3u + 2u].xyz));
      if (dot(n, d) > 0.0) { n = -n; }
      let p = o + d * hit.t + n * 1e-3;
      throughput *= vec3f(0.65, 0.62, 0.58);
      let lit = dot(n, camera.sun);
      if (lit > 0.0) {
        rays++;
        if (trace(p, camera.sun, true).tri == MISS) { color += throughput * lit * vec3f(3.0, 2.8, 2.4); }
      }
      let r1 = rand(&seed);
      let r2 = rand(&seed);
      let helper = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
      let tangent = normalize(cross(helper, n));
      let bitangent = cross(n, tangent);
      let phi = 6.2831853 * r1;
      o = p;
      d = normalize((tangent * cos(phi) + bitangent * sin(phi)) * sqrt(r2) + n * sqrt(1.0 - r2));
    }
    image[id.y * camera.size.x + id.x] = pack4x8unorm(vec4f(color / (color + 1.0), 1.0));
  }
  atomicAdd(&groupRays, rays);
  workgroupBarrier();
  if (local == 0u) { atomicAdd(&rayCount, atomicLoad(&groupRays)); }
}
`;

interface PathTraceResult {
  readonly triangles: number;
  readonly bvhNodes: number;
  /** CPU（JS）建 BVH 的时间。 */
  readonly buildMs: number;
  /** 1080p 一个像素一个样本（主光线、一次反弹、阴影光线）的 GPU 时间。 */
  readonly msPerSample: number;
  readonly raysPerSample: number;
  readonly megaRaysPerSecond: number;
}

async function pathTraceBench(sides: readonly number[]): Promise<PathTraceResult[]> {
  const module = device.createShaderModule({ code: PATH_TRACE });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const image = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const counter = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const counterRead = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const cameraBuffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const results: PathTraceResult[] = [];
  for (const side of sides) {
    const source = city(side);
    const start = performance.now();
    const bvh = buildBvh(source);
    const buildMs = performance.now() - start;
    const nodes = upload(new Uint8Array(bvh.nodes), GPUBufferUsage.STORAGE), tris = upload(bvh.triangles, GPUBufferUsage.STORAGE);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [cameraBuffer, nodes, tris, image, counter].map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    // 从城的一角、30 米高往对角看
    const extent = side * 12, eye: Vec3 = [-20, 30, -20], target: Vec3 = [extent * 0.5, 0, extent * 0.5];
    const forward = normalize(sub(target, eye)), right = normalize(cross(forward, [0, 1, 0])), up = cross(right, forward);
    const cameraData = new ArrayBuffer(96), cf = new Float32Array(cameraData), cu = new Uint32Array(cameraData);
    cf.set(eye, 0);
    cf.set(forward, 4);
    cf.set(right, 8);
    cf.set(up, 12);
    cf.set(normalize([0.5, 0.8, 0.3]), 16);
    cu.set([WIDTH, HEIGHT], 20);
    const frame = (index: number) => {
      cu[15] = index;
      device.queue.writeBuffer(cameraBuffer, 0, cameraData);
      device.queue.writeBuffer(counter, 0, new Uint32Array([0]));
      return timed((encoder, writes) => {
        const pass = encoder.beginComputePass({ timestampWrites: writes.both });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(WIDTH / 8), Math.ceil(HEIGHT / 8));
        pass.end();
        encoder.copyBufferToBuffer(counter, 0, counterRead, 0, 4);
      });
    };
    const msPerSample = await validated(`path trace ${side}`, () => median(8, frame));
    await counterRead.mapAsync(GPUMapMode.READ);
    const rays = new Uint32Array(counterRead.getMappedRange().slice(0))[0]!;
    counterRead.unmap();
    const result: PathTraceResult = {
      triangles: source.length / 9, bvhNodes: bvh.nodeCount, buildMs, msPerSample,
      raysPerSample: rays, megaRaysPerSecond: rays / msPerSample / 1000,
    };
    results.push(result);
    print(`  ${(result.triangles / 1e6).toFixed(2)}M triangles (BVH ${result.bvhNodes} nodes, built in ${buildMs.toFixed(0)} ms on the CPU): ${msPerSample.toFixed(2)} ms per sample at 1080p, ${(rays / (WIDTH * HEIGHT)).toFixed(2)} rays per pixel, ${result.megaRaysPerSecond.toFixed(0)} Mrays/s`);
    if (side === sides[sides.length - 1]) {
      const copy = device.createBuffer({ size: WIDTH * HEIGHT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(image, 0, copy, 0, WIDTH * HEIGHT * 4);
      device.queue.submit([encoder.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      showPixels(new Uint8Array(copy.getMappedRange().slice(0)), WIDTH, HEIGHT, 'path traced city');
      copy.destroy();
    }
    nodes.destroy();
    tris.destroy();
  }
  for (const buffer of [image, counter, counterRead, cameraBuffer]) buffer.destroy();
  return results;
}

// ---- 入口 ----

const LIMITS = [
  'maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage', 'maxComputeWorkgroupStorageSize',
  'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupsPerDimension', 'maxTextureDimension2D', 'maxTextureArrayLayers',
  'maxColorAttachments', 'maxColorAttachmentBytesPerSample', 'maxBindGroups', 'maxSampledTexturesPerShaderStage', 'maxVertexBuffers',
] as const;

async function main() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU is not available');
  const features = [...adapter.features].sort();
  const limits = Object.fromEntries(LIMITS.map((name) => [name, adapter.limits[name]]));
  device = await adapter.requestDevice({
    requiredFeatures: (['timestamp-query', 'subgroups', 'shader-f16', 'float32-filterable'] as GPUFeatureName[]).filter((feature) => adapter.features.has(feature)),
    requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
  });
  if (!device.features.has('timestamp-query')) throw new Error('timestamp-query is needed to time the GPU');
  querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  resolveBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  readBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const gpu = `${adapter.info.vendor} ${adapter.info.architecture} ${adapter.info.description}`.trim();
  print(`GPU ${gpu}; ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent}`);
  print(`features: ${features.join(', ')}`);
  print(`limits: ${Object.entries(limits).map(([name, value]) => `${name} ${value}`).join(', ')}`);

  const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | { error: string }> => {
    print(`\n${label}`);
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      print(`  failed: ${message}`);
      return { error: message };
    }
  };
  const splats = await attempt('Gaussian splats (16-bit counting sort by view depth + EWA splatting, back to front)', () => splatBench([1e6, 3e6, 6e6]));
  const crowd = await attempt('crowd (vertex animation textures, one instanced draw)', () => crowdBench([2000, 10000, 50000]));
  const video = await attempt('video textures (WebCodecs decode + importExternalTexture)', videoBench);
  const pathTracing = await attempt('path tracing (BVH2 in a compute shader: primary + 1 diffuse bounce + sun shadow rays)', () => pathTraceBench([100, 316]));
  return { gpu, features, limits, splats, crowd, video, pathTracing };
}

main().then((results) => {
  globals['capabilitiesResults'] = results;
  print('\ndone');
}).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  globals['capabilitiesError'] = message;
  print(`failed: ${message}`);
});
