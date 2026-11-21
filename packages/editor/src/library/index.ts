/**
 * 编辑器自带的材质库和特效库（S2，creation-tools.md 的"材质和贴图"第 4 条、"特效"）：常用的预设，用的时候拷一份进工程
 * （材质存成 `Materials/Library/<名字>`，特效变成场景里一个带粒子系统的实体），之后在工程里随便改，和库没有联系。
 *
 * 材质都不用贴图：纯参数的（金属、塑料、玻璃、霓虹）和材质节点图算出来的（混凝土、砖、石板、木头、大理石、布），下载量是零，
 * 放大不糊（vector-assets.md 的方向）。特效是 Stride 格式的粒子系统组件（和粒子编辑器改的是同一种），柔和的圆点不用贴图。
 *
 * 只有数据，没有 Node 和 DOM 的依赖：前端的库窗口、MCP 的 library 工具共用。缩略图是 thumbnails/ 下同 id 的图，由
 * tools/library-thumbnails.ts 用引擎画出来（库变了重跑）。
 */
import type { GraphFile, GraphNodeFile } from '@stride-ts/engine/node-graph';
import type { MaterialFile, ParticleModuleFile } from '@stride-ts/engine/content-format';

export type MaterialCategory = 'metal' | 'plastic' | 'glass' | 'emissive' | 'stone' | 'wood' | 'fabric';
export type EffectCategory = 'fire' | 'smoke' | 'sparks' | 'magic' | 'ambient' | 'water';

export interface LibraryMaterial {
  /** 小驼峰的 id：缩略图、翻译表、MCP 按它找；拷进工程时的名字是它的大驼峰。 */
  readonly id: string;
  readonly category: MaterialCategory;
  readonly material: MaterialFile;
}

export interface LibraryEffect {
  readonly id: string;
  readonly category: EffectCategory;
  /** 粒子系统组件（场景文件里 `components.particleSystem` 的值）。 */
  readonly particleSystem: ParticleModuleFile;
}

/** 拷进工程时的资源名：id 的大驼峰。 */
export const libraryAssetName = (id: string): string => id[0]!.toUpperCase() + id.slice(1);
/** 库里的材质拷进工程放在哪个内容路径。 */
export const libraryMaterialPath = (id: string): string => `Materials/Library/${libraryAssetName(id)}`;

// ---- 材质 ----

/** 一个节点：id、种类、参数、输入（端口名 → 源节点 id 或 [节点 id, 输出名]）。位置按顺序排成一列，面板里打开时不叠在一起。 */
type NodeSpec = readonly [id: string, type: string, params?: Record<string, unknown>, inputs?: Record<string, string | readonly [string, string]>];

function graph(nodes: readonly NodeSpec[], outputs: Record<string, string | readonly [string, string]>): GraphFile {
  const link = (source: string | readonly [string, string]) => (typeof source === 'string' ? { node: source } : { node: source[0], output: source[1] });
  return {
    nodes: nodes.map(([id, type, params, inputs], i): GraphNodeFile => ({
      id, type, position: [(i % 3) * 220, Math.floor(i / 3) * 160],
      ...(params ? { params } : {}),
      ...(inputs ? { inputs: Object.fromEntries(Object.entries(inputs).map(([port, source]) => [port, link(source)])) } : {}),
    })),
    outputs: Object.fromEntries(Object.entries(outputs).map(([name, source]) => [name, link(source)])),
  };
}

const plain = (id: string, category: MaterialCategory, material: Omit<MaterialFile, 'name'>): LibraryMaterial => ({ id, category, material: { name: libraryAssetName(id), ...material } });

