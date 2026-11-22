/** 编辑器里能编辑的资源文件的字段描述（ASSET_FIELDS：材质、JSON 模型、时间轴、白盒、SDF、多边形、导入设置、精灵表、声音、游戏设置）。 */
import type { BuildingFile, CityFile, WaterFile, TextureRef, MaterialFile, ProceduralModelFile, TextureSlot, TimelineFile, TerrainFile, BrushFile, SdfFile, PolyMeshFile, ModelImportFile, ImageImportFile, GameSettingsFile, SpriteSheetFile, SoundFile, SplineFile, TextModelFile, ScatterFile, TreeFile } from '../../content/format';
import { DEFAULT_SOUND_SYNTH, SYNTH_RANGES, type SoundSynth } from '../../audio/soundSynth.ts';
import { nullable, fields, number, integer, bool, string, oneOf, vector, rotation, asset, entity, list, object, optional, textureRef, type FieldType, type Field, type FieldSpec } from './builders.ts';

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
  wind: {
    type: object(fields<NonNullable<MaterialFile['wind']>>({
      bend: { type: number({ min: 0, step: 0.05, unit: 'm' }), description: 'how far a point 10 m up sways in a 10 m/s wind (grows with the height squared)' },
      flutter: { type: number({ min: 0, step: 0.01, unit: 'm' }), optional: true, default: 0, description: 'how far leaves away from the trunk shake along their normal in a 10 m/s wind' },
      mode: { type: oneOf('tree', 'grass'), optional: true, default: 'tree', description: 'tree bends by the height above the entity; grass (merged blades) by the blade height (uv v: 1 root, 0 tip), bend is the tip sway' },
    })),
    optional: true,
    group: 'advanced',
    description: 'vegetation wind: the mesh sways and its leaves flutter in the global wind (WindZone, weather)',
  },
  interior: {
    type: object(fields<NonNullable<MaterialFile['interior']>>({
      room: { type: vector(3, 'm'), description: 'room width, height (usually the floor height) and depth behind the glass' },
      lit: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.35, description: 'fraction of rooms with the lights on' },
      brightness: { type: number({ min: 0, step: 0.25 }), optional: true, default: 0.5, description: 'light of a lit room (linear, like emissive)' },
    })),
    optional: true,
    group: 'advanced',
    description: 'interior mapping: rooms behind vertical glass (walls, floor, ceiling, furniture, lights on or off), no extra geometry',
  },
  anisotropy: { type: object(fields<NonNullable<MaterialFile['anisotropy']>>({ strength: number({ min: -1, max: 1, step: 0.01 }), rotation: { type: number({ unit: 'rad' }), optional: true, default: 0 } })), optional: true, group: 'advanced' },
  transmission: {
    type: object(fields<NonNullable<MaterialFile['transmission']>>({
      factor: number({ min: 0, max: 1, step: 0.01 }),
      ior: { type: number({ min: 1, max: 3, step: 0.01 }), optional: true, default: 1.5 },
      thickness: { type: number({ min: 0, step: 0.01, unit: 'm' }), optional: true, default: 0, description: '0 is a thin surface (a window pane); above 0 the object is solid and bends what is behind it more' },
      attenuationColor: { type: colorLinear3, optional: true },
      attenuationDistance: { type: number({ min: 0, step: 0.01, unit: 'm' }), optional: true, description: 'light keeps the attenuation color after traveling this far inside' },
    })),
    optional: true, group: 'advanced', description: 'light passes through (glass, water, ice): what is behind shows through, bent by the index of refraction',
  },
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

