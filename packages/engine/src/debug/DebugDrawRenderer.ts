/**
 * 把 game.debugDraw 的线画到后备缓冲上（场景和后处理之后、UI 之前）：每条线一个四边形，顶点着色器里在屏幕上沿线的法线撑开成
 * 固定的像素宽度，片元着色器按到线段的距离算覆盖率（解析的抗锯齿，两头是圆的）。宽度是整数个设备像素，不随距离、分辨率变糊。
 *
 * 用主相机的视图；和场景比深度的线读主画面的深度缓冲（只读），所以有这种线的时候前向渲染器要把深度留着
 * （ForwardRenderer 看 debugDraw.tested.count）。
 *
 * 没变就不做：线没变（DebugDraw.version 没动）就不重新上传；一条线都没有时什么都不做。
 */
import type { Game } from '../games/Game';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import { DEBUG_LINE_FLOATS } from './DebugDraw';

/** 线的深度往相机挪的比例：离相机 10 米的线挪 2 厘米。 */
const DEPTH_BIAS = 0.002;

const SHADER = /* wgsl */ `
struct Frame {
  viewProjection: mat4x4f,
  // 画面的宽高（设备像素）、一个 CSS 像素是几个设备像素
  viewport: vec4f,
  // 相机的位置；w 是深度的偏移：线的深度按"往相机挪这么大比例的距离"算
  eye: vec4f,
};
// a：起点、线宽（CSS 像素）；b：终点；color：线性的颜色
struct Line { a: vec4f, b: vec4f, color: vec4f };
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> lines: array<Line>;

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  // 这个像素在线段的坐标系里（像素）：x 沿着线从起点量，y 是离线的距离
  @location(1) local: vec2f,
  // 线段在屏幕上的长度、半宽（像素）
  @location(2) @interpolate(flat) size: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Varyings {
  let line = lines[instance];
  var c0 = frame.viewProjection * vec4f(line.a.xyz, 1.0);
  var c1 = frame.viewProjection * vec4f(line.b.xyz, 1.0);
  // 贴在表面上的线（地面上的网格、包围盒的棱）和表面的深度一样，会一段有一段没有：深度按离相机近一点点的位置算
  // （位置不动，只改深度），线就稳稳地压在表面上
  let b0 = frame.viewProjection * vec4f(mix(line.a.xyz, frame.eye.xyz, frame.eye.w), 1.0);
  let b1 = frame.viewProjection * vec4f(mix(line.b.xyz, frame.eye.xyz, frame.eye.w), 1.0);
  c0.z = b0.z / b0.w * c0.w;
  c1.z = b1.z / b1.w * c1.w;
  var out: Varyings;
  // 两头都在近平面后面：整条不画（放到裁剪范围外）
  if (c0.z < 0.0 && c1.z < 0.0) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  // 一头在近平面后面：沿线段挪到近平面上（不然除以 w 以后会翻到屏幕另一边）
  if (c0.z < 0.0) { c0 = mix(c0, c1, c0.z / (c0.z - c1.z)); }
  if (c1.z < 0.0) { c1 = mix(c1, c0, c1.z / (c1.z - c0.z)); }
  let halfViewport = frame.viewport.xy * 0.5;
  let s0 = c0.xy / c0.w * halfViewport;
  let s1 = c1.xy / c1.w * halfViewport;
  let delta = s1 - s0;
  let segment = length(delta);
  let along = select(vec2f(1.0, 0.0), delta / segment, segment > 1e-6);
  let across = vec2f(-along.y, along.x);
  // 整数个设备像素，至少 1
  let halfWidth = max(1.0, round(line.a.w * frame.viewport.z)) * 0.5;
  // 四边形比线宽出一个像素：抗锯齿的边和圆头
  let extent = halfWidth + 1.0;
  let atEnd = f32(vertex & 1u);
  let side = f32(vertex >> 1u) * 2.0 - 1.0;
  let clip = select(c0, c1, atEnd > 0.5);
  let screen = select(s0, s1, atEnd > 0.5) + across * side * extent + along * (atEnd * 2.0 - 1.0) * extent;
  out.position = vec4f(screen / halfViewport * clip.w, clip.z, clip.w);
  out.color = line.color;
  out.local = vec2f(atEnd * segment + (atEnd * 2.0 - 1.0) * extent, side * extent);
  out.size = vec2f(segment, halfWidth);
  return out;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  // 到线段（不是到直线）的距离：过了两头以后按到端点的距离算，头就是圆的
  let beyond = max(max(-in.local.x, in.local.x - in.size.x), 0.0);
  let distance = length(vec2f(beyond, in.local.y));
  let coverage = saturate(in.size.y + 0.5 - distance);
  let alpha = in.color.a * coverage;
  return vec4f(in.color.rgb * alpha, alpha);
}
`;

