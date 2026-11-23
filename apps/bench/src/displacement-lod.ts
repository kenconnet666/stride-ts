// 几何实验 E2 的第二部分：每个基础三角形按它在屏幕上的大小各选一个细分级别，相邻两个级别不同时边上怎么不裂。
// 场景是一片往远处排开的同一个模型（透视相机），近处的细、远处的粗。
// - 级别：基础三角形最长的边在屏幕上有多少像素，除以想要的微三角形边长，取以 2 为底的对数，向上取整；
// - 缝合：一条边的级别取两侧三角形级别里小的那个；细的那一侧，边上的格点对齐到这条边级别的格点上（顶点着色器里做），
//   两侧边上的顶点就完全重合。对齐以后细的一侧沿边会有几个面积为 0 的三角形，不影响画面。
// - 查裂缝：背面涂成红的。有裂缝时从缝里能看到后面三角形的背面，红像素比全部用最细一级时（基准）多。
// 级别在 CPU 上逐帧选（这里只为实验，正式的做法是放进计算着色器，和剔除一起）。
import type { DisplacedMesh } from './displacement';
import { COLOR_FORMAT, DEPTH_FORMAT, type GpuBench } from './gpuBench';

export interface LodScene {
  readonly mesh: DisplacedMesh;
  readonly buffers: Readonly<Record<'basePositions' | 'baseNormals' | 'layout' | 'displacement' | 'staticVertices' | 'staticIndices', GPUBuffer>>;
  readonly bounds: { readonly min: readonly number[]; readonly max: readonly number[] };
  /** 细分 n 格的图案：顶点是格点 (i, j, 0, 0)，各一个字节。 */
  pattern(n: number): { vertices: Uint8Array; indices: Uint16Array };
}

export interface LodResult {
  readonly targetPixels: number;
  readonly triangles: number;
  readonly fullTriangles: number;
  readonly lodMs: number;
  readonly fullMs: number;
  readonly selectMs: number;
  readonly crackPixelsStitched: number;
  readonly crackPixelsUnstitched: number;
  readonly crackPixelsFull: number;
  readonly meanDifference: number;
}

const COLUMNS = 8, ROWS = 8;

const COMMON = /* wgsl */ `
struct Scene {
  viewProjection: mat4x4f,
  // 最细一级的格数、不用、要不要缝合（1 或 0）、正面和背面要不要对调（模型换轴以后可能镜像了）
  params: vec4f,
};
@group(0) @binding(0) var<uniform> scene: Scene;
@group(0) @binding(1) var<storage, read> objects: array<vec4f>;
struct Varyings { @builtin(position) position: vec4f, @location(0) world: vec3f };

@fragment fn fs(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = normalize(cross(dpdx(in.world), dpdy(in.world)));
  let light = abs(dot(n, normalize(vec3f(0.3, 0.5, 0.8)))) * 0.8 + 0.2;
  // 背面涂成红的：裂缝里才看得到
  let back = front == (scene.params.w > 0.5);
  return select(vec4f(vec3f(light), 1.0), vec4f(1.0, 0.0, 0.0, 1.0), back);
}`;