/** 矢量地形（TerrainFile）：改了马上存，视口里的地形热重载（整个重新求值）。 */
export const TERRAIN_FIELDS = fields<TerrainFile>({
  name: string,
  noise: {
    type: object(fields<NonNullable<TerrainFile['noise']>>({
      seed: { type: integer(0, 0xffffffff), optional: true, default: 0, description: 'random seed: another number is another landscape' },
      octaves: { type: integer(0, 16), optional: true, default: 6, description: 'noise layers: more is finer detail and slower' },
      scale: { type: number({ min: 1, step: 50, unit: 'm' }), optional: true, default: 1000, description: 'wavelength of the largest hills' },
      height: { type: number({ min: 0, step: 10, unit: 'm' }), optional: true, default: 200, description: 'how high the hills go (amplitude)' },
      offset: { type: number({ step: 1, unit: 'm' }), optional: true, default: 0, description: 'raises the whole terrain' },
      lacunarity: { type: number({ min: 1, max: 4, step: 0.05 }), optional: true, default: 2, description: 'frequency multiplier from one layer to the next' },
      gain: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.5, description: 'amplitude multiplier from one layer to the next' },
      ridged: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'how much of sharp ridges to mix in' },
      warp: { type: number({ min: 0, step: 10, unit: 'm' }), optional: true, default: 0, description: 'domain warp: bends the noise so hills look less regular' },
      erosion: { type: number({ min: 0, max: 4, step: 0.05 }), optional: true, default: 0, description: 'damps detail on steep slopes (smooth slopes, detailed valleys), like erosion' },
      gullies: {
        type: object(fields<NonNullable<NonNullable<TerrainFile['noise']>['gullies']>>({
          strength: { type: number({ min: 0, step: 1, unit: 'm' }), optional: true, default: 20, description: 'how deep the gullies are' },
          scale: { type: number({ min: 1, step: 10, unit: 'm' }), optional: true, default: 400, description: 'spacing of the coarsest gullies; each layer halves it' },
          octaves: { type: integer(0, 8), optional: true, default: 4, description: 'gully layers: finer gullies branch off the coarser ones' },
          detail: { type: number({ min: 0.05, max: 8, step: 0.1 }), optional: true, default: 1.5, description: 'lower keeps fine gullies to steep slopes only' },
          valley: { type: number({ step: 10, unit: 'm' }), optional: true, default: 0, description: 'height of the valley floors: below it gentle slopes fade into valleys' },
          peak: { type: number({ step: 10, unit: 'm' }), optional: true, default: 300, description: 'height of the peaks: above it gentle slopes fade into sharp tops' },
        })),
        optional: true,
        description: 'erosion gullies carved into the noise (branching, evaluated per point without simulation); unset has none',
      },
    })),
  },
  splines: {
    type: list(object(fields<NonNullable<TerrainFile['splines']>[number]>({
      spline: { type: asset('spline'), description: 'the spline the ground follows (its coordinates are the terrain\'s local ones)' },
      position: { type: vector(3, 'm'), optional: true, default: [0, 0, 0], description: 'moves the spline by this much first' },
      width: { type: number({ min: 0.1, step: 0.5, unit: 'm' }), optional: true, description: 'width flattened along the path; unset follows the cross-section (a road is its surface plus shoulders)' },
      offset: { type: number({ step: 0.05, unit: 'm' }), optional: true, default: -0.1, description: 'ground height relative to the path (slightly below a road surface)' },
      falloff: { type: number({ min: 0, step: 1, unit: 'm' }), optional: true, default: 10, description: 'blends back to the ground over this many meters beyond the width' },
      strength: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 1, description: '0..1: how fully the ground follows' },
      mode: { type: oneOf('conform', 'carve', 'fill'), optional: true, default: 'conform', description: 'conform cuts and fills, carve only cuts (cuttings, river beds), fill only raises (embankments)' },
    }))),
    optional: true,
    description: 'roads, rail beds and rivers the ground follows: flattened along each spline after the features, before the strokes',
  },
  material: { ...nullable(asset('material')), optional: true, description: 'material of the ground; unset uses the default material' },
  uvScale: { type: number({ min: 0.01, step: 0.5, unit: 'm' }), optional: true, default: 4, description: 'automatic UVs: one texture repeat per this many meters' },
  features: { type: { kind: 'json' }, optional: true, description: "vector features: { type: 'flatten', points: [[x, z], …], height, falloff, strength } flattens a polygon (roads, plazas, foundations)" },
  strokes: { type: { kind: 'json' }, optional: true, description: "sculpt strokes in order: { op: 'raise' | 'lower' | 'flatten' | 'smooth', x, z, radius, strength, height }" },
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

