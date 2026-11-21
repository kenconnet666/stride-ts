/**
 * 属性面板要的字段描述：场景文件里一个实体的每种组件有哪些字段、各是什么（数、向量、颜色、枚举、资源、实体……）、范围、
 * 单位、没写时的值。面板照着它画控件、生成对场景文档的修改；`checkFields` 照着它检查一个值（保存前、读别人写的文件时）。
 *
 * 两个来源，同一个形状（Field）：
 * - 引擎的组件（components 的各个键）：这个文件里手写的 COMPONENT_FIELDS。用 `fields<T>()` 写，文件格式的类型里有的字段
 *   这里必须都有、多一个少一个都过不了类型检查，所以格式加了字段，面板不会悄悄漏掉；
 * - 游戏的脚本：`scriptFields` 从脚本类的 `prop` 声明换过来。
 *
 * 只是数据，不依赖 DOM 和运行着的游戏（scriptFields 要脚本的类，在游戏页面里调）。
 */
import type {
  ColliderShapeFile, SceneAnimation, SceneBackground, SceneBody, SceneCharacter, SceneCollidable, SceneConstraint, SceneDayNightCycle, SceneEntityFile, ScenePrecipitation, SceneWeather, SceneDecal, SceneWindZone, SceneLightShadow, SceneReflectionProbe, SceneSkyAtmosphere, SceneVolumetricClouds, SceneVolumetricFog,
  SceneLocalLightShadow, SceneRenderTexture, SceneSprite, SceneUI, TextureRef, SceneCompositor, SceneNavigation, ScenePhysics, ScenePostEffects, MaterialFile, ProceduralModelFile, TextureSlot, TimelineFile, BrushFile, SdfFile, PolyMeshFile,
  GameSettingsFile, SceneScriptValue,
} from '../content/format';
import type { SceneSettingKey } from './SceneDocument';
import type { AssetKind } from '../content/references';
import type { PropOptions } from '../data/prop';
import type { ScriptConstructor } from '../engine/scripts';

