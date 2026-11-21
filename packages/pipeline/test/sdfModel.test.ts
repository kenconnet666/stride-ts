import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, type SdfFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeSdfModel } from '../src/sdfModel.ts';

describe('SDF 建模的烘焙', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(() => tools.shutdown());

  const decode = (bytes: Uint8Array) => decodeModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  test('雪人：身子和头平滑融合，眼睛挖掉；按材质槽分网格', async () => {
    const snowman: SdfFile = {
      name: 'Snowman',
      materials: ['Materials/Snow', 'Materials/Coal'],
      resolution: 0.04,
      shapes: [
        { kind: 'sphere', operation: 'add', position: [0, 0.5, 0], radius: 0.5 },
        { kind: 'sphere', operation: 'add', smoothness: 0.15, position: [0, 1.15, 0], radius: 0.3 },
        { kind: 'capsule', operation: 'subtract', smoothness: 0.02, position: [0.1, 1.2, 0.3], height: 0.05, radius: 0.05, material: 1 },
      ],
    };
    const model = decode(await bakeSdfModel(tools, snowman));
    expect(model.materials).toEqual(['Materials/Snow', 'Materials/Coal']);
    expect(model.meshes.map((mesh) => mesh.material)).toEqual([0, 1]);
    // 简化过：平的地方三角形少，弯的地方留着
    expect(model.meshes[0]!.indexCount / 3).toBeGreaterThan(200);
  });

  test('参数不对时报错，说是第几个形状；材质槽越界报错；没有加的形状报错', async () => {
    const base = { name: 'Bad', materials: [] };
    await expect(bakeSdfModel(tools, { ...base, shapes: [{ kind: 'sphere', operation: 'add', position: [0, 0, 0], radius: 0 }] })).rejects.toThrow(/shape 0: its sizes must be positive/);
    await expect(bakeSdfModel(tools, { ...base, shapes: [{ kind: 'sphere', operation: 'add', position: [0, 0, 0], radius: 1, material: 2 }] })).rejects.toThrow(/material slot 2/);
    await expect(bakeSdfModel(tools, { ...base, shapes: [{ kind: 'sphere', operation: 'subtract', position: [0, 0, 0], radius: 1 }] })).rejects.toThrow(/no shape adds anything/);
  });
});