/** 样条（SplineFile）：改了马上重新烘成模型、视口热重载。控制点按 JSON 改，或者在视口里拖（模型组件上的"编辑样条"）。 */
export const SPLINE_FIELDS = fields<SplineFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots: road, tube, custom one; rail rails and sleepers; fence posts and rails; wire poles and wires' },
  closed: { type: bool, optional: true, default: false, description: 'join the last point back to the first (a loop road, a fence around something)' },
  resolution: { type: number({ min: 0.1, step: 0.5, unit: 'm' }), optional: true, default: 2, description: 'one cross-section every this many meters along the path: smaller is rounder and heavier' },
  profile: {
    type: {
      kind: 'union',
      tag: 'type',
      variants: {
        road: fields<{ width: unknown; thickness: unknown; shoulder: unknown; cornerRadius: unknown; lanes: unknown; oneWay: unknown }>({
          width: { type: positiveNumber(), description: 'width of the road surface (m)' },
          thickness: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0.3, description: 'depth of the road body under the surface' },
          shoulder: { type: number({ min: 0, step: 0.1, unit: 'm' }), optional: true, default: 0.5, description: 'how far the sloped sides reach out beyond the surface' },
          cornerRadius: { type: number({ min: 0, step: 0.5, unit: 'm' }), optional: true, description: 'radius of the rounded corners at junctions; unset is half the road width' },
          lanes: { type: integer(1, 8), optional: true, description: 'lanes in each direction (all of them along the path when one-way); unset is one per 3.5 m of width' },
          oneWay: { type: bool, optional: true, default: false, description: 'all lanes run along the path direction (from the first control point on)' },
        }),
        tube: fields<{ radius: unknown; sides: unknown }>({
          radius: { type: positiveNumber(), description: 'radius (m)' },
          sides: { type: integer(3, 64), optional: true, default: 12, description: 'sides around the tube' },
        }),
        custom: fields<{ shape: unknown; closed: unknown }>({
          shape: { type: { kind: 'json' }, description: 'cross-section as [right, up] pairs in meters, counterclockwise' },
          closed: { type: bool, optional: true, default: false, description: 'join the last shape point back to the first' },
        }),
        rail: fields<{ gauge: unknown; sleeperSpacing: unknown }>({
          gauge: { type: number({ min: 0.3, step: 0.01, unit: 'm' }), optional: true, default: 1.435, description: 'distance between the inner sides of the rails (standard gauge 1.435 m)' },
          sleeperSpacing: { type: number({ min: 0.1, step: 0.05, unit: 'm' }), optional: true, default: 0.6, description: 'distance between sleepers' },
        }),
        fence: fields<{ height: unknown; postSpacing: unknown; rails: unknown }>({
          height: { type: number({ min: 0.1, step: 0.1, unit: 'm' }), optional: true, default: 1.2, description: 'height of the posts' },
          postSpacing: { type: number({ min: 0.1, step: 0.5, unit: 'm' }), optional: true, default: 2.5, description: 'distance between posts' },
          rails: { type: integer(1, 10), optional: true, default: 2, description: 'horizontal rails between the posts' },
        }),
        wire: fields<{ poleHeight: unknown; poleSpacing: unknown; sag: unknown; wires: unknown }>({
          poleHeight: { type: number({ min: 1, step: 1, unit: 'm' }), optional: true, default: 10, description: 'height of the poles' },
          poleSpacing: { type: number({ min: 1, step: 5, unit: 'm' }), optional: true, default: 40, description: 'distance between poles' },
          sag: { type: number({ min: 0, step: 0.25, unit: 'm' }), optional: true, default: 1.5, description: 'how far the wires hang down midway between two poles' },
          wires: { type: integer(1, 12), optional: true, default: 3, description: 'wires on the crossarm' },
        }),
      },
    },
    description: 'what is built along the path',
  },
  points: { type: { kind: 'json' }, description: 'control points the path passes through: position [x, y, z], optional tilt (degrees, banks to the right) and width (multiplies the profile width)' },
  branches: { type: { kind: 'json' }, optional: true, description: 'more paths of a network ({ points, closed }); points at the same position are welded, and roads get a junction where three or more meet' },
});