export type FieldType =
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly step?: number; readonly unit?: string; readonly integer?: boolean }
  | { readonly kind: 'bool' }
  | { readonly kind: 'string' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** 几个数的数组。 */
  | { readonly kind: 'vector'; readonly size: 2 | 3 | 4; readonly unit?: string }
  /** 四元数 [x, y, z, w]；面板上按欧拉角改。 */
  | { readonly kind: 'rotation' }
  /** 颜色：3 个或 4 个数（alpha）；space 是文件里存的是哪种（面板的取色器是 sRGB 的）。 */
  | { readonly kind: 'color'; readonly alpha: boolean; readonly space: 'srgb' | 'linear' }
  /** 一个资源。form 是文件里怎么写：path 是内容路径的字符串，ref 是脚本属性的 `{ $asset, kind }`（refKind 是其中的 kind）。 */
  | { readonly kind: 'asset'; readonly asset: AssetKind; readonly form: 'path' | 'ref'; readonly refKind?: string }
  /** 场景里的一个实体。form：id 是实体 id 的字符串，ref 是脚本属性的 `{ $entity }`。 */
  | { readonly kind: 'entity'; readonly form: 'id' | 'ref' }
  /** nullableItems：列表里可以有 null（模型的材质槽：null 是用模型自带的）。 */
  | { readonly kind: 'list'; readonly item: FieldType; readonly nullableItems?: boolean }
  | { readonly kind: 'object'; readonly fields: readonly Field[] }
  /** 几种形状之一，tag 那个字段的值说是哪种；common 是每种都有的字段。 */
  | { readonly kind: 'union'; readonly tag: string; readonly variants: Readonly<Record<string, readonly Field[]>>; readonly common?: readonly Field[] }
  /** 还没有描述（粒子的模块、约束的设置）：面板按原样的 JSON 改，checkFields 不看里面。 */
  | { readonly kind: 'json' };

export interface Field {
  readonly name: string;
  readonly type: FieldType;
  /** 文件里可以不写；不写时用 default（没有 default 的就是"没设"）。 */
  readonly optional?: boolean;
  /** 可以是 null（没指定）。 */
  readonly nullable?: boolean;
  readonly default?: unknown;
  readonly label?: string;
  readonly group?: string;
  readonly description?: string;
}

/** 一个字段怎么写：只有类型，或者带上可不可以不写这些。 */
type FieldSpec = FieldType | (Omit<Field, 'name' | 'type'> & { readonly type: FieldType });

/** 照着文件格式的类型 T 写它的字段：T 的每个字段都要写到，写了 T 没有的也报错。 */
function fields<T>(spec: { readonly [K in keyof Required<T>]: FieldSpec }): Field[] {
  return Object.entries<FieldSpec>(spec).map(([name, value]) => ('kind' in value ? { name, type: value } : { name, ...value }));
}

const number = (options: Omit<Extract<FieldType, { kind: 'number' }>, 'kind'> = {}): FieldType => ({ kind: 'number', ...options });
const integer = (min?: number, max?: number): FieldType => ({ kind: 'number', integer: true, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
const bool: FieldType = { kind: 'bool' };
const string: FieldType = { kind: 'string' };
const oneOf = (...values: string[]): FieldType => ({ kind: 'enum', values });
const vector = (size: 2 | 3 | 4, unit?: string): FieldType => ({ kind: 'vector', size, ...(unit !== undefined ? { unit } : {}) });
const rotation: FieldType = { kind: 'rotation' };
const asset = (kind: AssetKind): FieldType => ({ kind: 'asset', asset: kind, form: 'path' });
const entity: FieldType = { kind: 'entity', form: 'id' };
const list = (item: FieldType): FieldType => ({ kind: 'list', item });
const object = (of: readonly Field[]): FieldType => ({ kind: 'object', fields: of });
const optional = (type: FieldType, fallback?: unknown): FieldSpec => ({ type, optional: true, ...(fallback !== undefined ? { default: fallback } : {}) });
const nullable = (type: FieldType): FieldSpec => ({ type, nullable: true });

/** 渲染组（Stride 的 RenderGroup）。 */
const renderGroup = optional(integer(0, 31), 0);
const sampler = oneOf('linearClamp', 'pointClamp', 'anisotropicClamp');

/** 一张贴图文件，或者（精灵、背景）一张渲染目标贴图。 */
const textureRef = fields<TextureRef>({
  texture: asset('image'),
  encoding: optional(oneOf('ktx2', 'svg', 'png', 'jpeg', 'webp'), 'ktx2'),
  size: optional(vector(2, 'px')),
  srgb: optional(bool),
  invertY: optional(bool, false),
});
const renderTexture = fields<SceneRenderTexture>({ renderTexture: string, width: integer(1), height: integer(1), hdr: bool, srgb: bool });

const colliderShapes: FieldType = list({
  kind: 'union',
  tag: 'type',
  variants: {
    box: [{ name: 'size', type: vector(3, 'm') }],
    empty: [],
    sphere: [{ name: 'radius', type: number({ min: 0, unit: 'm' }) }],
    capsule: [{ name: 'radius', type: number({ min: 0, unit: 'm' }) }, { name: 'length', type: number({ min: 0, unit: 'm' }) }],
    cylinder: [{ name: 'radius', type: number({ min: 0, unit: 'm' }) }, { name: 'length', type: number({ min: 0, unit: 'm' }) }],
    mesh: [{ name: 'model', type: asset('model') }],
    convexHull: [
      { name: 'model', type: asset('model') },
      { name: 'hull', type: object([{ name: 'scale', type: vector(3) }, { name: 'rotation', type: rotation }, { name: 'offset', type: vector(3, 'm') }]) },
    ],
  } satisfies Record<ColliderShapeFile['type'], readonly Field[]>,
  common: [{ name: 'position', type: vector(3, 'm') }, { name: 'rotation', type: rotation }, { name: 'mass', type: number({ min: 0, unit: 'kg' }) }],
});

const collidable = {
  shapes: colliderShapes,
  layer: integer(0, 31),
  friction: number({ min: 0 }),
  trigger: optional(bool, false),
} satisfies { readonly [K in keyof Required<SceneCollidable>]: FieldSpec };

const localShadow = fields<SceneLocalLightShadow>({
  size: oneOf('xsmall', 'small', 'medium', 'large', 'xlarge'),
  filter: oneOf('none', 'pcf3x3', 'pcf5x5', 'pcf7x7', 'pcss'),
  depthBias: number(),
  normalOffsetScale: number(),
});
const directionalShadow = fields<SceneLightShadow>({
  size: oneOf('xsmall', 'small', 'medium', 'large', 'xlarge'),
  filter: oneOf('none', 'pcf3x3', 'pcf5x5', 'pcf7x7', 'pcss'),
  cascadeCount: oneOf('one', 'two', 'four'),
  depthBias: number(),
  normalOffsetScale: number(),
  stabilization: oneOf('none', 'viewSnapping', 'projectionSnapping'),
  pssmFactor: number({ min: 0, max: 1 }),
  depthRange: oneOf('automatic', 'manual'),
  minDistance: number({ min: 0, unit: 'm' }),
  maxDistance: number({ min: 0, unit: 'm' }),
  blendCascades: bool,
  lightAngle: optional(number({ min: 0, max: 20, unit: 'deg' }), 0.53),
});
/** 光的颜色按 sRGB 存（同 Stride 的编辑器）。 */
const lightColor: Field = { name: 'color', type: { kind: 'color', alpha: false, space: 'srgb' } };
const intensity: Field = { name: 'intensity', type: number({ min: 0 }) };

type Components = SceneEntityFile['components'];
type SpriteCommon = Omit<SceneSprite, 'texture' | 'pixelsPerUnit' | 'center' | 'centerFromMiddle' | 'sheet' | 'frame'>;

export interface ComponentDescription {
  /** 面板上的名字（Stride 的组件名）。 */
  readonly label: string;
  /** 组件的值是什么：多数是一个对象，光、背景、精灵按种类分，约束是列表。 */
  readonly type: FieldType;
  /** "添加组件"时放进文件的值。 */
  readonly initial: unknown;
  /** 要同一个实体上也有的组件（场景文件的键）：编辑器加这个组件时把缺的一起加上，去掉被依赖的组件时提示。 */
  readonly requires?: readonly string[];
}

/**
 * 实体文件里每种组件（脚本另算，见 scriptFields）。键的顺序是面板上的顺序。
 * 和文件格式对不上（少了字段、多了字段）时这里过不了类型检查。
 */
export const COMPONENT_FIELDS: { readonly [K in Exclude<keyof Components, 'scripts'>]-?: ComponentDescription } = {
  model: {
    label: 'Model',
    type: object(fields<NonNullable<Components['model']>>({
      model: asset('model'),
      materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, optional: true, default: [], description: 'one per material slot of the model; null keeps the model\'s own material; omitted keeps all of them' },
      isShadowCaster: optional(bool, true),
      renderGroup,
    })),
    initial: { model: '' },
  },
  camera: {
    label: 'Camera',
    type: object(fields<NonNullable<Components['camera']>>({
      verticalFieldOfView: number({ min: 1, max: 179, unit: 'deg' }),
      nearClipPlane: number({ min: 0, unit: 'm' }),
      farClipPlane: number({ min: 0, unit: 'm' }),
      slot: optional(integer(0), 0),
      projection: optional(oneOf('orthographic')),
      orthographicSize: optional(number({ min: 0, unit: 'm' }), 10),
      aspectRatio: { type: number({ min: 0 }), optional: true, default: 0, description: 'frame width / height (2.39, 1.778, 0.5625); bars outside it; 0 fills the canvas' },
      physical: {
        type: object(fields<NonNullable<NonNullable<Components['camera']>['physical']>>({
          sensor: { type: vector(2, 'mm'), optional: true, default: [36, 24], description: 'sensor width and height; 36x24 is full frame' },
          focalLength: { type: number({ min: 1, unit: 'mm' }), optional: true, default: 50, description: 'replaces verticalFieldOfView' },
          aperture: { type: number({ min: 0.5 }), optional: true, default: 2.8, description: 'f-number; smaller is a shallower depth of field' },
          focusDistance: { type: number({ min: 0.01, unit: 'm' }), optional: true, default: 10 },
          shutterAngle: { type: number({ min: 0, max: 360, unit: 'deg' }), optional: true, default: 180, description: 'motion blur: 180 exposes half a frame' },
          exposureCompensation: { type: number({ unit: 'EV' }), optional: true, default: 0 },
          depthOfField: { type: bool, optional: true, default: false, description: 'blur by aperture, focal length and focus distance (needs post effects)' },
        })),
        optional: true,
        description: 'physical camera: focal length, aperture, focus, shutter, exposure (main view only)',
      },
    })),
    initial: { verticalFieldOfView: 45, nearClipPlane: 0.1, farClipPlane: 1000 },
  },
  light: {
    label: 'Light',
    type: {
      kind: 'union',
      tag: 'type',
      variants: {
        directional: [lightColor, intensity, { name: 'shadow', type: object(directionalShadow), optional: true }],
        ambient: [lightColor, intensity, { name: 'shadow', type: object(directionalShadow), optional: true }],
        skybox: [{ name: 'skybox', type: asset('skybox') }, intensity],
        point: [lightColor, intensity, { name: 'radius', type: number({ min: 0, unit: 'm' }) }, { name: 'shadow', type: object(localShadow), optional: true }],
        spot: [
          lightColor, intensity, { name: 'range', type: number({ min: 0, unit: 'm' }) },
          { name: 'angleInner', type: number({ min: 0, max: 180, unit: 'deg' }) }, { name: 'angleOuter', type: number({ min: 0, max: 180, unit: 'deg' }) },
          { name: 'shadow', type: object(localShadow), optional: true },
        ],
      } satisfies Record<NonNullable<Components['light']>['type'], readonly Field[]>,
    },
    initial: { type: 'point', color: [1, 1, 1], intensity: 1, radius: 1 },
  },
  background: {
    label: 'Background',
    type: {
      kind: 'union',
      tag: 'type',
      variants: {
        cubemap: [{ name: 'texture', type: asset('cubemap') }],
        '2d': [{ name: 'image', type: object(textureRef) }],
      } satisfies Record<SceneBackground['type'], readonly Field[]>,
      common: [intensity, { name: 'renderGroup', type: integer(0, 31), optional: true, default: 0 }],
    },
    initial: { type: 'cubemap', texture: '', intensity: 1 },
  },
  reflectionProbe: {
    label: 'Reflection probe',
    type: object(fields<SceneReflectionProbe>({
      size: vector(3, 'm'),
      blendDistance: optional(number({ min: 0, unit: 'm' }), 1),
      boxProjection: optional(bool, true),
      intensity: optional(number({ min: 0 }), 1),
      refresh: optional(oneOf('once', 'everyFrame'), 'once'),
    })),
    initial: { size: [10, 10, 10] },
  },
  cameraRig: {
    label: 'Camera rig',
    type: object(fields<NonNullable<Components['cameraRig']>>({
      follow: { type: entity, optional: true, description: 'entity to follow; unset keeps the position' },
      offset: optional(vector(3, 'm'), [0, 2, 6]),
      followDamping: { type: number({ min: 0, unit: 's' }), optional: true, default: 0.2, description: 'half-life of the smoothing; 0 snaps' },
      lookAt: { type: entity, optional: true, description: 'entity to look at; unset keeps the rotation' },
      lookOffset: optional(vector(3, 'm'), [0, 1, 0]),
      lookDamping: { type: number({ min: 0, unit: 's' }), optional: true, default: 0.05, description: 'half-life of the smoothing; 0 snaps' },
      shakeRotation: { type: number({ min: 0, unit: 'deg' }), optional: true, default: 0, description: 'handheld shake' },
      shakePosition: optional(number({ min: 0, unit: 'm' }), 0),
      shakeFrequency: optional(number({ min: 0, unit: 'Hz' }), 1),
    })),
    initial: { offset: [0, 2, 6] },
    requires: ['camera'],
  },
  skyAtmosphere: {
    label: 'Sky atmosphere',
    type: object(fields<SceneSkyAtmosphere>({
      planetRadius: optional(number({ min: 1, unit: 'km' }), 6360),
      atmosphereHeight: optional(number({ min: 0.1, unit: 'km' }), 100),
      rayleighScattering: optional(vector(3, '1/km'), [0.005802, 0.013558, 0.0331]),
      mieScattering: optional(number({ min: 0, unit: '1/km' }), 0.003996),
      mieAbsorption: optional(number({ min: 0, unit: '1/km' }), 0.000444),
      miePhaseG: optional(number({ min: -0.99, max: 0.99 }), 0.8),
      ozoneAbsorption: optional(vector(3, '1/km'), [0.00065, 0.001881, 0.000085]),
      groundAlbedo: optional(vector(3), [0.3, 0.3, 0.3]),
      skyIntensity: optional(number({ min: 0 }), 1),
      aerialPerspectiveScale: optional(number({ min: 0 }), 1),
      sun: { type: entity, optional: true, description: 'entity with the directional light of the sun; unset uses the shadow-casting directional light' },
      moon: { type: entity, optional: true, description: 'entity with the directional light of the moon (its color and intensity are those of the full moon)' },
      moonDiskIntensity: optional(number({ min: 0 }), 1),
      starsIntensity: optional(number({ min: 0 }), 1),
    })),
    initial: {},
  },
  volumetricClouds: {
    label: 'Volumetric clouds',
    type: object(fields<SceneVolumetricClouds>({
      coverage: optional(number({ min: 0, max: 1 }), 0.5),
      density: optional(number({ min: 0 }), 1),
      bottom: optional(number({ min: 0, unit: 'm' }), 1500),
      thickness: optional(number({ min: 10, unit: 'm' }), 2500),
      cloudType: { type: number({ min: 0, max: 1 }), optional: true, default: 0.7, description: '0 stratus, 0.5 stratocumulus, 1 cumulus' },
      scale: optional(number({ min: 0.05 }), 1),
      windSpeed: optional(number({ min: 0, unit: 'm/s' }), 10),
      windDirection: { type: number({ unit: 'deg' }), optional: true, default: 0, description: 'where the wind blows to, around Y: 0 is +Z, 90 is +X' },
    })),
    initial: {},
  },
  volumetricFog: {
    label: 'Volumetric fog',
    type: object(fields<SceneVolumetricFog>({
      density: { type: number({ min: 0, unit: '1/m' }), optional: true, default: 0.02, description: 'extinction per meter at the base height' },
      heightFalloff: optional(number({ min: 0, unit: '1/m' }), 0.1),
      baseHeight: optional(number({ unit: 'm' }), 0),
      color: optional(vector(3), [1, 1, 1]),
      anisotropy: optional(number({ min: -0.9, max: 0.9 }), 0.6),
      distance: optional(number({ min: 1, unit: 'm' }), 120),
      ambient: optional(number({ min: 0 }), 1),
      noise: { type: number({ min: 0, max: 1 }), optional: true, default: 0, description: 'clumps that drift with the wind' },
      noiseScale: optional(number({ min: 0.1, unit: 'm' }), 8),
      farFog: { type: bool, optional: true, default: true, description: 'analytic height fog beyond distance' },
    })),
    initial: {},
  },
  dayNightCycle: {
    label: 'Day-night cycle',
    type: object(fields<SceneDayNightCycle>({
      timeOfDay: optional(number({ min: 0, max: 24, unit: 'h' }), 12),
      dayLength: { type: number({ min: 0, unit: 's' }), optional: true, default: 0, description: 'game seconds per day; 0 keeps the time still' },
      dayOfYear: optional(number({ min: 1, max: 365 }), 80),
      latitude: optional(number({ min: -90, max: 90, unit: 'deg' }), 35),
      north: optional(number({ unit: 'deg' }), 0),
      moonPhase: { type: number({ min: 0, max: 1 }), optional: true, default: 0.5, description: '0 new moon, 0.5 full moon' },
    })),
    initial: {},
    // 日夜循环的系统查询的是同时有 DayNightCycle 和 SkyAtmosphere 的实体
    requires: ['skyAtmosphere'],
  },
  windZone: {
    label: 'Wind zone',
    type: object(fields<SceneWindZone>({
      mode: { type: oneOf('directional', 'spherical'), optional: true, default: 'directional', description: 'directional blows everywhere along the entity\'s -Z; spherical blows outward within the radius' },
      strength: optional(number({ unit: 'm/s' }), 3),
      turbulence: optional(number({ min: 0, unit: 'm/s' }), 0.5),
      pulseMagnitude: { type: number({ min: 0 }), optional: true, default: 0.5, description: 'gusts swing the strength by 1 ± this' },
      pulseFrequency: optional(number({ min: 0, unit: 'Hz' }), 0.2),
      radius: optional(number({ min: 0, unit: 'm' }), 10),
    })),
    initial: {},
  },
  precipitation: {
    label: 'Precipitation',
    type: object(fields<ScenePrecipitation>({
      kind: optional(oneOf('rain', 'snow'), 'rain'),
      intensity: { type: number({ min: 0, max: 1 }), optional: true, default: 1, description: 'set by the weather; 0 stops it' },
      radius: { type: number({ min: 1, unit: 'm' }), optional: true, default: 20, description: 'half size of the volume around the camera' },
      height: { type: number({ min: 1, unit: 'm' }), optional: true, default: 12, description: 'how far above the camera it starts falling' },
    })),
    initial: {},
  },
  decal: {
    label: 'Decal',
    type: object(fields<SceneDecal>({
      size: { type: vector(3), optional: true, default: [2, 2, 2], description: 'box size in meters; projects along the entity\'s -Y' },
      albedo: { type: object(textureRef), optional: true, description: 'color texture (sRGB); its alpha masks the decal' },
      normal: { type: object(textureRef), optional: true, description: 'tangent-space normal map (green up)' },
      color: optional(vector(3), [1, 1, 1]),
      opacity: optional(number({ min: 0, max: 1 }), 1),
      albedoMix: { type: number({ min: 0, max: 1 }), optional: true, default: 1, description: 'how much of the color is replaced; 0 keeps only the normal' },
      normalFade: { type: number({ min: 0, max: 1 }), optional: true, default: 0.3, description: 'fade surfaces that face away from the projection' },
      upperFade: optional(number({ min: 0, max: 1 }), 0.3),
      lowerFade: optional(number({ min: 0, max: 1 }), 0.3),
    })),
    initial: {},
  },
  weather: {
    label: 'Weather',
    type: object(fields<SceneWeather>({
      cloudCoverage: optional(number({ min: 0, max: 1 }), 0.3),
      cloudType: { type: number({ min: 0, max: 1 }), optional: true, default: 0.7, description: '0 layered stratus, 1 towering cumulonimbus' },
      precipitation: { type: number({ min: 0, max: 1 }), optional: true, default: 0, description: 'rain or snow (by temperature); 1 is a downpour' },
      temperature: { type: number({ unit: '°C' }), optional: true, default: 15, description: 'below 1 °C it snows' },
      fog: optional(number({ min: 0, max: 1 }), 0),
      windSpeed: optional(number({ min: 0, unit: 'm/s' }), 3),
      windDirection: { type: number({ unit: 'deg' }), optional: true, default: 0, description: 'where the wind blows to, around Y: 0 is +Z, 90 is +X' },
      gustiness: optional(number({ min: 0, max: 1 }), 0.3),
      transitionTime: { type: number({ min: 0, unit: 's' }), optional: true, default: 30, description: 'how fast the current weather follows; 0 changes at once' },
    })),
    initial: {},
  },
  sprite: {
    label: 'Sprite',
    // 精灵要么是精灵表的一帧（有 sheet），要么是一整张贴图（有 texture）：没有单独的种类字段，面板按有哪个键分
    type: object([
      ...fields<SpriteCommon>({
        enabled: optional(bool, true),
        renderGroup,
        type: oneOf('sprite', 'billboard'),
        color: { kind: 'color', alpha: true, space: 'linear' },
        intensity: number({ min: 0 }),
        isTransparent: bool,
        premultipliedAlpha: bool,
        ignoreDepth: bool,
        isAlphaCutoff: bool,
        blendMode: oneOf('auto', 'none', 'alphaBlend', 'additiveBlend', 'noColor'),
        sampler,
      }),
      { name: 'sheet', type: asset('spriteSheet'), optional: true, group: 'sheet' },
      { name: 'frame', type: integer(0), optional: true, group: 'sheet' },
      { name: 'texture', type: { kind: 'json' }, optional: true, group: 'texture', description: 'a texture file ({ texture, encoding }) or a render texture ({ renderTexture, width, height, hdr, srgb })' },
      { name: 'pixelsPerUnit', type: number({ min: 0 }), optional: true, group: 'texture' },
      { name: 'center', type: vector(2, 'px'), optional: true, group: 'texture' },
      { name: 'centerFromMiddle', type: bool, optional: true, group: 'texture' },
    ]),
    initial: { type: 'sprite', color: [1, 1, 1, 1], intensity: 1, isTransparent: true, premultipliedAlpha: true, ignoreDepth: false, isAlphaCutoff: false, blendMode: 'auto', sampler: 'linearClamp', sheet: '', frame: 0 },
  },
  animation: {
    label: 'Animation',
    type: object(fields<SceneAnimation>({ animations: list(object([{ name: 'name', type: string }, { name: 'clip', type: asset('animation') }])) })),
    initial: { animations: [] },
  },
  static: {
    label: 'Static collider',
    type: object(fields<SceneCollidable>(collidable)),
    initial: { shapes: [{ type: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1 },
  },
  body: {
    label: 'Body',
    type: object(fields<SceneBody>({ ...collidable, kinematic: bool, gravity: bool, sleepThreshold: number(), interpolated: bool })),
    initial: { shapes: [{ type: 'box', size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1, kinematic: false, gravity: true, sleepThreshold: 0.01, interpolated: true },
  },
  character: {
    label: 'Character',
    type: object(fields<SceneCharacter>({
      ...collidable,
      speed: number({ min: 0 }),
      jumpForce: number({ min: 0 }),
      maximumHorizontalForce: number({ min: 0 }),
      maximumVerticalForce: number({ min: 0 }),
      slopeAngle: number({ min: 0, max: 90, unit: 'deg' }),
      airControlForceScale: number({ min: 0 }),
      airControlScale: number({ min: 0 }),
      gravity: bool,
      interpolated: bool,
    })),
    initial: {
      shapes: [{ type: 'capsule', radius: 0.35, length: 1.2, position: [0, 0.95, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1,
      speed: 10, jumpForce: 5, maximumHorizontalForce: 20, maximumVerticalForce: 100, slopeAngle: 45, airControlForceScale: 0.2, airControlScale: 0.5,
      gravity: true, interpolated: true,
    },
  },
  constraints: {
    label: 'Constraints',
    type: list(object(fields<SceneConstraint>({
      type: string,
      enabled: bool,
      bodyA: entity,
      bodyB: optional(entity),
      settings: { kind: 'json' },
    }))),
    initial: [],
  },
  particleSystem: { label: 'Particle system', type: { kind: 'json' }, initial: {} },
  ui: {
    label: 'UI',
    type: object(fields<SceneUI>({
      page: nullable(asset('ui')),
      resolution: vector(3, 'px'),
      size: vector(3, 'm'),
      resolutionStretch: oneOf('fixedWidthFixedHeight', 'fixedWidthAdaptableHeight', 'fixedHeightAdaptableWidth'),
      renderGroup,
      isFullScreen: optional(bool, true),
      isBillboard: optional(bool, true),
      isFixedSize: optional(bool, false),
      snapText: optional(bool, true),
      sampler: optional(sampler, 'linearClamp'),
      enabled: optional(bool, true),
    })),
    initial: { page: null, resolution: [1280, 720, 1000], size: [1.28, 0.72, 1], resolutionStretch: 'fixedWidthAdaptableHeight' },
  },
  instancing: { label: 'Instancing', type: object([]), initial: {} },
  instance: { label: 'Instance', type: object(fields<NonNullable<Components['instance']>>({ master: nullable(entity) })), initial: { master: null } },
  nodeLink: {
    label: 'Model node link',
    type: object(fields<NonNullable<Components['nodeLink']>>({ target: { type: entity, nullable: true, description: 'null links to the parent entity' }, nodeName: string })),
    initial: { target: null, nodeName: '' },
  },
  uiElementLink: {
    label: 'UI element link',
    type: object(fields<NonNullable<Components['uiElementLink']>>({ target: nullable(entity), camera: nullable(entity), nodeName: string })),
    initial: { target: null, camera: null, nodeName: '' },
  },
};

/** 场景的后处理（合成器的 postEffects）：ambientOcclusion、localReflections 写了就是开着。 */
const postEffects = fields<ScenePostEffects>({
  brightFilter: bool,
  bloom: bool,
  lightStreak: bool,
  lensFlare: bool,
  toneMap: bool,
  antialiasing: bool,
  ambientOcclusion: optional(object([{ name: 'radius', type: number({ min: 0, unit: 'm' }) }])),
  localReflections: optional(object([{ name: 'maxRoughness', type: number({ min: 0, max: 1 }) }, { name: 'edgeFade', type: number({ min: 0, max: 1 }) }])),
});

/**
 * 场景自己的设置（场景文件里实体以外的那几个键，'scene' 修改改它们）：面板上没选实体时显示。initial 是"添加"时放进去的值
 * （同引擎没写时用的默认值）。编辑状态下合成器、偏移改了马上看得见，物理、导航试玩时才用上（见 LiveScene）。
 */
export const SCENE_FIELDS: { readonly [K in SceneSettingKey]: ComponentDescription } = {
  physics: {
    label: 'Physics',
    type: object(fields<ScenePhysics>({
      gravity: vector(3, 'm/s²'),
      linearDamping: number({ min: 0, max: 1 }),
      angularDamping: number({ min: 0, max: 1 }),
      fixedTimeStep: number({ min: 0.001, unit: 's' }),
      maximumTimeToProcess: optional(number({ min: 0, unit: 's' }), 0.25),
      dropPostponedTicks: optional(bool, false),
      collisionMasks: optional(list(integer(0))),
    })),
    initial: { gravity: [0, -9.8, 0], linearDamping: 0.05, angularDamping: 0.05, fixedTimeStep: 1 / 60 },
  },
  navigation: {
    label: 'Navigation',
    type: object(fields<SceneNavigation>({
      build: object(fields<SceneNavigation['build']>({
        cellSize: number({ min: 0.01, unit: 'm' }),
        cellHeight: number({ min: 0.01, unit: 'm' }),
        agentHeight: number({ min: 0, unit: 'm' }),
        agentRadius: number({ min: 0, unit: 'm' }),
        agentMaxClimb: number({ min: 0, unit: 'm' }),
        agentMaxSlopeDegrees: number({ min: 0, max: 90, unit: '°' }),
        tileSize: integer(1),
        maxEdgeLength: number({ min: 0 }),
        maxSimplificationError: number({ min: 0 }),
        minRegionSize: number({ min: 0 }),
        mergeRegionSize: number({ min: 0 }),
        detailSampleDistance: number({ min: 0 }),
        detailSampleMaxError: number({ min: 0 }),
      })),
      includedLayers: integer(0),
    })),
    initial: {
      build: {
        cellSize: 0.3, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.6, agentMaxClimb: 0.9, agentMaxSlopeDegrees: 45, tileSize: 32,
        maxEdgeLength: 12, maxSimplificationError: 1.3, minRegionSize: 8, mergeRegionSize: 20, detailSampleDistance: 6, detailSampleMaxError: 1,
      },
      includedLayers: 0xffffffff,
    },
  },
  offset: { label: 'Offset', type: vector(3, 'm'), initial: [0, 0, 0] },
  compositor: {
    label: 'Compositor',
    type: object(fields<SceneCompositor>({
      clearColor: { kind: 'color', alpha: true, space: 'linear' },
      postEffects: nullable(object(postEffects)),
      renderMask: optional(integer(0)),
      transparent: bool,
      subsurfaceScattering: optional(bool, false),
      // 渲染目标贴图的相机：形状多（各带一套前向渲染器的设置），先按 JSON 改
      textureCameras: optional({ kind: 'json' }),
      shadows: optional(bool, true),
      particlesOverUI: optional(bool, false),
      meshEffect: optional(string),
    })),
    initial: { clearColor: [0.01, 0.0134, 0.022, 1], postEffects: null, transparent: true },
  },
};

/** 每个实体都有的字段（名字和变换）。 */
export const ENTITY_FIELDS: readonly Field[] = [
  { name: 'name', type: string },
  { name: 'position', type: vector(3, 'm') },
  { name: 'rotation', type: rotation },
  { name: 'scale', type: vector(3) },
];

/** 背景的平面图片、精灵的贴图可以写成的两种形状（面板给 'json' 的 texture 字段选形状时用）。 */
export const TEXTURE_FIELDS = { file: textureRef, renderTexture } as const;

/** 材质的贴图槽（颜色、自发光）：贴图加采样方式和 UV 的缩放、偏移。 */
const textureSlot = fields<TextureSlot>({
  ...Object.fromEntries(textureRef.map((field) => [field.name, field])) as Record<keyof TextureRef, Field>,
  filter: optional(oneOf('point', 'anisotropic')),
  addressU: optional(oneOf('clamp', 'mirror')),
  addressV: optional(oneOf('clamp', 'mirror')),
  scale: { type: vector(2), optional: true, default: [1, 1] },
  offset: { type: vector(2), optional: true, default: [0, 0] },
});
const colorLinear3: FieldType = { kind: 'color', alpha: false, space: 'linear' };
/** 编辑器里还没有专门控件的复杂部分（颜色树、材质层……）：按原样的 JSON 改。 */
const json: FieldType = { kind: 'json' };

/**
 * 材质文件（MaterialFile）的字段：常用的（基础色、金属度、粗糙度、自发光、两面、透明、裁剪）有控件，颜色树、材质层这类
 * 导入的复杂结构先按 JSON 改。
 */
export const MATERIAL_FIELDS = fields<MaterialFile>({
  name: string,
  baseColor: { type: { kind: 'color', alpha: true, space: 'linear' }, group: 'base', description: 'linear base color; multiplied with (or added to) the texture' },
  baseColorTexture: { type: object(textureSlot), optional: true, group: 'base' },
  baseColorOperator: { type: oneOf('multiply', 'add'), optional: true, default: 'multiply', group: 'base' },
  metalness: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, group: 'surface', description: 'metalness workflow; leave unset for the specular workflow' },
  roughness: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, default: 1, group: 'surface' },
  specular: { type: colorLinear3, optional: true, group: 'surface', description: 'specular workflow (instead of metalness)' },
  specularEnergyConservative: { type: json, optional: true, group: 'advanced' },
  specularShading: { type: json, optional: true, group: 'advanced' },
  diffuseShading: { type: json, optional: true, group: 'advanced' },
  glossinessTexture: { type: json, optional: true, group: 'advanced' },
  emissive: { type: colorLinear3, optional: true, group: 'emissive', description: 'linear color times intensity (can exceed 1 for bloom)' },
  emissiveTexture: { type: object(textureSlot), optional: true, group: 'emissive' },
  emissiveTree: { type: json, optional: true, group: 'advanced' },
  normalMap: { type: json, optional: true, group: 'advanced' },
  normalTree: { type: json, optional: true, group: 'advanced' },
  displacementTree: { type: json, optional: true, group: 'advanced' },
  ambientOcclusion: { type: json, optional: true, group: 'advanced' },
  cavity: { type: object(fields<NonNullable<MaterialFile['cavity']>>({ diffuse: number({ min: 0, max: 1 }), specular: number({ min: 0, max: 1 }) })), optional: true, group: 'advanced' },
  doubleSided: { type: bool, optional: true, default: false, group: 'surface' },
  alphaCutoff: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, group: 'surface', description: 'pixels with a base color alpha below it are discarded' },
  transparency: { type: json, optional: true, group: 'surface' },
  microfacet: { type: json, optional: true, group: 'advanced' },
  celShading: { type: json, optional: true, group: 'advanced' },
  glass: { type: object(fields<NonNullable<MaterialFile['glass']>>({ refractiveIndex: number({ min: 1, max: 3, step: 0.01 }) })), optional: true, group: 'advanced' },
  clearCoat: { type: json, optional: true, group: 'advanced' },
  subsurfaceScattering: { type: json, optional: true, group: 'advanced' },
  sheen: { type: object(fields<NonNullable<MaterialFile['sheen']>>({ color: colorLinear3, roughness: number({ min: 0, max: 1, step: 0.01 }) })), optional: true, group: 'advanced' },
  anisotropy: { type: object(fields<NonNullable<MaterialFile['anisotropy']>>({ strength: number({ min: -1, max: 1, step: 0.01 }), rotation: { type: number({ unit: 'rad' }), optional: true, default: 0 } })), optional: true, group: 'advanced' },
  layers: { type: json, optional: true, group: 'advanced' },
  graph: { type: json, optional: true, group: 'advanced', description: 'material node graph (edited in the node graph panel); its outputs override the values above' },
});

const positiveNumber = (step = 0.05): FieldType => number({ min: 0, step });
const tessellation = (fallback: number): FieldSpec => ({ type: integer(1, 256), optional: true, default: fallback });

/** JSON 写的模型（ProceduralModelFile）：形状和它的参数（默认值同 Stride），共有的 UV 缩放、平移、缩放，材质槽。 */
export const PROCEDURAL_MODEL_FIELDS = fields<ProceduralModelFile>({
  format: { type: integer(1, 1), description: 'file format version' },
  procedural: {
    type: {
      kind: 'union',
      tag: 'type',
      variants: {
        cube: fields<{ size: unknown }>({ size: { type: vector(3, 'm'), optional: true, default: [1, 1, 1] } }),
        plane: fields<{ size: unknown; tessellation: unknown; backFace: unknown; normal: unknown }>({
          size: { type: vector(2, 'm'), optional: true, default: [1, 1] },
          tessellation: { type: vector(2), optional: true, default: [1, 1] },
          backFace: { type: bool, optional: true, default: false },
          normal: { type: oneOf('x', 'y', 'z'), optional: true, default: 'y' },
        }),
        sphere: fields<{ radius: unknown; tessellation: unknown }>({ radius: { type: positiveNumber(), optional: true, default: 0.5 }, tessellation: tessellation(16) }),
        geoSphere: fields<{ radius: unknown; tessellation: unknown }>({ radius: { type: positiveNumber(), optional: true, default: 0.5 }, tessellation: { type: integer(0, 8), optional: true, default: 3 } }),
        capsule: fields<{ length: unknown; radius: unknown; tessellation: unknown }>({ length: { type: positiveNumber(), optional: true, default: 0.5 }, radius: { type: positiveNumber(), optional: true, default: 0.35 }, tessellation: tessellation(8) }),
        cylinder: fields<{ height: unknown; radius: unknown; tessellation: unknown }>({ height: { type: positiveNumber(), optional: true, default: 1 }, radius: { type: positiveNumber(), optional: true, default: 0.5 }, tessellation: tessellation(32) }),
        torus: fields<{ radius: unknown; thickness: unknown; tessellation: unknown }>({ radius: { type: positiveNumber(), optional: true, default: 0.375 }, thickness: { type: positiveNumber(0.01), optional: true, default: 0.125 }, tessellation: tessellation(32) }),
        cone: fields<{ radius: unknown; height: unknown; tessellation: unknown }>({ radius: { type: positiveNumber(), optional: true, default: 0.5 }, height: { type: positiveNumber(), optional: true, default: 1 }, tessellation: tessellation(16) }),
        teapot: fields<{ size: unknown; tessellation: unknown }>({ size: { type: positiveNumber(), optional: true, default: 1 }, tessellation: tessellation(8) }),
      },
      common: fields<{ uvScale: unknown; localOffset: unknown; scale: unknown }>({
        uvScale: { type: vector(2), optional: true, default: [1, 1] },
        localOffset: { type: vector(3, 'm'), optional: true, default: [0, 0, 0] },
        scale: { type: vector(3), optional: true, default: [1, 1, 1] },
      }),
    },
  },
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, optional: true, default: [], description: 'material per slot (a procedural model has one slot)' },
});

/** 时间轴（TimelineFile）：轨道按种类分；关键帧的值是数或按分量的数组，按 JSON 改。 */
export const TIMELINE_FIELDS = fields<TimelineFile>({
  name: string,
  duration: { type: number({ min: 0, unit: 's' }) },
  frameRate: { type: number({ min: 1 }), optional: true, default: 30, description: 'frames per second for snapping and display in the editor' },
  tracks: list({
    kind: 'union',
    tag: 'type',
    variants: {
      property: fields<{ entity: unknown; component: unknown; property: unknown; interpolation: unknown; keys: unknown }>({
        entity: { type: entity, description: 'id of the entity in the scene file' },
        component: { type: string, description: 'runtime component name (Transform, Light, or a game component registered by module path)' },
        property: string,
        interpolation: { type: oneOf('constant', 'linear', 'cubic'), optional: true, default: 'linear' },
        keys: list(object([
          { name: 'time', type: number({ min: 0, unit: 's' }) },
          { name: 'value', type: { kind: 'json' }, description: 'a number, or the components (xyz, xyzw, rgba)' },
          { name: 'in', type: { kind: 'json' }, optional: true, description: 'cubic only: slope (per second) arriving at the key, per component; unset is automatic' },
          { name: 'out', type: { kind: 'json' }, optional: true, description: 'cubic only: slope (per second) leaving the key, per component; unset is automatic' },
        ])),
      }),
      camera: fields<{ cuts: unknown }>({ cuts: list(object([{ name: 'time', type: number({ min: 0, unit: 's' }) }, { name: 'camera', type: entity, description: 'id of the camera entity in the scene file' }])) }),
      animation: fields<{ entity: unknown; clips: unknown }>({
        entity: { type: entity, description: 'id of the entity in the scene file' },
        clips: list(object([
          { name: 'start', type: number({ min: 0, unit: 's' }) },
          { name: 'clip', type: string, description: 'name of the clip in the AnimationComponent' },
          { name: 'speed', type: number(), optional: true, default: 1 },
          { name: 'blend', type: number({ min: 0, unit: 's' }), optional: true, description: 'seconds of crossfade from the previous clip' },
        ])),
      }),
      sound: fields<{ clips: unknown }>({
        clips: list(object([
          { name: 'start', type: number({ min: 0, unit: 's' }) },
          { name: 'sound', type: asset('sound') },
          { name: 'volume', type: number({ min: 0 }), optional: true, default: 1 },
        ])),
      }),
      subtitle: fields<{ cues: unknown }>({
        cues: list(object([{ name: 'start', type: number({ min: 0, unit: 's' }) }, { name: 'end', type: number({ min: 0, unit: 's' }) }, { name: 'text', type: string }])),
      }),
      event: fields<{ events: unknown }>({ events: list(object([{ name: 'time', type: number({ min: 0, unit: 's' }) }, { name: 'name', type: string }])) }),
    } satisfies Record<TimelineFile['tracks'][number]['type'], readonly Field[]>,
  }),
});

/** 关卡白盒（BrushFile）：笔刷按形状分；改了马上存，编辑器后端烘成同名的模型，视口里热重载。 */
export const BRUSH_FIELDS = fields<BrushFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots; a brush picks one by index' },
  uvScale: { type: number({ min: 0.01, step: 0.25, unit: 'm' }), optional: true, default: 1, description: 'automatic UVs: one texture repeat per this many meters' },
  brushes: list({
    kind: 'union',
    tag: 'kind',
    variants: {
      box: fields<{ size: unknown }>({ size: { type: vector(3, 'm') } }),
      prism: fields<{ points: unknown; height: unknown }>({
        points: { type: { kind: 'json' }, description: 'polygon in the XZ plane as [x, z] pairs (may be concave), extruded up from the position' },
        height: { type: positiveNumber() },
      }),
      cylinder: fields<{ height: unknown; radius: unknown; topRadius: unknown; segments: unknown }>({
        height: { type: positiveNumber() },
        radius: { type: positiveNumber() },
        topRadius: { type: positiveNumber(), optional: true, description: 'unset: same as radius; 0 makes a cone' },
        segments: { type: integer(3, 256), optional: true, default: 32 },
      }),
      sphere: fields<{ radius: unknown; segments: unknown }>({ radius: { type: positiveNumber() }, segments: { type: integer(3, 256), optional: true, default: 32 } }),
    },
    common: fields<{ name: unknown; operation: unknown; position: unknown; rotation: unknown; material: unknown }>({
      name: { type: string, optional: true },
      operation: { type: oneOf('add', 'subtract', 'intersect') },
      position: { type: vector(3, 'm') },
      rotation: { type: rotation, optional: true, default: [0, 0, 0, 1] },
      material: { type: integer(0, 255), optional: true, default: 0, description: 'index into materials' },
    }),
  }),
});

/** SDF 建模（SdfFile）：形状按种类分；改了马上存，编辑器后端烘成同名的模型，视口里热重载。 */
export const SDF_FIELDS = fields<SdfFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots; a shape picks one by index' },
  resolution: { type: number({ min: 0.005, step: 0.01, unit: 'm' }), optional: true, default: 0.05, description: 'mesh edge length: smaller is finer and slower to bake' },
  uvScale: { type: number({ min: 0.01, step: 0.25, unit: 'm' }), optional: true, default: 1, description: 'automatic UVs: one texture repeat per this many meters' },
  shapes: list({
    kind: 'union',
    tag: 'kind',
    variants: {
      sphere: fields<{ radius: unknown }>({ radius: { type: positiveNumber() } }),
      box: fields<{ size: unknown; cornerRadius: unknown }>({
        size: { type: vector(3, 'm') },
        cornerRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0 },
      }),
      capsule: fields<{ height: unknown; radius: unknown }>({
        height: { type: number({ min: 0, step: 0.1, unit: 'm' }), description: 'distance between the two end centers, along Y' },
        radius: { type: positiveNumber() },
      }),
      cylinder: fields<{ height: unknown; radius: unknown; edgeRadius: unknown }>({
        height: { type: positiveNumber() },
        radius: { type: positiveNumber() },
        edgeRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0 },
      }),
      torus: fields<{ ringRadius: unknown; tubeRadius: unknown }>({ ringRadius: { type: positiveNumber() }, tubeRadius: { type: positiveNumber() } }),
      ellipsoid: fields<{ radii: unknown }>({ radii: { type: vector(3, 'm') } }),
    },
    common: fields<{ name: unknown; operation: unknown; smoothness: unknown; position: unknown; rotation: unknown; material: unknown }>({
      name: { type: string, optional: true },
      operation: { type: oneOf('add', 'subtract', 'intersect') },
      smoothness: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0, description: 'how wide the blend into the shapes before it is (0 is a sharp seam)' },
      position: { type: vector(3, 'm') },
      rotation: { type: rotation, optional: true, default: [0, 0, 0, 1] },
      material: { type: integer(0, 255), optional: true, default: 0, description: 'index into materials' },
    }),
  }),
});

