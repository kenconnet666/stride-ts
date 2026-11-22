import { describe, expect, test } from 'vitest';
import { assetReferences } from '../../src/content/references';
import { isProceduralModel, parseProceduralModel, PROCEDURAL_SHAPES, proceduralModelData, readModelFile } from '../../src/content/formats/format';
import { generateProceduralMesh, proceduralTangents, type ProceduralModel } from '../../src/rendering/mesh/procedural';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;

describe('JSON 写的 .model（程序生成的形状）', () => {
  test('每种形状都生成三角形、法线是单位向量，切线和法线垂直', () => {
    for (const type of PROCEDURAL_SHAPES) {
      const mesh = generateProceduralMesh({ type } as ProceduralModel);
      expect(mesh.indices.length % 3, type).toBe(0);
      expect(mesh.indices.length, type).toBeGreaterThan(0);
      const tangents = proceduralTangents(mesh);
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const n = mesh.normals.subarray(v * 3, v * 3 + 3), t = tangents.subarray(v * 4, v * 4 + 4);
        expect(Math.hypot(...n), type).toBeCloseTo(1, 4);
        expect(Math.hypot(t[0]!, t[1]!, t[2]!), type).toBeCloseTo(1, 4);
        expect(Math.abs(n[0]! * t[0]! + n[1]! * t[1]! + n[2]! * t[2]!), type).toBeLessThan(1e-4);
        expect(Math.abs(t[3]!), type).toBe(1);
      }
    }
  });

  test('按第一个字节认出 JSON；生成成和二进制解码一样的 ModelData（一个带切线的网格、材质槽）；材质的引用照常列出', () => {
    const file = { format: 1, procedural: { type: 'cube', size: [2, 1, 4] }, materials: ['Materials/Ground'] };
    expect(isProceduralModel(bytes(file))).toBe(true);
    expect(isProceduralModel(new Uint8Array([0x53, 0x4d, 0x44, 0x4c]))).toBe(false);
    const data = readModelFile(bytes(file), 'Ground.model');
    expect(data.materials).toEqual(['Materials/Ground']);
    expect(data.meshes).toHaveLength(1);
    expect(data.meshes[0]!.layout.tangent).toBe('float32x4');
    // 立方体：6 个面各 4 个顶点、2 个三角形
    expect(data.meshes[0]!.vertexCount).toBe(24);
    expect(data.meshes[0]!.indexCount).toBe(36);
    expect(proceduralModelData({ format: 1, procedural: { type: 'sphere' } }).materials).toEqual([null]);
    expect(assetReferences('model', 'Ground', { materials: parseProceduralModel(bytes(file)).materials ?? [] })).toEqual([{ kind: 'material', path: 'Materials/Ground' }]);
  });

  test('不认识的形状、尺寸不是正数、格式版本不对时报错，错误里带着文件和字段', () => {
    expect(() => readModelFile(bytes({ format: 1, procedural: { type: 'donut' } }), 'A.model')).toThrow(/A\.model: procedural\.type must be one of cube, plane/);
    expect(() => readModelFile(bytes({ format: 1, procedural: { type: 'cube', size: [1, 0, 1] } }), 'B.model')).toThrow(/B\.model: procedural model: size\[1\] must be a positive number/);
    expect(() => readModelFile(bytes({ format: 2, procedural: { type: 'cube' } }), 'C.model')).toThrow(/C\.model: unsupported JSON model format 2/);
    expect(() => readModelFile(new TextEncoder().encode('{ nope').buffer, 'D.model')).toThrow(/D\.model: not a valid JSON model/);
  });
});