/** 参数化的树（TreeFile）：改了马上重新长成模型、视口热重载。 */
export const TREE_FIELDS = fields<TreeFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots: bark, leaves (leaves use a leaf-cluster texture with alpha cutoff, double-sided)' },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed: another number grows another tree of the same kind' },
  shape: { type: oneOf('deciduous', 'conifer'), optional: true, default: 'deciduous', description: 'conifer: the trunk runs to the top and side branches get shorter upward' },
  levels: {
    type: list(object(fields<TreeFile['levels'][number]>({
      length: { type: number({ min: 0.01, step: 0.5, unit: 'm' }), description: 'length of the branches of this level' },
      radius: { type: number({ min: 0.001, step: 0.05 }), description: 'trunk: radius in meters; branches: times the radius of the parent where they grow' },
      children: { type: integer(0, 64), optional: true, description: 'branches of the next level growing on each branch of this level' },
      angle: { type: number({ min: 0, max: 180, step: 5, unit: '°' }), optional: true, default: 45, description: 'angle to the parent branch' },
      start: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.3, description: 'where along the parent they start growing (0..1)' },
      gnarliness: { type: number({ min: 0, step: 0.02 }), optional: true, default: 0.1, description: 'random bending at each section; thinner branches bend more' },
      taper: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.7, description: 'how much thinner the tip is than the base (0..1)' },
      twist: { type: number({ step: 0.05 }), optional: true, default: 0, description: 'twist per section around the branch axis (radians)' },
      sections: { type: integer(1, 64), optional: true, default: 8, description: 'sections along the length' },
      segments: { type: integer(3, 32), optional: true, default: 6, description: 'segments around the branch' },
    }))),
    description: 'branch levels: the first is the trunk, each grows the next one (at most 4)',
  },
  leaves: {
    type: object(fields<NonNullable<TreeFile['leaves']>>({
      count: { type: integer(0, 200), description: 'leaf cards on each branch of the last level' },
      size: { type: number({ min: 0.01, step: 0.1, unit: 'm' }), description: 'size of a leaf card' },
      sizeVariance: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.3, description: 'random variation of the size (0..1)' },
      angle: { type: number({ min: 0, max: 180, step: 5, unit: '°' }), optional: true, default: 40, description: 'angle to the branch' },
      start: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'where along the branch the leaves start (0..1)' },
    })),
    optional: true,
    description: 'leaf cards (two crossed quads each) on the branches of the last level',
  },
  growth: {
    type: object(fields<NonNullable<TreeFile['growth']>>({
      direction: { type: vector(3), description: 'direction the branches turn toward (up toward the light, down for drooping)' },
      strength: { type: number({ step: 0.001 }), description: 'turn per section, divided by the branch radius (thin branches turn more)' },
    })),
    optional: true,
    description: 'a pull on the branches toward a direction',
  },
});

/** 程序化建筑（BuildingFile）：改了马上重新生成模型、视口热重载。体块的底面、屋顶和立面规则、构件按 JSON 改（形状多变）。 */
export const BUILDING_FIELDS = fields<BuildingFile>({
  name: string,
  materials: { type: { kind: 'list', item: asset('material'), nullableItems: true }, description: 'material slots: wall, glass, frame, roof (modules and roofs can use more slots)' },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed for the A|B choices in the patterns: another number is another building of the same kind' },
  masses: {
    type: list(object(fields<BuildingFile['masses'][number]>({
      footprint: { type: { kind: 'json' }, optional: true, description: 'outline: points [[x, z], …], { rect: [width, depth], center } or { circle: radius, segments, center }; unset is the mass below moved in by inset' },
      inset: { type: number({ min: 0, step: 0.5, unit: 'm' }), optional: true, default: 0, description: 'moves every edge of the outline inward (setbacks)' },
      base: { type: number({ min: 0, step: 1, unit: 'm' }), optional: true, description: 'height of the bottom of this mass; unset stacks it on the one below (side-by-side towers, sky bridges)' },
      floors: { type: integer(1, 300), description: 'floors in this mass' },
      floorHeight: { type: number({ min: 0.5, step: 0.1, unit: 'm' }), description: 'height of one floor' },
      facade: { type: string, optional: true, description: 'name of the facade rule; unset is plain wall' },
      roof: { type: { kind: 'json' }, optional: true, description: "{ kind: 'flat', parapet }, { kind: 'dome', height, rings } or { kind: 'pyramid', height }; material is a slot (default 3); default flat" },
    }))),
    description: 'masses stacked bottom up; every edge of the outline is a facade',
  },
  facades: { type: { kind: 'json' }, optional: true, description: "facade rules by name: { floors: [{ where: 'ground' | 'top' (unset: any floor), pattern: 'Pillar [Window Window]* Pillar', ledge: { height, depth } }] }; the first matching rule is used, * repeats to fill the edge, A|B picks one per column by the seed" },
  modules: { type: { kind: 'json' }, optional: true, description: "facade modules by name, one floor high: { kind: 'wall' | 'window' (sill, head, margin, depth, frame, mullions, balcony) | 'pillar' (depth) | 'curtain' (frame) | 'panel' (margin, sill, head, depth, material: signs, light strips), width, slots: { wall, glass, frame } (other material slots) }" },
});

