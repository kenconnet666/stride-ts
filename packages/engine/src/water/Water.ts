/**
 * 水体（W6，Stride 没有）：Water 组件引用一个 `.water.json`（content/waterFormat.ts），实体的位置是水面。画法参考 WickedEngine 的
 * ocean（屏幕空间的折射、按水深的吸收、岸边泡沫）和 GPU Gems 第 1 章的 Gerstner 波，按我们的规模做成一个自带管线的渲染器
 * （同高斯泼溅）：
 * - 网格：以相机为中心的极坐标网格（近处密、往外按几何级数变疏，铺到 extent），顶点着色器把它放到水面上、叠 6 组 Gerstner 波
 *   （按世界坐标算：相机动了浪不跟着跑），远处的浪渐渐压平。湖的岸线在片元里裁（点在多边形里），比地面低的部分被地形的深度挡住。
 * - 着色：每个像素重算浪的法线，叠几组短的波纹；反射天空（天空的镜面立方体贴图）、太阳的高光（GGX），按菲涅耳混；水下是主画面
 *   不透明的那份拷贝（rendering/screenspace/Refraction.ts，和透射材质共用），按法线偏开、按光在水里走的路程吸收（清澈度），越深越
 *   接近水的颜色；岸边按水深起泡沫，和地面相交的地方按水深淡出（没有硬边）。
 * - 只画主画面（要那份拷贝），在不透明的之后、透明的之前，读深度、不写。
 */
import type { WaterFile } from '../content/waterFormat';
import { WATER_MAX_OUTLINE } from '../content/waterFormat';
import { prop, type Branded, type EntityId } from '../data/prop';
import { component } from '../engine/component';
import { shaderTime, type GameTime } from '../engine/GameTime';
import { ResourceTable } from '../engine/ResourceTable';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { GpuResources } from '../graphics/GpuResources';
import { Skybox } from '../rendering/lighting/Skybox';
import type { Lighting, RenderContext, RenderView } from '../rendering/RenderSystem';
import type { Refraction } from '../rendering/screenspace/Refraction';

export type WaterAssetId = Branded<number, 'WaterAssetId'>;

/** 水体：实体的位置是水面（本地 y = 0），水体文件里的岸线是本地的 [x, z]。 */
export const Water = component('Water', {
  water: prop.u32().brand<'WaterAssetId'>().default(0 as WaterAssetId),
});

const assets = new ResourceTable<WaterAsset>();

/** 一片水在世界里占哪儿：水面的高度、岸线（世界的 [x, z]；海是 undefined，哪儿都是）。 */
export interface WaterArea {
  readonly level: number;
  readonly outline: readonly (readonly [number, number])[] | undefined;
}

const areaQuery = system('waterAreas', {
  with: { water: Water, transform: Transform },
  update: ({ water, transform, count }) => {
    for (let i = 0; i < count; i++) {
      const asset = WaterAsset.byId(water.water[i]!);
      if (!asset) continue;
      const w = transform.slot[i]! * 16, m = transform.world;
      collected.push({
        level: m[w + 13]!,
        outline: asset.file.outline?.map(([x, z]) => [m[w]! * x + m[w + 8]! * z + m[w + 12]!, m[w + 2]! * x + m[w + 10]! * z + m[w + 14]!] as const),
      });
    }
  },
});
let collected: WaterArea[] = [];

/** 场景里的水体占的地方（程序化摆放不往水下撒）。 */
export function waterAreas(entities: { run: (query: typeof areaQuery, time: GameTime) => void }, time: GameTime): WaterArea[] {
  collected = [];
  entities.run(areaQuery, time);
  return collected;
}

/** 点（世界的 x、高度 y、z）在不在水下。 */
export function underWater(areas: readonly WaterArea[], x: number, y: number, z: number): boolean {
  return areas.some((area) => y < area.level && (!area.outline || insidePolygon(area.outline, x, z)));
}

