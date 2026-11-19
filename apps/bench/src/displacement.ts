// 几何实验 E2（docs/vector-assets.md 的"几何"）：基础网格加位移微图，顶点着色器里按"基础三角形编号加重心坐标"现算位置，
// 比直接画同样多三角形的静态网格慢多少。数据由 packages/pipeline/experiments/displacement-storage.ts --export 导出。
// 两条路径画同样的三角形、同样的片元着色器（法线用屏幕导数现算），差别只在顶点怎么来：
//   位移：一个基础三角形一个实例，顶点缓冲是细分图案的 (i, j)；顶点着色器取三个基础顶点、插值、按格点的编号取 8 位的位移
//         （0..255 对应这一点的位移范围，范围从三个顶点各自的范围插值）；
//   静态：重建好的顶点和下标，一个物体一个实例。
// 先核对两条路径画出来的画面逐像素一致（格点编号算错了就不一致），再量 GPU 时间（时间戳查询，没有这个特性时退回等提交完成的墙钟时间）。
// 第二部分（每个基础三角形各选一个级别、边上缝合）在 displacement-lod.ts。
import { runLodExperiment, type LodResult } from './displacement-lod';
import { COLOR_FORMAT, DEPTH_FORMAT, runBench, type GpuBench } from './gpuBench';

export interface DisplacementResult {
  readonly copies: number;
  readonly triangles: number;
  readonly displacedMs: number;
  readonly staticMs: number;
}

export interface DisplacementResults {
  readonly results: DisplacementResult[];
  readonly lod: LodResult[];
  readonly differingPixels: number;
  readonly memory: Record<string, number>;
  readonly timing: string;
}

const WIDTH = 1280, HEIGHT = 720;

const COMMON = /* wgsl */ `
struct Scene {
  viewProjection: mat4x4f,
  // 细分的格数 n、不用、每个物体的基础三角形数、物体排成几列
  params: vec4f,
  // 物体之间的间距（xy），z 不用
  spacing: vec4f,
};
@group(0) @binding(0) var<uniform> scene: Scene;
struct Varyings { @builtin(position) position: vec4f, @location(0) world: vec3f };

/** 第 object 个物体摆在网格的哪里。 */
fn objectOffset(object: u32) -> vec3f {
  let columns = u32(scene.params.w);
  return vec3f(f32(object % columns) * scene.spacing.x, f32(object / columns) * scene.spacing.y, 0.0);
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let n = normalize(cross(dpdx(in.world), dpdy(in.world)));
  // 两面都照亮：模型的朝向和三角形的绕向不一定对着相机
  let light = abs(dot(n, normalize(vec3f(0.3, 0.5, 0.8)))) * 0.8 + 0.2;
  return vec4f(vec3f(light), 1.0);
}`;

const DISPLACED = /* wgsl */ `${COMMON}
struct Triangle { a: u32, b: u32, c: u32, ab: u32, ac: u32, bc: u32, interior: u32, pad: u32 };
@group(0) @binding(1) var<storage, read> positions: array<vec4f>;
@group(0) @binding(2) var<storage, read> normals: array<vec4f>;
@group(0) @binding(3) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(4) var<storage, read> displacement: array<u32>;

/** 边上离起点第 k 格的点的编号；最高位是 1 时这条边存的方向和三角形里的相反。 */
fn onEdge(edge: u32, k: u32, n: u32) -> u32 {
  return (edge & 0x7fffffffu) + select(k, n - k, (edge & 0x80000000u) != 0u) - 1u;
}

/** 格点 (i, j) 的采样点编号：顶点、边上的点在相邻的三角形之间共用（同 MicroGrid.sample）。 */
fn sampleIndex(t: Triangle, i: u32, j: u32, n: u32) -> u32 {
  if (i == 0u && j == 0u) { return t.a; }
  if (i == n) { return t.b; }
  if (j == n) { return t.c; }
  if (j == 0u) { return onEdge(t.ab, i, n); }
  if (i == 0u) { return onEdge(t.ac, j, n); }
  if (i + j == n) { return onEdge(t.bc, j, n); }
  return t.interior + (j - 1u) * (n - 1u) - (j - 1u) * j / 2u + (i - 1u);
}

@vertex fn vs(@location(0) ij: vec2u, @builtin(instance_index) instance: u32) -> Varyings {
  let n = u32(scene.params.x);
  let perObject = u32(scene.params.z);
  let t = triangles[instance % perObject];
  let w = vec3f(1.0 - f32(ij.x + ij.y) / f32(n), f32(ij.x) / f32(n), f32(ij.y) / f32(n));
  let base = positions[t.a].xyz * w.x + positions[t.b].xyz * w.y + positions[t.c].xyz * w.z;
  let normal = normalize(normals[t.a].xyz * w.x + normals[t.b].xyz * w.y + normals[t.c].xyz * w.z);
  let s = sampleIndex(t, ij.x, ij.y, n);
  // 位移 8 位，四个挤在一个 u32 里
  let quantized = (displacement[s >> 2u] >> ((s & 3u) * 8u)) & 0xffu;
  // 这一点的位移范围：三个顶点的下界（位置的 w）、上界（法线的 w）按重心坐标插值
  let low = dot(vec3f(positions[t.a].w, positions[t.b].w, positions[t.c].w), w);
  let high = dot(vec3f(normals[t.a].w, normals[t.b].w, normals[t.c].w), w);
  let world = base + normal * mix(low, high, f32(quantized) / 255.0) + objectOffset(instance / perObject);
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}`;

