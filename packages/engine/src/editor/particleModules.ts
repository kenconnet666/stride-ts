/**
 * 粒子模块库（编辑器的粒子面板用；参考 Niagara 的发射器模块栈）：运行时认识的每种模块（particles/ 里的 createSpawner、
 * createInitializer、createUpdater、引擎的形状、材质）属于哪一栏、有哪些参数（字段描述）、新加时文件里写什么。参数的默认值同
 * 运行时（Stride 的默认值）。曲线参数（samplerMain、samplerSize 这种 `computeCurveSampler*`）字段种类是 json，面板认出来画
 * 曲线和颜色渐变编辑器。
 *
 * 这里没列的（导入的游戏模块、子粒子的模块）面板上按 JSON 改。
 */
import type { ParticleModuleFile } from '../content/formats/format';
import type { Field, FieldType } from './fields/index';

export type ParticleStackKind = 'spawners' | 'initializers' | 'updaters' | 'shapeBuilder' | 'material';

export interface ParticleModuleSpec {
  readonly type: string;
  readonly stack: ParticleStackKind;
  readonly fields: readonly Field[];
  /** 新加时写进文件的内容。 */
  readonly initial: ParticleModuleFile;
}

const num = (min?: number, max?: number, unit?: string): FieldType => ({ kind: 'number', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(unit ? { unit } : {}), step: 0.05 });
const int = (min: number): FieldType => ({ kind: 'number', integer: true, min });
const vec = (size: 2 | 3 | 4, unit?: string): FieldType => ({ kind: 'vector', size, ...(unit ? { unit } : {}) });
const color: FieldType = { kind: 'color', alpha: true, space: 'srgb' };
const json: FieldType = { kind: 'json' };
const bool: FieldType = { kind: 'bool' };
const oneOf = (...values: string[]): FieldType => ({ kind: 'enum', values });
const f = (name: string, type: FieldType, fallback: unknown, description?: string): Field => ({ name, type, optional: true, default: fallback, ...(description ? { description } : {}) });

/** 曲线：一条从 0 到 1（走过的寿命）的曲线，float 是一个数，vector4 是颜色（rgba）。 */
export function curve(kind: 'Float' | 'Vector4', keys: readonly (readonly [number, number | readonly number[]])[]): ParticleModuleFile {
  return {
    $type: `computeCurveSampler${kind}`,
    curve: { $type: `computeAnimationCurve${kind}`, keyFrames: keys.map(([key, value]) => ({ key, value: value as number, tangentType: 'linear' })) },
  };
}

/** 文件里的值是不是曲线（面板画曲线编辑器）。 */
export function isCurve(value: unknown): value is ParticleModuleFile {
  return typeof value === 'object' && value !== null && String((value as ParticleModuleFile).$type ?? '').startsWith('computeCurveSampler');
}

const spawner = (type: string, fields: readonly Field[], initial: ParticleModuleFile = {}): ParticleModuleSpec => ({
  type, stack: 'spawners',
  fields: [
    f('loopCondition', oneOf('looping', 'loopingNoDelay', 'oneShot'), 'looping'),
    f('delay', vec(2, 's'), [0, 0], 'random delay before it starts (min, max)'),
    f('duration', vec(2, 's'), [1, 1], 'how long one loop lasts (min, max)'),
    ...fields,
  ],
  initial: { $type: type, ...initial },
});

const initializer = (type: string, fields: readonly Field[], initial: ParticleModuleFile): ParticleModuleSpec => ({
  type, stack: 'initializers', fields: [...fields, f('seedOffset', int(0), 0, 'change it to get a different random pattern')], initial: { $type: type, ...initial },
});

const updater = (type: string, fields: readonly Field[], initial: ParticleModuleFile): ParticleModuleSpec => ({ type, stack: 'updaters', fields, initial: { $type: type, ...initial } });

const shape = (type: string): ParticleModuleSpec => ({
  type, stack: 'shapeBuilder',
  fields: [f('samplerSize', json, null, 'size over the particle life (multiplies its size)'), f('samplerRotation', json, null, 'rotation over the particle life')],
  initial: { $type: type },
});

