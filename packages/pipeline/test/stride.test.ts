import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { decodeModel, type MaterialFile, type SceneFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseAssetReference, parseObjectReference, parseStrideYaml, StrideImporter, StrideProject } from '../src/index';

describe('Stride 的 YAML', () => {
  test('标签里的逗号（程序集限定名）、对象引用和资源引用', () => {
    const value = parseStrideYaml(
      [
        '!SceneAsset',
        'Id: 98760599-6f0e-4c6b-9ba2-613e9d68d2e3',
        'Components:',
        '    a1: !Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics',
        '        Id: x',
        '    b2: !TransformComponent',
        '        Children:',
        '            c3: ref!! b90064b2-8620-4e77-a0d1-243b9d099112',
        'Model: 66d4458f-7fd8-452c-bb3c-c89eca9d666a:/PrototypingBlocks/Models/Wall0x2x5Window',
      ].join('\n'),
    );
    expect(value.$type).toBe('SceneAsset');
    const components = value['Components'] as Record<string, { $type: string; Children?: Record<string, string> }>;
    expect(components['a1']!.$type).toBe('Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics');
    expect(parseObjectReference(components['b2']!.Children!['c3'])).toBe('b90064b2-8620-4e77-a0d1-243b9d099112');
    expect(parseAssetReference(value['Model'])).toEqual({ id: '66d4458f-7fd8-452c-bb3c-c89eca9d666a', url: '/PrototypingBlocks/Models/Wall0x2x5Window' });
    expect(() => parseStrideYaml('a: [1', 'broken.sdscene')).toThrow('broken.sdscene');
  });
});

