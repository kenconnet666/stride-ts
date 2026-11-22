import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, type SdfFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeSdfModel } from '../src/bakers/sdfModel.ts';

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

  test('圆台、两头是球的圆锥、六棱柱都烘得出来；圆锥的半径差不小于高、圆台没有半径时报错', async () => {
    const one = (shape: SdfFile['shapes'][number]): SdfFile => ({ name: shape.kind, materials: [], resolution: 0.03, shapes: [shape] });
    for (const shape of [
      { kind: 'cone', operation: 'add', position: [0, 0, 0], height: 0.6, bottomRadius: 0.3 },
      { kind: 'cone', operation: 'add', position: [0, 0, 0], height: 0.6, bottomRadius: 0.3, topRadius: 0.15 },
      { kind: 'roundCone', operation: 'add', position: [0, 0, 0], height: 0.6, bottomRadius: 0.2, topRadius: 0.08 },
      { kind: 'hexPrism', operation: 'add', position: [0, 0, 0], height: 0.3, radius: 0.2 },
    ] as const) {
      const model = decode(await bakeSdfModel(tools, one(shape)));
      expect(model.meshes[0]!.indexCount, shape.kind).toBeGreaterThan(30);
    }
    await expect(bakeSdfModel(tools, one({ kind: 'roundCone', operation: 'add', position: [0, 0, 0], height: 0.1, bottomRadius: 0.3, topRadius: 0.05 }))).rejects.toThrow(/radii must differ by less than its height/);
    await expect(bakeSdfModel(tools, one({ kind: 'cone', operation: 'add', position: [0, 0, 0], height: 0.5, bottomRadius: 0, topRadius: 0 }))).rejects.toThrow(/needs a bottom or a top radius/);
  });
});