export const PARTICLE_MODULES: readonly ParticleModuleSpec[] = [
  spawner('spawnerPerSecond', [f('spawnCount', num(0), 100, 'particles per second')], { spawnCount: 20 }),
  spawner('spawnerBurst', [f('spawnCount', num(0), 100, 'particles at once')], { spawnCount: 50, loopCondition: 'oneShot' }),
  spawner('spawnerPerFrame', [f('spawnCount', num(0), 1), f('framerate', num(1), 60)]),
  spawner('spawnerFromDistance', [f('spawnCount', num(0), 100, 'particles per meter moved')]),
  initializer('initialSizeSeed', [f('randomSize', vec(2, 'm'), [0.5, 1], 'size (min, max)')], { randomSize: [0.2, 0.4] }),
  initializer('initialPositionSeed', [f('positionMin', vec(3, 'm'), [-1, 1, -1]), f('positionMax', vec(3, 'm'), [1, 1, 1])], { positionMin: [-0.5, 0, -0.5], positionMax: [0.5, 0, 0.5] }),
  initializer('initialVelocitySeed', [f('velocityMin', vec(3, 'm/s'), [-1, 1, -1]), f('velocityMax', vec(3, 'm/s'), [1, 1, 1])], { velocityMin: [-0.5, 2, -0.5], velocityMax: [0.5, 3, 0.5] }),
  initializer('initialDirectionSeed', [f('directionMin', vec(3), [-1, 1, -1]), f('directionMax', vec(3), [1, 1, 1])], {}),
  initializer('initialRotationSeed', [f('angularRotation', vec(2, 'deg'), [-60, 60], 'rotation (min, max)')], {}),
  initializer('initialColorSeed', [f('colorMin', color, [1, 1, 1, 1]), f('colorMax', color, [1, 1, 1, 1])], { colorMin: [1, 0.6, 0.2, 1], colorMax: [1, 0.9, 0.4, 1] }),
  initializer('initialSpawnOrder', [], {}),
  updater('updaterGravity', [f('gravitationalAcceleration', vec(3, 'm/s²'), [0, -9.80665, 0])], {}),
  updater('updaterSizeOverTime', [f('samplerMain', json, null, 'size over the particle life'), f('samplerOptional', json, null, 'a second curve; each particle picks a random mix of the two')],
    { samplerMain: curve('Float', [[0, 0.2], [0.3, 1], [1, 0]]) }),
  updater('updaterColorOverTime', [f('samplerMain', json, null, 'color over the particle life'), f('samplerOptional', json, null, 'a second gradient; each particle picks a random mix of the two')],
    { samplerMain: curve('Vector4', [[0, [1, 0.9, 0.5, 1]], [0.5, [1, 0.4, 0.1, 1]], [1, [0.2, 0.2, 0.2, 0]]]) }),
  updater('updaterRotationOverTime', [f('samplerMain', json, null, 'rotation (degrees) over the particle life')], { samplerMain: curve('Float', [[0, 0], [1, 180]]) }),
  updater('updaterSpeedToDirection', [], {}),
  updater('updaterWind', [f('drag', num(0), 1, 'how fast the particles follow the wind'), f('terminalVelocity', vec(3, 'm/s'), [0, 0, 0])], {}),
  updater('updaterForceField', [f('forceDirected', num(), 0), f('forceVortex', num(), 1), f('forceRepulsive', num(), 1), f('forceFixed', vec(3), [0, 0, 0]), f('energyConservation', num(0, 1), 0)], {}),
  updater('updaterCollider', [f('restitution', num(0, 1), 0.5), f('friction', num(0, 1), 0.1), f('killParticles', bool, false), f('isHollow', bool, false)], {}),
  updater('updaterDepthCollision', [f('surface', oneOf('view', 'sky'), 'view'), f('restitution', num(0, 1), 0.5), f('friction', num(0, 1), 0.1), f('killParticles', bool, false), f('thickness', num(0, undefined, 'm'), 0.5)], {}),
  shape('shapeBuilderBillboard'),
  shape('shapeBuilderQuad'),
  shape('shapeBuilderOrientedQuad'),
  shape('shapeBuilderHexagon'),
  {
    type: 'particleMaterialComputeColor', stack: 'material',
    fields: [f('computeColor', json, null, 'color tree (a texture, a color...)'), f('uvBuilder', json, null, 'flipbook or scrolling UVs'), f('alphaAdditive', num(0, 1), 0, '0 is alpha blended, 1 is additive')],
    initial: { $type: 'particleMaterialComputeColor', computeColor: { $type: 'computeSoftCircle', hardness: 0 }, alphaAdditive: 1 },
  },
];

/** 发射器自己的参数（Stride 的 ParticleEmitter）。 */
export const EMITTER_FIELDS: readonly Field[] = [
  f('emitterName', { kind: 'string' }, ''),
  f('enabled', bool, true),
  f('particleLifetime', vec(2, 's'), [1, 1], 'life of a particle (min, max)'),
  f('maxParticlesOverride', int(0), 0, '0 works it out from the spawners and the lifetime'),
  f('simulationSpace', oneOf('world', 'local'), 'world'),
  f('sortingPolicy', oneOf('none', 'byDepth', 'byAge', 'byOrder'), 'none'),
  f('drawPriority', int(0), 0),
  f('simulation', oneOf('auto', 'cpu', 'gpu'), 'auto', 'gpu runs big emitters in a compute shader'),
];

/** 新的发射器：每秒 20 个、往上飘、越来越大越来越淡的加色亮点。 */
export function newEmitter(name: string): ParticleModuleFile {
  const pick = (type: string) => PARTICLE_MODULES.find((module) => module.type === type)!.initial;
  return {
    emitterName: name, particleLifetime: [1.5, 2.5],
    shapeBuilder: pick('shapeBuilderBillboard'), material: pick('particleMaterialComputeColor'),
    spawners: [pick('spawnerPerSecond')],
    initializers: [pick('initialSizeSeed'), pick('initialVelocitySeed'), pick('initialColorSeed')],
    updaters: [pick('updaterColorOverTime'), pick('updaterSizeOverTime')],
  };
}
