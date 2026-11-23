/** 大世界资源的字段：地形、树、建筑、城市、水体、程序化摆放。 */
import type { BuildingFile, CityFile, WaterFile, TerrainFile, ScatterFile, TreeFile } from '../../../content/formats/format';
import { nullable, fields, number, integer, bool, string, oneOf, vector, asset, list, object } from '../../../content/schema/builders.ts';

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
      spectrum: {
        type: object(fields<NonNullable<NonNullable<WaterFile['waves']>['spectrum']>>({
          wind: { type: number({ min: 0.5, step: 0.5, unit: 'm/s' }), optional: true, default: 10, description: 'wind speed driving the waves' },
          patch: { type: number({ min: 10, step: 50, unit: 'm' }), optional: true, default: 400, description: 'size of the largest wave tile (two finer tiles are 1/6 and 1/36 of it)' },
          seed: { type: integer(0, 1_000_000), optional: true, default: 0, description: 'another seed gives other waves' },
        })),
        optional: true,
        description: 'FFT ocean waves from a wind spectrum instead of the Gerstner waves (unset height follows the wind)',
      },
    })),
    optional: true,
    description: 'Gerstner waves (or an FFT wind spectrum), flattened far from the camera',
  },
  rise: { type: number({ min: 0, step: 0.1, unit: 'm' }), optional: true, description: 'how far the water rises after long heavy rain (unset: lakes 0.5, rivers 0.6, the sea 0)' },
  caustics: { type: number({ min: 0, max: 3, step: 0.1 }), optional: true, default: 1, description: 'how strong the light patterns the waves focus onto the bottom are (0 none; rivers have none)' },
  foam: {
    type: object(fields<NonNullable<WaterFile['foam']>>({
      shore: { type: number({ min: 0, step: 0.1, unit: 'm' }), optional: true, default: 1, description: 'foam where the water is shallower than this' },
    })),
    optional: true,
    description: 'foam along the shore',
  },
  river: {
    type: object(fields<NonNullable<WaterFile['river']>>({
      spline: { type: asset('spline'), description: 'the river spline (profile river; its width is the water width)' },
      level: { type: number({ step: 0.1, unit: 'm' }), optional: true, default: 0.3, description: 'how far the water surface is below the spline' },
      speed: { type: number({ min: 0, step: 0.25, unit: 'm/s' }), optional: true, default: 1.5, description: 'how fast the ripples flow along the spline' },
    })),
    optional: true,
    description: 'a river along a spline instead of a lake or sea',
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