const DISPLACED = /* wgsl */ `${COMMON}
struct Triangle { a: u32, b: u32, c: u32, ab: u32, ac: u32, bc: u32, interior: u32, pad: u32 };
// levels：低 4 位是这个三角形的级别，往上每 4 位是 ab、ac、bc 三条边的级别
struct Instance { triangle: u32, object: u32, levels: u32, pad: u32 };
@group(0) @binding(2) var<storage, read> positions: array<vec4f>;
@group(0) @binding(3) var<storage, read> normals: array<vec4f>;
@group(0) @binding(4) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(5) var<storage, read> displacement: array<u32>;
@group(0) @binding(6) var<storage, read> instances: array<Instance>;

fn onEdge(edge: u32, k: u32, n: u32) -> u32 {
  return (edge & 0x7fffffffu) + select(k, n - k, (edge & 0x80000000u) != 0u) - 1u;
}

fn sampleIndex(t: Triangle, i: u32, j: u32, n: u32) -> u32 {
  if (i == 0u && j == 0u) { return t.a; }
  if (i == n) { return t.b; }
  if (j == n) { return t.c; }
  if (j == 0u) { return onEdge(t.ab, i, n); }
  if (i == 0u) { return onEdge(t.ac, j, n); }
  if (i + j == n) { return onEdge(t.bc, j, n); }
  return t.interior + (j - 1u) * (n - 1u) - (j - 1u) * j / 2u + (i - 1u);
}

/** 边上第 k 格对齐到粗 shift 级的格点上（四舍五入）。 */
fn snap(k: u32, shift: u32) -> u32 {
  return ((k + ((1u << shift) >> 1u)) >> shift) << shift;
}

@vertex fn vs(@location(0) ij: vec2u, @builtin(instance_index) index: u32) -> Varyings {
  let instance = instances[index];
  let t = triangles[instance.triangle];
  let level = instance.levels & 15u;
  let n = 1u << level;
  var i = ij.x;
  var j = ij.y;
  if (scene.params.z > 0.5) {
    if (j == 0u) {
      i = snap(i, level - ((instance.levels >> 4u) & 15u));
    } else if (i == 0u) {
      j = snap(j, level - ((instance.levels >> 8u) & 15u));
    } else if (i + j == n) {
      j = snap(j, level - ((instance.levels >> 12u) & 15u));
      i = n - j;
    }
  }
  let w = vec3f(1.0 - f32(i + j) / f32(n), f32(i) / f32(n), f32(j) / f32(n));
  let base = positions[t.a].xyz * w.x + positions[t.b].xyz * w.y + positions[t.c].xyz * w.z;
  let normal = normalize(normals[t.a].xyz * w.x + normals[t.b].xyz * w.y + normals[t.c].xyz * w.z);
  // 位移按最细一级存，粗的级别隔着取
  let finest = u32(scene.params.x);
  let stride = finest / n;
  let s = sampleIndex(t, i * stride, j * stride, finest);
  let quantized = (displacement[s >> 2u] >> ((s & 3u) * 8u)) & 0xffu;
  // 位移的范围按重心坐标从三个顶点插值（下界在位置的 w，上界在法线的 w）
  let low = dot(vec3f(positions[t.a].w, positions[t.b].w, positions[t.c].w), w);
  let high = dot(vec3f(normals[t.a].w, normals[t.b].w, normals[t.c].w), w);
  let world = base + normal * mix(low, high, f32(quantized) / 255.0) + objects[instance.object].xyz;
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}`;

const STATIC = /* wgsl */ `${COMMON}
@vertex fn vs(@location(0) position: vec3f, @builtin(instance_index) instance: u32) -> Varyings {
  let world = position + objects[instance].xyz;
  return Varyings(scene.viewProjection * vec4f(world, 1.0), world);
}`;

