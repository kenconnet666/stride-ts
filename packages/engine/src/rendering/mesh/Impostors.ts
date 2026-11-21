/**
 * 远处卡片（impostor，W4；参考 Unreal 的 Impostor Baker、Ryan Brucks 的 Octahedral Impostors、SpeedTree 的 billboard）：远处的树
 * 换成一张转向相机的四边形，贴的是这棵树从几个方向拍下来的样子。一棵树几千个三角形换成两个，几百米外成片的林子也画得起。
 *
 * 烘（运行时，第一次要时；同一个模型只烘一次）：
 * - 模型临时挂在一个实体上，放进烘焙的渲染组（RENDER_GROUP_BAKE：相机、阴影、探针都不画它）；下一帧前向渲染器多画
 *   IMPOSTOR_FRAMES 个正交视图，绕竖直轴每 360° / 格数 一个方向，画进一张一行排开的图集：颜色图是材质的漫反射色（材质层、
 *   Alpha 裁剪都照材质算，不受光照：卡片着色时照常受光、投影、淋雨积雪），法线图是那个视图的右、上、朝相机框架里的法线加粗糙度。
 *   植被的风在烘的视图里不吹（RenderView.windless）。
 * - 透明的像素用最近的不透明像素的颜色填上（alpha 还是 0），往下的 mip 在叶子的边上不混进黑色；mip 在 GPU 上生成，Alpha 裁剪的
 *   覆盖率照网格着色器的做法按级放大。
 * - 再下一帧开头拷进卡片材质的两张贴图，拿掉临时的实体，交出卡片的模型。
 *
 * 画（网格着色器的 vsImpostor）：四个顶点都在卡片中心，按相机转开；图集的格子按相机在实例自己的朝向里的方位角选最近的一格。
 * 阴影、天空遮挡这种正交的视图里卡片整个转向光。卡片是一个普通的材质（颜色、法线贴图、Alpha 裁剪），植被的风按源模型材质里
 * 最大的弯曲照常摆（不抖）。
 *
 * 只有绕竖直轴的方向：从高处往下看远处的林子，卡片是侧面的样子（八面体的半球卡片以后要再做）。换格子是跳的（相邻两格不混）。
 *
 *   const far = await game.renderSystem.impostors.impostor(game, await game.content.loadModel('Trees/Oak'));
 *   game.content.addModel(entity, far);
 */
import type { LoadedModel } from '../../content/ContentManager';
import { FLOAT_LAYOUT, VERTEX_FLOATS } from '../../content/format';
import { Matrix } from '../../data/Matrix';
import type { Game } from '../../engine/Game';
import type { Entity } from '../../engine/Entity';
import { Transform } from '../../engine/transform';
import type { GpuResources } from '../../graphics/GpuResources';
import { Texture } from '../../graphics/Texture';
import { RENDER_GROUP_BAKE, RenderStage, RenderView, type RenderContext } from '../RenderSystem';
import { Material } from './Material';
import { IMPOSTOR_FRAMES, Mesh } from './Mesh';
import type { MeshRenderFeature } from './MeshRenderFeature';

const ALBEDO_FORMAT: GPUTextureFormat = 'rgba8unorm-srgb';
const NORMAL_FORMAT: GPUTextureFormat = 'rgba8unorm';
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
/** 透明的像素往外找不透明像素找多远（像素）。 */
const DILATE_RADIUS = 48;

const DILATE_SHADER = /* wgsl */ `
@group(0) @binding(0) var albedo: texture_2d<f32>;
@group(0) @binding(1) var normal: texture_2d<f32>;
override FRAME_SIZE: i32 = 256;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

struct Out {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
};

/** 不透明的像素原样；透明的取同一格里离它最近的不透明像素（8 个方向，越远步子越大）的颜色和法线，alpha 留 0。 */
@fragment fn fs(@builtin(position) position: vec4f) -> Out {
  let at = vec2i(position.xy);
  let own = textureLoad(albedo, at, 0);
  if (own.a > 0.0) {
    return Out(own, textureLoad(normal, at, 0));
  }
  let lo = vec2i((at.x / FRAME_SIZE) * FRAME_SIZE, 0);
  let hi = lo + vec2i(FRAME_SIZE - 1, FRAME_SIZE - 1);
  var r = 1;
  loop {
    if (r > ${DILATE_RADIUS}) { break; }
    for (var k = 0; k < 8; k++) {
      let angle = f32(k) * 0.78539816;
      let q = clamp(at + vec2i(round(vec2f(cos(angle), sin(angle)) * f32(r))), lo, hi);
      let found = textureLoad(albedo, q, 0);
      if (found.a > 0.0) {
        return Out(vec4f(found.rgb, 0.0), textureLoad(normal, q, 0));
      }
    }
    r += max(1, r / 4);
  }
  return Out(vec4f(0.0), vec4f(0.5, 0.5, 1.0, 1.0));
}
`;