/**
 * 多边形网格（PolyMeshFile）：顶点和面在视口里点线面地改（多边形编辑模式）或者用 MCP 的 edit_poly，这里按 JSON 显示；
 * 改了马上存，编辑器后端烘成同名的模型。
 */
export const POLY_FIELDS = fields<PolyMeshFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots; a face picks one by index' },
  smoothAngle: { type: number({ min: 0, max: 180, step: 5, unit: '°' }), optional: true, default: 30, description: 'neighboring faces closer than this angle share smooth normals; 0 makes every edge hard' },
  uvScale: { type: number({ min: 0.01, step: 0.25, unit: 'm' }), optional: true, default: 1, description: 'automatic UVs: one texture repeat per this many meters' },
  mirror: { type: oneOf('x', 'y', 'z'), optional: true, description: 'mirror a copy across the x = 0, y = 0 or z = 0 plane (edit one half, both change)' },
  vertices: { type: { kind: 'json' }, description: 'vertex positions; edit them in the viewport (poly edit mode) or with edit_poly' },
  faces: { type: { kind: 'json' }, description: 'faces as vertex index loops, counterclockwise seen from outside, each with an optional material slot' },
});

/**
 * 游戏设置（.game.json，Stride 的 GameSettings）。根渲染器（合成器的根是游戏自己的渲染器时，SpriteFonts、CustomEffect）的类型是
 * 游戏登记的名字，属性的字段由游戏的代码定，这里是 JSON；属性面板按文件里现在的值推出字段（gameSettingsFields）。
 */