export async function runLodExperiment(bench: GpuBench, scene: LodScene): Promise<LodResult[]> {
  const { device, upload, print, width, height } = bench;
  const { mesh, buffers, bounds: { min, max } } = scene;
  const finestLevel = mesh.level, finest = 1 << finestLevel;
  const objectCount = COLUMNS * ROWS;

  // 物体排成一片，一排比一排远；相机在第一排前面，正对着它们的中间
  const extent = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
  const objects = new Float32Array(objectCount * 4);
  for (let o = 0; o < objectCount; o++) objects.set([(o % COLUMNS) * extent[0]! * 1.1, 0, -Math.floor(o / COLUMNS) * extent[1]! * 0.6], o * 4);
  const fov = Math.PI / 4, f = 1 / Math.tan(fov / 2), aspect = width / height;
  const near = extent[1]! * 0.05, far = extent[1]! * 40;
  const camera = [(min[0]! + max[0]! + (COLUMNS - 1) * extent[0]! * 1.1) / 2, (min[1]! + max[1]!) / 2 + extent[1]! * 0.25, max[2]! + extent[1]! * 0.9];
  // 透视投影（z 映射到 0..1）乘平移，列主序
  const viewProjection = new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0]);
  const m = viewProjection;
  const translated = [-camera[0]!, -camera[1]!, -camera[2]!];
  for (let row = 0; row < 4; row++) m[12 + row] = m[row]! * translated[0]! + m[4 + row]! * translated[1]! + m[8 + row]! * translated[2]! + m[12 + row]!;

  const sceneBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const setScene = (stitch: boolean, flip: boolean) => {
    const data = new Float32Array(20);
    data.set(viewProjection);
    data.set([finest, 0, stitch ? 1 : 0, flip ? 1 : 0], 16);
    device.queue.writeBuffer(sceneBuffer, 0, data);
  };
  const objectBuffer = upload(objects, GPUBufferUsage.STORAGE);
  const instanceData = new Uint32Array(objectCount * mesh.triangles * 4);
  const instanceBuffer = device.createBuffer({ size: instanceData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  // 每一级一个细分图案
  const patterns = Array.from({ length: finestLevel + 1 }, (_, level) => {
    const grid = scene.pattern(1 << level);
    return { vertices: upload(grid.vertices, GPUBufferUsage.VERTEX), indices: upload(grid.indices, GPUBufferUsage.INDEX), indexCount: grid.indices.length };
  });

  const depthStencil = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' } as const;
  const primitive = { topology: 'triangle-list', cullMode: 'none' } as const;
  const displacedModule = device.createShaderModule({ code: DISPLACED }), staticModule = device.createShaderModule({ code: STATIC });
  const displacedPipeline = await device.createRenderPipelineAsync({
    layout: 'auto', primitive, depthStencil,
    vertex: { module: displacedModule, entryPoint: 'vs', buffers: [{ arrayStride: 4, attributes: [{ shaderLocation: 0, offset: 0, format: 'uint8x2' }] }] },
    fragment: { module: displacedModule, entryPoint: 'fs', targets: [{ format: COLOR_FORMAT }] },
  });
  const staticPipeline = await device.createRenderPipelineAsync({
    layout: 'auto', primitive, depthStencil,
    vertex: { module: staticModule, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
    fragment: { module: staticModule, entryPoint: 'fs', targets: [{ format: COLOR_FORMAT }] },
  });
  const displacedGroup = device.createBindGroup({
    layout: displacedPipeline.getBindGroupLayout(0),
    entries: [sceneBuffer, objectBuffer, buffers.basePositions, buffers.baseNormals, buffers.layout, buffers.displacement, instanceBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })),
  });
  const staticGroup = device.createBindGroup({ layout: staticPipeline.getBindGroupLayout(0), entries: [sceneBuffer, objectBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })) });

  /**
   * 给每个物体的每个基础三角形选级别，边的级别取两侧小的，按级别排好写进实例缓冲。返回每一级有多少个实例。
   * 整个物体在相机后面或者画面外的这里不剔（实验里都在画面内）。
   */
  const edgeLevels = new Uint8Array(mesh.samples), triangleLevels = new Uint8Array(mesh.triangles);
  const pixelX = new Float32Array(mesh.vertices), pixelY = new Float32Array(mesh.vertices);
  const select = (targetPixels: number): number[] => {
    const counts = new Array<number>(finestLevel + 1).fill(0);
    const perObject: { levels: Uint8Array; edges: Uint8Array }[] = [];
    for (let o = 0; o < objectCount; o++) {
      for (let v = 0; v < mesh.vertices; v++) {
        const x = mesh.basePositions[v * 4]! + objects[o * 4]!, y = mesh.basePositions[v * 4 + 1]! + objects[o * 4 + 1]!, z = mesh.basePositions[v * 4 + 2]! + objects[o * 4 + 2]!;
        const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
        pixelX[v] = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w) * 0.5 * width;
        pixelY[v] = ((m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w) * 0.5 * height;
      }
      edgeLevels.fill(255);
      for (let t = 0; t < mesh.triangles; t++) {
        const a = mesh.layout[t * 8]!, b = mesh.layout[t * 8 + 1]!, c = mesh.layout[t * 8 + 2]!;
        const longest = Math.max(Math.hypot(pixelX[a]! - pixelX[b]!, pixelY[a]! - pixelY[b]!), Math.hypot(pixelX[a]! - pixelX[c]!, pixelY[a]! - pixelY[c]!), Math.hypot(pixelX[b]! - pixelX[c]!, pixelY[b]! - pixelY[c]!));
        const level = Math.min(finestLevel, Math.max(0, Math.ceil(Math.log2(longest / targetPixels))));
        triangleLevels[t] = level;
        for (let e = 0; e < 3; e++) {
          const edge = mesh.layout[t * 8 + 3 + e]! & 0x7fffffff;
          if (level < edgeLevels[edge]!) edgeLevels[edge] = level;
        }
        counts[level]!++;
      }
      perObject.push({ levels: triangleLevels.slice(), edges: edgeLevels.slice() });
    }
    // 按级别排：每一级在实例缓冲里占连续的一段
    const next = counts.map((_, level) => counts.slice(0, level).reduce((sum, count) => sum + count, 0));
    perObject.forEach(({ levels, edges }, o) => {
      for (let t = 0; t < mesh.triangles; t++) {
        const level = levels[t]!, at = next[level]!++ * 4;
        const edge = (e: number) => edges[mesh.layout[t * 8 + 3 + e]! & 0x7fffffff]!;
        instanceData[at] = t;
        instanceData[at + 1] = o;
        instanceData[at + 2] = level | (edge(0) << 4) | (edge(1) << 8) | (edge(2) << 12);
      }
    });
    return counts;
  };

  const drawLod = (counts: readonly number[]) => (pass: GPURenderPassEncoder) => {
    pass.setPipeline(displacedPipeline);
    pass.setBindGroup(0, displacedGroup);
    let first = 0;
    counts.forEach((count, level) => {
      if (count > 0) {
        pass.setVertexBuffer(0, patterns[level]!.vertices);
        pass.setIndexBuffer(patterns[level]!.indices, 'uint16');
        pass.drawIndexed(patterns[level]!.indexCount, count, 0, 0, first);
      }
      first += count;
    });
  };
  const drawFull = (pass: GPURenderPassEncoder) => {
    pass.setPipeline(staticPipeline);
    pass.setBindGroup(0, staticGroup);
    pass.setVertexBuffer(0, buffers.staticVertices);
    pass.setIndexBuffer(buffers.staticIndices, 'uint32');
    pass.drawIndexed(mesh.indices.length, objectCount);
  };
  const red = (pixels: Uint8Array) => {
    let count = 0;
    for (let p = 0; p < pixels.length; p += 4) if (pixels[p]! > 200 && pixels[p + 1]! < 60) count++;
    return count;
  };
  // 对照：全部用最细的静态网格。先定正反面：红的占了大半就是换轴时镜像了，对调
  setScene(true, false);
  await bench.render(drawFull);
  let flip = false, fullPixels = await bench.readPixels();
  if (red(fullPixels) > (width * height) / 20) {
    flip = true;
    setScene(true, true);
    await bench.render(drawFull);
    fullPixels = await bench.readPixels();
  }
  const fullMs = await bench.measure(drawFull), fullTriangles = mesh.microTriangles * objectCount, crackPixelsFull = red(fullPixels);
  print(`\nLOD: ${objectCount} objects in perspective, ${fullTriangles} triangles at the finest level, ${fullMs.toFixed(3)} ms; ${crackPixelsFull} red (back-face) pixels in the reference`);
  print('target px   triangles   LOD ms   select ms   crack px stitched / unstitched   mean difference to the reference');

  const results: LodResult[] = [];
  let shown: Uint8Array | undefined;
  for (const targetPixels of [1, 2, 4]) {
    const started = performance.now();
    const counts = select(targetPixels);
    const selectMs = performance.now() - started;
    device.queue.writeBuffer(instanceBuffer, 0, instanceData);
    const triangles = counts.reduce((sum, count, level) => sum + count * 4 ** level, 0);
    setScene(false, flip);
    await bench.render(drawLod(counts));
    const crackPixelsUnstitched = red(await bench.readPixels());
    setScene(true, flip);
    await bench.render(drawLod(counts));
    const pixels = await bench.readPixels();
    shown ??= pixels;
    let difference = 0;
    for (let p = 0; p < pixels.length; p += 4) difference += Math.abs(pixels[p]! - fullPixels[p]!);
    const lodMs = await bench.measure(drawLod(counts));
    const result = { targetPixels, triangles, fullTriangles, lodMs, fullMs, selectMs, crackPixelsStitched: red(pixels), crackPixelsUnstitched, crackPixelsFull, meanDifference: difference / (width * height) };
    results.push(result);
    print(`${String(targetPixels).padStart(9)} ${String(triangles).padStart(11)} ${lodMs.toFixed(3).padStart(8)} ${selectMs.toFixed(1).padStart(11)} ${String(result.crackPixelsStitched).padStart(18)} / ${String(crackPixelsUnstitched).padEnd(10)} ${result.meanDifference.toFixed(3).padStart(12)}   levels ${counts.join(', ')}`);
  }
  // 最细那一档缝合以后的画面放到页面上
  if (shown) bench.show(shown);
  return results;
}
