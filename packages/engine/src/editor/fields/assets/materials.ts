/** 材质文件的字段：基础色、金属度、粗糙度、贴图槽、透明和玻璃、扩展材质（光泽、各向异性、室内映射），颜色树、材质层按 JSON 改。 */
import type { TextureRef, MaterialFile, TextureSlot } from '../../../content/formats/format';
import { fields, number, bool, string, oneOf, vector, object, optional, type FieldType, type Field } from '../../../content/schema/builders.ts';
import { textureRef } from './shared.ts';
import { json } from './shared.ts';

/** 材质的贴图槽（颜色、自发光）：贴图加采样方式和 UV 的缩放、偏移。 */
export const textureSlot = fields<TextureSlot>({
  ...Object.fromEntries(textureRef.map((field) => [field.name, field])) as Record<keyof TextureRef, Field>,
  filter: optional(oneOf('point', 'anisotropic')),
  addressU: optional(oneOf('clamp', 'mirror')),
  addressV: optional(oneOf('clamp', 'mirror')),
  scale: { type: vector(2), optional: true, default: [1, 1] },
  offset: { type: vector(2), optional: true, default: [0, 0] },
});

export const colorLinear3: FieldType = { kind: 'color', alpha: false, space: 'linear' };

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
  credit: {
    type: object(fields<NonNullable<MaterialFile['credit']>>({
      source: { type: string, description: 'where the sampled data comes from (URL)' },
      license: { type: string, description: 'license, e.g. CC0 1.0 or CC BY 4.0' },
      author: { type: string, optional: true },
    })),
    optional: true,
    group: 'advanced',
    description: 'source and attribution of scanned or sampled data',
  },
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
