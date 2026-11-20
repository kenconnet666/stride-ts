/**
 * 反射探针（ReflectionProbe 组件；Stride 没有，做法同 Unity、Godot 的盒子探针）：在探针的位置拍一张立方体贴图，预滤波成按粗糙度
 * 分级的镜面贴图，盒子里的表面的环境镜面反射用它代替天空盒（MeshRenderFeature 的 probeSpecular）。
 *
 * - 拍：每帧最多拍一个面（不卡顿），用前向渲染器画进 capture（6 层的 2D 数组）的那一层；视图不用方向光的阴影（级联是按主画面
 *   算的）。右手系的相机拍出来的画面和 WebGPU 立方体贴图的面左右相反，六个面齐了以后翻正画进 radiance、逐级缩小出 mip，再用
 *   CubemapPrefilter 预滤波进 cubes（立方体数组，每个探针占一个立方体）。拍的画面里照样有别的探针的反射，几次以后就是多次反射。
 * - 什么时候拍：refresh 是 once 的在加进来、挪了、改了设置、或者调 refresh() 以后拍一次；everyFrame 的拍完一轮接着拍。没拍完的
 *   探针着色时不用。
 * - 着色用的表（buffer）：拍好的探针按盒子的体积从小到大排（小的盖住大的），每个四个 vec4（见 PROBE_FLOATS）。
 * - 立方体数组按探针数取 2 的幂（最多 MAX_REFLECTION_PROBES），不够了换大的、全部重拍。
 */
import type { EntityId } from '../data/prop';
import { system } from '../engine/system';
import { Matrix } from '../mathematics/Matrix';
import { Transform } from '../engine/transform';
import { ReflectionProbe } from './components';
import { FULLSCREEN_VERTEX } from './fullscreen';
import type { GpuResources } from './GpuResources';
import { RenderView, type RenderContext } from './RenderSystem';

/** 同时在用的探针最多几个（再多的按体积小的优先，其余的不用）。 */
export const MAX_REFLECTION_PROBES = 16;
/** 着色用的表里每个探针几个 float：中心（拍的位置）和立方体的序号、盒子的最小角和过渡距离、最大角和强度、视差校正。 */
export const PROBE_FLOATS = 16;
const FORMAT: GPUTextureFormat = 'rgba16float';
/** 探针每个纹素的 GGX 采样数（源贴图带 mip，按立体角取 mip，比天空盒的 1024 少也不显噪声）。 */
const PREFILTER_SAMPLES = 256;
/** 拍的视图的近、远平面。 */
const NEAR = 0.05;
const FAR = 1000;

/** WebGPU 立方体贴图的六个面（+X、-X、+Y、-Y、+Z、-Z）：朝向和上方向（同 D3D 的约定）。 */
const FACES: readonly { readonly forward: readonly [number, number, number]; readonly up: readonly [number, number, number] }[] = [
  { forward: [1, 0, 0], up: [0, 1, 0] },
  { forward: [-1, 0, 0], up: [0, 1, 0] },
  { forward: [0, 1, 0], up: [0, 0, -1] },
  { forward: [0, -1, 0], up: [0, 0, 1] },
  { forward: [0, 0, 1], up: [0, 1, 0] },
  { forward: [0, 0, -1], up: [0, 1, 0] },
];

/** 翻正和缩小：从 2D 数组的一层取（flip 时左右翻），画进另一张贴图的一层。 */
const COPY_SHADER = /* wgsl */ `
${FULLSCREEN_VERTEX}
struct Params { layer: u32, flip: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d_array<f32>;
@group(0) @binding(2) var linearClamp: sampler;

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let uv = select(in.uv, vec2f(1.0 - in.uv.x, in.uv.y), params.flip == 1u);
  return vec4f(textureSampleLevel(source, linearClamp, uv, params.layer, 0.0).rgb, 1.0);
}`;
/** 每次绘制的参数占一块 uniform（动态偏移按 256 字节对齐）：先六个翻的面，再六个不翻的。 */
const PARAMS_STRIDE = 256;