const STATIC = /* wgsl */ `${COMMON}
@vertex fn vs(@location(0) position: vec3f, @builtin(instance_index) instance: u32) -> Varyings {
  let world = position + objectOffset(instance);
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}`;

export interface DisplacedMesh {
  readonly level: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly samples: number;
  readonly microTriangles: number;
  readonly basePositions: Float32Array;
  readonly baseNormals: Float32Array;
  readonly layout: Uint32Array;
  readonly displacement: Uint8Array;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/** 格式见 displacement-storage.ts 的 exportForBench。 */
function parse(buffer: ArrayBuffer): DisplacedMesh {
  const header = new Uint32Array(buffer, 0, 8);
  if (header[0] !== 0x48534d44) throw new Error('not a displaced mesh file');
  const [, level, vertices, triangles, samples, microTriangles] = header as unknown as [number, number, number, number, number, number];
  let offset = 32;
  const take = <T>(make: (byteOffset: number, length: number) => T, length: number, bytesPerElement: number): T => {
    const view = make(offset, length);
    offset += length * bytesPerElement;
    return view;
  };
  return {
    level, vertices, triangles, samples, microTriangles,
    basePositions: take((o, n) => new Float32Array(buffer, o, n), vertices * 4, 4),
    baseNormals: take((o, n) => new Float32Array(buffer, o, n), vertices * 4, 4),
    layout: take((o, n) => new Uint32Array(buffer, o, n), triangles * 8, 4),
    displacement: take((o, n) => new Uint8Array(buffer, o, n), (samples + 3) & ~3, 1),
    positions: take((o, n) => new Float32Array(buffer, o, n), samples * 3, 4),
    indices: take((o, n) => new Uint32Array(buffer, o, n), microTriangles * 3, 4),
  };
}

/** 把模型转成"最长的轴朝上、最短的轴对着相机"（只是换轴，镜像了也没关系：两面都画）。 */
function upright(mesh: DisplacedMesh): DisplacedMesh {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, mesh.positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, mesh.positions[i]!);
  }
  const byExtent = [0, 1, 2].sort((a, b) => max[b]! - min[b]! - (max[a]! - min[a]!));
  // 新的 x、y、z 分别取原来的哪个轴
  const axes = [byExtent[1]!, byExtent[0]!, byExtent[2]!];
  const permute = (data: Float32Array, stride: number) => {
    // 先整份拷贝：基础顶点的第四个分量（位移范围）原样留着
    const out = data.slice();
    for (let v = 0; v < data.length; v += stride) for (let axis = 0; axis < 3; axis++) out[v + axis] = data[v + axes[axis]!]!;
    return out;
  };
  return { ...mesh, basePositions: permute(mesh.basePositions, 4), baseNormals: permute(mesh.baseNormals, 4), positions: permute(mesh.positions, 3) };
}

