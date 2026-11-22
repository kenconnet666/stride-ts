import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, type SplineFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeSplineModel } from '../src/splineModel.ts';

describe('样条的烘焙', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(() => tools.shutdown());

  const decode = (bytes: Uint8Array) => decodeModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  test('河道没有几何：不烘模型', () => {
    expect(bakeSplineModel(tools, { name: 'River', materials: [], profile: { type: 'river', width: 12 }, points: [{ position: [0, 0, 0] }, { position: [50, -1, 10] }] })).toBeUndefined();
  });

  test('电线：电杆、导线两个材质槽各一个网格', () => {
    const wire: SplineFile = {
      name: 'PowerLine', materials: ['Materials/Pole', 'Materials/Wire'], profile: { type: 'wire', poleHeight: 9, poleSpacing: 30 },
      points: [{ position: [0, 0, 0] }, { position: [60, 0, 20] }, { position: [120, 0, 0] }],
    };
    const model = decode(bakeSplineModel(tools, wire)!);
    expect(model.materials).toEqual(['Materials/Pole', 'Materials/Wire']);
    expect(model.meshes.map((mesh) => mesh.material)).toEqual([0, 1]);
    // 120 多米、间距 30 米：5 根杆，每根杆身加横担 2 个方块 × 24 个顶点
    expect(model.meshes[0]!.vertexCount).toBe(5 * 2 * 24);
    expect(model.meshes[1]!.vertexCount).toBeGreaterThan(0);
  });

  test('控制点不够时报错，带着资源名', () => {
    expect(() => bakeSplineModel(tools, { name: 'Bad', materials: [null], profile: { type: 'road', width: 6 }, points: [{ position: [0, 0, 0] }] }, 'spline Roads/Bad')).toThrow(/spline Roads\/Bad: points needs at least 2 points/);
  });
});