interface DilatePipeline {
  readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly frameSize: number;
}

interface Request {
  readonly entity: Entity;
  /** 卡片的边长、中心的高度（模型空间，米）。 */
  readonly size: number;
  readonly centerY: number;
  readonly result: LoadedModel;
  readonly resolve: (model: LoadedModel) => void;
}

/** 烘焙用的几张贴图（同一时间只烘一个，复用；图集变大时重建）。 */
interface Targets {
  readonly width: number;
  readonly height: number;
  readonly albedo: GPUTexture;
  readonly normal: GPUTexture;
  readonly depth: GPUTexture;
  readonly albedoOut: GPUTexture;
  readonly normalOut: GPUTexture;
  readonly group: GPUBindGroup;
}

export class ImpostorBaker {
  /** 图集里一格的边长（像素）。改它只影响之后烘的。 */
  frameSize = 256;
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #cache = new WeakMap<LoadedModel, Promise<LoadedModel>>();
  readonly #queue: Request[] = [];
  readonly #views: RenderView[] = [];
  #stage: RenderStage | undefined;
  #dilate: DilatePipeline | undefined;
  #targets: Targets | undefined;
  /** 这一帧要画的、上一帧画好等着拷的。 */
  #drawing: Request | undefined;
  #drawn: Request | undefined;

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 烘的阶段（网格特性按它选 fsImpostorBake 的管线）。 */
  get stage(): RenderStage {
    return (this.#stage ??= new RenderStage('ImpostorBake', { colorFormat: ALBEDO_FORMAT, depthFormat: DEPTH_FORMAT, surfaceFormats: [NORMAL_FORMAT] }, { impostor: true }));
  }

  /** 有没有在烘的（调试、冒烟等它烘完）。 */
  get pending(): number {
    return this.#queue.length + (this.#drawing ? 1 : 0) + (this.#drawn ? 1 : 0);
  }

  /** model 的远处卡片：第一次要时排进烘焙（管线编好后的下一帧画、再下一帧交出），同一个模型拿同一个。 */
  impostor(game: Game, model: LoadedModel): Promise<LoadedModel> {
    let promise = this.#cache.get(model);
    if (!promise) {
      promise = this.#request(game, model);
      this.#cache.set(model, promise);
    }
    return promise;
  }

  async #request(game: Game, model: LoadedModel): Promise<LoadedModel> {
    const first = model.meshes[0];
    if (!first) throw new Error('ImpostorBaker: the model has no meshes');
    // 网格名是"模型路径/网格"：卡片按模型命名
    const name = first.mesh.name.includes('/') ? first.mesh.name.slice(0, first.mesh.name.lastIndexOf('/')) : first.mesh.name;
    let radius = 0, y0 = Infinity, y1 = -Infinity;
    for (const { mesh } of model.meshes) {
      const { min, max } = mesh.bounds;
      radius = Math.max(radius, Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2]));
      y0 = Math.min(y0, min[1]);
      y1 = Math.max(y1, max[1]);
    }
    // 卡片是正方形（图集的格子是正方形），留一点边，免得叶子的尖贴着格子的边
    const size = Math.max(2 * radius, y1 - y0) * 1.04, centerY = (y0 + y1) / 2;
    const materials = model.meshes.map(({ material }) => (material === null ? null : model.materials[material]) ?? game.content.defaultMaterial);
    // 管线在后台编好再画，烘的那一帧不卡
    await Promise.all(model.meshes.map(({ mesh, skin }, i) => game.meshes.warm(mesh, materials[i]!, skin !== undefined, false, [this.stage])));
    const width = this.frameSize * IMPOSTOR_FRAMES, height = this.frameSize;
    const atlas = (suffix: string, format: GPUTextureFormat) => new Texture(`${name} impostor ${suffix}`, { format, width, height, levels: [new Uint8Array(width * height * 4)], generateMipmaps: true });
    const albedo = atlas('albedo', ALBEDO_FORMAT), normal = atlas('normal', NORMAL_FORMAT);
    // 植被的风：源模型材质里最大的弯曲（卡片不抖：四个角一起抖没有意义）
    const bend = Math.max(0, ...materials.map((material) => material.wind?.bend ?? 0));
    const material = new Material(`${name} impostor`, {
      baseColorTexture: { texture: albedo },
      normalMap: { texture: normal, scaleAndBias: true, isXYNormal: false },
      glossinessMap: { texture: normal, channel: 'a', invert: true },
      metalness: 0,
      alphaCutoff: 0.5,
      ...(bend > 0 ? { wind: { bend, flutter: 0 } } : {}),
    });
    const result: LoadedModel = { meshes: [{ mesh: impostorMesh(`${name} impostor`, size, centerY), material: 0 }], materials: [material] };
    const entity = game.entities.create({ name: `${name} impostor bake`, components: [Transform] });
    game.content.addModel(entity, model, { isShadowCaster: false, renderGroup: RENDER_GROUP_BAKE });
    // 编辑状态下视口按需出帧：烘完（两帧）之前一直出帧
    const release = game.holdFrames();
    return new Promise((resolve) => this.#queue.push({ entity, size, centerY, result, resolve: (card) => { release(); resolve(card); } }));
  }

  /**
   * @internal 前向渲染器每帧开头调：上一帧画好的拷进卡片的贴图、交出去；有排着的就给出这一帧要画的视图（和别的视图一起剔除、
   * 写常量）。
   */
  begin(): readonly RenderView[] {
    this.#commit();
    const request = (this.#drawing = this.#queue.shift());
    if (!request) return [];
    const world = request.entity.require(Transform).renderWorld;
    const center = [world[12]!, world[13]! + request.centerY, world[14]!];
    const half = request.size / 2, distance = request.size;
    for (let k = 0; k < IMPOSTOR_FRAMES; k++) {
      const view = (this.#views[k] ??= Object.assign(new RenderView(), { receivesShadows: false, reversedDepth: false, windless: true, cullingMask: 1 << RENDER_GROUP_BAKE }));
      const angle = (k / IMPOSTOR_FRAMES) * Math.PI * 2;
      Matrix.lookAtRH(view.view, [center[0]! + Math.sin(angle) * distance, center[1]!, center[2]! + Math.cos(angle) * distance], center, [0, 1, 0]);
      Matrix.orthoOffCenterRH(view.projection, -half, half, -half, half, 0, distance * 2);
      view.nearClipPlane = 0;
      view.farClipPlane = distance * 2;
      view.width = view.height = this.frameSize;
      view.viewport = { x: k * this.frameSize, y: 0, width: this.frameSize, height: this.frameSize };
      view.update();
    }
    return this.#views;
  }

  /** @internal 前向渲染器在剔除、写完常量之后调（begin 给了视图的帧）：各个方向画进图集，再填透明的像素。 */
  draw(context: RenderContext, encoder: GPUCommandEncoder, meshes: MeshRenderFeature): void {
    const request = this.#drawing;
    if (!request) return;
    this.#drawing = undefined;
    const targets = this.#targetsFor(this.frameSize * IMPOSTOR_FRAMES, this.frameSize);
    const pass = encoder.beginRenderPass({
      label: 'ImpostorBake',
      colorAttachments: [
        { view: targets.albedo.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
        { view: targets.normal.createView(), clearValue: [0.5, 0.5, 1, 1], loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: targets.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    for (const view of this.#views) {
      const { x, y, width, height } = view.viewport!;
      pass.setViewport(x, y, width, height, 0, 1);
      meshes.draw(context, pass, view, this.stage);
    }
    pass.end();
    const dilate = encoder.beginRenderPass({
      label: 'ImpostorBake dilate',
      colorAttachments: [
        { view: targets.albedoOut.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' },
        { view: targets.normalOut.createView(), loadOp: 'clear', clearValue: [0.5, 0.5, 1, 1], storeOp: 'store' },
      ],
    });
    dilate.setPipeline(this.#dilatePipeline().pipeline);
    dilate.setBindGroup(0, targets.group);
    dilate.draw(3);
    dilate.end();
    this.#drawn = request;
  }

  destroy(): void {
    this.#destroyTargets();
  }

  #commit(): void {
    const request = this.#drawn;
    if (!request) return;
    this.#drawn = undefined;
    const targets = this.#targets!;
    const material = request.result.materials[0]!;
    this.#resources.replaceLevel0(material.baseColorTexture!.texture, targets.albedoOut);
    this.#resources.replaceLevel0(material.normalMap!.texture, targets.normalOut);
    request.entity.destroy();
    request.resolve(request.result);
  }

  #targetsFor(width: number, height: number): Targets {
    const current = this.#targets;
    if (current && current.width === width && current.height === height) return current;
    this.#destroyTargets();
    const device = this.#device;
    const texture = (label: string, format: GPUTextureFormat, usage: number) => device.createTexture({ label: `ImpostorBake ${label}`, size: [width, height], format, usage });
    const drawn = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, out = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    const albedo = texture('albedo', ALBEDO_FORMAT, drawn), normal = texture('normal', NORMAL_FORMAT, drawn);
    const targets: Targets = {
      width, height, albedo, normal,
      depth: texture('depth', DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT),
      albedoOut: texture('albedo out', ALBEDO_FORMAT, out),
      normalOut: texture('normal out', NORMAL_FORMAT, out),
      group: device.createBindGroup({ layout: this.#dilatePipeline().layout, entries: [{ binding: 0, resource: albedo.createView() }, { binding: 1, resource: normal.createView() }] }),
    };
    this.#targets = targets;
    return targets;
  }

  #dilatePipeline(): DilatePipeline {
    if (this.#dilate && this.#dilate.frameSize === this.frameSize) return this.#dilate;
    const device = this.#device;
    const module = device.createShaderModule({ label: 'ImpostorBake dilate', code: DILATE_SHADER });
    const layout = device.createBindGroupLayout({
      entries: [0, 1].map((binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' as const } })),
    });
    const pipeline = device.createRenderPipeline({
      label: 'ImpostorBake dilate',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', constants: { FRAME_SIZE: this.frameSize }, targets: [{ format: ALBEDO_FORMAT }, { format: NORMAL_FORMAT }] },
    });
    return (this.#dilate = { pipeline, layout, frameSize: this.frameSize });
  }

  #destroyTargets(): void {
    const targets = this.#targets;
    if (!targets) return;
    for (const texture of [targets.albedo, targets.normal, targets.depth, targets.albedoOut, targets.normalOut]) texture.destroy();
    this.#targets = undefined;
  }
}

/**
 * 卡片的网格（MeshData.impostor）：四个顶点都在 (0, centerY, 0)，法线的 xy 是角离中心的偏移，UV 是格子里的位置（格子由
 * vsImpostor 选）。剔除的包围盒是卡片转到任何方向都包得住的那个立方体。
 */
export function impostorMesh(name: string, size: number, centerY: number): Mesh {
  const h = size / 2;
  const corners = [[-h, -h, 0, 1], [h, -h, 1, 1], [h, h, 1, 0], [-h, h, 0, 0]] as const;
  const vertices = new Float32Array(4 * VERTEX_FLOATS);
  corners.forEach(([x, y, u, v], i) => vertices.set([0, centerY, 0, x, y, 0, u, v], i * VERTEX_FLOATS));
  const mesh = new Mesh(name, { vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), layout: FLOAT_LAYOUT, impostor: true });
  const reach = h * Math.SQRT2;
  mesh.cullBounds = { min: [-reach, centerY - reach, -reach], max: [reach, centerY + reach, reach] };
  return mesh;
}
