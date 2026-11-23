import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeModel, decodeModelMeshes, meshFloatVertices, VERTEX_FLOATS, type ModelData } from '@stride-ts/engine/content-format';
import { fracturePieceOf } from '@stride-ts/engine/modeling';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeBrushModel } from '../src/bakers/brushModel.ts';
import { bakeFracture } from '../src/bakers/fractureModel.ts';
import { runtimeNative } from '../src/bakers/settle.ts';

describe('可破碎物体的碎块的烘焙', () => {
  let tools: StrideTools;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 2 });
  });
  afterAll(async () => {
    tools.shutdown();
    (await runtimeNative()).shutdown();
  });

  const decode = (bytes: Uint8Array) => decodeModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  /** 每个网格解成不量化的顶点和索引。 */
  async function geometry(model: ModelData) {
    const native = await runtimeNative();
    const meshes = await decodeModelMeshes(model.meshes, (requests) => native.decodeMeshoptBatch(requests), 'test');
    return meshes.map((mesh, i) => ({ name: model.meshes[i]!.name, material: model.meshes[i]!.material, vertices: meshFloatVertices(mesh), indices: mesh.indices }));
  }

  test('1 米的方块切 6 块：每块有外表面（原来的材质、法线朝轴）和断面（断面的材质），体积加起来是 1 立方米；同一个种子切得一样', async () => {
    const cube = await bakeBrushModel(tools, { name: 'Crate', materials: ['Materials/Wood'], brushes: [{ kind: 'box', operation: 'add', position: [0, 0, 0], size: [1, 1, 1] }] });
    const read = async (path: string) => {
      if (path !== 'Props/Crate.model') throw new Error(`no ${path}`);
      return cube;
    };
    const file = { name: 'CratePieces', model: 'Props/Crate', count: 6, seed: 3, interiorMaterial: 'Materials/Splinters' };
    const bytes = await bakeFracture(tools, file, read);
    const model = decode(bytes);
    expect(model.materials).toEqual(['Materials/Wood', 'Materials/Splinters']);
    const meshes = await geometry(model);
    const pieces = new Set(meshes.map((mesh) => fracturePieceOf(mesh.name)));
    expect(pieces.has(undefined)).toBe(false);
    expect(pieces.size).toBeGreaterThanOrEqual(2);
    expect(pieces.size).toBeLessThanOrEqual(6);

    let volume = 0;
    for (const mesh of meshes) {
      expect(mesh.material).toBe(mesh.name.endsWith('-inside') ? 1 : 0);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => Array.from(mesh.vertices.subarray(mesh.indices[t + k]! * VERTEX_FLOATS, mesh.indices[t + k]! * VERTEX_FLOATS + 3)));
        volume += (a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) - a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!)) / 6;
      }
      if (mesh.name.endsWith('-inside')) continue;
      // 外表面在方块的面上：法线沿某根轴（量化以后差一点）
      for (let v = 0; v < mesh.vertices.length; v += VERTEX_FLOATS) {
        const normal = Array.from(mesh.vertices.subarray(v + 3, v + 6)).map(Math.abs);
        expect(Math.max(...normal)).toBeGreaterThan(0.99);
      }
    }
    expect(volume).toBeCloseTo(1, 2);
    expect(await bakeFracture(tools, file, read)).toEqual(bytes);
  });

  test('模型读不到时报错，说是哪个模型', async () => {
    await expect(bakeFracture(tools, { name: 'Bad', model: 'Props/Missing' }, () => Promise.reject(new Error('not found')))).rejects.toThrow(/Bad: cannot read the model Props\/Missing/);
  });
});