function insidePolygon(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 加载好的水体资源。 */
export class WaterAsset {
  readonly id: WaterAssetId;
  readonly path: string;
  readonly file: WaterFile;

  constructor(path: string, file: WaterFile) {
    this.path = path;
    this.file = file;
    this.id = assets.add(this) as WaterAssetId;
  }

  /** @internal Water 组件里存的 id 对应的资源。 */
  static byId(id: number): WaterAsset | undefined {
    return assets.get(id);
  }
}

/** 极坐标网格：几圈、每圈几段。 */
const RINGS = 160;
const SEGMENTS = 192;
/** 常量的字节数（见着色器的 WaterParams）。 */
const UNIFORM_FLOATS = 92 + (WATER_MAX_OUTLINE / 2) * 4;

const SHADER = /* wgsl */ `
struct WaterParams {
  viewProjection: mat4x4f,
  inverseViewProjection: mat4x4f,
  // 相机（渲染空间）、着色用的时间
  eye: vec4f,
  // 朝太阳的方向、天空的强度（0 是没有天空盒）
  sun: vec4f,
  // 太阳的颜色乘强度、天空镜面贴图的级数
  sunColor: vec4f,
  ambient: vec4f,
  skyRotation: mat4x4f,
  // 水面的原点（渲染空间）、铺多远
  origin: vec4f,
  // 本地 X 轴在世界 xz 里的方向；岸线的点数（0 是海）
  axis: vec4f,
  // 深处的颜色、清澈度（米）
  color: vec4f,
  // 浪：高、最长的波长、方向（弧度，世界的）、快慢
  waves: vec4f,
  // 尖、岸边泡沫多宽
  waves2: vec4f,
  // 渲染原点取模的 xz（浪按世界坐标排，原点换了不跳）
  pattern: vec4f,
  // 1 / 画面宽、1 / 画面高
  screen: vec4f,
  outline: array<vec4f, ${WATER_MAX_OUTLINE / 2}>,
};
@group(0) @binding(0) var<uniform> water: WaterParams;
@group(0) @binding(1) var scene: texture_2d<f32>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var sky: texture_cube<f32>;
@group(0) @binding(4) var linearClamp: sampler;

const PI = 3.14159265;
const WAVES = 6u;
// 每组浪：方向相对主方向转多少（弧度）、波长、振幅的比例
const WAVE_TABLE = array<vec3f, 6>(
  vec3f(0.0, 1.0, 1.0), vec3f(0.45, 0.61, 0.6), vec3f(-0.38, 0.43, 0.45),
  vec3f(0.9, 0.29, 0.3), vec3f(-0.8, 0.19, 0.2), vec3f(1.6, 0.13, 0.12));

struct Wave { offset: vec3f, normal: vec3f };

/** p 处（世界的 xz，加了取模的原点）的 Gerstner 浪：位移和法线。fade 把振幅压下去（远处）。 */
fn gerstner(p: vec2f, fade: f32) -> Wave {
  var offset = vec3f(0.0);
  var nx = 0.0;
  var ny = 1.0;
  var nz = 0.0;
  let t = water.eye.w * water.waves.w;
  for (var i = 0u; i < WAVES; i++) {
    let row = WAVE_TABLE[i];
    let angle = water.waves.z + row.x;
    let d = vec2f(cos(angle), sin(angle));
    let length = max(water.waves.y * row.y, 0.05);
    let k = 2.0 * PI / length;
    let a = water.waves.x * 0.5 * row.z * fade;
    let q = select(0.0, min(water.waves2.x / (k * a * f32(WAVES)), 1.0), a > 1e-5);
    let theta = k * dot(d, p) - sqrt(9.81 * k) * t;
    let c = cos(theta);
    let s = sin(theta);
    offset += vec3f(q * a * d.x * c, a * s, q * a * d.y * c);
    nx -= d.x * k * a * c;
    nz -= d.y * k * a * c;
    ny -= q * k * a * s;
  }
  return Wave(offset, normalize(vec3f(nx, ny, nz)));
}

struct Varyings {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) plane: vec2f,
  @location(2) fade: f32,
};

fn ringRadius(ring: u32) -> f32 {
  if (ring == 0u) { return 0.0; }
  let near = 0.4;
  return near * pow(max(water.origin.w, near * 2.0) / near, f32(ring - 1u) / f32(${RINGS - 1}));
}

@vertex fn vs(@builtin(vertex_index) index: u32) -> Varyings {
  let quad = index / 6u;
  let corner = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u))[index % 6u];
  let ring = quad / ${SEGMENTS}u + corner.x;
  let angle = f32(quad % ${SEGMENTS}u + corner.y) / f32(${SEGMENTS}) * 2.0 * PI;
  let r = ringRadius(ring);
  let plane = water.eye.xz + vec2f(cos(angle), sin(angle)) * r;
  // 离相机几十个波长以外的浪压平（远处一个像素里好多个浪，只会闪）
  let fade = saturate(1.0 - r / (water.waves.y * 40.0));
  let wave = gerstner(plane + water.pattern.xy, fade);
  var out: Varyings;
  out.world = vec3f(plane.x, water.origin.y, plane.y) + wave.offset;
  out.plane = plane;
  out.fade = fade;
  out.position = water.viewProjection * vec4f(out.world, 1.0);
  return out;
}

/** 本地的点在岸线里（奇偶规则）。 */
fn insideOutline(p: vec2f) -> bool {
  let count = u32(water.axis.w);
  var inside = false;
  var j = count - 1u;
  for (var i = 0u; i < count; i++) {
    let a = select(water.outline[i / 2u].xy, water.outline[i / 2u].zw, (i & 1u) == 1u);
    let b = select(water.outline[j / 2u].xy, water.outline[j / 2u].zw, (j & 1u) == 1u);
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

fn skyDirection(direction: vec3f) -> vec3f {
  let rotation = mat3x3f(water.skyRotation[0].xyz, water.skyRotation[1].xyz, water.skyRotation[2].xyz);
  let d = direction * rotation;
  return vec3f(d.xy, -d.z);
}

/** 画面上 uv、深度 depth 处的世界位置（渲染空间）。 */
fn scenePosition(uv: vec2f, depth: f32) -> vec3f {
  let clip = water.inverseViewProjection * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return clip.xyz / clip.w;
}

@fragment fn fs(in: Varyings) -> @location(0) vec4f {
  if (water.axis.w > 0.0) {
    let d = in.plane - water.origin.xz;
    let local = vec2f(dot(d, water.axis.xy), dot(d, vec2f(-water.axis.y, water.axis.x)));
    if (!insideOutline(local)) {
      discard;
    }
  }
  let p = in.plane + water.pattern.xy;
  var n = gerstner(p, in.fade).normal;
  // 近处叠几组短的波纹（风吹的细浪），远处淡掉
  let toEye = water.eye.xyz - in.world;
  let viewDistance = length(toEye);
  let ripple = saturate(1.0 - viewDistance / 80.0) * 0.12;
  let t = water.eye.w * water.waves.w;
  for (var i = 0u; i < 3u; i++) {
    let angle = water.waves.z + f32(i) * 2.1 + 0.7;
    let d = vec2f(cos(angle), sin(angle));
    let k = 2.0 * PI / (0.7 + f32(i) * 0.55);
    let theta = k * dot(d, p) - sqrt(9.81 * k) * t;
    n.x -= d.x * ripple * cos(theta);
    n.z -= d.y * ripple * cos(theta);
  }
  n = normalize(n);
  let v = toEye / max(viewDistance, 1e-4);
  let nDotV = max(dot(n, v), 0.001);
  let fresnel = 0.02 + 0.98 * pow(1.0 - nDotV, 5.0);

  // 反射：天空（地平线以下的反射方向抬到地平线上）
  var r = reflect(-v, n);
  r.y = max(r.y, 0.02);
  let skyIntensity = water.sun.w;
  let reflected = select(water.ambient.rgb, textureSampleLevel(sky, linearClamp, skyDirection(normalize(r)), 0.0).rgb * skyIntensity, skyIntensity > 0.0);
  // 太阳的高光（GGX，很光滑）
  let l = water.sun.xyz;
  let h = normalize(l + v);
  let nDotH = max(dot(n, h), 0.0);
  let alpha2 = 0.0036;
  let dTerm = alpha2 / (PI * pow(nDotH * nDotH * (alpha2 - 1.0) + 1.0, 2.0));
  let specular = water.sunColor.rgb * dTerm * fresnel * 0.25 * max(dot(n, l), 0.0) / max(nDotV, 0.2);

  // 水下：主画面那份拷贝。先按没偏的位置量水深，再按水深偏开（浅的地方偏得少）
  let screen = in.position.xy * water.screen.xy;
  let size = vec2f(textureDimensions(sceneDepth));
  let flatDepth = textureLoad(sceneDepth, vec2i(clamp(in.position.xy, vec2f(0.0), size - 1.0)), 0);
  let flatScene = scenePosition(screen, flatDepth);
  let path = max(distance(flatScene, water.eye.xyz) - viewDistance, 0.0);
  var uv = screen + n.xz * 0.04 * saturate(path * 0.5);
  let bentDepth = textureLoad(sceneDepth, vec2i(clamp(uv * size, vec2f(0.0), size - 1.0)), 0);
  let bentScene = scenePosition(uv, bentDepth);
  var through = distance(bentScene, water.eye.xyz) - viewDistance;
  // 偏到了水面前面的东西上：退回没偏的
  if (through < 0.0) {
    uv = screen;
    through = path;
  }
  let below = textureSampleLevel(scene, linearClamp, uv, 0.0).rgb;
  let transmittance = exp(-through / water.color.w);
  // 水里散射出来的光：水的颜色，被天光和太阳照着
  let lightIn = water.ambient.rgb + select(vec3f(0.0), textureSampleLevel(sky, linearClamp, skyDirection(vec3f(0.0, 1.0, 0.0)), max(water.sunColor.w - 1.0, 0.0)).rgb * skyIntensity, skyIntensity > 0.0)
    + water.sunColor.rgb * max(l.y, 0.0) * 0.25;
  let underwater = mix(water.color.rgb * lightIn, below * mix(vec3f(1.0), water.color.rgb * 8.0, 1.0 - transmittance), transmittance);
  var color = mix(underwater, reflected, fresnel) + specular;

  // 岸边的泡沫：按竖直的水深，碎成一块一块
  let depthBelow = in.world.y - flatScene.y;
  let shore = water.waves2.y;
  if (shore > 0.0) {
    let wobble = sin(dot(p, vec2f(1.7, 0.9)) * 2.3 + t * 1.3) * sin(dot(p, vec2f(-0.8, 1.6)) * 3.1 - t) * 0.5 + 0.5;
    let foam = saturate((1.0 - depthBelow / shore) * (0.55 + 0.9 * wobble));
    color = mix(color, lightIn * 0.9, foam * 0.8);
  }
  // 和地面相交的地方按水深淡出
  let edge = saturate(depthBelow / 0.08);
  return vec4f(color, edge);
}
`;

interface WaterPipeline {
  readonly pipeline: GPURenderPipeline;
  readonly layout: GPUBindGroupLayout;
  readonly key: string;
}

interface Instance {
  readonly buffer: GPUBuffer;
  group: GPUBindGroup | undefined;
  /** 建绑定组时用的贴图（换了要重建）。 */
  key: readonly unknown[];
}

/** 水体的渲染器（RenderSystem.water）：合成器每帧 collect，主画面的透明那一遍里 draw。 */
export class WaterRenderer {
  readonly #device: GPUDevice;
  readonly #resources: GpuResources;
  readonly #instances = new Map<EntityId, Instance>();
  readonly #data = new Float32Array(UNIFORM_FLOATS);
  #frame: { id: EntityId; asset: WaterAsset; world: Float32Array }[] = [];
  #pipeline: WaterPipeline | undefined;

  readonly #collect = system('WaterRenderer.collect', {
    with: { water: Water, transform: Transform },
    update: ({ water, transform, count, entities }) => {
      for (let i = 0; i < count; i++) {
        const asset = WaterAsset.byId(water.water[i]!);
        if (!asset) continue;
        const w = transform.slot[i]! * 16;
        this.#frame.push({ id: entities[i]!, asset, world: transform.renderWorld.slice(w, w + 16) });
      }
    },
  });

  constructor(device: GPUDevice, resources: GpuResources) {
    this.#device = device;
    this.#resources = resources;
  }

  /** 这一帧有没有水要画（合成器按它决定要不要拷主画面）。 */
  get active(): boolean {
    return this.#frame.length > 0;
  }

  /** 合成器每帧开头：这一帧的水体。 */
  collect(context: RenderContext): void {
    this.#frame = [];
    context.game.entities.run(this.#collect, context.time);
    for (const [id, instance] of this.#instances) {
      if (this.#frame.some((item) => item.id === id)) continue;
      instance.buffer.destroy();
      this.#instances.delete(id);
    }
  }

  /**
   * 在主画面透明的那一遍里画（拷贝了不透明的画面之后）。lighting 是这一帧的光照，origin 是渲染原点（浪按世界坐标排）。
   */
  draw(pass: GPURenderPassEncoder, context: RenderContext, view: RenderView, lighting: Lighting, refraction: Refraction, origin: readonly number[], colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): void {
    const scene = refraction.texture, depth = refraction.depthTexture;
    if (this.#frame.length === 0 || !scene || !depth) return;
    const { pipeline, layout } = this.#pipelineFor(colorFormat, depthFormat);
    const skybox = lighting.skybox;
    const sky = !skybox ? this.#resources.blackCube : skybox.skybox instanceof Skybox ? this.#resources.skyboxSpecular(skybox.skybox) : skybox.skybox.specular;
    // 太阳：投阴影的那盏方向光，没有就第一盏
    const sunIndex = lighting.shadowLight >= 0 ? lighting.shadowLight : 0;
    const sun = lighting.directionalCount > 0 ? lighting.directionals[sunIndex] : undefined;
    const data = this.#data;
    data.set(view.viewProjection, 0);
    data.set(view.inverseViewProjection, 16);
    data.set([view.eye.x, view.eye.y, view.eye.z, shaderTime(context.time.total)], 32);
    if (sun) {
      const d = sun.direction, length = Math.hypot(d.x, d.y, d.z) || 1;
      data.set([-d.x / length, -d.y / length, -d.z / length, skybox?.intensity ?? 0], 36);
      data.set([sun.color.r, sun.color.g, sun.color.b, skybox?.skybox.specularLevels ?? 1], 40);
    } else {
      data.set([0, 1, 0, skybox?.intensity ?? 0], 36);
      data.set([0, 0, 0, skybox?.skybox.specularLevels ?? 1], 40);
    }
    data.set([lighting.ambient.r, lighting.ambient.g, lighting.ambient.b, 0], 44);
    data.set(skybox ? skybox.rotation : IDENTITY, 48);
    data.set([origin[0]! % 65536, origin[2]! % 65536, 0, 0], 84);
    data.set([1 / view.width, 1 / view.height, view.width, view.height], 88);
    pass.setPipeline(pipeline);
    for (const { id, asset, world } of this.#frame) {
      const file = asset.file;
      let instance = this.#instances.get(id);
      if (!instance) {
        instance = { buffer: this.#device.createBuffer({ label: `Water ${asset.path}`, size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), group: undefined, key: [] };
        this.#instances.set(id, instance);
      }
      const key = [scene, depth, sky, layout];
      if (!instance.group || key.some((item, i) => item !== instance!.key[i])) {
        instance.group = this.#device.createBindGroup({
          label: `Water ${asset.path}`,
          layout,
          entries: [
            { binding: 0, resource: { buffer: instance.buffer } },
            { binding: 1, resource: scene.createView({ mipLevelCount: 1 }) },
            { binding: 2, resource: depth.createView() },
            { binding: 3, resource: sky.createView({ dimension: 'cube' }) },
            { binding: 4, resource: this.#resources.linearClamp },
          ],
        });
        instance.key = key;
      }
      // 水面：实体的位置；本地 X 轴的水平方向（岸线按它转回本地）
      const ax = world[0]!, az = world[2]!, axisLength = Math.hypot(ax, az) || 1;
      const outline = file.outline ?? [];
      // 湖：铺到离相机最远的岸线点为止
      let extent = file.extent ?? 6000;
      if (outline.length > 0) {
        extent = 0;
        for (const [x, z] of outline) {
          const wx = world[12]! + world[0]! * x + world[8]! * z, wz = world[14]! + world[2]! * x + world[10]! * z;
          extent = Math.max(extent, Math.hypot(wx - view.eye.x, wz - view.eye.z));
        }
      }
      data.set([world[12]!, world[13]!, world[14]!, extent], 64);
      data.set([ax / axisLength, az / axisLength, 0, outline.length], 68);
      const color = file.color ?? [0.015, 0.06, 0.07];
      data.set([color[0], color[1], color[2], file.clarity ?? 4], 72);
      const waves = file.waves ?? {};
      // 方向：本地的角度加上实体绕 Y 转的角度
      const yaw = Math.atan2(az, ax);
      data.set([waves.height ?? 0.3, waves.length ?? 12, yaw + ((waves.direction ?? 0) * Math.PI) / 180, waves.speed ?? 1], 76);
      data.set([waves.choppiness ?? 0.5, file.foam?.shore ?? 1, 0, 0], 80);
      data.fill(0, 92);
      outline.forEach(([x, z], i) => data.set([x, z], 92 + i * 2));
      this.#device.queue.writeBuffer(instance.buffer, 0, data);
      pass.setBindGroup(0, instance.group);
      pass.draw(RINGS * SEGMENTS * 6);
    }
  }

  destroy(): void {
    for (const instance of this.#instances.values()) instance.buffer.destroy();
    this.#instances.clear();
  }

  #pipelineFor(colorFormat: GPUTextureFormat, depthFormat: GPUTextureFormat): WaterPipeline {
    const key = `${colorFormat}:${depthFormat}`;
    if (this.#pipeline?.key === key) return this.#pipeline;
    const device = this.#device;
    const module = device.createShaderModule({ label: 'Water', code: SHADER });
    const layout = device.createBindGroupLayout({
      label: 'Water',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const pipeline = device.createRenderPipeline({
      label: 'Water',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format: colorFormat, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      // 反向 Z：近 1 远 0；读深度、不写
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
    });
    this.#pipeline = { pipeline, layout, key };
    return this.#pipeline;
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