interface Gpu {
  readonly layout: GPUBindGroupLayout;
  readonly module: GPUShaderModule;
  readonly uniforms: GPUBuffer;
}

export class DebugDrawRenderer {
  #gpu: Gpu | undefined;
  #lines: GPUBuffer | undefined;
  #bindGroup: GPUBindGroup | undefined;
  readonly #pipelines = new Map<string, GPURenderPipeline>();
  #uploaded = -1;
  readonly #frame = new Float32Array(24);

  /** @internal 每帧画完场景之后、UI 之前。 */
  draw(game: Game): void {
    const debugDraw = game.debugDraw;
    const { tested, overlay } = debugDraw;
    const total = tested.count + overlay.count;
    const compositor = game.graphicsCompositor;
    const view = compositor.mainView;
    if (!debugDraw.visible || total === 0 || !view) return;
    const graphicsDevice = game.graphicsDevice;
    const { device, canvas } = graphicsDevice;
    const gpu = (this.#gpu ??= this.#create(device));
    // 两组线连着放进一个缓冲：先是比深度的，后是画在最上面的
    if (!this.#lines || this.#lines.size < total * DEBUG_LINE_FLOATS * 4) {
      this.#lines?.destroy();
      let capacity = 1024;
      while (capacity < total) capacity *= 2;
      this.#lines = device.createBuffer({ label: 'DebugDraw lines', size: capacity * DEBUG_LINE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.#bindGroup = device.createBindGroup({ label: 'DebugDraw', layout: gpu.layout, entries: [{ binding: 0, resource: { buffer: gpu.uniforms } }, { binding: 1, resource: { buffer: this.#lines } }] });
      this.#uploaded = -1;
    }
    if (this.#uploaded !== debugDraw.version) {
      this.#uploaded = debugDraw.version;
      if (tested.count > 0) device.queue.writeBuffer(this.#lines, 0, tested.data, 0, tested.count * DEBUG_LINE_FLOATS);
      if (overlay.count > 0) device.queue.writeBuffer(this.#lines, tested.count * DEBUG_LINE_FLOATS * 4, overlay.data, 0, overlay.count * DEBUG_LINE_FLOATS);
    }
    this.#frame.set(view.viewProjection);
    this.#frame.set([canvas.width, canvas.height, canvas.width / Math.max(1, canvas.clientWidth), 0], 16);
    this.#frame.set([view.eye.x, view.eye.y, view.eye.z, DEPTH_BIAS], 20);
    device.queue.writeBuffer(gpu.uniforms, 0, this.#frame);

    // 比深度的线要主画面的深度缓冲；没有（这一帧没留）时它们不画
    const depth = tested.count > 0 ? compositor.mainDepth : undefined;
    const format = graphicsDevice.backBufferViewFormat;
    const pass = graphicsDevice.frameEncoder.beginRenderPass({
      label: 'DebugDraw',
      colorAttachments: [{ view: graphicsDevice.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }],
      ...(depth ? { depthStencilAttachment: { view: depth.createView(), depthReadOnly: true } } : {}),
    });
    pass.setBindGroup(0, this.#bindGroup!);
    if (depth) {
      pass.setPipeline(this.#pipeline(device, gpu, format, 'less-equal'));
      pass.draw(4, tested.count, 0, 0);
    }
    if (overlay.count > 0) {
      pass.setPipeline(this.#pipeline(device, gpu, format, depth ? 'always' : undefined));
      pass.draw(4, overlay.count, 0, tested.count);
    }
    pass.end();
  }

  destroy(): void {
    this.#gpu?.uniforms.destroy();
    this.#lines?.destroy();
    this.#gpu = undefined;
    this.#lines = undefined;
    this.#pipelines.clear();
  }

  #create(device: GPUDevice): Gpu {
    const layout = device.createBindGroupLayout({
      label: 'DebugDraw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    return {
      layout,
      module: device.createShaderModule({ label: 'DebugDraw', code: SHADER }),
      uniforms: device.createBuffer({ label: 'DebugDraw frame', size: this.#frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    };
  }

  /** depthCompare 是 undefined 时这一遍没有深度附件。 */
  #pipeline(device: GPUDevice, gpu: Gpu, format: GPUTextureFormat, depthCompare: GPUCompareFunction | undefined): GPURenderPipeline {
    const key = `${format}:${depthCompare ?? 'none'}`;
    let pipeline = this.#pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: `DebugDraw ${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layout] }),
        vertex: { module: gpu.module, entryPoint: 'vs' },
        fragment: {
          module: gpu.module,
          entryPoint: 'fs',
          // 预乘 alpha
          targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
        },
        primitive: { topology: 'triangle-strip' },
        ...(depthCompare ? { depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare } } : {}),
      });
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }
}