/** 一个探针拍到哪了。 */
interface ProbeState {
  /** 在 cubes 里是第几个立方体。 */
  cube: number;
  /** 位置、盒子、设置拼成的键：变了就重拍。 */
  key: string;
  /** 拍好了（着色时用）。 */
  captured: boolean;
  /** 下一个要拍的面（0..5）；6 是这一轮拍完了。 */
  nextFace: number;
  everyFrame: boolean;
  /** 这一帧还在场景里。 */
  seen: boolean;
  readonly center: [number, number, number];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  blendDistance: number;
  intensity: number;
  boxProjection: boolean;
}

export class ReflectionProbes {
  /** 每个面的边长（像素，2 的幂）。改它要在第一次用之前。 */
  size = 128;
  /** 关掉时不拍、着色时也不用（画质档位、调试用）。 */
  enabled = true;
  /** 这一帧要拍的面的视图（begin 设，不拍时 undefined）。 */
  readonly view = Object.assign(new RenderView(), { receivesShadows: false });
  /** 着色用的探针表和个数（MeshRenderFeature 绑定）。 */
  readonly data = new Float32Array(MAX_REFLECTION_PROBES * PROBE_FLOATS);
  count = 0;
  /** 绑定的贴图或缓冲换了就加一（MeshRenderFeature 据此重建绑定组）。 */
  generation = 0;

  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #states = new Map<EntityId, ProbeState>();
  #cubes: GPUTexture;
  #capacity = 0;
  #capture: GPUTexture | undefined;
  #radiance: GPUTexture | undefined;
  #buffer: GPUBuffer;
  #copy: { readonly pipeline: GPURenderPipeline; readonly layout: GPUBindGroupLayout; readonly params: GPUBuffer } | undefined;
  /** 这一帧在拍哪个探针的哪个面。 */
  #capturing: { readonly state: ProbeState; readonly face: number } | undefined;
  /** 上一帧上传的表，没变就不传。 */
  readonly #uploaded = new Float32Array(MAX_REFLECTION_PROBES * PROBE_FLOATS);
  #uploadedCount = -1;

