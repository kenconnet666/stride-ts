/**
 * 编辑器自带的材质库和特效库（S2，creation-tools.md 的"材质和贴图"第 4 条、"特效"）：常用的预设，用的时候拷一份进工程
 * （材质存成 `Materials/Library/<名字>`，特效变成场景里一个带粒子系统的实体），之后在工程里随便改，和库没有联系。
 *
 * 材质按类别在 materials/ 下各一个文件（类别照 Poly Haven 的材质分类：金属、塑料橡胶、玻璃、石头、砖、混凝土沥青、陶瓷、木头、织物
 * 皮革、纸和卡、有机、地面，加发光和智能材质），都不用贴图：纯参数的（金属、塑料、玻璃、霓虹）和材质节点图算出来的（混凝土、砖、
 * 石板、木头、大理石、布……），下载量是零，放大不糊（vector-assets.md 的方向）。"智能材质"带着磨损、脏污的规则：按模型的棱边、缝
 * （curvatureMask）和遮蔽（occlusionMask）自动长在该长的地方，用在什么模型上都对（要场景开环境光遮蔽）。特效是 Stride 格式的粒子系统
 * 组件（和粒子编辑器改的是同一种），柔和的圆点
 *
 * 只有数据，没有 Node 和 DOM 的依赖：前端的库窗口、MCP 的 library 工具共用。缩略图是 thumbnails/ 下同 id 的图，由
 * tools/dev/library-thumbnails.ts 用引擎画出来（库变了重跑）。
 */
import type { ParticleModuleFile } from '@stride-ts/engine/content-format';
import { type LibraryMaterial } from './define.ts';
import { BRICK_MATERIALS } from './materials/brick.ts';
import { CERAMIC_MATERIALS } from './materials/ceramic.ts';
import { CONCRETE_MATERIALS } from './materials/concrete.ts';
import { EMISSIVE_MATERIALS } from './materials/emissive.ts';
import { FABRIC_MATERIALS } from './materials/fabric.ts';
import { GLASS_MATERIALS } from './materials/glass.ts';
import { METAL_MATERIALS } from './materials/metal.ts';
import { ORGANIC_MATERIALS } from './materials/organic.ts';
import { PAPER_MATERIALS } from './materials/paper.ts';
import { PLASTIC_MATERIALS } from './materials/plastic.ts';
import { SMART_MATERIALS } from './materials/smart.ts';
import { STONE_MATERIALS } from './materials/stone.ts';
import { TERRAIN_MATERIALS } from './materials/terrain.ts';
import { WOOD_MATERIALS } from './materials/wood.ts';

export { libraryAssetName, libraryMaterialPath, nodeGraph, type LibraryMaterial, type MaterialCategory, type NodeSpec } from './define.ts';

export type EffectCategory = 'fire' | 'smoke' | 'sparks' | 'magic' | 'ambient' | 'water';

export interface LibraryEffect {
  readonly id: string;
  readonly category: EffectCategory;
  /** 粒子系统组件（场景文件里 `components.particleSystem` 的值）。 */
  readonly particleSystem: ParticleModuleFile;
}

/** 材质库，按类别的顺序（库窗口的类别开关也按这个顺序）。 */
export const LIBRARY_MATERIALS: readonly LibraryMaterial[] = [
  ...METAL_MATERIALS, ...PLASTIC_MATERIALS, ...GLASS_MATERIALS, ...EMISSIVE_MATERIALS,
  ...STONE_MATERIALS, ...BRICK_MATERIALS, ...CONCRETE_MATERIALS, ...CERAMIC_MATERIALS,
  ...WOOD_MATERIALS, ...FABRIC_MATERIALS, ...PAPER_MATERIALS, ...ORGANIC_MATERIALS,
  ...TERRAIN_MATERIALS, ...SMART_MATERIALS,
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