/** 城市（CityFile）：改了马上存，挂着它的实体整个城重摆。 */
export const CITY_FIELDS = fields<CityFile>({
  name: string,
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed: another number picks other buildings along the same roads' },
  roads: { type: list(asset('spline')), description: 'roads the buildings line (both sides of every path of each spline)' },
  buildings: {
    type: list(object(fields<CityFile['buildings'][number]>({
      model: { type: asset('model'), description: 'the building (usually the model generated from a .building.json); its +Z side faces the road' },
      weight: { type: number({ min: 0.01, step: 0.5 }), optional: true, default: 1, description: 'how often it is picked compared to the others' },
    }))),
    description: 'buildings picked at random by weight along the roads',
  },
  setback: { type: number({ min: 0, step: 0.5, unit: 'm' }), optional: true, default: 3, description: 'distance from the road edge to the building front (sidewalk)' },
  gap: { type: number({ min: 0, step: 0.5, unit: 'm' }), optional: true, default: 2, description: 'space between neighboring buildings' },
  area: { type: { kind: 'json' }, optional: true, description: 'only build inside this polygon [[x, z], …]; unset builds along the whole network' },
  fill: {
    type: object(fields<NonNullable<CityFile['fill']>>({
      spacing: { type: number({ min: 1, step: 1, unit: 'm' }), optional: true, default: 12, description: 'grid step of the points tried inside the blocks (jittered)' },
      maxDistance: { type: number({ min: 1, step: 10, unit: 'm' }), optional: true, default: 100, description: 'only this far from the nearest road' },
    })),
    optional: true,
    description: 'after the street front, fill the blocks: points nearest the roads first, each building facing the nearest road',
  },
});

/** 水体（WaterFile）：改了马上看到。 */
export const WATER_FIELDS = fields<WaterFile>({
  name: string,
  outline: { type: { kind: 'json' }, optional: true, description: 'lake shoreline [[x, z], …] in the entity space (at most 64 points); unset is the open sea. It need not follow the ground: the terrain hides what is below it' },
  extent: { type: number({ min: 10, step: 100, unit: 'm' }), optional: true, default: 6000, description: 'how far from the camera the sea reaches' },
  color: { type: vector(3), optional: true, default: [0.015, 0.06, 0.07], description: 'color of deep water (linear)' },
  clarity: { type: number({ min: 0.05, step: 0.5, unit: 'm' }), optional: true, default: 4, description: 'how far light travels in the water before 1/e of it is left (clear lakes 10+, muddy rivers below 1)' },
  waves: {
    type: object(fields<NonNullable<WaterFile['waves']>>({
      height: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0.3, description: 'height of the largest waves' },
      length: { type: number({ min: 0.1, step: 1, unit: 'm' }), optional: true, default: 12, description: 'wavelength of the longest waves' },
      direction: { type: number({ step: 5, unit: '°' }), optional: true, default: 0, description: 'where the waves travel (0 is local +X, counterclockwise)' },
      speed: { type: number({ min: 0, step: 0.1 }), optional: true, default: 1, description: 'time scale of the waves' },
      choppiness: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.5, description: 'how much the crests bunch up (0 round, 1 sharp)' },
    })),
    optional: true,
    description: 'Gerstner waves, flattened far from the camera',
  },
  foam: {
    type: object(fields<NonNullable<WaterFile['foam']>>({
      shore: { type: number({ min: 0, step: 0.1, unit: 'm' }), optional: true, default: 1, description: 'foam where the water is shallower than this' },
    })),
    optional: true,
    description: 'foam along the shore',
  },
});

