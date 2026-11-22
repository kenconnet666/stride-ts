import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, type BrushFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeBrushModel, brushToPoly } from '../src/bakers/brushModel.ts';
import { polyMeshSlots } from '@stride-ts/engine/modeling';

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

  test('导出成多边形网格：方块是 6 个四边形；挖了门洞的墙的正面是一个凹的 n 边形，材质槽照搬，能烘成模型', async () => {
    const box = await brushToPoly(tools, { name: 'Box', materials: [], brushes: [{ kind: 'box', operation: 'add', position: [0, 0.5, 0], size: [2, 1, 1] }] }, 'BoxPoly');
    expect(box.name).toBe('BoxPoly');
    expect(box.vertices).toHaveLength(8);
    expect(box.faces.map((face) => face.vertices.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(box.smoothAngle).toBe(0);

    const wall = await brushToPoly(tools, {
      name: 'Wall', materials: ['Materials/Floor', 'Materials/Wall'], uvScale: 2,
      brushes: [
        { kind: 'box', operation: 'add', position: [0, 1.5, 0], size: [4, 3, 0.5], material: 1 },
        { kind: 'box', operation: 'subtract', position: [0, 1, 0], size: [1, 2, 1], material: 1 },
      ],
    }, 'WallPoly');
    expect(wall.materials).toEqual(['Materials/Floor', 'Materials/Wall']);
    expect(wall.uvScale).toBe(2);
    expect(wall.faces.every((face) => face.material === 1)).toBe(true);
    // 正面（z = 0.25）：门洞从地上挖起，墙面是一圈 8 个点的 n 边形
    const front = wall.faces.filter((face) => face.vertices.every((v) => Math.abs(wall.vertices[v]![2] - 0.25) < 1e-6));
    expect(front.map((face) => face.vertices.length)).toEqual([8]);
    // 正反两面、顶面、左右两面、被门洞分成两块的底面、门洞里的两侧和顶
    expect(wall.faces.length).toBe(2 + 1 + 2 + 2 + 3);
    expect(polyMeshSlots(wall).length).toBeGreaterThan(0);
  });
});
