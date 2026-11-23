/** 建模类资源的字段：JSON 写的基本形状、白盒、SDF、多边形网格、样条、3D 文字。 */
import type { ProceduralModelFile, BrushFile, SdfFile, PolyMeshFile, SplineFile, TextModelFile } from '../../../content/formats/format';
import { fields, number, integer, bool, string, oneOf, vector, rotation, asset, list, optional, type FieldType, type FieldSpec } from '../../../content/schema/builders.ts';

export const positiveNumber = (step = 0.05): FieldType => number({ min: 0, step });

export const tessellation = (fallback: number): FieldSpec => ({ type: integer(1, 256), optional: true, default: fallback });

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
      cone: fields<{ height: unknown; bottomRadius: unknown; topRadius: unknown }>({
        height: { type: positiveNumber() },
        bottomRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }) },
        topRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0, description: '0 is a pointed cone' },
      }),
      roundCone: fields<{ height: unknown; bottomRadius: unknown; topRadius: unknown }>({
        height: { type: positiveNumber(), description: 'distance between the two sphere centers, along Y (more than the difference of the radii)' },
        bottomRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }) },
        topRadius: { type: number({ min: 0, step: 0.05, unit: 'm' }) },
      }),
      hexPrism: fields<{ height: unknown; radius: unknown }>({
        height: { type: positiveNumber() },
        radius: { type: positiveNumber(), description: 'from the center to the middle of a side' },
      }),
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
        river: fields<{ width: unknown }>({
          width: { type: positiveNumber(), description: 'width of the water surface (m); the water body (.water.json river) draws it, the terrain (carve) digs the bed' },
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

/** 3D 文字（TextModelFile）：后端烘成同名的模型。 */
export const TEXT_FIELDS = fields<TextModelFile>({
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