/** 程序化摆放（ScatterFile）：改了马上存，挂着它的地形重撒。 */
export const SCATTER_FIELDS = fields<ScatterFile>({
  name: string,
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed: another number is another arrangement with the same rules' },
  cellSize: { type: number({ min: 4, step: 8, unit: 'm' }), optional: true, default: 64, description: 'edge of the streamed cells: cells near the camera are scattered, far ones dropped' },
  layers: {
    type: list(object(fields<ScatterFile['layers'][number]>({
      name: string,
      model: { type: asset('model'), optional: true, description: 'the model scattered (not for grass)' },
      grass: {
        type: object(fields<NonNullable<ScatterFile['layers'][number]['grass']>>({
          height: { type: number({ min: 0.01, step: 0.05, unit: 'm' }), description: 'blade height (times the scale)' },
          width: { type: number({ min: 0.001, step: 0.01, unit: 'm' }), description: 'blade width at the root (times the scale)' },
          lean: { type: number({ min: 0, max: 2, step: 0.05 }), optional: true, default: 0.3, description: 'how far the tip leans, in blade heights' },
        })),
        optional: true,
        description: 'scatter grass blades instead of a model: one triangle each, merged into one mesh per cell',
      },
      material: { type: asset('material'), optional: true, description: 'material of the grass blades (double-sided, wind mode grass)' },
      cellSize: { type: number({ min: 4, step: 4, unit: 'm' }), optional: true, description: 'edge of this layer\'s cells; unset uses the file\'s (grass: 16)' },
      density: { type: number({ min: 0.01, step: 10 }), description: 'at most this many per hectare (100 × 100 m)' },
      slope: { type: vector(2, '°'), optional: true, default: [0, 90], description: 'only where the ground slope is in this range' },
      height: { type: vector(2, 'm'), optional: true, description: 'only where the ground height is in this range; unset is anywhere' },
      clump: {
        type: object(fields<NonNullable<ScatterFile['layers'][number]['clump']>>({
          scale: { type: number({ min: 1, step: 5, unit: 'm' }), description: 'size of the patches' },
          coverage: { type: number({ min: 0, max: 1, step: 0.05 }), description: '0..1: how much of the ground the patches cover' },
        })),
        optional: true,
        description: 'scatter in patches instead of everywhere',
      },
      avoidPaths: { type: number({ min: 0, step: 1, unit: 'm' }), optional: true, default: 3, description: 'keeps this far off the roads and rails the terrain follows (and out of its flatten features)' },
      scale: { type: vector(2), optional: true, default: [0.8, 1.2], description: 'random uniform scale in this range' },
      alignToSlope: { type: number({ min: 0, max: 1, step: 0.1 }), optional: true, default: 0, description: '0 stands upright (trees), 1 lies along the slope (rocks)' },
      sink: { type: number({ step: 0.05, unit: 'm' }), optional: true, default: 0, description: 'pushed this far into the ground (times the scale)' },
      viewDistance: { type: number({ min: 1, step: 50, unit: 'm' }), optional: true, default: 400, description: 'scattered only this close to the camera' },
      lods: {
        type: list(object(fields<NonNullable<ScatterFile['layers'][number]['lods']>[number]>({
          distance: { type: number({ min: 1, step: 10, unit: 'm' }), description: 'cells farther than this from the camera use this level' },
          model: { type: asset('model'), optional: true, description: 'a simpler model (e.g. the same tree without its finest level); unset keeps the nearer one' },
          keep: { type: number({ min: 0.01, max: 1, step: 0.05 }), optional: true, description: 'keeps this fraction of the points (thinner grass far away); unset keeps the nearer level\'s' },
          impostor: { type: bool, optional: true, default: false, description: "draws the nearer level's model as a camera-facing card baked at runtime (far trees)" },
        }))),
        optional: true,
        description: 'levels of detail by distance, nearest first',
      },
      castShadows: { type: bool, optional: true, default: true },
    }))),
    description: 'layers of placement rules, each scattering one model',
  },
});

/**
 * 游戏设置（.game.json，Stride 的 GameSettings）。根渲染器（合成器的根是游戏自己的渲染器时，SpriteFonts、CustomEffect）的类型是
 * 游戏登记的名字，属性的字段由游戏的代码定：按文件里现在的值推（record）。
 */
export const GAME_SETTINGS_FIELDS = fields<GameSettingsFile>({
  name: string,
  defaultScene: { ...nullable(asset('scene')), description: 'the scene the game opens with; null when the root renderer draws everything (no scene)' },
  renderer: {
    ...nullable(object([
      { name: 'type', type: string, description: 'the name the game registered its renderer under (loadGameSettings renderers)' },
      { name: 'props', type: { kind: 'record' } },
    ])),
    description: 'the compositor root when the game draws with its own renderer: its registered type name and properties',
  },
  defaultBackBufferSize: { ...optional(vector(2, 'px'), [1280, 720]), description: 'the design resolution (desktop Stride opens its window this size)' },
});