export const GAME_SETTINGS_FIELDS = fields<GameSettingsFile>({
  name: string,
  defaultScene: { ...nullable(asset('scene')), description: 'the scene the game opens with; null when the root renderer draws everything (no scene)' },
  renderer: { ...nullable({ kind: 'json' }), description: 'the compositor root when the game draws with its own renderer: its registered type name and properties' },
  defaultBackBufferSize: { ...optional(vector(2, 'px'), [1280, 720]), description: 'the design resolution (desktop Stride opens its window this size)' },
});

/** 属性面板能编辑的资源（选中资源浏览器里的它时）：种类 → 字段。模型只有 JSON 写的那种能编辑。 */
export const ASSET_FIELDS = { material: MATERIAL_FIELDS, model: PROCEDURAL_MODEL_FIELDS, timeline: TIMELINE_FIELDS, brush: BRUSH_FIELDS, sdf: SDF_FIELDS, poly: POLY_FIELDS, gameSettings: GAME_SETTINGS_FIELDS } as const;

/**
 * 按值推出字段（游戏自己的渲染器、没有声明的脚本属性：代码里没有字段描述，文件里的值就是全部信息）：资源引用
 * `{ $asset, kind }` 是资源，`{ $entity }` 是实体，数、布尔、文字照原样，两到四个数的数组是向量，对象逐个推，别的（null、
 * 混着的数组）按 JSON 改。
 */
