/**
 * 在模型上画贴图（S2；参考 ArmorPaint、Substance Painter 的做法）：笔刷在世界空间里是个球，画的时候把网格按 UV 当成二维画进
 * 一张工作贴图——顶点着色器输出 UV 位置、带上世界坐标，片元按到笔刷中心的距离算衰减，混进去。所以一笔落在哪个面上、跨了几个
 * UV 岛都对，接缝两边一起画到；三角形的边再画一遍线（1 像素），补上 UV 岛边上漏掉的像素。
 *
 * 投影绘制（brush.projection，同 Substance Painter 的 Projection 工具）：笔刷是画面上的一个圆，只画从这个视角看得见的地方——
 * 纹素投到主视图上一帧的深度图（graphicsCompositor.viewDepth，粒子碰撞也用它）里比深浅，被挡住的、背面的不画。一笔可以同时
 * 落在圆里的几个面上，也不会绕到模型背后去。要在画之前一帧 depth.use()（不然渲染器不留深度）。
 *
 * 画的是材质层的遮罩那种贴图：浏览器解码的 png、线性（rgba8unorm）、在 GPU 上生成 mip 的。一笔（stroke 里的几个点）画完拷回
 * 那张贴图（GpuResources.replaceLevel0），视口马上看到；read() 读回像素存盘。
 *
 *   const painter = new MeshPainter(game.renderSystem.resources, mask, game.graphicsCompositor.viewDepth);
 *   painter.dab([{ mesh, world }], { center, radius: 0.2, hardness: 0.5, strength: 1, value: [1, 1, 1, 1] });
 *   painter.commit();
 */
import type { GpuResources } from '../../graphics/GpuResources';
import { DEPTH_SURFACE_WGSL, type GpuDepthSurface } from '../DepthSurface';
import type { Texture } from '../../graphics/Texture';
import type { Mesh } from '../mesh/Mesh';
import { readTexture } from '../../graphics/readTexture';

/** 笔刷：世界空间里的球，中心衰减到边上。 */
export interface Brush {
  readonly center: readonly [number, number, number];
  /** 半径（米）。 */
  readonly radius: number;
  /** 0..1：多大一块是满的（1 是硬边）。 */
  readonly hardness: number;
  /** 0..1：一下盖上去多少。 */
  readonly strength: number;
  /** 画上去的值（rgba，线性）；擦掉就是画 0。 */
  readonly value: readonly [number, number, number, number];
  /**
   * 投影绘制（见文件开头）：笔刷是主视图画面上以 center（NDC）为圆心、radius（NDC 的竖直单位，画面高是 2）的圆，aspect 是画面的
   * 宽高比，origin 是渲染原点（深度图的视图投影是相对它的）。这时 center、radius 这两个球的字段不用。
   */
  readonly projection?: { readonly center: readonly [number, number]; readonly radius: number; readonly aspect: number; readonly origin: readonly [number, number, number] };
}

/** 画在哪：网格和它的世界矩阵（列主序；双精度的在投影绘制时先减渲染原点再降成单精度）。 */
export interface PaintTarget {
  readonly mesh: Mesh;
  readonly world: Float32Array | Float64Array;
}

const FORMAT: GPUTextureFormat = 'rgba8unorm';
const UNIFORM_BYTES = 128;

const SHADER = /* wgsl */ `
struct Dab {
  world: mat4x4f,
  /** xyz：中心，w：半径。 */
  sphere: vec4f,
  /** x：硬度，y：强度，z：1 是投影绘制。 */
  shape: vec4f,
  value: vec4f,
  /** 投影绘制：xy 圆心（NDC），z 半径（NDC 的竖直单位），w 画面的宽高比。 */
  screen: vec4f,
};
@group(0) @binding(0) var<uniform> dab: Dab;
${DEPTH_SURFACE_WGSL}

/** 投影绘制：world（渲染空间）在画面上离圆心多远（半径的倍数）；看不见（被挡住、背面、画面外）时是 2。 */
fn projectedDistance(world: vec3f) -> f32 {
  if (surface.valid.x == 0u) { return 2.0; }
  let c = surface.viewProjection * vec4f(world, 1.0);
  if (c.w <= 0.0) { return 2.0; }
  let ndc = c.xyz / c.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return 2.0; }
  let size = vec2i(surface.valid.yz);
  let depth = textureLoad(surfaceDepth, clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1), 0);
  // 反向 Z（近 1 远 0）：纹素在画面上那一点的表面前面或者就是它才看得见；留一点相对的余量（深度图是上一帧、按像素取的）
  let tolerance = max(abs(depth) * 0.004, 1e-6);
  let visible = select(ndc.z <= depth + tolerance, ndc.z >= depth - tolerance, surface.valid.w == 1u);
  if (!visible) { return 2.0; }
  return length((ndc.xy - dab.screen.xy) * vec2f(dab.screen.w, 1.0)) / max(dab.screen.z, 1e-6);
}
struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
};
@vertex fn vs(@location(0) position: vec3f, @location(1) uv: vec2f) -> Varyings {
  var out: Varyings;
  out.position = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.world = (dab.world * vec4f(position, 1.0)).xyz;
  return out;
}
@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  let d = select(distance(in.world, dab.sphere.xyz) / max(dab.sphere.w, 1e-6), projectedDistance(in.world), dab.shape.z > 0.5);
  let falloff = 1.0 - smoothstep(dab.shape.x, 1.0, d);
  if (falloff <= 0.0) { discard; }
  return vec4f(dab.value.rgb, falloff * dab.shape.y);
}
`;