/** 属性面板能编辑的资源（选中资源浏览器里的它时）：种类 → 字段。模型只有 JSON 写的那种能编辑。 */
/** 源模型的导入设置（ModelImportFile，.import.json）：改了马上存，编辑器后端照新的设置重新导入。 */
export const MODEL_IMPORT_FIELDS = fields<ModelImportFile>({
  source: { type: oneOf('glb', 'gltf', 'fbx', 'obj'), description: 'format of the source file next to these settings (same name); drop a new file to replace it' },
  scale: { type: number({ min: 0.001, step: 0.001 }), description: 'uniform scale applied to vertices, bones and animation (0.01 for an FBX made in centimeters)' },
  materials: { type: bool, description: 'import materials and their textures; off: meshes use the default material. Material files already there are kept on reimport' },
  animations: { type: bool, description: 'import each animation as a clip (the skeleton comes too)' },
  sampleRate: { type: integer(1, 240), description: 'animation keyframes per second when baking' },
});

/** 贴图的导入设置（ImageImportFile，.image.json）：改了马上存，编辑器后端照新的设置压缩（或改回源图片）。 */
export const IMAGE_IMPORT_FIELDS = fields<ImageImportFile>({
  source: { type: oneOf('png', 'jpeg', 'webp'), description: 'format of the source image next to these settings (same name)' },
  compress: { type: oneOf('none', 'uastc', 'etc1s'), description: 'none: use the source image; uastc: KTX2, high quality; etc1s: KTX2, smallest file' },
  mipmaps: { type: bool, description: 'generate mipmaps when compressing' },
  maxSize: { type: integer(0, 16384), description: 'when compressing, scale down so the longer side is at most this many pixels; 0: no limit' },
  srgb: { type: bool, description: 'color image (stored as sRGB); turn off for normal, roughness and other data maps' },
});

/**
 * 精灵表（SpriteSheetFile）：精灵的列表，每个精灵是贴图上的一块区域、原点、九宫格的边框。改了马上存，用到它的精灵热重载；
 * 区域、原点在编辑器底部的精灵表面板里拖（贴图上画出各个精灵的框），切图（按网格、自动找）也在那里。
 */
export const SPRITE_SHEET_FIELDS = fields<SpriteSheetFile>({
  name: string,
  sprites: {
    type: list(object(fields<SpriteSheetFile['sprites'][number]>({
      name: string,
      texture: object(textureRef),
      region: { type: vector(4), description: 'area on the texture in pixels: x, y (top left), width, height' },
      pixelsPerUnit: { type: number({ min: 0.001, step: 1 }), description: 'texture pixels per world unit (meter)' },
      center: { type: vector(2), description: 'origin in pixels: from the region center when centerFromMiddle, otherwise from its top left' },
      centerFromMiddle: bool,
      borders: { type: vector(4), optional: true, default: [0, 0, 0, 0], description: '9-slice borders in pixels: left, top, right, bottom (0: the whole sprite stretches)' },
    }))),
    description: 'the sprites, in order (a sprite component picks one by index)',
  },
});

/** 合成音效的一个数值参数：范围照 SYNTH_RANGES，默认值照 DEFAULT_SOUND_SYNTH，group 是面板上的分组。 */
const synthNumber = (key: keyof typeof SYNTH_RANGES, group: string, description: string): FieldSpec => {
  const [min, max] = SYNTH_RANGES[key];
  return { type: number({ min, max, step: 0.01 }), optional: true, default: DEFAULT_SOUND_SYNTH[key], group, description };
};

