/**
 * 粒子系统（Stride 的 ParticleSystemComponent）导入成 ParticleModuleFile 的树：类型标签换成首字母小写的类名放进 $type，属性名
 * 首字母小写；{X, Y, Z, W}、{R, G, B, A} 换成数组；Spawners、Initializers、Updaters、Emitters 这几个集合（按 Id 的字典）换成
 * 数组；贴图引用导出贴图，换成 TextureRef；对实体或组件的引用（`ref!! Id`）换成所在实体的 { $entity }；枚举的字符串首字母小写
 * （名字原样）。编辑器用的属性（Id、Display*）不导入。
 *
 * 运行时还不认识的模块类型（SUPPORTED 以外）记警告、去掉；去掉的是形状或材质时发射器整个不画（同 Stride 的 null）。
 */
import type { ParticleModuleFile, ParticleValue, TextureRef } from '@stride-ts/engine/content-format';
import { lowerFirst, parseAssetReference, parseObjectReference, type StrideObject, type StrideValue } from './yaml.ts';

/** 运行时认识的模块（Stride 的类名）。 */
export const SUPPORTED_PARTICLE_MODULES: ReadonlySet<string> = new Set([
  // Stride 的类名就拼错成这样（BoundingSphereStatic 少了个 S）
  'BoundingBoxStatic', 'BoundingSpheretatic',
  'SpawnerPerSecond', 'SpawnerPerFrame',
  'InitialSizeSeed', 'InitialPositionSeed', 'InitialPositionArc', 'InitialVelocitySeed', 'InitialDirectionSeed', 'InitialRotationSeed',
  'Initial3DRotationSeed', 'InitialColorSeed', 'InitialSpawnOrder',
  'UpdaterForceField', 'UpdaterGravity', 'UpdaterSizeOverTime', 'UpdaterColorOverTime', 'UpdaterRotationOverTime', 'UpdaterSpeedToDirection',
  'UpdaterCollider', 'FieldShapeSphere', 'FieldShapeCylinder',
  'ShapeBuilderBillboard', 'ShapeBuilderQuad', 'ShapeBuilderHexagon', 'ShapeBuilderOrientedQuad', 'ShapeBuilderRibbon', 'ShapeBuilderTrail',
  'ParticleMaterialComputeColor', 'ComputeTextureColor', 'ComputeTextureScalar', 'ComputeVertexStreamColor', 'ColorVertexStreamDefinition',
  'ComputeFloat4', 'ComputeFloat', 'ComputeColor', 'ComputeBinaryColor',
  'UVBuilderFlipbook', 'UVBuilderScroll',
  'ComputeCurveSamplerFloat', 'ComputeCurveSamplerVector3', 'ComputeCurveSamplerColor4', 'ComputeCurveSamplerQuaternion',
  'ComputeAnimationCurveFloat', 'ComputeAnimationCurveVector3', 'ComputeAnimationCurveColor4', 'ComputeAnimationCurveQuaternion',
]);

/** 按 Id 存的集合（曲线的关键帧也是），换成数组。 */
const COLLECTIONS = new Set(['Emitters', 'Spawners', 'Initializers', 'Updaters', 'KeyFrames']);
/** 字符串原样的属性（名字）；其余的字符串是枚举。 */
const NAMES = new Set(['EmitterName', 'Name']);

export interface ParticleImportContext {
  /** 贴图引用（Id）导出贴图。 */
  readonly texture: (assetId: string) => Promise<TextureRef>;
  /** 实体或组件的 Id → 所在实体的 Id；不在这个场景里时是 undefined。 */
  readonly entity: (id: string) => string | undefined;
  readonly warn: (message: string) => void;
}

/** 导入一个 ParticleSystemComponent。 */
export async function importParticleSystem(component: StrideObject, where: string, context: ParticleImportContext): Promise<ParticleModuleFile> {
  const { $type: _, ...rest } = component;
  return (await convertObject(rest, `${where}: particle system`, context)) as ParticleModuleFile;
}

async function convert(key: string, value: StrideValue | undefined, where: string, context: ParticleImportContext): Promise<ParticleValue | undefined> {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (key === 'Texture') {
      const reference = parseAssetReference(value);
      return reference ? context.texture(reference.id) : null;
    }
    const object = parseObjectReference(value);
    if (object !== undefined) {
      const entity = context.entity(object);
      if (entity === undefined) context.warn(`${where}: reference ${object} is not in this scene; using null`);
      return entity === undefined ? null : { $entity: entity };
    }
    return NAMES.has(key) ? value : lowerFirst(value);
  }
  if (Array.isArray(value)) return (await Promise.all(value.map((item) => convert(key, item, where, context)))).filter((item) => item !== undefined) as ParticleValue;
  const object = value as StrideObject;
  if (COLLECTIONS.has(key)) {
    const items = await Promise.all(Object.values(object).map((item) => convert('', item, where, context)));
    return items.filter((item): item is ParticleModuleFile => item !== undefined && item !== null);
  }
  const vector = asVector(object);
  if (vector) return vector;
  return convertObject(object, where, context);
}

async function convertObject(object: StrideObject, where: string, context: ParticleImportContext): Promise<ParticleModuleFile | undefined> {
  const type = object.$type;
  if (type !== undefined && !SUPPORTED_PARTICLE_MODULES.has(type)) {
    context.warn(`${where}: ${type} is not supported yet; it is skipped`);
    return undefined;
  }
  const result: Record<string, ParticleValue> = type === undefined ? {} : { $type: lowerFirst(type) };
  for (const [key, value] of Object.entries(object)) {
    if (key === '$type' || key === 'Id' || key.startsWith('Display')) continue;
    const converted = await convert(key, value, `${where} ${key}`, context);
    // 去掉的模块写成 null（不能省略：省略的属性在运行时取默认值，比如默认的 Billboard 形状）
    result[lowerFirst(key)] = converted ?? null;
  }
  return result as ParticleModuleFile;
}

/** {X, Y[, Z[, W]]} 或 {R, G, B, A} 换成数组；别的是 undefined。 */
function asVector(object: StrideObject): number[] | undefined {
  const keys = Object.keys(object).filter((key) => key !== '$type');
  for (const order of [['X', 'Y'], ['X', 'Y', 'Z'], ['X', 'Y', 'Z', 'W'], ['R', 'G', 'B', 'A'], ['R', 'G', 'B']]) {
    if (keys.length === order.length && order.every((key) => typeof object[key] === 'number')) return order.map((key) => object[key] as number);
  }
  return undefined;
}
