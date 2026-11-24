/** 实体的组件、场景的设置、实体自己的字段描述（COMPONENT_FIELDS、SCENE_FIELDS、ENTITY_FIELDS）。 */
import type { ColliderShapeFile, SceneAnimation, SceneBackground, SceneBody, SceneCharacter, SceneCollidable, SceneConstraint, SceneDayNightCycle, SceneEntityFile, ScenePrecipitation, SceneWeather, SceneStreamingSource, ScenePersistent, SceneDecal, SceneWindZone, SceneLightShadow, SceneReflectionProbe, ScenePlanarReflection, SceneIrradianceVolume, SceneSkyAtmosphere, SceneVolumetricClouds, SceneVolumetricFog, SceneLocalLightShadow, SceneColorGrading, SceneExposure, SceneRenderTexture, SceneSprite, SceneUI, SceneCompositor, SceneNavigation, ScenePhysics, ScenePostEffects, SceneTextureCamera } from '../../content/formats/format';
import type { SceneSettingKey } from '../SceneDocument';
import { fields, number, integer, bool, string, oneOf, vector, rotation, asset, entity, list, object, optional, nullable, type FieldType, type Field, type FieldSpec } from '../../content/schema/builders.ts';
import { textureRef } from './assets/shared.ts';

/** 渲染组（Stride 的 RenderGroup）。 */
const renderGroup = optional(integer(0, 31), 0);
const sampler = oneOf('linearClamp', 'pointClamp', 'anisotropicClamp');

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
  absoluteSize: { type: bool, optional: true, default: false, description: 'shape sizes are world units and ignore the entity scale (Stride rule, imported content); off: shapes scale with the entity' },
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
      visibleInRayTracing: { type: bool, optional: true, default: true, description: 'part of the ray-traced scene (indirect light, ray-traced reflections, path tracing); turn off for small clutter like debris on the ground' },
      visibleInCamera: { type: bool, optional: true, default: true, description: 'drawn in camera views; turn off to only cast shadows and be part of ray tracing and sky occlusion (the proxy mesh of a scan, whose picture is the splats)' },
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
        point: [
          lightColor, intensity, { name: 'radius', type: number({ min: 0, unit: 'm' }) }, { name: 'shadow', type: object(localShadow), optional: true },
          { name: 'profile', type: asset('lightProfile'), optional: true, description: 'IES light profile: how strongly the fixture shines in each direction; 0° points along local -Z' },
        ],
        spot: [
          lightColor, intensity, { name: 'range', type: number({ min: 0, unit: 'm' }) },
          { name: 'angleInner', type: number({ min: 0, max: 180, unit: 'deg' }) }, { name: 'angleOuter', type: number({ min: 0, max: 180, unit: 'deg' }) },
          { name: 'shadow', type: object(localShadow), optional: true },
          { name: 'profile', type: asset('lightProfile'), optional: true, description: 'IES light profile: how strongly the fixture shines in each direction; 0° points along local -Z' },
        ],
        rect: [
          lightColor, { name: 'intensity', type: number({ min: 0, step: 0.1 }), description: 'like a point light: as bright straight in front at the same distance; a bigger panel is softer, not brighter' },
          { name: 'width', type: number({ min: 0, unit: 'm' }), description: 'size along the local X axis' },
          { name: 'height', type: number({ min: 0, unit: 'm' }), description: 'size along the local Y axis; the light shines toward local -Z' },
          { name: 'range', type: number({ min: 0, unit: 'm' }) },
        ],
        disc: [
          lightColor, { name: 'intensity', type: number({ min: 0, step: 0.1 }), description: 'like a point light: as bright straight in front at the same distance; a bigger panel is softer, not brighter' },
          { name: 'diameter', type: number({ min: 0, unit: 'm' }), description: 'the disc lies in the local XY plane and shines toward local -Z' },
          { name: 'range', type: number({ min: 0, unit: 'm' }) },
        ],
        tube: [
          lightColor, { name: 'intensity', type: number({ min: 0, step: 0.1 }), description: 'like a point light: as bright straight in front at the same distance; a bigger panel is softer, not brighter' },
          { name: 'length', type: number({ min: 0, unit: 'm' }), description: 'along the local X axis; the tube shines all around' },
          { name: 'range', type: number({ min: 0, unit: 'm' }) },
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
  planarReflection: {
    label: 'Planar reflection',
    type: object(fields<ScenePlanarReflection>({
      size: { type: vector(3, 'm'), description: 'box (around the entity, turning with it) whose surfaces facing the plane normal (local +Y) reflect' },
      resolution: { type: number({ min: 0.1, max: 1, step: 0.05 }), optional: true, default: 0.5, description: 'resolution of the mirrored image relative to the main view' },
      distortion: { type: number({ min: 0, step: 0.01 }), optional: true, default: 0.02, description: 'how much normals that tilt away from the plane bend the reflection' },
      intensity: optional(number({ min: 0 }), 1),
    })),
    initial: { size: [10, 1, 10] },
  },
  irradianceVolume: {
    label: 'Irradiance volume',
    type: object(fields<SceneIrradianceVolume>({
      size: { type: vector(3, 'm'), description: 'box (around the entity, along the world axes) filled with ray traced probes; surfaces inside get their diffuse ambient light from them' },
      spacing: { type: number({ min: 0.1, step: 0.1, unit: 'm' }), optional: true, default: 1, description: 'distance between probes' },
      rays: { type: integer(16, 256), optional: true, default: 128, description: 'rays per probe per update' },
      hysteresis: { type: number({ min: 0, max: 0.999, step: 0.01 }), optional: true, default: 0.97, description: 'share of the old value kept per update (higher is steadier, slower to follow changes)' },
      intensity: optional(number({ min: 0 }), 1),
      budget: { type: number({ min: 0.1, step: 0.1, unit: 'ms' }), optional: true, default: 1.5, description: 'GPU time per frame for the probes; rays per frame follow the measured time' },
      followCamera: { type: bool, optional: true, default: false, description: 'the box follows the main camera (large worlds) instead of staying at the entity' },
    })),
    initial: { size: [20, 8, 20] },
  },
  gaussianSplat: {
    label: 'Gaussian splats',
    type: object(fields<NonNullable<Components['gaussianSplat']>>({
      splats: { type: asset('splats'), description: 'splat asset (.splat, imported from a 3D Gaussian Splatting .ply, .spz or .sog)' },
    })),
    initial: { splats: '' },
  },
  terrain: {
    label: 'Terrain',
    type: object(fields<NonNullable<Components['terrain']>>({
      terrain: { type: asset('terrain'), description: 'vector terrain asset (.terrain.json): noise base, flatten features and sculpt strokes, evaluated at run time' },
      size: { type: number({ min: 1, step: 64, unit: 'm' }), optional: true, default: 4096, description: 'edge length of the square the terrain covers, centered on the entity' },
      detail: { type: number({ min: 1, step: 1, unit: 'm' }), optional: true, default: 32, description: 'edge of the finest tile (32 × 32 cells): 32 is one vertex per meter near the camera' },
      lodFactor: { type: number({ min: 0.5, step: 0.25 }), optional: true, default: 2, description: 'tiles closer than this many tile edges split into finer ones: larger is finer and more triangles' },
      isShadowCaster: { type: bool, optional: true, default: true },
      renderGroup: { type: integer(0, 31), optional: true, default: 0 },
    })),
    initial: { terrain: '' },
  },
  scatter: {
    label: 'Scatter',
    type: object(fields<NonNullable<Components['scatter']>>({
      scatter: { type: asset('scatter'), description: 'placement rules (.scatter.json): models scattered on the terrain of this entity by density, slope, height and clumps, around the camera' },
    })),
    initial: { scatter: '' },
  },
  city: {
    label: 'City',
    type: object(fields<NonNullable<Components['city']>>({
      city: { type: asset('city'), description: 'city rules (.city.json): buildings placed along its roads, as children of this entity' },
    })),
    initial: { city: '' },
  },
  water: {
    label: 'Water',
    type: object(fields<NonNullable<Components['water']>>({
      water: { type: asset('water'), description: 'water body (.water.json): a lake inside its shoreline or the open sea; the entity position is the water surface' },
    })),
    initial: { water: '' },
  },
  buoyancy: {
    label: 'Buoyancy',
    type: object(fields<NonNullable<Components['buoyancy']>>({
      buoyancy: { type: number({ min: 0, step: 0.05 }), optional: true, default: 1.2, description: 'buoyancy factor: 1 is as heavy as water (hovers), above 1 floats' },
      linearDrag: { type: number({ min: 0, step: 0.05 }), optional: true, default: 0.5, description: 'water drag on the motion' },
      angularDrag: { type: number({ min: 0, step: 0.01 }), optional: true, default: 0.05, description: 'water drag on the rotation' },
    })),
    initial: {},
  },
  materialParams: {
    label: 'Material params',
    type: object(fields<NonNullable<Components['materialParams']>>({
      tint: { type: { kind: 'color', alpha: true, space: 'srgb' }, optional: true, default: [1, 1, 1, 1], description: 'multiplies the diffuse color of this object (white keeps it)' },
      seed: { type: integer(0), optional: true, default: 0, description: 'seed of the material variation (0: by transform slot, differs per object)' },
      wet: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'wet regardless of the weather (darker, glossier)' },
      dirt: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'grime in crevices, occluded spots and on downward faces' },
      wear: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'worn edges: paint rubbed off, lighter and rougher' },
      snow: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'snow on upward faces regardless of the weather' },
    })),
    initial: {},
  },
  simulationLod: {
    label: 'Simulation LOD',
    type: object(fields<NonNullable<Components['simulationLod']>>({
      distanceScale: { type: number({ min: 0.01, step: 0.25 }), optional: true, default: 1, description: 'multiplies the LOD distances: above 1 keeps full simulation farther away (important characters)' },
    })),
    initial: {},
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
  persistent: {
    label: 'Persistent',
    type: object(fields<ScenePersistent>({
      transform: { type: bool, optional: true, default: true, description: 'keep where it was moved (off when something else places it)' },
    })),
    initial: {},
  },
  streamingSource: {
    label: 'Streaming Source',
    type: object(fields<SceneStreamingSource>({
      radiusScale: { type: number({ min: 0 }), optional: true, default: 1, description: "world cells load within each layer's radius times this (the main camera always streams with 1)" },
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
    type: object(fields<SceneBody>({
      ...collidable, kinematic: bool, gravity: bool, sleepThreshold: number(), interpolated: bool,
      continuous: { type: bool, optional: true, default: false, description: 'continuous collision detection: sweeps the motion of each step so fast small bodies (bullets, debris) do not pass through thin walls; costs more' },
    })),
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
      // 每种约束的设置不一样（原生的 ConstraintDesc 有三十来种），文件里写全了：按值推字段
      settings: { kind: 'record' },
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
  antialiasingMode: { type: oneOf('fxaa', 'temporal'), optional: true, default: 'fxaa', description: 'fxaa (Stride) or temporal: TAA with sharpening, smoother edges and less shimmer in motion' },
  ambientOcclusion: optional(object([{ name: 'radius', type: number({ min: 0, unit: 'm' }) }])),
  localReflections: optional(object([{ name: 'maxRoughness', type: number({ min: 0, max: 1 }) }, { name: 'edgeFade', type: number({ min: 0, max: 1 }) }])),
  exposure: optional(object(fields<SceneExposure>({
    metering: { type: oneOf('average', 'histogram'), optional: true, default: 'average', description: 'average: whole-frame log average (Stride); histogram: drops the darkest and brightest pixels before averaging' },
    keyValue: { type: number({ min: 0.01, max: 1, step: 0.01 }), optional: true, description: 'how bright the average comes out (middle gray); unset follows the brightness automatically (Stride)' },
    minLog: { type: number({ min: -20, max: 0, step: 0.5 }), optional: true, default: -10, description: 'histogram range: darkest log2 luminance' },
    maxLog: { type: number({ min: 0, max: 30, step: 0.5 }), optional: true, default: 14, description: 'histogram range: brightest log2 luminance' },
    low: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, default: 0.1, description: 'share of the darkest pixels left out' },
    high: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, default: 0.9, description: 'pixels above this share (the brightest) are left out' },
    speedBrighten: { type: number({ min: 0, step: 0.1, unit: 'EV/s' }), optional: true, default: 3, description: 'adaptation speed when the scene gets brighter' },
    speedDarken: { type: number({ min: 0, step: 0.1, unit: 'EV/s' }), optional: true, default: 1, description: 'adaptation speed when the scene gets darker' },
    localHighlights: { type: number({ min: 0, max: 2, step: 0.05 }), optional: true, default: 1, description: 'local exposure: contrast of areas brighter than average (below 1 compresses them)' },
    localShadows: { type: number({ min: 0, max: 2, step: 0.05 }), optional: true, default: 1, description: 'local exposure: contrast of areas darker than average (below 1 lifts them)' },
    localDetail: { type: number({ min: 0, max: 4, step: 0.05 }), optional: true, default: 1, description: 'local exposure: strength of fine detail' },
    localBlur: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.6, description: 'local exposure: share of the wide blur in the local average (the rest follows edges)' },
  }))),
  colorGrading: optional(object(fields<SceneColorGrading>({
    operator: { type: oneOf('hejl2', 'agx', 'aces'), optional: true, default: 'hejl2', description: 'tone mapping curve: hejl2 (Stride), agx (Blender, natural highlight roll-off), aces' },
    temperature: { type: number({ min: 1667, max: 25000, step: 50, unit: 'K' }), optional: true, default: 6500, description: 'camera white balance: lower makes the image cooler' },
    tint: { type: number({ min: -1, max: 1, step: 0.01 }), optional: true, default: 0, description: 'green (negative) to magenta (positive)' },
    contrast: optional(number({ min: 0, step: 0.01 }), 1),
    saturation: optional(number({ min: 0, step: 0.01 }), 1),
    vignette: optional(number({ min: 0, max: 1, step: 0.01 }), 0),
    grain: optional(number({ min: 0, max: 1, step: 0.01 }), 0),
    chromaticAberration: { type: number({ min: 0, max: 0.05, step: 0.001 }), optional: true, default: 0, description: 'red and blue drift apart towards the edges' },
    distortion: { type: number({ min: -1, max: 1, step: 0.01 }), optional: true, default: 0, description: 'lens distortion: positive is barrel (wide angle), negative is pincushion' },
    lut: { type: asset('lut'), optional: true, description: 'color lookup table (.cube) applied after tone mapping' },
    lutStrength: { type: number({ min: 0, max: 1, step: 0.01 }), optional: true, default: 1, description: 'how much of the lookup table is mixed in' },
  }))),
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
  children: { label: 'Child scenes', type: list(asset('scene')), initial: [] },
  compositor: {
    label: 'Compositor',
    type: object(fields<SceneCompositor>({
      clearColor: { kind: 'color', alpha: true, space: 'linear' },
      postEffects: nullable(object(postEffects)),
      renderMask: optional(integer(0)),
      transparent: bool,
      subsurfaceScattering: optional(bool, false),
      // 渲染目标贴图的相机：各带一套前向渲染器的设置
      textureCameras: optional(list(object(fields<SceneTextureCamera>({
        cameraSlot: integer(0),
        texture: object(renderTexture),
        clearColor: { kind: 'color', alpha: true, space: 'linear' },
        postEffects: nullable(object(postEffects)),
        renderMask: optional(integer(0)),
        transparent: bool,
        subsurfaceScattering: optional(bool, false),
      })))),
      shadows: optional(bool, true),
      particlesOverUI: optional(bool, false),
      rayTracedShadows: optional(bool, false),
      emissiveLighting: optional(bool, false),
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