/** 合成音效（audio/soundSynth.ts，sfxr 的算法和参数范围）。 */
const SOUND_SYNTH_FIELDS = fields<SoundSynth>({
  wave: { type: oneOf('square', 'sawtooth', 'sine', 'triangle', 'noise'), optional: true, default: DEFAULT_SOUND_SYNTH.wave, group: 'tone', description: 'waveform' },
  attack: synthNumber('attack', 'envelope', 'rise time (squared: 1 is about 2.3 seconds)'),
  sustain: synthNumber('sustain', 'envelope', 'hold time (squared, like attack)'),
  punch: synthNumber('punch', 'envelope', 'extra loudness at the start of the hold, falling off'),
  decay: synthNumber('decay', 'envelope', 'fade-out time (squared, like attack)'),
  frequency: synthNumber('frequency', 'pitch', 'start pitch (squared: 0.3 is about 330 Hz, 0.5 about 880 Hz)'),
  minFrequency: synthNumber('minFrequency', 'pitch', 'the sound ends when a falling pitch reaches this (0: never)'),
  slide: synthNumber('slide', 'pitch', 'pitch slide: positive goes up, negative goes down'),
  deltaSlide: synthNumber('deltaSlide', 'pitch', 'change of the slide over time'),
  vibratoDepth: synthNumber('vibratoDepth', 'pitch', 'vibrato depth'),
  vibratoSpeed: synthNumber('vibratoSpeed', 'pitch', 'vibrato speed'),
  arpeggio: synthNumber('arpeggio', 'pitch', 'pitch jump after a while: positive up, negative down'),
  arpeggioSpeed: synthNumber('arpeggioSpeed', 'pitch', 'how soon the pitch jumps (1: never)'),
  repeatSpeed: synthNumber('repeatSpeed', 'pitch', 'restart the pitch (not the envelope) this often (0: never)'),
  duty: synthNumber('duty', 'tone', 'square wave: 0 is half and half, higher is thinner'),
  dutySweep: synthNumber('dutySweep', 'tone', 'change of the duty over time'),
  phaserOffset: synthNumber('phaserOffset', 'tone', 'phaser: delay of the copy mixed in'),
  phaserSweep: synthNumber('phaserSweep', 'tone', 'change of the phaser delay over time'),
  lowPassCutoff: synthNumber('lowPassCutoff', 'filter', 'low-pass cutoff (1: no filtering)'),
  lowPassSweep: synthNumber('lowPassSweep', 'filter', 'change of the low-pass cutoff over time'),
  lowPassResonance: synthNumber('lowPassResonance', 'filter', 'low-pass resonance'),
  highPassCutoff: synthNumber('highPassCutoff', 'filter', 'high-pass cutoff (0: no filtering)'),
  highPassSweep: synthNumber('highPassSweep', 'filter', 'change of the high-pass cutoff over time'),
  volume: synthNumber('volume', 'output', 'peak level'),
  seed: { type: integer(0), optional: true, default: DEFAULT_SOUND_SYNTH.seed, group: 'output', description: 'random seed of the noise (the same parameters always give the same sound)' },
});

/** 3D 文字（TextModelFile）：后端烘成同名的模型。 */
const TEXT_FIELDS = fields<TextModelFile>({
  name: string,
  text: { type: string, description: 'the text; line breaks start new lines' },
  font: { type: asset('font'), description: 'font asset whose outlines are extruded' },
  size: { type: number({ min: 0.001, step: 0.05, unit: 'm' }), description: 'height of a line (ascent plus descent)' },
  depth: { type: number({ min: 0, step: 0.005, unit: 'm' }), description: 'extrusion depth; a few millimetres for signs on a wall' },
  align: optional(oneOf('left', 'center', 'right'), 'center'),
  lineSpacing: { type: number({ min: 0, step: 0.05 }), optional: true, default: 1.2, description: 'line spacing as a multiple of the line height' },
  letterSpacing: { type: number({ step: 0.01 }), optional: true, default: 0, description: 'extra space between letters as a multiple of the line height' },
  materials: { type: list(asset('material')), description: 'slot 0: the front faces, slot 1: the sides and the back (the front material when missing)' },
});

/** 声音资源：音频文件的格式和播放方式，合成的音效的参数。 */
export const SOUND_FIELDS = fields<SoundFile>({
  name: string,
  encoding: { type: oneOf('wav', 'mp3', 'ogg', 'flac', 'aac', 'synth'), description: "format of the audio file next to it; 'synth' is a generated sound effect with no audio file" },
  streamFromDisk: { type: bool, description: 'play while downloading (music) instead of decoding it whole first; generated sounds are never streamed' },
  spatialized: { type: bool, description: 'can be positioned in 3D by an audio emitter' },
  synth: { type: object(SOUND_SYNTH_FIELDS), optional: true, description: "sound effect generator parameters (sfxr's), used when the encoding is 'synth'" },
});

export const ASSET_FIELDS = { material: MATERIAL_FIELDS, terrain: TERRAIN_FIELDS, model: PROCEDURAL_MODEL_FIELDS, timeline: TIMELINE_FIELDS, brush: BRUSH_FIELDS, sdf: SDF_FIELDS, poly: POLY_FIELDS, modelImport: MODEL_IMPORT_FIELDS, imageImport: IMAGE_IMPORT_FIELDS, spriteSheet: SPRITE_SHEET_FIELDS, text: TEXT_FIELDS, spline: SPLINE_FIELDS, tree: TREE_FIELDS, building: BUILDING_FIELDS, city: CITY_FIELDS, water: WATER_FIELDS, scatter: SCATTER_FIELDS, sound: SOUND_FIELDS, gameSettings: GAME_SETTINGS_FIELDS } as const;

