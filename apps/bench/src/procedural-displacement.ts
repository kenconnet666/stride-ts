// 几何实验 E3（docs/vector-assets.md 的"几何"）：位移由材质图的高度输出给出时，比只出法线好多少、贵多少。
// 一面 4 × 2 米的砖墙，高度是一个程序化的函数（砖、灰缝、每块砖高低不同、表面的噪声）。先把它求值成一页贴图
// （高度、砖的遮罩、法线；2 毫米一个纹素，带 mip），这是"按页求值"的做法，三条路径都采这一页：
//   法线：一个平面（两个三角形），法线取自贴图；
//   视差：同一个平面，片元着色器里沿视线在高度场里步进找交点（视差遮蔽映射），再取法线；
//   位移：平面细分成格子，顶点着色器里采高度、沿法线抬起来，片元着色器里取法线。
// 三个视角（正面、贴着墙面的掠射角、近处斜着看）各量 GPU 时间，画面和最细的位移比（平均每通道差多少）。
import { COLOR_FORMAT, DEPTH_FORMAT, runBench, type Draw, type GpuBench } from './gpuBench';

export interface ProceduralPath {
  readonly name: string;
  readonly triangles: number;
  readonly ms: number;
  /** 和最细的位移的画面平均每通道差多少（0..255）。 */
  readonly difference: number;
}

export interface ProceduralResults {
  /** 求值一页（含 mip）的 GPU 时间。 */
  readonly bakeMs: number;
  readonly pageBytes: number;
  readonly views: { readonly view: string; readonly paths: ProceduralPath[] }[];
  readonly timing: string;
}

const WIDTH = 1280, HEIGHT = 720;
const WALL = [4, 2] as const;
/** 灰缝到砖面的高差（米）。 */
const AMPLITUDE = 0.012;
const PAGE = [2048, 1024] as const, PAGE_FORMAT: GPUTextureFormat = 'rgba16float';
/** 位移的格子边长（毫米）。 */
const CELLS = [16, 8, 4, 2];

const FULLSCREEN = /* wgsl */ `
struct Fullscreen { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> Fullscreen {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return Fullscreen(vec4f(corner * 2.0 - 1.0, 0.0, 1.0), vec2f(corner.x, 1.0 - corner.y));
}`;

/** 程序化的砖墙：p 是墙面上的位置（米），返回高度（0..1）和砖的遮罩。 */
const BAKE = /* wgsl */ `${FULLSCREEN}
fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var sum = 0.0;
  var scale = 0.5;
  var q = p;
  for (var octave = 0; octave < 4; octave++) {
    sum += noise(q) * scale;
    q *= 2.03;
    scale *= 0.5;
  }
  return sum;
}
fn wall(p: vec2f) -> vec2f {
  let size = vec2f(0.24, 0.08);
  let row = floor(p.y / size.y);
  let q = vec2f(p.x / size.x + 0.5 * (row % 2.0), p.y / size.y);
  let f = fract(q);
  // 到砖的边有多远（米）
  let edge = min(min(f.x, 1.0 - f.x) * size.x, min(f.y, 1.0 - f.y) * size.y);
  let brick = smoothstep(0.006, 0.014, edge);
  let top = 0.7 + 0.3 * hash(floor(q)) - fbm(p * 70.0) * 0.18;
  let mortar = 0.08 + fbm(p * 150.0) * 0.12;
  return vec2f(mix(mortar, top, brick), brick);
}
@fragment fn fs(in: Fullscreen) -> @location(0) vec4f {
  let p = vec2f(in.uv.x, 1.0 - in.uv.y) * vec2f(${WALL[0]}, ${WALL[1]});
  let here = wall(p);
  // 法线：高度的差分（间隔半个纹素），高度乘上实际的高差
  let e = ${WALL[0] / PAGE[0] / 2};
  let dx = (wall(p + vec2f(e, 0.0)).x - wall(p - vec2f(e, 0.0)).x) / (2.0 * e) * ${AMPLITUDE};
  let dy = (wall(p + vec2f(0.0, e)).x - wall(p - vec2f(0.0, e)).x) / (2.0 * e) * ${AMPLITUDE};
  let n = normalize(vec3f(-dx, -dy, 1.0));
  return vec4f(here.x, here.y, n.x, n.y);
}`;