/** 金属的基础色是 F0（线性），取自常见的实测值（Filament、glTF 样例的金属表）。 */
export const LIBRARY_MATERIALS: readonly LibraryMaterial[] = [
  plain('gold', 'metal', { baseColor: [1, 0.766, 0.336, 1], metalness: 1, roughness: 0.25 }),
  plain('copper', 'metal', { baseColor: [0.955, 0.638, 0.538, 1], metalness: 1, roughness: 0.3 }),
  plain('chrome', 'metal', { baseColor: [0.55, 0.556, 0.554, 1], metalness: 1, roughness: 0.05 }),
  plain('brushedSteel', 'metal', { baseColor: [0.56, 0.57, 0.58, 1], metalness: 1, roughness: 0.35, anisotropy: { strength: 0.8 } }),
  plain('carPaint', 'plastic', { baseColor: [0.45, 0.01, 0.015, 1], metalness: 0, roughness: 0.2 }),
  plain('glossyPlastic', 'plastic', { baseColor: [0.03, 0.25, 0.75, 1], metalness: 0, roughness: 0.25 }),
  plain('mattePlastic', 'plastic', { baseColor: [0.75, 0.75, 0.72, 1], metalness: 0, roughness: 0.7 }),
  plain('rubber', 'plastic', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.9 }),
  // 玻璃：漫反射的颜色只当透过去的颜色（不算漫反射光照），同 Stride 的薄玻璃
  plain('clearGlass', 'glass', { baseColor: [0.92, 0.96, 0.96, 1], metalness: 0, roughness: 0.03, glass: { refractiveIndex: 1.5 }, diffuseShading: false }),
  plain('neonCyan', 'emissive', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.4, emissive: [0.2, 5, 6] }),
  plain('neonMagenta', 'emissive', { baseColor: [0.02, 0.02, 0.02, 1], metalness: 0, roughness: 0.4, emissive: [6, 0.3, 4] }),
  plain('concrete', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9,
    graph: graph([
      ['uv', 'uv'],
      ['grain', 'noise', { scale: 40, octaves: 5, roughness: 0.6 }, { uv: 'uv' }],
      ['stains', 'noise', { scale: 3, octaves: 3, seed: 4 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.32, 0.31, 0.29], to: [0.55, 0.54, 0.52] }, { t: 'stains' }],
      ['speckle', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.1, 1.1, 1.1] }, { t: 'grain' }],
      ['color', 'multiply', {}, { a: 'tone', b: 'speckle' }],
      ['normal', 'normalFromHeight', { strength: 0.6 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  plain('redBrick', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.85,
    graph: graph([
      ['uv', 'uv'],
      ['bricks', 'bricks', { columns: 4, rows: 8, mortar: 0.03, shift: 0.5 }, { uv: 'uv' }],
      ['variation', 'colorRamp', { from: [0.3, 0.07, 0.04], to: [0.55, 0.18, 0.1] }, { t: ['bricks', 'brick'] }],
      ['mortar', 'color', { color: [0.55, 0.53, 0.5] }],
      ['color', 'mix', {}, { a: 'mortar', b: 'variation', t: ['bricks', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 2 }, { height: ['bricks', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  // 方石板：不错缝的砖（每块一个色调）加表面的细噪声
  plain('stoneTiles', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.7,
    graph: graph([
      ['uv', 'uv'],
      ['tiles', 'bricks', { columns: 12, rows: 6, mortar: 0.015, shift: 0 }, { uv: 'uv' }],
      ['tone', 'colorRamp', { from: [0.36, 0.35, 0.33], to: [0.6, 0.58, 0.54] }, { t: ['tiles', 'brick'] }],
      ['grain', 'noise', { scale: 48, octaves: 4 }, { uv: 'uv' }],
      ['speckle', 'colorRamp', { from: [0.85, 0.85, 0.85], to: [1.05, 1.05, 1.05] }, { t: 'grain' }],
      ['surface', 'multiply', {}, { a: 'tone', b: 'speckle' }],
      ['joint', 'color', { color: [0.2, 0.19, 0.18] }],
      ['color', 'mix', {}, { a: 'joint', b: 'surface', t: ['tiles', 'mask'] }],
      ['normal', 'normalFromHeight', { strength: 1.5 }, { height: ['tiles', 'mask'], uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  plain('wood', 'wood', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.6,
    graph: graph([
      ['uv', 'uv', { scale: [1, 12] }],
      ['grain', 'noise', { scale: 6, octaves: 5, roughness: 0.55 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.18, 0.08, 0.03], to: [0.5, 0.27, 0.12] }, { t: 'grain' }],
      ['normal', 'normalFromHeight', { strength: 0.5 }, { height: 'grain', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
  plain('marble', 'stone', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.15,
    graph: graph([
      ['uv', 'uv'],
      ['veins', 'noise', { scale: 4, octaves: 7, roughness: 0.6, seed: 2 }, { uv: 'uv' }],
      // 纹路是噪声等于 0.5 的那条线：往上一段从 0 升到 1、往下一段从 1 降到 0，乘起来只在 0.5 附近是 1
      ['rise', 'levels', { inMin: 0.46, inMax: 0.5 }, { in: 'veins' }],
      ['fall', 'levels', { inMin: 0.5, inMax: 0.54, outMin: 1, outMax: 0 }, { in: 'veins' }],
      ['vein', 'multiply', {}, { a: 'rise', b: 'fall' }],
      ['color', 'colorRamp', { from: [0.93, 0.92, 0.89], to: [0.35, 0.35, 0.38] }, { t: 'vein' }],
    ], { baseColor: 'color' }),
  }),
  plain('fabric', 'fabric', {
    baseColor: [1, 1, 1, 1], metalness: 0, roughness: 0.9, sheen: { color: [0.4, 0.45, 0.6], roughness: 0.5 },
    graph: graph([
      ['uv', 'uv'],
      ['weave', 'checker', { scale: 24 }, { uv: 'uv' }],
      ['fibers', 'noise', { scale: 30, octaves: 3 }, { uv: 'uv' }],
      ['color', 'colorRamp', { from: [0.1, 0.13, 0.3], to: [0.16, 0.2, 0.42] }, { t: 'fibers' }],
      ['normal', 'normalFromHeight', { strength: 0.3 }, { height: 'weave', uv: 'uv' }],
    ], { baseColor: 'color', normal: 'normal' }),
  }),
];

// ---- 特效 ----

type Key<T> = readonly [time: number, value: T];

const colorCurve = (keys: readonly Key<readonly [number, number, number, number]>[]) => ({
  $type: 'computeCurveSamplerVector4',
  curve: { $type: 'computeAnimationCurveVector4', keyFrames: keys.map(([key, value]) => ({ key, value, tangentType: 'linear' })) },
});
const floatCurve = (keys: readonly Key<number>[]) => ({
  $type: 'computeCurveSamplerFloat',
  curve: { $type: 'computeAnimationCurveFloat', keyFrames: keys.map(([key, value]) => ({ key, value, tangentType: 'linear' })) },
});

interface EmitterSpec {
  readonly name: string;
  readonly lifetime: readonly [number, number];
  readonly perSecond: number;
  readonly position?: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly velocity: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** 加法混合（火、火花、光点）；否则是普通的透明（烟）。 */
  readonly additive: boolean;
  /** 柔和圆点的硬度，0..1。 */
  readonly hardness?: number;
  readonly colors: readonly Key<readonly [number, number, number, number]>[];
  /** 大小随寿命（米）：同 Stride，按曲线直接设大小，不乘出生时的大小。 */
  readonly sizes: readonly Key<number>[];
  readonly gravity?: number;
}

function emitter(spec: EmitterSpec): Record<string, unknown> {
  return {
    emitterName: spec.name,
    particleLifetime: spec.lifetime,
    shapeBuilder: { $type: 'shapeBuilderBillboard' },
    material: { $type: 'particleMaterialComputeColor', computeColor: { $type: 'computeSoftCircle', hardness: spec.hardness ?? 0 }, alphaAdditive: spec.additive ? 1 : 0 },
    spawners: [{ $type: 'spawnerPerSecond', spawnCount: spec.perSecond }],
    initializers: [
      ...(spec.position ? [{ $type: 'initialPositionSeed', positionMin: spec.position[0], positionMax: spec.position[1] }] : []),
      { $type: 'initialVelocitySeed', velocityMin: spec.velocity[0], velocityMax: spec.velocity[1] },
      { $type: 'initialColorSeed', colorMin: [1, 1, 1, 1], colorMax: [1, 1, 1, 1] },
    ],
    updaters: [
      { $type: 'updaterColorOverTime', samplerMain: colorCurve(spec.colors) },
      { $type: 'updaterSizeOverTime', samplerMain: floatCurve(spec.sizes) },
      ...(spec.gravity ? [{ $type: 'updaterGravity', gravitationalAcceleration: [0, -spec.gravity, 0] }] : []),
    ],
  };
}

const effect = (id: string, category: EffectCategory, ...emitters: EmitterSpec[]): LibraryEffect => ({ id, category, particleSystem: { particleSystem: { settings: {}, emitters: emitters.map(emitter) } } as ParticleModuleFile });

export const LIBRARY_EFFECTS: readonly LibraryEffect[] = [
  effect('campfire', 'fire',
    {
      name: 'Flames', lifetime: [0.6, 1.1], perSecond: 140, additive: true,
      position: [[-0.2, 0, -0.2], [0.2, 0.1, 0.2]], velocity: [[-0.15, 0.9, -0.15], [0.15, 1.8, 0.15]],
      colors: [[0, [1, 0.75, 0.3, 0.3]], [0.35, [1, 0.38, 0.06, 0.25]], [1, [0.4, 0.05, 0.01, 0]]],
      sizes: [[0, 0.45], [0.4, 0.35], [1, 0.05]],
    },
    {
      name: 'Embers', lifetime: [1, 2], perSecond: 12, additive: true, hardness: 0.6,
      position: [[-0.2, 0.1, -0.2], [0.2, 0.3, 0.2]], velocity: [[-0.4, 1, -0.4], [0.4, 2.5, 0.4]],
      colors: [[0, [1, 0.6, 0.2, 1]], [1, [1, 0.2, 0.05, 0]]],
      sizes: [[0, 0.05], [1, 0.02]],
    }),
  effect('smokeColumn', 'smoke', {
    name: 'Smoke', lifetime: [3, 5], perSecond: 18, additive: false,
    position: [[-0.15, 0, -0.15], [0.15, 0, 0.15]], velocity: [[-0.15, 0.6, -0.15], [0.15, 1, 0.15]],
    colors: [[0, [0.3, 0.3, 0.3, 0]], [0.15, [0.25, 0.25, 0.25, 0.5]], [1, [0.45, 0.45, 0.45, 0]]],
    sizes: [[0, 0.4], [1, 1.8]],
  }),
  effect('steam', 'smoke', {
    name: 'Steam', lifetime: [1.2, 2], perSecond: 30, additive: false,
    velocity: [[-0.2, 1.2, -0.2], [0.2, 1.8, 0.2]],
    colors: [[0, [0.9, 0.9, 0.9, 0]], [0.2, [0.95, 0.95, 0.95, 0.3]], [1, [1, 1, 1, 0]]],
    sizes: [[0, 0.15], [1, 0.9]],
  }),
  effect('sparks', 'sparks', {
    name: 'Sparks', lifetime: [0.4, 0.9], perSecond: 90, additive: true, hardness: 0.7,
    velocity: [[-2.5, 1.5, -2.5], [2.5, 4, 2.5]], gravity: 9.8,
    colors: [[0, [1, 0.95, 0.7, 1]], [0.5, [1, 0.6, 0.15, 1]], [1, [0.8, 0.2, 0.05, 0]]],
    sizes: [[0, 0.05], [1, 0.02]],
  }),
  effect('magicOrb', 'magic',
    {
      name: 'Glow', lifetime: [0.4, 0.6], perSecond: 40, additive: true,
      velocity: [[0, 0, 0], [0, 0, 0]],
      colors: [[0, [0.3, 0.4, 1, 0]], [0.3, [0.4, 0.5, 1, 0.25]], [1, [0.6, 0.2, 1, 0]]],
      sizes: [[0, 0.4], [1, 0.8]],
    },
    {
      name: 'Motes', lifetime: [1, 2], perSecond: 60, additive: true, hardness: 0.5,
      position: [[-0.3, -0.3, -0.3], [0.3, 0.3, 0.3]], velocity: [[-0.6, -0.2, -0.6], [0.6, 0.8, 0.6]],
      colors: [[0, [0.5, 0.7, 1, 1]], [0.5, [0.8, 0.4, 1, 1]], [1, [1, 0.5, 1, 0]]],
      sizes: [[0, 0.06], [1, 0]],
    }),
  effect('dustMotes', 'ambient', {
    name: 'Dust', lifetime: [6, 10], perSecond: 12, additive: true, hardness: 0.3,
    position: [[-3, 0.2, -3], [3, 2.5, 3]], velocity: [[-0.05, -0.02, -0.05], [0.05, 0.05, 0.05]],
    colors: [[0, [1, 0.95, 0.85, 0]], [0.2, [1, 0.95, 0.85, 0.8]], [0.8, [1, 0.95, 0.85, 0.8]], [1, [1, 0.95, 0.85, 0]]],
    sizes: [[0, 0.05], [1, 0.05]],
  }),
  effect('fountain', 'water', {
    name: 'Water', lifetime: [1.2, 1.6], perSecond: 160, additive: false, hardness: 0.4,
    velocity: [[-0.4, 4.5, -0.4], [0.4, 5.5, 0.4]], gravity: 9.8,
    colors: [[0, [0.75, 0.85, 1, 0.8]], [1, [0.8, 0.9, 1, 0]]],
    sizes: [[0, 0.06], [1, 0.14]],
  }),
];