  readonly #collect = system('ReflectionProbes.collect', {
    with: { probe: ReflectionProbe, transform: Transform },
    update: ({ probe, transform, entities, count }) => {
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16, world = transform.world;
        const center: [number, number, number] = [world[w + 12]!, world[w + 13]!, world[w + 14]!];
        // 盒子跟实体的缩放（各轴的长度），不跟旋转
        const half = [0, 1, 2].map((axis) => Math.hypot(world[w + axis * 4]!, world[w + axis * 4 + 1]!, world[w + axis * 4 + 2]!) * probe.size[i * 3 + axis]! / 2);
        const blendDistance = probe.blendDistance[i]!, intensity = probe.intensity[i]!, boxProjection = probe.boxProjection[i] !== 0;
        const everyFrame = probe.refresh[i] === 'everyFrame';
        const key = [...center, ...half, blendDistance, boxProjection].join();
        let state = this.#states.get(entities[i]!);
        if (!state) {
          state = { cube: -1, key: '', captured: false, nextFace: 0, everyFrame, seen: true, center, min: [0, 0, 0], max: [0, 0, 0], blendDistance, intensity, boxProjection };
          this.#states.set(entities[i]!, state);
        }
        state.seen = true;
        state.everyFrame = everyFrame;
        state.intensity = intensity;
        if (state.key !== key) {
          // 挪了或改了盒子：重拍（拍好之前着色时不用它）
          state.key = key;
          state.captured = false;
          state.nextFace = 0;
          state.center.splice(0, 3, ...center);
          state.min.splice(0, 3, center[0] - half[0]!, center[1] - half[1]!, center[2] - half[2]!);
          state.max.splice(0, 3, center[0] + half[0]!, center[1] + half[1]!, center[2] + half[2]!);
          state.blendDistance = blendDistance;
          state.boxProjection = boxProjection;
        }
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
    this.#cubes = this.#createCubes(1, 1);
    this.#buffer = device.createBuffer({ label: 'ReflectionProbes', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /** 着色时采样的立方体数组（没有探针时是一张 1x1 的黑的）。 */
  get cubes(): GPUTexture {
    return this.#cubes;
  }

  /** 着色用的探针表。 */
  get buffer(): GPUBuffer {
    return this.#buffer;
  }

  /** 所有探针（refresh 是 once 的）下一轮重拍：场景里的东西挪了、灯变了以后调。 */
  refresh(): void {
    for (const state of this.#states.values()) state.nextFace = 0;
  }

  /**
   * 每帧开头（剔除之前）：收集探针，排着色用的表，挑这一帧要拍的面。返回要拍的面的视图，不拍时 undefined。
   */
  begin(context: RenderContext): RenderView | undefined {
    this.#capturing = undefined;
    for (const state of this.#states.values()) state.seen = false;
    if (this.enabled) context.game.entities.run(this.#collect, context.time);
    for (const [entity, state] of this.#states) if (!state.seen) this.#states.delete(entity);
    this.#allocate();
    this.#upload();
    if (!this.enabled) return undefined;
    // 先拍没拍完的（新加的、挪了的），再轮 everyFrame 的
    const states = [...this.#states.values()].filter((state) => state.cube >= 0);
    const next = states.find((state) => state.nextFace < 6) ?? states.find((state) => state.everyFrame);
    if (!next) return undefined;
    if (next.nextFace >= 6) next.nextFace = 0;
    const face = next.nextFace;
    this.#capturing = { state: next, face };
    const view = this.view;
    const { forward, up } = FACES[face]!;
    const [x, y, z] = next.center;
    Matrix.lookAtRH(view.view, next.center, [x + forward[0], y + forward[1], z + forward[2]], up);
    Matrix.perspectiveFovRH(view.projection, Math.PI / 2, 1, NEAR, FAR);
    view.nearClipPlane = NEAR;
    view.farClipPlane = FAR;
    view.width = view.height = this.size;
    view.update();
    return view;
  }

  /** 这一帧要拍的面画进哪（capture 的一层）；begin 返回了视图时才有。 */
  captureTarget(): GPUTextureView | undefined {
    if (!this.#capturing) return undefined;
    this.#capture ??= this.#device.createTexture({ label: 'ReflectionProbes capture', size: [this.size, this.size, 6], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    return this.#capture.createView({ dimension: '2d', baseArrayLayer: this.#capturing.face, arrayLayerCount: 1 });
  }

  /** 拍的面画完之后（录进同一个编码器）：六个面齐了就翻正、出 mip、预滤波进 cubes，这个探针算拍好了。 */
  finish(encoder: GPUCommandEncoder): void {
    const capturing = this.#capturing;
    if (!capturing) return;
    const { state, face } = capturing;
    state.nextFace = face + 1;
    if (state.nextFace < 6) return;
    const levels = Math.log2(this.size) + 1;
    this.#radiance ??= this.#device.createTexture({ label: 'ReflectionProbes radiance', size: [this.size, this.size, 6], format: FORMAT, mipLevelCount: levels, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const radiance = this.#radiance;
    const copy = (this.#copy ??= this.#createCopy());
    for (let level = 0; level < levels; level++) {
      // 第 0 级从拍的画面翻正，其余每级从上一级缩小（线性采样，一次就是 2x2 平均）
      const source = level === 0 ? this.#capture! : radiance;
      const sourceView = source.createView({ dimension: '2d-array', baseMipLevel: level === 0 ? 0 : level - 1, mipLevelCount: 1 });
      for (let f = 0; f < 6; f++) {
        const pass = encoder.beginRenderPass({
          label: `ReflectionProbes radiance level ${level} face ${f}`,
          colorAttachments: [{ view: radiance.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: f, arrayLayerCount: 1 }), loadOp: 'clear', storeOp: 'store' }],
        });
        pass.setPipeline(copy.pipeline);
        pass.setBindGroup(0, this.#device.createBindGroup({
          layout: copy.layout,
          entries: [
            { binding: 0, resource: { buffer: copy.params, size: 8 } },
            { binding: 1, resource: sourceView },
            { binding: 2, resource: this.#resources.linearClamp },
          ],
        }), [((level === 0 ? 0 : 6) + f) * PARAMS_STRIDE]);
        pass.draw(3);
        pass.end();
      }
    }
    this.#resources.prefilter.record(encoder, radiance, this.#cubes, state.cube * 6, PREFILTER_SAMPLES);
    state.captured = true;
  }

  destroy(): void {
    this.#cubes.destroy();
    this.#capture?.destroy();
    this.#radiance?.destroy();
    this.#buffer.destroy();
    this.#copy?.params.destroy();
  }

  /** 给探针分立方体：按体积从小到大，前 MAX_REFLECTION_PROBES 个有；立方体数组不够大就换大的、全部重拍。 */
  #allocate(): void {
    const states = [...this.#states.values()].sort((a, b) => volume(a) - volume(b));
    const wanted = Math.min(states.length, MAX_REFLECTION_PROBES);
    if (wanted > this.#capacity) {
      this.#capacity = 2 ** Math.ceil(Math.log2(wanted));
      this.#cubes.destroy();
      this.#cubes = this.#createCubes(this.size, this.#capacity);
      this.generation++;
      for (const state of states) {
        state.cube = -1;
        state.captured = false;
        state.nextFace = 0;
      }
    }
    const used = new Set(states.slice(0, wanted).map((state) => state.cube).filter((cube) => cube >= 0));
    let free = 0;
    states.forEach((state, i) => {
      if (i >= wanted) {
        state.cube = -1;
        state.captured = false;
        return;
      }
      if (state.cube >= 0) return;
      while (used.has(free)) free++;
      state.cube = free;
      used.add(free);
      state.captured = false;
      state.nextFace = 0;
    });
  }

  /** 着色用的表：拍好的探针，体积小的在前。没变就不传。 */
  #upload(): void {
    const data = this.data;
    data.fill(0);
    let count = 0;
    if (this.enabled) {
      for (const state of [...this.#states.values()].sort((a, b) => volume(a) - volume(b))) {
        if (!state.captured || state.cube < 0) continue;
        data.set([...state.center, state.cube, ...state.min, state.blendDistance, ...state.max, state.intensity, state.boxProjection ? 1 : 0, 0, 0, 0], count * PROBE_FLOATS);
        count++;
      }
    }
    this.count = count;
    if (count === this.#uploadedCount && data.every((value, i) => value === this.#uploaded[i])) return;
    this.#uploaded.set(data);
    this.#uploadedCount = count;
    this.#device.queue.writeBuffer(this.#buffer, 0, data);
  }

  #createCubes(size: number, count: number): GPUTexture {
    const levels = Math.log2(size) + 1;
    return this.#device.createTexture({
      label: `ReflectionProbes cubes (${count})`,
      size: [size, size, 6 * count],
      format: FORMAT,
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  #createCopy(): { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; params: GPUBuffer } {
    const module = this.#device.createShaderModule({ label: 'ReflectionProbes copy', code: COPY_SHADER });
    // 参数按动态偏移取，自动推导的布局不支持，显式写
    const layout = this.#device.createBindGroupLayout({
      label: 'ReflectionProbes copy',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 8 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const pipeline = this.#device.createRenderPipeline({
      label: 'ReflectionProbes copy',
      layout: this.#device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'fullscreenVertex' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
    });
    const params = new Uint32Array((12 * PARAMS_STRIDE) / 4);
    for (let i = 0; i < 12; i++) params.set([i % 6, i < 6 ? 1 : 0], (i * PARAMS_STRIDE) / 4);
    const buffer = this.#device.createBuffer({ label: 'ReflectionProbes copy params', size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.#device.queue.writeBuffer(buffer, 0, params);
    return { pipeline, layout, params: buffer };
  }
}

function volume(state: ProbeState): number {
  return (state.max[0] - state.min[0]) * (state.max[1] - state.min[1]) * (state.max[2] - state.min[2]);
}