const DOWNSAMPLE = /* wgsl */ `${FULLSCREEN}
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var bilinear: sampler;
@fragment fn fs(in: Fullscreen) -> @location(0) vec4f {
  return textureSampleLevel(source, bilinear, in.uv, 0.0);
}`;

const WALL_SHADER = /* wgsl */ `
struct Scene {
  viewProjection: mat4x4f,
  eye: vec4f,
  // 位移的格子：列数、行数、采高度用的 mip；视差的步数
  params: vec4f,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var page: texture_2d<f32>;
@group(0) @binding(2) var bilinear: sampler;
struct Varyings { @builtin(position) position: vec4f, @location(0) world: vec3f };
const WALL = vec2f(${WALL[0]}, ${WALL[1]});
const AMPLITUDE = ${AMPLITUDE};

fn pageUv(p: vec2f) -> vec2f {
  return vec2f(p.x / WALL.x, 1.0 - p.y / WALL.y);
}

/** 平面：两个三角形，放在砖面的高度上。 */
@vertex fn vsFlat(@builtin(vertex_index) index: u32) -> Varyings {
  let corner = vec2f(f32(index & 1u), f32((index >> 1u) & 1u));
  let world = vec3f(corner * WALL, AMPLITUDE);
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}

/** 位移：格点由顶点的编号算出来，高度从这一页里采。 */
@vertex fn vsDisplaced(@builtin(vertex_index) index: u32) -> Varyings {
  let columns = u32(scene.params.x);
  let cell = vec2f(f32(index % (columns + 1u)), f32(index / (columns + 1u))) / scene.params.xy;
  let p = cell * WALL;
  let world = vec3f(p, textureSampleLevel(page, bilinear, pageUv(p), scene.params.z).r * AMPLITUDE);
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}

/** 按这一页里的遮罩和法线着色；导数用平面上的位置的（视差挪过以后的位置在遮挡的边上是断的）。 */
fn shade(p: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f {
  let texel = textureSampleGrad(page, bilinear, pageUv(p), ddx, ddy);
  let n = normalize(vec3f(texel.zw, sqrt(max(1.0 - dot(texel.zw, texel.zw), 0.0))));
  let albedo = mix(vec3f(0.62, 0.6, 0.57), vec3f(0.55, 0.22, 0.16), texel.g);
  let light = normalize(vec3f(0.4, 0.7, 0.6));
  return vec4f(albedo * (0.25 + 0.75 * max(dot(n, light), 0.0)), 1.0);
}

@fragment fn fsPlain(in: Varyings) -> @location(0) vec4f {
  let uv = pageUv(in.world.xy);
  return shade(in.world.xy, dpdx(uv), dpdy(uv));
}

/** 视差遮蔽：从平面（砖面的高度）沿视线往墙里走，走到低于高度场为止，再二分几次。 */
@fragment fn fsParallax(in: Varyings) -> @location(0) vec4f {
  let uv = pageUv(in.world.xy);
  let ddx = dpdx(uv);
  let ddy = dpdy(uv);
  let lod = log2(max(length(ddx * vec2f(${PAGE[0]}, ${PAGE[1]})), length(ddy * vec2f(${PAGE[0]}, ${PAGE[1]}))));
  let direction = normalize(in.world - scene.eye.xyz);
  // 走到墙的底（z = 0）要多远；贴着墙面看时限制在 12 倍高差以内
  let reach = AMPLITUDE / max(-direction.z, 1.0 / 12.0);
  let steps = i32(scene.params.w);
  let stride = reach / f32(steps);
  var near = 0.0;
  for (var i = 0; i < steps; i++) {
    let at = in.world + direction * (near + stride);
    if (at.z <= textureSampleLevel(page, bilinear, pageUv(at.xy), lod).r * AMPLITUDE) { break; }
    near += stride;
  }
  var far = near + stride;
  for (var i = 0; i < 4; i++) {
    let middle = (near + far) * 0.5;
    let at = in.world + direction * middle;
    if (at.z <= textureSampleLevel(page, bilinear, pageUv(at.xy), lod).r * AMPLITUDE) { far = middle; } else { near = middle; }
  }
  return shade((in.world + direction * far).xy, ddx, ddy);
}`;