/** 最小的 PNG 编码器（RGBA8，每行滤波类型 None）。 */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; ++y) Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('导入 Stride 场景', () => {
  let tools: StrideTools;
  let dir: string;
  beforeAll(async () => {
    tools = await createStrideTools({ workerThreads: 1 });
    dir = await mkdtemp(path.join(tmpdir(), 'stride-import-'));
  });
  afterAll(async () => {
    tools?.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  // 一个最小的 Stride 工程：一个三角形的 glTF 模型、一个"颜色加贴图"的材质（贴图是 16x16 的棋盘格 PNG）、一个父子两个实体的场景
  const ids = { scene: '11111111-0000-0000-0000-000000000001', model: '11111111-0000-0000-0000-000000000002', material: '11111111-0000-0000-0000-000000000003', texture: '11111111-0000-0000-0000-000000000004' };
  const gltf = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: 36, uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    materials: [{ name: 'Grid' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  });
  const checker = new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : ((i >> 2) % 16 ^ (i >> 6)) & 1 ? 255 : 0));
  const files: Record<string, string | Buffer> = {
    'Resources/checker.png': encodePng(16, 16, checker),
    'Resources/tri.gltf': gltf,
    'Assets/Models/Tri.sdm3d': [
      '!Model',
      `Id: ${ids.model}`,
      'Source: ../../Resources/tri.gltf',
      'PivotPosition: {X: 0.0, Y: 0.0, Z: 0.0}',
      'Materials:',
      '    2a4c:',
      '        Name: Grid',
      '        MaterialInstance:',
      `            Material: ${ids.material}:Materials/Red`,
    ].join('\n'),
    'Assets/Materials/Red.sdmat': [
      '!MaterialAsset',
      `Id: ${ids.material}`,
      'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature',
      '        DiffuseMap: !ComputeBinaryColor',
      '            Operator: Add',
      '            LeftChild: !ComputeColor',
      '                Value: {R: 1.0, G: 0.0, B: 0.0, A: 1.0}',
      '            RightChild: !ComputeTextureColor',
      `                Texture: ${ids.texture}:Textures/Checker`,
      '                Scale: {X: 2.0, Y: 2.0}',
      '                Offset: {X: 0.5, Y: 0.0}',
      '    Specular: !MaterialMetalnessMapFeature',
      '        MetalnessMap: !ComputeFloat',
      '            Value: 0.25',
      '    Overrides:',
      '        UVScale: {X: 1.0, Y: 3.0}',
    ].join('\n'),
    'Assets/Textures/Checker.sdtex': ['!Texture', `Id: ${ids.texture}`, 'Source: ../../Resources/checker.png', 'Type: !ColorTextureType {}'].join('\n'),
    'Assets/Main.sdscene': [
      '!SceneAsset',
      `Id: ${ids.scene}`,
      'Hierarchy:',
      '    Parts:',
      '        -   Entity:',
      '                Id: e1',
      '                Name: Child',
      '                Components:',
      '                    t1: !TransformComponent',
      '                        Id: tc1',
      '                        Position: {X: 0.0, Y: 2.0, Z: 0.0}',
      '                        Children: {}',
      '                    m1: !ModelComponent',
      '                        Id: mc1',
      `                        Model: ${ids.model}:Models/Tri`,
      '                        Materials: {}',
      '                    s1: !Game.Spinner,Game',
      '                        Id: sc1',
      '        -   Entity:',
      '                Id: e2',
      '                Name: Root',
      '                Components:',
      '                    t2: !TransformComponent',
      '                        Id: tc2',
      '                        Rotation: {X: 0.0, Y: 0.0, Z: 0.0, W: 1.0}',
      '                        Children:',
      '                            x: ref!! tc1',
      '                    l2: !LightComponent',
      '                        Id: lc2',
      '                        Type: !LightDirectional',
      '                            Color: !ColorRgbProvider',
      '                                Value: {R: 1.0, G: 0.5, B: 0.0}',
      '                        Intensity: 5.0',
    ].join('\n'),
  };

  test('实体、父子、模型、材质、贴图、光源；不认识的组件计数', async () => {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    const project = await StrideProject.open([{ package: 'Game', dir: path.join(dir, 'Assets') }]);
    const out = path.join(dir, 'content');
    const result = await new StrideImporter(project, tools, out).importScene(project.byPath('Game/Main')!);
    expect(result).toMatchObject({ scene: 'Game/Main', entities: 2, models: ['Game/Models/Tri'], materials: ['Game/Materials/Red'], textures: ['Game/Textures/Checker'] });
    expect([...result.skipped]).toEqual([['Game.Spinner,Game', 1]]);

    const scene = JSON.parse(await readFile(path.join(out, 'Game/Main.scene.json'), 'utf8')) as SceneFile;
    // 父实体排在前面，即使文件里子实体在前
    expect(scene.entities.map((e) => [e.name, e.parent])).toEqual([['Root', null], ['Child', 'e2']]);
    expect(scene.entities[1]!.position).toEqual([0, 2, 0]);
    expect(scene.entities[0]!.components.light).toEqual({ type: 'directional', color: [1, 0.5, 0], intensity: 5 });
    expect(scene.entities[1]!.components.model).toEqual({ model: 'Game/Models/Tri', materials: [] });

    const model = decodeModel((await readFile(path.join(out, 'Game/Models/Tri.model'))).buffer as ArrayBuffer);
    expect(model.materials).toEqual(['Game/Materials/Red']);
    expect(model.meshes.map((m) => [m.material, m.indices.length])).toEqual([[0, 3]]);

    const material = JSON.parse(await readFile(path.join(out, 'Game/Materials/Red.material.json'), 'utf8')) as MaterialFile;
    // 红色加贴图：uv 缩放是贴图的 Scale 乘材质的 UVScale
    expect(material).toEqual({
      name: 'Red',
      baseColor: [1, 0, 0, 1],
      baseColorTexture: { texture: 'Game/Textures/Checker', scale: [2, 6], offset: [0.5, 0] },
      baseColorOperator: 'add',
      metalness: 0.25,
    });
    expect(result.warnings).toEqual([]);

    const ktx2 = new Uint8Array(await readFile(path.join(out, 'Game/Textures/Checker.ktx2')));
    expect([...ktx2.subarray(0, 8)]).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]);
  });
});