/** 网格画在 UV 空间里要的缓冲：位置加 UV 的顶点、三角形、三角形的边。 */
interface MeshBuffers {
  readonly vertices: GPUBuffer;
  readonly triangles: GPUBuffer;
  readonly triangleCount: number;
  readonly edges: GPUBuffer;
  readonly edgeCount: number;
}

export class MeshPainter {
  readonly texture: Texture;
  readonly #resources: GpuResources;
  readonly #device: GPUDevice;
  readonly #work: GPUTexture;
  readonly #uniforms: GPUBuffer;
  readonly #depth: GpuDepthSurface;
  readonly #layout: GPUBindGroupLayout;
  readonly #fill: GPURenderPipeline;
  readonly #lines: GPURenderPipeline;
  readonly #meshes = new Map<Mesh, MeshBuffers>();
  #dirty = false;

  /**
   * texture：要画的贴图（材质已经在用的那份，线性的 png）。开始时把它现在的内容拷进工作贴图。depth：投影绘制看可见性用的主视图
   * 深度（graphicsCompositor.viewDepth）。
   */
  constructor(resources: GpuResources, texture: Texture, depth: GpuDepthSurface) {
    if (texture.data.format !== FORMAT) throw new Error(`MeshPainter: '${texture.name}' is ${texture.data.format}; only linear ${FORMAT} images (a mask) can be painted`);
    this.texture = texture;
    this.#resources = resources;
    this.#depth = depth;
    const device = (this.#device = resources.device);
    const source = resources.texture(texture);
    this.#work = device.createTexture({
      label: `paint ${texture.name}`, size: [source.width, source.height], format: FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    // 拷不了（贴图不能拷出去）时 WebGPU 只在错误范围里报：报出来，不然会从一张全黑的图画起，原来的内容丢掉
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder({ label: 'MeshPainter begin' });
    encoder.copyTextureToTexture({ texture: source }, { texture: this.#work }, [source.width, source.height]);
    device.queue.submit([encoder.finish()]);
    void device.popErrorScope().then((error) => error && console.error(`[stride] MeshPainter: cannot copy '${texture.name}' to paint on it: ${error.message}`));
    this.#uniforms = device.createBuffer({ label: 'MeshPainter dab', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'MeshPainter', code: SHADER });
    const layout = this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    });
    const pipeline = (topology: GPUPrimitiveTopology) => device.createRenderPipeline({
      label: `MeshPainter ${topology}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }] }] },
      // 颜色按衰减混进去，alpha 留着原来的
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } } }] },
      primitive: { topology },
    });
    this.#fill = pipeline('triangle-list');
    this.#lines = pipeline('line-list');
  }

  /** 画一下（一个笔刷印）到这些网格上。一笔里的几个印画完调 commit。 */
  dab(targets: readonly PaintTarget[], brush: Brush): void {
    const device = this.#device;
    const projection = brush.projection;
    // 深度图换过（窗口改了大小）时绑定组跟着换：每一下现建，很便宜
    const group = device.createBindGroup({
      layout: this.#layout,
      entries: [{ binding: 0, resource: { buffer: this.#uniforms } }, { binding: 2, resource: this.#depth.depthView }, { binding: 3, resource: { buffer: this.#depth.uniform } }],
    });
    for (const { mesh, world } of targets) {
      const data = new Float32Array(UNIFORM_BYTES / 4);
      data.set(world, 0);
      // 投影绘制在渲染空间里比（深度图的视图投影相对渲染原点）：平移先按双精度减掉原点
      if (projection) for (let i = 0; i < 3; i++) data[12 + i] = world[12 + i]! - projection.origin[i]!;
      data.set([...brush.center, brush.radius], 16);
      data.set([Math.min(Math.max(brush.hardness, 0), 0.999), Math.min(Math.max(brush.strength, 0), 1), projection ? 1 : 0, 0], 20);
      data.set(brush.value, 24);
      if (projection) data.set([...projection.center, projection.radius, projection.aspect], 28);
      // 每个网格一次提交：同一个统一缓冲在提交前写两次，两次绘制读到的都是后写的值
      device.queue.writeBuffer(this.#uniforms, 0, data);
      const buffers = this.#buffersFor(mesh);
      const encoder = device.createCommandEncoder({ label: 'MeshPainter dab' });
      const pass = encoder.beginRenderPass({ label: 'MeshPainter', colorAttachments: [{ view: this.#work.createView(), loadOp: 'load', storeOp: 'store' }] });
      pass.setBindGroup(0, group);
      pass.setVertexBuffer(0, buffers.vertices);
      pass.setPipeline(this.#fill);
      pass.setIndexBuffer(buffers.triangles, 'uint32');
      pass.drawIndexed(buffers.triangleCount * 3);
      pass.setPipeline(this.#lines);
      pass.setIndexBuffer(buffers.edges, 'uint32');
      pass.drawIndexed(buffers.edgeCount * 2);
      pass.end();
      device.queue.submit([encoder.finish()]);
      this.#dirty = true;
    }
  }

  /** 画好的拷回贴图（重建 mip），用到它的材质马上显示。 */
  commit(): void {
    if (!this.#dirty) return;
    this.#resources.replaceLevel0(this.texture, this.#work);
    this.#dirty = false;
  }

  /** 读回现在的像素（RGBA8，一行紧挨一行），存成 png 用。 */
  async read(): Promise<{ readonly width: number; readonly height: number; readonly rgba: Uint8Array<ArrayBuffer> }> {
    const { width, height } = this.#work;
    return { width, height, rgba: await readTexture(this.#device, this.#work, 4) };
  }

  destroy(): void {
    this.#work.destroy();
    this.#uniforms.destroy();
    for (const buffers of this.#meshes.values()) for (const buffer of [buffers.vertices, buffers.triangles, buffers.edges]) buffer.destroy();
    this.#meshes.clear();
  }

  #buffersFor(mesh: Mesh): MeshBuffers {
    let buffers = this.#meshes.get(mesh);
    if (buffers) return buffers;
    const positions = mesh.positions(), uvs = mesh.uvs(), indices = mesh.data.indices;
    const vertices = new Float32Array((positions.length / 3) * 5);
    for (let v = 0; v < positions.length / 3; v++) {
      vertices.set(positions.subarray(v * 3, v * 3 + 3), v * 5);
      vertices.set(uvs.subarray(v * 2, v * 2 + 2), v * 5 + 3);
    }
    const triangles = Uint32Array.from(indices);
    const edges = new Uint32Array(triangles.length * 2);
    for (let t = 0; t < triangles.length; t += 3) {
      const [a, b, c] = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
      edges.set([a, b, b, c, c, a], t * 2);
    }
    const upload = (data: Float32Array | Uint32Array, usage: number, label: string) => {
      const buffer = this.#device.createBuffer({ label: `MeshPainter ${label}`, size: Math.max(4, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      this.#device.queue.writeBuffer(buffer, 0, data);
      return buffer;
    };
    buffers = {
      vertices: upload(vertices, GPUBufferUsage.VERTEX, 'vertices'),
      triangles: upload(triangles, GPUBufferUsage.INDEX, 'triangles'), triangleCount: triangles.length / 3,
      edges: upload(edges, GPUBufferUsage.INDEX, 'edges'), edgeCount: edges.length / 2,
    };
    this.#meshes.set(mesh, buffers);
    return buffers;
  }
}

/** 解码过的顶点位置（射线求交每帧都要，网格的数据不变）。 */
const decoded = new WeakMap<Mesh, Float32Array>();

/**
 * 射线和网格的最近交点（Möller–Trumbore，两面都算）：origin、direction 在世界空间，world 是网格的世界矩阵。没打到是 undefined。
 * 在 CPU 上算：绘制要的是画笔落在哪个面上，用编号缓冲的点选只知道是哪个实体。
 */
export function raycastMesh(mesh: Mesh, world: Float32Array | Float64Array, origin: readonly number[], direction: readonly number[]): { readonly distance: number; readonly point: [number, number, number]; readonly normal: [number, number, number] } | undefined {
  let positions = decoded.get(mesh);
  if (!positions) decoded.set(mesh, (positions = mesh.positions()));
  const indices = mesh.data.indices;
  const p = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) {
    const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
    for (let k = 0; k < 3; k++) p[v + k] = world[k]! * x + world[4 + k]! * y + world[8 + k]! * z + world[12 + k]!;
  }
  let best: { distance: number; point: [number, number, number]; normal: [number, number, number] } | undefined;
  const [ox, oy, oz] = origin as [number, number, number], [dx, dy, dz] = direction as [number, number, number];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3, b = indices[i + 1]! * 3, c = indices[i + 2]! * 3;
    const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
    const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - p[a]!, ty = oy - p[a + 1]!, tz = oz - p[a + 2]!;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 0 || (best && t >= best.distance)) continue;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const length = Math.hypot(nx, ny, nz) || 1;
    best = { distance: t, point: [ox + dx * t, oy + dy * t, oz + dz * t], normal: [nx / length, ny / length, nz / length] };
  }
  return best;
}