export function inferFields(values: Readonly<Record<string, SceneScriptValue>>): Field[] {
  return Object.entries(values).map(([name, value]) => ({ name, type: inferType(value) }));
}

function inferType(value: SceneScriptValue): FieldType {
  if (typeof value === 'number') return number();
  if (typeof value === 'boolean') return bool;
  if (typeof value === 'string') return string;
  if (Array.isArray(value)) return value.length >= 2 && value.length <= 4 && value.every((item) => typeof item === 'number') ? vector(value.length as 2 | 3 | 4) : { kind: 'json' };
  if (value === null || typeof value !== 'object') return { kind: 'json' };
  if ('$asset' in value && typeof value.kind === 'string') {
    const kind = value.kind as string;
    return { kind: 'asset', asset: (kind === 'uiPage' || kind === 'uiLibrary' ? 'ui' : kind) as AssetKind, form: 'ref', refKind: kind };
  }
  if ('$entity' in value) return { kind: 'entity', form: 'ref' };
  return object(inferFields(value as Readonly<Record<string, SceneScriptValue>>));
}

/** 这份游戏设置在属性面板上的字段：根渲染器的属性按文件里的值推出来（见 inferFields），类型名不让改。 */
export function gameSettingsFields(file: GameSettingsFile): Field[] {
  if (!file.renderer) return GAME_SETTINGS_FIELDS;
  const renderer: Field = {
    name: 'renderer',
    description: `the root renderer ${file.renderer.type} (registered by the game); its properties`,
    type: object([{ name: 'props', type: object(inferFields(file.renderer.props)) }]),
  };
  return GAME_SETTINGS_FIELDS.map((field) => (field.name === 'renderer' ? renderer : field));
}