/** 一个基础三角形细分 n 格的图案：顶点是格点 (i, j)，三角形的朝向同 displacement-storage.ts 的 reconstruct。 */
function pattern(n: number): { vertices: Uint8Array; indices: Uint16Array } {
  const index = new Map<number, number>(), vertices: number[] = [];
  const at = (i: number, j: number) => {
    const key = j * (n + 1) + i;
    let found = index.get(key);
    if (found === undefined) {
      found = vertices.length / 2;
      index.set(key, found);
      vertices.push(i, j);
    }
    return found;
  };
  const indices: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - j; i++) {
      indices.push(at(i, j), at(i + 1, j), at(i, j + 1));
      if (i + j < n - 1) indices.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  // 顶点缓冲的步长要是 4 的倍数：每个顶点 (i, j, 0, 0)
  const padded = new Uint8Array((vertices.length / 2) * 4);
  for (let v = 0; v < vertices.length / 2; v++) padded.set([vertices[v * 2]!, vertices[v * 2 + 1]!], v * 4);
  return { vertices: padded, indices: Uint16Array.from(indices) };
}

/** 正交投影，把排成网格的物体整个放进画面（列主序，z 映射到 0..1）。 */
function orthographic(min: readonly number[], max: readonly number[]): Float32Array {
  const aspect = WIDTH / HEIGHT;
  let width = max[0]! - min[0]!, height = max[1]! - min[1]!;
  if (width / height < aspect) width = height * aspect;
  else height = width / aspect;
  const cx = (min[0]! + max[0]!) / 2, cy = (min[1]! + max[1]!) / 2, depth = max[2]! - min[2]! || 1;
  // 相机在 +z 一侧往 -z 看：近处的 z 大
  return new Float32Array([2 / width, 0, 0, 0, 0, 2 / height, 0, 0, 0, 0, -1 / depth, 0, (-2 * cx) / width, (-2 * cy) / height, max[2]! / depth, 1]);
}

