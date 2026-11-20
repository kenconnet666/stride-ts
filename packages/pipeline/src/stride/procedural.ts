/**
 * Stride 的程序模型（.sdpromodel，ProceduralModelAsset）：把 YAML 里的 Type 换成引擎的 ProceduralModel，网格由引擎生成
 * （rendering/mesh/procedural.ts，运行时读 JSON 写的 .model 也用它）。Disc 用到时再加。
 */
import { generateProceduralMesh, type ProceduralMesh, type ProceduralModel } from '@stride-ts/engine';
import { asNumber, asObject, type StrideObject, type StrideValue } from './yaml.ts';

export type { ProceduralMesh };

/** .sdpromodel 的 Type 换成引擎的描述；不认识的类型返回 undefined。 */
export function proceduralModel(type: StrideObject): ProceduralModel | undefined {
  const common = { uvScale: vec2(type['UvScale'], 1), localOffset: vec3(type['LocalOffset'], 0), scale: vec3(type['Scale'], 1) } as const;
  const tessellation = (fallback: number) => asNumber(type['Tessellation'], fallback);
  switch (type.$type) {
    case 'CubeProceduralModel':
      return { type: 'cube', size: vec3(type['Size'], 1), ...common };
    case 'PlaneProceduralModel': {
      const grid = asObject(type['Tessellation']);
      const normal = ({ UpX: 'x', UpY: 'y', UpZ: 'z' } as const)[String(type['Normal'] ?? 'UpY') as 'UpX' | 'UpY' | 'UpZ'] ?? 'z';
      return { type: 'plane', size: vec2(type['Size'], 1), tessellation: [asNumber(grid?.['X'], 1), asNumber(grid?.['Y'], 1)], backFace: type['GenerateBackFace'] === true, normal, ...common };
    }
    case 'SphereProceduralModel':
      return { type: 'sphere', radius: asNumber(type['Radius'], 0.5), tessellation: tessellation(16), ...common };
    case 'GeoSphereProceduralModel':
      return { type: 'geoSphere', radius: asNumber(type['Radius'], 0.5), tessellation: tessellation(3), ...common };
    case 'CapsuleProceduralModel':
      return { type: 'capsule', length: asNumber(type['Length'], 0.5), radius: asNumber(type['Radius'], 0.35), tessellation: tessellation(8), ...common };
    case 'CylinderProceduralModel':
      return { type: 'cylinder', height: asNumber(type['Height'], 1), radius: asNumber(type['Radius'], 0.5), tessellation: tessellation(32), ...common };
    case 'TorusProceduralModel':
      return { type: 'torus', radius: asNumber(type['Radius'], 0.375), thickness: asNumber(type['Thickness'], 0.125), tessellation: tessellation(32), ...common };
    case 'ConeProceduralModel':
      return { type: 'cone', radius: asNumber(type['Radius'], 0.5), height: asNumber(type['Height'], 1), tessellation: tessellation(16), ...common };
    case 'TeapotProceduralModel':
      return { type: 'teapot', size: asNumber(type['Size'], 1), tessellation: tessellation(8), ...common };
    default:
      return undefined;
  }
}

/** .sdpromodel 的 Type 生成网格；不认识的类型返回 undefined。 */
export function proceduralMesh(type: StrideObject): ProceduralMesh | undefined {
  const model = proceduralModel(type);
  return model && generateProceduralMesh(model);
}

function vec3(value: StrideValue | undefined, fallback: number): [number, number, number] {
  const o = asObject(value) ?? {};
  return [asNumber(o['X'], fallback), asNumber(o['Y'], fallback), asNumber(o['Z'], fallback)];
}

function vec2(value: StrideValue | undefined, fallback: number): [number, number] {
  const o = asObject(value) ?? {};
  return [asNumber(o['X'], fallback), asNumber(o['Y'], fallback)];
}
