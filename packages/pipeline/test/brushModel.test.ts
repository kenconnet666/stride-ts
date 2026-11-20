import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, type BrushFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeBrushModel } from '../src/brushModel.ts';

describe('关卡白盒的烘焙', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(() => tools.shutdown());

  const decode = (bytes: Uint8Array) => decodeModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

  test('房间：地板加墙，挖出门洞；按材质槽分网格，每个槽一个网格', async () => {
    const room: BrushFile = {
      name: 'Room',
      materials: ['Materials/Floor', 'Materials/Wall'],
      brushes: [
        { kind: 'box', operation: 'add', position: [0, -0.25, 0], size: [8, 0.5, 8] },
        { kind: 'box', operation: 'add', position: [0, 1.5, -3.75], size: [8, 3, 0.5], material: 1 },
        { kind: 'box', operation: 'subtract', position: [0, 1, -3.75], size: [1.2, 2, 1], material: 1 },
      ],
    };
    const model = decode(await bakeBrushModel(tools, room));
    expect(model.materials).toEqual(['Materials/Floor', 'Materials/Wall']);
    expect(model.meshes.map((mesh) => mesh.material)).toEqual([0, 1]);
    // 墙上挖了门洞：比一个方块（12 个三角形）多
    expect(model.meshes[1]!.indexCount / 3).toBeGreaterThan(12);
  });

  test('参数不对时报错，说是第几个笔刷；材质槽越界报错；全减光了报错', async () => {
    const base = { name: 'Bad', materials: [] };
    await expect(bakeBrushModel(tools, { ...base, brushes: [{ kind: 'prism', operation: 'add', position: [0, 0, 0], points: [[0, 0], [1, 0]], height: 1 }] })).rejects.toThrow(/brush 0: a prism needs at least 3 points/);
    await expect(bakeBrushModel(tools, { ...base, brushes: [{ kind: 'box', operation: 'add', position: [0, 0, 0], size: [1, 1, 1], material: 2 }] })).rejects.toThrow(/material slot 2/);
    await expect(bakeBrushModel(tools, { ...base, brushes: [
      { kind: 'box', operation: 'add', position: [0, 0, 0], size: [1, 1, 1] },
      { kind: 'box', operation: 'subtract', position: [0, 0, 0], size: [2, 2, 2] },
    ] })).rejects.toThrow(/leave nothing/);
  });
});