async function main(bench: GpuBench): Promise<DisplacementResults> {
  const { device, upload, render, readPixels, print } = bench;
  // ?model=<名字>：public/content/displacement/<名字>.dmesh，默认 lucy
  const model = new URLSearchParams(location.search).get('model') ?? 'lucy';
  const mesh = upright(parse(await (await fetch(`/content/displacement/${model}.dmesh`)).arrayBuffer()));
  const n = 1 << mesh.level;
  print(`${mesh.triangles} base triangles, level ${mesh.level} (${n * n} micro triangles each), ${mesh.samples} samples, ${mesh.microTriangles} micro triangles`);

  const grid = pattern(n);
  const buffers = {
    scene: device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    basePositions: upload(mesh.basePositions, GPUBufferUsage.STORAGE),
    baseNormals: upload(mesh.baseNormals, GPUBufferUsage.STORAGE),
    layout: upload(mesh.layout, GPUBufferUsage.STORAGE),
    displacement: upload(mesh.displacement, GPUBufferUsage.STORAGE),
    patternVertices: upload(grid.vertices, GPUBufferUsage.VERTEX),
    patternIndices: upload(grid.indices, GPUBufferUsage.INDEX),
    staticVertices: upload(mesh.positions, GPUBufferUsage.VERTEX),
    staticIndices: upload(mesh.indices, GPUBufferUsage.INDEX),
  };
  const sizes = Object.fromEntries(Object.entries(buffers).map(([name, buffer]) => [name, buffer.size]));
  const memory = {
    // 现在这个页面里实际用的缓冲
    displacedBytes: sizes['basePositions']! + sizes['baseNormals']! + sizes['layout']! + sizes['displacement']! + sizes['patternVertices']! + sizes['patternIndices']!,
    staticBytes: sizes['staticVertices']! + sizes['staticIndices']!,
    // 静态网格按引擎的顶点格式算（位置 u16x4、法线 snorm8x4、UV u16x2，共 16 字节）
    staticEngineLayoutBytes: mesh.samples * 16 + mesh.microTriangles * 12,
  };
  print(`memory: displaced ${(memory.displacedBytes / 1024).toFixed(0)} KB, static ${(memory.staticBytes / 1024).toFixed(0)} KB (positions only) / ${(memory.staticEngineLayoutBytes / 1024).toFixed(0)} KB (engine vertex layout)`);

  const depthStencil = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' } as const;
  const primitive = { topology: 'triangle-list', cullMode: 'none' } as const;
  const displacedModule = device.createShaderModule({ code: DISPLACED }), staticModule = device.createShaderModule({ code: STATIC });
  const displacedPipeline = await device.createRenderPipelineAsync({
    layout: 'auto', primitive, depthStencil,
    vertex: { module: displacedModule, entryPoint: 'vs', buffers: [{ arrayStride: 4, stepMode: 'vertex', attributes: [{ shaderLocation: 0, offset: 0, format: 'uint8x2' }] }] },
    fragment: { module: displacedModule, entryPoint: 'fs', targets: [{ format: COLOR_FORMAT }] },
  });
  const staticPipeline = await device.createRenderPipelineAsync({
    layout: 'auto', primitive, depthStencil,
    vertex: { module: staticModule, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
    fragment: { module: staticModule, entryPoint: 'fs', targets: [{ format: COLOR_FORMAT }] },
  });
  const displacedGroup = device.createBindGroup({
    layout: displacedPipeline.getBindGroupLayout(0),
    entries: [buffers.scene, buffers.basePositions, buffers.baseNormals, buffers.layout, buffers.displacement].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const staticGroup = device.createBindGroup({ layout: staticPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buffers.scene } }] });

  // 物体排成网格；包围盒按重建出来的顶点算
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, mesh.positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, mesh.positions[i]!);
  }
  const spacing = [(max[0]! - min[0]!) * 1.05, (max[1]! - min[1]!) * 1.05];
  const setScene = (copies: number) => {
    const columns = Math.ceil(Math.sqrt(copies)), rows = Math.ceil(copies / columns);
    const data = new Float32Array(24);
    data.set(orthographic(min, [max[0]! + spacing[0]! * (columns - 1), max[1]! + spacing[1]! * (rows - 1), max[2]!]));
    data.set([n, 0, mesh.triangles, columns, spacing[0]!, spacing[1]!, 0, 0], 16);
    device.queue.writeBuffer(buffers.scene, 0, data);
  };

  /** 两条路径各画 copies 个物体。 */
  const frame = (displaced: boolean, copies: number) => (pass: GPURenderPassEncoder) => {
    if (displaced) {
      pass.setPipeline(displacedPipeline);
      pass.setBindGroup(0, displacedGroup);
      pass.setVertexBuffer(0, buffers.patternVertices);
      pass.setIndexBuffer(buffers.patternIndices, 'uint16');
      pass.drawIndexed(grid.indices.length, mesh.triangles * copies);
    } else {
      pass.setPipeline(staticPipeline);
      pass.setBindGroup(0, staticGroup);
      pass.setVertexBuffer(0, buffers.staticVertices);
      pass.setIndexBuffer(buffers.staticIndices, 'uint32');
      pass.drawIndexed(mesh.indices.length, copies);
    }
  };

  // 先核对：一个物体，两条路径的画面应该逐像素一样（同样的三角形；位置在着色器里算和在 CPU 上算有末位的差，允许差 2）
  setScene(1);
  await render(frame(true, 1));
  const displacedPixels = await readPixels();
  await render(frame(false, 1));
  const staticPixels = await readPixels();
  // 左上角是背景（模型没铺满画面）
  let differingPixels = 0, covered = 0;
  for (let p = 0; p < displacedPixels.length; p += 4) {
    if (staticPixels[p]! !== staticPixels[0]!) covered++;
    if (Math.abs(displacedPixels[p]! - staticPixels[p]!) > 2) differingPixels++;
  }
  bench.show(displacedPixels);
  print(`same image check: ${differingPixels} of ${WIDTH * HEIGHT} pixels differ by more than 2 (${covered} pixels covered by the model)`);

  const results: DisplacementResult[] = [];
  print('\ncopies   triangles   displaced ms   static ms   ratio');
  for (const copies of [1, 4, 16, 64]) {
    setScene(copies);
    const measure = (displaced: boolean) => bench.measure(frame(displaced, copies));
    // 两条路径交替量两轮取小的，免得被别的进程的抖动偏向一边
    const displacedMs = Math.min(await measure(true), await measure(true)), staticMs = Math.min(await measure(false), await measure(false));
    results.push({ copies, triangles: mesh.microTriangles * copies, displacedMs, staticMs });
    print(`${String(copies).padStart(6)} ${String(mesh.microTriangles * copies).padStart(11)} ${displacedMs.toFixed(3).padStart(14)} ${staticMs.toFixed(3).padStart(11)} ${(displacedMs / staticMs).toFixed(2).padStart(7)}`);
  }
  const lod = await runLodExperiment(bench, { mesh, buffers, bounds: { min, max }, pattern });
  return { results, lod, differingPixels, memory, timing: bench.timing };
}

runBench('displacement', [WIDTH, HEIGHT], main);