/** 列主序的 4×4 矩阵相乘。 */
function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] = out[column * 4 + row]! + a[k * 4 + row]! * b[column * 4 + k]!;
    }
  }
  return out;
}

/** 右手系、往 -z 看、z 映射到 0..1 的透视投影乘视图矩阵。 */
function camera(eye: readonly number[], target: readonly number[]): Float32Array {
  const f = 1 / Math.tan((50 * Math.PI) / 360), near = 0.02, far = 20;
  const projection = new Float32Array([f / (WIDTH / HEIGHT), 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
  const normalize = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const back = normalize([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!]);
  const right = normalize(cross([0, 1, 0], back)), up = cross(back, right);
  const view = new Float32Array([right[0]!, up[0]!, back[0]!, 0, right[1]!, up[1]!, back[1]!, 0, right[2]!, up[2]!, back[2]!, 0, -dot(right, eye), -dot(up, eye), -dot(back, eye), 1]);
  return multiply(projection, view);
}

const VIEWS: readonly { name: string; eye: readonly number[]; target: readonly number[] }[] = [
  { name: 'front (2.2 m away)', eye: [2, 1, 2.2], target: [2, 1, 0] },
  { name: 'grazing (along the wall)', eye: [-0.2, 1.1, 0.22], target: [3, 0.9, 0] },
  { name: 'close (0.3 m, oblique)', eye: [1.0, 1.05, 0.22], target: [1.35, 0.95, 0] },
];

async function main(bench: GpuBench): Promise<ProceduralResults> {
  const { device, print } = bench;
  const bilinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  // 求值一页：最细一级跑程序化的函数，其余各级逐级缩小
  const levels = Math.floor(Math.log2(Math.max(...PAGE))) + 1;
  const page = device.createTexture({ size: [...PAGE], format: PAGE_FORMAT, mipLevelCount: levels, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  const bakeModule = device.createShaderModule({ code: BAKE }), downModule = device.createShaderModule({ code: DOWNSAMPLE });
  const bakePipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: bakeModule, entryPoint: 'vs' }, fragment: { module: bakeModule, entryPoint: 'fs', targets: [{ format: PAGE_FORMAT }] } });
  const downPipeline = await device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: downModule, entryPoint: 'vs' }, fragment: { module: downModule, entryPoint: 'fs', targets: [{ format: PAGE_FORMAT }] } });
  const bake = async () => {
    const encoder = device.createCommandEncoder();
    for (let level = 0; level < levels; level++) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: page.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(level === 0 ? bakePipeline : downPipeline);
      if (level > 0) {
        pass.setBindGroup(0, device.createBindGroup({
          layout: downPipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: page.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) }, { binding: 1, resource: bilinear }],
        }));
      }
      pass.draw(3);
      pass.end();
    }
    const started = performance.now();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - started;
  };
  await bake();
  // 第一次含编译管线的时间，再求值几次取最小的
  const bakeMs = Math.min(await bake(), await bake(), await bake());
  const pageBytes = Math.round((PAGE[0] * PAGE[1] * 8 * 4) / 3);
  print(`page: ${PAGE[0]}x${PAGE[1]} ${PAGE_FORMAT} with mips (${(pageBytes / 1024 / 1024).toFixed(1)} MB), evaluated in ${bakeMs.toFixed(2)} ms (wall clock until the queue is done)`);

  const module = device.createShaderModule({ code: WALL_SHADER });
  const depthStencil = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' } as const;
  const pipeline = (vertex: string, fragment: string, topology: GPUPrimitiveTopology) => device.createRenderPipelineAsync({
    layout: 'auto', depthStencil, primitive: { topology, cullMode: 'none' },
    vertex: { module, entryPoint: vertex }, fragment: { module, entryPoint: fragment, targets: [{ format: COLOR_FORMAT }] },
  });
  const flat = await pipeline('vsFlat', 'fsPlain', 'triangle-strip'), parallax = await pipeline('vsFlat', 'fsParallax', 'triangle-strip');
  const displaced = await pipeline('vsDisplaced', 'fsPlain', 'triangle-list');
  const sceneBuffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const group = (target: GPURenderPipeline) => device.createBindGroup({
    layout: target.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: sceneBuffer } }, { binding: 1, resource: page.createView() }, { binding: 2, resource: bilinear }],
  });
  const groups = new Map([flat, parallax, displaced].map((target) => [target, group(target)]));

  // 位移的格子：每档一个下标缓冲（顶点由编号算，不用顶点缓冲）
  const grids = CELLS.map((millimeters) => {
    const columns = Math.round((WALL[0] * 1000) / millimeters), rows = Math.round((WALL[1] * 1000) / millimeters);
    const indices = new Uint32Array(columns * rows * 6);
    for (let y = 0, at = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const a = y * (columns + 1) + x, b = a + columns + 1;
        indices.set([a, a + 1, b, a + 1, b + 1, b], at);
        at += 6;
      }
    }
    // 采高度用的 mip：一个格子盖几个纹素
    const lod = Math.max(0, Math.log2(millimeters / ((WALL[0] * 1000) / PAGE[0])));
    return { millimeters, columns, rows, lod, indexCount: indices.length, indices: bench.upload(indices, GPUBufferUsage.INDEX) };
  });

  let viewProjection: Float32Array = new Float32Array(16), eye: readonly number[] = [0, 0, 0];
  const setScene = (params: readonly number[]) => {
    const data = new Float32Array(24);
    data.set(viewProjection);
    data.set([...eye, 1, ...params], 16);
    device.queue.writeBuffer(sceneBuffer, 0, data);
  };
  type Path = { name: string; triangles: number; params: readonly number[]; draw: Draw };
  const plane = (name: string, target: GPURenderPipeline, steps: number): Path => ({
    name, triangles: 2, params: [1, 1, 0, steps],
    draw: (pass) => {
      pass.setPipeline(target);
      pass.setBindGroup(0, groups.get(target)!);
      pass.draw(4);
    },
  });
  const paths: Path[] = [
    plane('normal map', flat, 0), plane('parallax, 16 steps', parallax, 16), plane('parallax, 48 steps', parallax, 48),
    ...grids.map((grid): Path => ({
      name: `displaced, ${grid.millimeters} mm cells`, triangles: grid.columns * grid.rows * 2, params: [grid.columns, grid.rows, grid.lod, 0],
      draw: (pass) => {
        pass.setPipeline(displaced);
        pass.setBindGroup(0, groups.get(displaced)!);
        pass.setIndexBuffer(grid.indices, 'uint32');
        pass.drawIndexed(grid.indexCount);
      },
    })),
  ];

  const views: ProceduralResults['views'] = [];
  for (const view of VIEWS) {
    viewProjection = camera(view.eye, view.target);
    eye = view.eye;
    print(`\n${view.name}\npath                       triangles       ms   difference to the finest displaced`);
    const measured: { path: Path; ms: number; pixels: Uint8Array }[] = [];
    for (const path of paths) {
      setScene(path.params);
      await bench.render(path.draw);
      measured.push({ path, ms: Infinity, pixels: await bench.readPixels() });
    }
    // 所有路径轮着量三轮、各取最小的：负载轻的时候显卡会降频，单独一轮里个别路径会慢出几倍
    for (let round = 0; round < 3; round++) {
      for (const entry of measured) {
        setScene(entry.path.params);
        entry.ms = Math.min(entry.ms, await bench.measure(entry.path.draw, 20));
      }
    }
    const reference = measured.at(-1)!.pixels;
    const results = measured.map(({ path, ms, pixels }) => {
      let sum = 0;
      for (let p = 0; p < pixels.length; p += 4) sum += Math.abs(pixels[p]! - reference[p]!) + Math.abs(pixels[p + 1]! - reference[p + 1]!) + Math.abs(pixels[p + 2]! - reference[p + 2]!);
      const result = { name: path.name, triangles: path.triangles, ms, difference: sum / (WIDTH * HEIGHT * 3) };
      print(`${result.name.padEnd(24)} ${String(result.triangles).padStart(11)} ${ms.toFixed(3).padStart(8)} ${result.difference.toFixed(2).padStart(8)}`);
      return result;
    });
    views.push({ view: view.name, paths: results });
    // 掠射角和近处的画面放到页面上：法线、视差 48 步、最细的位移
    if (view !== VIEWS[0]) for (const index of [0, 2, measured.length - 1]) bench.show(measured[index]!.pixels);
  }
  return { bakeMs, pageBytes, views, timing: bench.timing };
}

runBench('procedural', [WIDTH, HEIGHT], main);