const INTEGER_KINDS: ReadonlySet<string> = new Set(['int', 'u8', 'u32']);

/** 脚本属性的声明（prop 的选项）换成字段的类型。脚本属性里对实体、资源的引用在文件里是 `{ $entity }`、`{ $asset, kind }`。 */
function propType(options: PropOptions): FieldType {
  const { kind } = options;
  if (kind === 'number' || kind === 'f32' || INTEGER_KINDS.has(kind)) {
    return {
      kind: 'number',
      ...(INTEGER_KINDS.has(kind) ? { integer: true } : {}),
      ...(options.min !== undefined ? { min: options.min } : {}), ...(options.max !== undefined ? { max: options.max } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}), ...(options.unit !== undefined ? { unit: options.unit } : {}),
    };
  }
  if (kind === 'bool') return bool;
  if (kind === 'string') return string;
  if (kind === 'enum') return { kind: 'enum', values: options.values ?? [] };
  if (kind === 'vec3') return vector(3, options.unit);
  if (kind === 'quat') return rotation;
  if (kind === 'color') return { kind: 'color', alpha: true, space: 'linear' };
  if (kind === 'entity' || kind === 'component') return { kind: 'entity', form: 'ref' };
  if (kind === 'asset') {
    const refKind = options.assetKind ?? '';
    return { kind: 'asset', asset: (refKind === 'uiPage' || refKind === 'uiLibrary' ? 'ui' : refKind) as AssetKind, form: 'ref', refKind };
  }
  if (kind === 'list' && options.item) return list(propType(options.item.options));
  if (kind === 'object' && options.shape) return object(shapeFields(options.shape));
  if (kind === 'union' && options.variants && options.discriminator) {
    return { kind: 'union', tag: options.discriminator, variants: Object.fromEntries(Object.entries(options.variants).map(([name, shape]) => [name, shapeFields(shape)])) };
  }
  return { kind: 'json' };
}

