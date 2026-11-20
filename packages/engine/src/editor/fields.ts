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
  ColliderShapeFile, SceneAnimation, SceneBackground, SceneBody, SceneCharacter, SceneCollidable, SceneConstraint, SceneDayNightCycle, SceneEntityFile, SceneLightShadow, SceneReflectionProbe, SceneSkyAtmosphere,
  SceneLocalLightShadow, SceneRenderTexture, SceneSprite, SceneUI, TextureRef, SceneCompositor, SceneNavigation, ScenePhysics, ScenePostEffects,
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
  encoding: optional(oneOf('ktx2', 'svg', 'png', 'jpeg'), 'ktx2'),
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
      materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'one per material slot of the model; null keeps the model\'s own material' },
      isShadowCaster: optional(bool, true),
      renderGroup,
    })),
    initial: { model: '', materials: [] },
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
export function checkEntity(entity: SceneEntityFile): string[] {
  const where = `entity ${entity.name}`;
  const issues: string[] = [];
  checkObject({ name: entity.name, position: entity.position, rotation: entity.rotation, scale: entity.scale }, ENTITY_FIELDS, where, issues);
  for (const [key, value] of Object.entries(entity.components)) {
    if (key === 'scripts') continue;
    const description = (COMPONENT_FIELDS as Readonly<Record<string, ComponentDescription | undefined>>)[key];
    if (!description) issues.push(`${where}.components.${key}: not a component`);
    else check(value, description.type, `${where}.components.${key}`, issues);
  }
  return issues;
}