/** 嵌套的 shape（prop.object、prop.union）里的字段；字面量是"这个类型、这个默认值"的简写。 */
function shapeFields(shape: Readonly<Record<string, unknown>>): Field[] {
  return Object.entries(shape).map(([name, value]) => {
    const options = (value as { options?: PropOptions } | null)?.options;
    if (options) return propField(name, options);
    const type: FieldType = typeof value === 'number' ? number() : typeof value === 'boolean' ? bool : string;
    return { name, type, optional: true, default: value };
  });
}

function propField(name: string, options: PropOptions): Field {
  return {
    name,
    type: propType(options),
    ...(options.hasDefault ? { optional: true, default: options.defaultValue } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.group !== undefined ? { group: options.group } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
  };
}

/** 一个脚本类能在面板上改的属性（`props` 里的字段）：运行时状态（transient）、受管的（sealed）、藏起来的（hidden）不算。 */
export function scriptFields(script: ScriptConstructor): Field[] {
  return script.schema.fields
    .filter(({ options }) => !options.transient && !options.sealed && !options.hidden)
    .map(({ name, options }) => propField(name, options));
}

/**
 * 照着描述检查一个值，返回问题的列表（空的就是没问题）：缺了必填的字段、多了描述里没有的字段、种类不对、数超出范围、
 * 枚举里没有这个值。where 是报在前面的位置。不检查引用的资源、实体在不在（那要数据库和场景）。
 */
export function checkFields(value: unknown, type: FieldType, where: string): string[] {
  const issues: string[] = [];
  check(value, type, where, issues);
  return issues;
}

function check(value: unknown, type: FieldType, where: string, issues: string[]): void {
  const fail = (expected: string) => void issues.push(`${where}: expected ${expected}, got ${JSON.stringify(value) ?? 'undefined'}`);
  const numbers = (count: number) => Array.isArray(value) && value.length === count && value.every((item) => typeof item === 'number' && Number.isFinite(item));
  switch (type.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('a number');
      if (type.integer && !Number.isInteger(value)) fail('an integer');
      if ((type.min !== undefined && value < type.min) || (type.max !== undefined && value > type.max)) fail(`a number in ${type.min ?? '-inf'}..${type.max ?? 'inf'}`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') fail('true or false');
      return;
    case 'string':
      if (typeof value !== 'string') fail('a string');
      return;
    case 'enum':
      if (!type.values.includes(value as string)) fail(`one of ${type.values.join(', ')}`);
      return;
    case 'vector':
      if (!numbers(type.size)) fail(`${type.size} numbers`);
      return;
    case 'rotation':
      if (!numbers(4)) fail('a quaternion (4 numbers)');
      return;
    case 'color':
      if (!numbers(type.alpha ? 4 : 3)) fail(`a color (${type.alpha ? 4 : 3} numbers)`);
      return;
    case 'asset':
      if (type.form === 'path' ? typeof value !== 'string' : typeof (value as { $asset?: unknown } | null)?.$asset !== 'string') fail(`a ${type.asset} asset`);
      return;
    case 'entity':
      if (type.form === 'id' ? typeof value !== 'string' : typeof (value as { $entity?: unknown } | null)?.$entity !== 'string') fail('an entity');
      return;
    case 'list':
      if (!Array.isArray(value)) return fail('a list');
      value.forEach((item, index) => {
        if (!(item === null && type.nullableItems)) check(item, type.item, `${where}[${index}]`, issues);
      });
      return;
    case 'object':
      checkObject(value, type.fields, where, issues);
      return;
    case 'union': {
      const tag = (value as Record<string, unknown> | null)?.[type.tag];
      const variant = typeof tag === 'string' ? type.variants[tag] : undefined;
      if (!variant) return void issues.push(`${where}.${type.tag}: expected one of ${Object.keys(type.variants).join(', ')}, got ${JSON.stringify(tag) ?? 'undefined'}`);
      checkObject(value, [{ name: type.tag, type: string }, ...variant, ...(type.common ?? [])], where, issues);
      return;
    }
    case 'json':
      return;
  }
}

function checkObject(value: unknown, of: readonly Field[], where: string, issues: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return void issues.push(`${where}: expected an object, got ${JSON.stringify(value) ?? 'undefined'}`);
  const object = value as Record<string, unknown>;
  const known = new Set<string>();
  for (const field of of) {
    known.add(field.name);
    const item = object[field.name];
    if (item === undefined) {
      if (!field.optional) issues.push(`${where}.${field.name}: missing`);
    } else if (!(item === null && field.nullable)) check(item, field.type, `${where}.${field.name}`, issues);
  }
  for (const key of Object.keys(object)) if (!known.has(key)) issues.push(`${where}.${key}: not a field of this component`);
}

/** 检查一个实体文件：名字、变换和每种组件（脚本不查，要脚本的类）。 */
/** 场景文件里一个实体能有的键（SceneEntityFile）。 */
const ENTITY_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'parent', 'prefab', 'position', 'rotation', 'scale', 'components'] satisfies (keyof SceneEntityFile)[]);

export function checkEntity(entity: SceneEntityFile): string[] {
  const where = `entity ${entity.name}`;
  const issues: string[] = [];
  // 实体自己的字段以外的键：写错了地方的（比如脚本写在实体上，应该在 components.scripts 里）加载时会被悄悄忽略
  for (const key of Object.keys(entity)) {
    if (!ENTITY_KEYS.has(key)) issues.push(`${where}.${key}: not an entity field${key === 'scripts' ? ' (scripts go in components.scripts)' : ''}`);
  }
  checkObject({ name: entity.name, position: entity.position, rotation: entity.rotation, scale: entity.scale }, ENTITY_FIELDS, where, issues);
  for (const [key, value] of Object.entries(entity.components ?? {})) {
    if (key === 'scripts') continue;
    const description = (COMPONENT_FIELDS as Readonly<Record<string, ComponentDescription | undefined>>)[key];
    if (!description) issues.push(`${where}.components.${key}: not a component`);
    else check(value, description.type, `${where}.components.${key}`, issues);
  }
  return issues;
}
