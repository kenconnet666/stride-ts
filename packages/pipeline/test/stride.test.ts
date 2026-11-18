import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { decodeCubemap, decodeModel, type MaterialFile, type PrefabFile, type SceneFile, type SkyboxFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dictionaryKey, floatToHalf, fromRgb9e5, halfToFloat, importCompositor, parseAssetReference, parseObjectReference, parseStrideYaml, readDdsCubemap, regenerateMips, StrideImporter, StrideProject, svgSize, toRgb9e5 } from '../src/index';

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

/** 只有一级 mip、处处同一个颜色的 RGBA16F 立方体贴图 DDS（老式 FourCC 113，Stride 的天空盒就是这种）。 */
function encodeDdsCube(size: number, color: readonly [number, number, number, number]): Buffer {
  const texels = 6 * size * size;
  const bytes = Buffer.alloc(128 + texels * 8);
  bytes.writeUInt32LE(0x20534444, 0); // 'DDS '
  bytes.writeUInt32LE(124, 4);
  bytes.writeUInt32LE(0x1007, 8); // CAPS | HEIGHT | WIDTH | PIXELFORMAT
  bytes.writeUInt32LE(size, 12);
  bytes.writeUInt32LE(size, 16);
  bytes.writeUInt32LE(1, 28);
  bytes.writeUInt32LE(32, 76);
  bytes.writeUInt32LE(0x4, 80); // DDPF_FOURCC
  bytes.writeUInt32LE(113, 84); // D3DFMT_A16B16G16R16F
  bytes.writeUInt32LE(0x1008, 108); // TEXTURE | COMPLEX
  bytes.writeUInt32LE(0xfe00, 112); // CUBEMAP 加 6 个面
  const half = color.map(floatToHalf);
  for (let i = 0; i < texels * 4; i++) bytes.writeUInt16LE(half[i % 4]!, 128 + i * 2);
  return bytes;
}

describe('DDS、半精度和 RGB9E5', () => {
  test('半精度往返、舍入和特殊值', () => {
    for (const value of [0, 1, -2, 0.5, 65504, 6.103515625e-5]) expect(halfToFloat(floatToHalf(value))).toBe(value);
    expect(halfToFloat(floatToHalf(1 / 3))).toBeCloseTo(1 / 3, 3);
    expect(halfToFloat(floatToHalf(1e6))).toBe(Infinity);
    expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
  });

  test('RGB9E5：能精确表示的值原样还原，其余相对误差在 9 位尾数以内，负数当 0，超出范围截到最大值', () => {
    const packed = toRgb9e5(new Float32Array([0.5, 1, 2, 1, 0, 0, 0, 1, 0.1, 3.7, 1000, 1, -1, 1e9, 0.25, 1]));
    expect(fromRgb9e5(packed[0]!)).toEqual([0.5, 1, 2]);
    expect(fromRgb9e5(packed[1]!)).toEqual([0, 0, 0]);
    // 共用指数跟着最大的通道（1000），小通道的精度是 1000 / 512 量级
    const [r, g, b] = fromRgb9e5(packed[2]!);
    expect(b).toBeCloseTo(1000, -1);
    expect(Math.abs(g - 3.7)).toBeLessThan(1000 / 512);
    expect(r).toBeLessThan(1000 / 512);
    expect(fromRgb9e5(packed[3]!)).toEqual([0, 65408, 0]);
  });

  test('重建 mip：每级 2x2 盒式平均到 1x1，丢掉原来的 mip（同 Stride 贴图编译的 GenerateMipmaps）', () => {
    // 2x2 的面：每个面四个纹素是 1、2、3、6，下一级是平均 3；原来的第 1 级（全 0）不要
    const level0 = new Float32Array(6 * 4 * 4);
    for (let face = 0; face < 6; face++) [1, 2, 3, 6].forEach((v, i) => level0.set([v, v * face, 0, 1], (face * 4 + i) * 4));
    const cube = regenerateMips({ size: 2, levels: [level0, new Float32Array(6 * 4)] });
    expect(cube.levels.map((level) => level.length)).toEqual([6 * 4 * 4, 6 * 4]);
    expect([...cube.levels[1]!.subarray(5 * 4, 6 * 4)]).toEqual([3, 15, 0, 1]);
  });

  test('读浮点立方体贴图；不是立方体贴图或格式不对时报错', () => {
    const cube = readDdsCubemap(encodeDdsCube(4, [0.25, 0.5, 4, 1]), 'sky.dds');
    expect([cube.size, cube.levels.length, cube.levels[0]!.length]).toEqual([4, 1, 6 * 16 * 4]);
    expect([...cube.levels[0]!.subarray(-4)]).toEqual([0.25, 0.5, 4, 1]);
    const notCube = encodeDdsCube(4, [0, 0, 0, 0]);
    notCube.writeUInt32LE(0, 112);
    expect(() => readDdsCubemap(notCube, 'flat.dds')).toThrow('flat.dds is not a square cubemap');
    expect(() => readDdsCubemap(new Uint8Array(200), 'x.dds')).toThrow('x.dds is not a DDS file');
  });
});

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
  const ids = {
    scene: '11111111-0000-0000-0000-000000000001',
    model: '11111111-0000-0000-0000-000000000002',
    material: '11111111-0000-0000-0000-000000000003',
    texture: '11111111-0000-0000-0000-000000000004',
    skybox: '11111111-0000-0000-0000-000000000005',
    skyTexture: '11111111-0000-0000-0000-000000000006',
    bumpyScene: '11111111-0000-0000-0000-000000000007',
    quad: '11111111-0000-0000-0000-000000000008',
    bumpy: '11111111-0000-0000-0000-000000000009',
    bumps: '11111111-0000-0000-0000-00000000000a',
    physicsScene: '11111111-0000-0000-0000-00000000000b',
    gameSettings: '11111111-0000-0000-0000-00000000000c',
    glass: '11111111-0000-0000-0000-00000000000d',
    glassScene: '11111111-0000-0000-0000-00000000000e',
    cratePrefab: '11111111-0000-0000-0000-00000000000f',
  };
  // 法线贴图用：一个带法线和 UV 的四边形（两个三角形，z = 0，法线 +Z）
  const quadData = Buffer.from(new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 1, 1, 1, 1, 0, 0, 0,
  ]).buffer);
  const quadGltf = JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: quadData.byteLength + 12, uri: `data:application/octet-stream;base64,${Buffer.concat([quadData, Buffer.from(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer)]).toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 }, { buffer: 0, byteOffset: 96, byteLength: 32 }, { buffer: 0, byteOffset: 128, byteLength: 12 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    materials: [{ name: 'Bumpy' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  });
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
      '    MicroSurface: !MaterialGlossinessMapFeature',
      '        GlossinessMap: !ComputeFloat',
      '            Value: 0.75',
      '    Emissive: !MaterialEmissiveMapFeature',
      '        EmissiveMap: !ComputeColor',
      '            Value: {R: 1.0, G: 1.0, B: 0.0, A: 1.0}',
      '        Intensity: !ComputeFloat',
      '            Value: 2.0',
      '    Occlusion: !MaterialOcclusionMapFeature',
      '        AmbientOcclusionMap: !ComputeFloat',
      '            Value: 1.0',
      '        CavityMap: !ComputeTextureScalar',
      '            FallbackValue:',
      '                Value: 0.5',
      '        DiffuseCavity: !ComputeFloat',
      '            Value: 1.0',
      '        SpecularCavity: !ComputeFloat',
      '            Value: 0.5',
      '    Overrides:',
      '        UVScale: {X: 1.0, Y: 3.0}',
    ].join('\n'),
    // 天空：8x8 的 HDR 立方体贴图，处处是 (0.5, 1, 2)
    'Resources/sky.dds': encodeDdsCube(8, [0.5, 1, 2, 1]),
    'Assets/SkyTexture.sdtex': ['!Texture', `Id: ${ids.skyTexture}`, 'Source: !file ../Resources/sky.dds', 'Type: !ColorTextureType {}'].join('\n'),
    'Assets/Sky.sdsky': ['!SkyboxAsset', `Id: ${ids.skybox}`, `CubeMap: ${ids.skyTexture}:SkyTexture`].join('\n'),
    'Assets/Textures/Checker.sdtex': ['!Texture', `Id: ${ids.texture}`, 'Source: ../../Resources/checker.png', 'Type: !ColorTextureType {}'].join('\n'),
    'Resources/quad.gltf': quadGltf,
    'Assets/Models/Quad.sdm3d': [
      '!Model', `Id: ${ids.quad}`, 'Source: ../../Resources/quad.gltf', 'Materials:', '    5b6d:', '        Name: Bumpy', '        MaterialInstance:',
      `            Material: ${ids.bumpy}:Materials/Bumpy`,
    ].join('\n'),
    'Assets/Materials/Bumpy.sdmat': [
      '!MaterialAsset', `Id: ${ids.bumpy}`, 'Attributes:',
      '    Surface: !MaterialNormalMapFeature',
      '        NormalMap: !ComputeTextureColor',
      `            Texture: ${ids.bumps}:Textures/Bumps`,
      '            Scale: {X: 4.0, Y: 4.0}',
      '            Offset: {X: 0.0, Y: 0.0}',
      '        IsXYNormal: true',
      '    Diffuse: !MaterialDiffuseMapFeature',
      '        DiffuseMap: !ComputeColor',
      '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
    ].join('\n'),
    // 法线贴图默认 InvertY（OpenGL 的 Y+）
    'Assets/Textures/Bumps.sdtex': ['!Texture', `Id: ${ids.bumps}`, 'Source: ../../Resources/checker.png', 'Type: !NormalMapTextureType {}'].join('\n'),
    // PhysicsSample 用到的材质特性：镜面颜色、遮蔽贴图（G 通道）、贴图乘 Float4 的自发光、透明混合；材质层还不支持
    'Assets/Materials/Glass.sdmat': [
      '!MaterialAsset', `Id: ${ids.glass}`, 'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    Specular: !MaterialSpecularMapFeature', '        SpecularMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '        Intensity: !ComputeFloat', '            Value: 0.5',
      '    Occlusion: !MaterialOcclusionMapFeature', '        AmbientOcclusionMap: !ComputeTextureScalar', `            Texture: ${ids.texture}:Textures/Checker`,
      '            Channel: G', '            Scale: {X: 2.0, Y: 2.0}', '        DirectLightingFactor: !ComputeFloat', '            Value: 0.5',
      '    Emissive: !MaterialEmissiveMapFeature', '        EmissiveMap: !ComputeBinaryColor', '            Operator: Multiply',
      '            LeftChild: !ComputeTextureColor', `                Texture: ${ids.texture}:Textures/Checker`, '                Filtering: Point', '                AddressModeU: Mirror',
      '            RightChild: !ComputeFloat4', '                Value: {X: 5.0, Y: 9.0, Z: 50.0, W: 5.0}', '        Intensity: !ComputeFloat', '            Value: 2.0',
      '    Transparency: !MaterialTransparencyBlendFeature', '        Alpha: !ComputeFloat', '            Value: 0.25',
      '        Tint: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      'Layers:', '    l1:', `        Material: ${ids.bumpy}:Materials/Bumpy`,
    ].join('\n'),
    'Assets/Glassy.sdscene': [
      '!SceneAsset', `Id: ${ids.glassScene}`, 'Hierarchy:', '    Parts:', '        -   Entity:', '                Id: g1', '                Name: Holder', '                Components:',
      '                    t: !TransformComponent', '                        Id: tg1', '                        Children: {}',
      '                    s: !Game.Holder,Game', '                        Id: sg1', `                        Look: ${ids.glass}:Materials/Glass`, '                        Speed: {X: 5.0, Y: 2.0}',
      `                        Spawn: ${ids.cratePrefab}:Prefabs/Crate`,
      // 正交相机（PhysicsSample 的 VolumeTrigger）
      '                    c: !CameraComponent', '                        Id: cg1', '                        Projection: Orthographic', '                        OrthographicSize: 21.0',
      // 模型实例化（BepuSample）：实例引用的是 InstancingComponent 的 Id，主实体排在后面；空碰撞体的刚体
      '        -   Entity:', '                Id: g2', '                Name: Instance', '                Components:',
      '                    t: !TransformComponent', '                        Id: tg2', '                        Children: {}',
      '                    i: !InstanceComponent', '                        Id: ig2', '                        Master: ref!! ing3',
      '                    b: !Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics', '                        Id: bg2', '                        Collider: !Stride.BepuPhysics.Definitions.Colliders.EmptyCollider,Stride.BepuPhysics {}',
      // 约束组件：A 引用的是物理组件；两体约束缺 B 的跳过
      '                    m: !Stride.BepuPhysics.Constraints.OneBodyAngularMotorConstraintComponent,Stride.BepuPhysics', '                        Id: mg2', '                        Enabled: false',
      '                        A: ref!! bg2', '                        TargetVelocity: {X: 0.0, Y: 10.0, Z: 0.0}', '                        MotorDamping: 50.0', '                        MotorMaximumForce: 10000000.0',
      '                    h: !Stride.BepuPhysics.Constraints.HingeConstraintComponent,Stride.BepuPhysics', '                        Id: hg2', '                        A: ref!! bg2', '                        B: null',
      '        -   Entity:', '                Id: g3', '                Name: Master', '                Components:',
      '                    t: !TransformComponent', '                        Id: tg3', '                        Children: {}',
      '                    n: !InstancingComponent', '                        Id: ing3', '                        Type: !InstancingEntityTransform {}',
      // 聚光（BepuSample 的 Cube Mixer）
      '                    l: !LightComponent', '                        Id: lg3', '                        Type: !LightSpot', '                            Color: !ColorRgbProvider',
      '                                Value: {R: 0.0, G: 0.0, B: 1.0}', '                            Range: 200.0', '                            AngleInner: 50.0', '                            AngleOuter: 90.0',
      '                        Intensity: 300.0',
    ].join('\n'),
    // 预制体：根实体带刚体，子实体带脚本（脚本属性引用同一个预制体里的根实体）
    'Assets/Prefabs/Crate.sdprefab': [
      '!PrefabAsset', `Id: ${ids.cratePrefab}`, 'Hierarchy:', '    RootParts:', '        - ref!! p1', '    Parts:',
      '        -   Entity:', '                Id: p1', '                Name: Crate', '                Components:',
      '                    t: !TransformComponent', '                        Id: tp1', '                        Children:', '                            c: ref!! tp2',
      '                    b: !Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics', '                        Id: bp1',
      '                        Collider: !Stride.BepuPhysics.Definitions.Colliders.CompoundCollider,Stride.BepuPhysics', '                            Colliders:',
      '                                a: !Stride.BepuPhysics.Definitions.Colliders.BoxCollider,Stride.BepuPhysics', '                                    Size: {X: 1.0, Y: 1.0, Z: 1.0}',
      '        -   Entity:', '                Id: p2', '                Name: Label', '                Components:',
      '                    t: !TransformComponent', '                        Id: tp2', '                        Children: {}',
      '                    s: !Game.Follower,Game', '                        Id: sp2', '                        Target: ref!! p1',
    ].join('\n'),
    'Assets/Bumpy.sdscene': [
      '!SceneAsset', `Id: ${ids.bumpyScene}`, 'Hierarchy:', '    Parts:', '        -   Entity:', '                Id: q1', '                Name: Quad', '                Components:',
      '                    t: !TransformComponent', '                        Id: tq1', '                        Children: {}',
      '                    m: !ModelComponent', '                        Id: mq1', `                        Model: ${ids.quad}:Models/Quad`, '                        Materials: {}',
    ].join('\n'),
    // TPP 的仿真设置；BepuSimulations 里没写的字段取 Stride 的默认值
    'Assets/GameSettings.sdgamesettings': [
      '!GameSettingsAsset', `Id: ${ids.gameSettings}`, `DefaultScene: ${ids.physicsScene}:Physics`, 'Defaults:',
      '    - !Stride.BepuPhysics.BepuConfiguration,Stride.BepuPhysics', '        BepuSimulations:',
      '            -   AssociatedScene: null', '                FixedTimeStepSeconds: 0.02', '                PoseGravity: {X: 0.0, Y: -40.0, Z: 0.0}',
    ].join('\n'),
    'Assets/Physics.sdscene': [
      '!SceneAsset', `Id: ${ids.physicsScene}`, 'Hierarchy:', '    Parts:',
      // 复合碰撞体：盒子带本地位置，胶囊取默认尺寸，凸包还不支持（跳过并警告）
      '        -   Entity:', '                Id: w1', '                Name: Wall', '                Components:',
      '                    t: !TransformComponent', '                        Id: tw1', '                        Children: {}',
      '                    s: !Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics', '                        Id: sw1',
      '                        Collider: !Stride.BepuPhysics.Definitions.Colliders.CompoundCollider,Stride.BepuPhysics', '                            Colliders:',
      '                                a: !Stride.BepuPhysics.Definitions.Colliders.BoxCollider,Stride.BepuPhysics',
      '                                    PositionLocal: {X: 0.0, Y: 1.0, Z: 0.0}', '                                    Size: {X: 1.0, Y: 2.0, Z: 3.0}',
      '                                b: !Stride.BepuPhysics.Definitions.Colliders.CapsuleCollider,Stride.BepuPhysics', '                                    Mass: 2.0',
      '                                c: !Stride.BepuPhysics.Definitions.Colliders.ConvexHullCollider,Stride.BepuPhysics',
      '                        CollisionLayer: Layer1', '                        FrictionCoefficient: 0.3',
      // 网格碰撞体引用模型
      '        -   Entity:', '                Id: r1', '                Name: Ramp', '                Components:',
      '                    t: !TransformComponent', '                        Id: tr1', '                        Children: {}',
      '                    s: !Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics', '                        Id: sr1',
      '                        Collider: !Stride.BepuPhysics.Definitions.Colliders.MeshCollider,Stride.BepuPhysics', `                            Model: ${ids.model}:Models/Tri`,
      // TPP 的角色
      '        -   Entity:', '                Id: p1', '                Name: Player', '                Components:',
      '                    t: !TransformComponent', '                        Id: tp1', '                        Children: {}',
      '                    c: !Stride.BepuPhysics.CharacterComponent,Stride.BepuPhysics', '                        Id: cp1',
      '                        Collider: !Stride.BepuPhysics.Definitions.Colliders.CompoundCollider,Stride.BepuPhysics', '                            Colliders:',
      '                                a: !Stride.BepuPhysics.Definitions.Colliders.CapsuleCollider,Stride.BepuPhysics',
      '                                    PositionLocal: {X: 0.0, Y: 0.95, Z: 0.0}', '                                    Radius: 0.4', '                                    Length: 1.2',
      '                        FrictionCoefficient: 0.5', '                        CollisionLayer: Layer2', '                        InterpolationMode: Interpolated',
      '                        Speed: 10.0', '                        JumpForce: 13.0', '                        SlopeAngle: 45.0',
    ].join('\n'),
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
      '                        IsShadowCaster: false',
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
      // TPP 的设置：没写的字段（级联数、稳定化、法线偏移）取 Stride 的默认值
      '                            Shadow:',
      '                                Enabled: true',
      '                                Filter: !LightShadowMapFilterTypePcf',
      '                                    FilterSize: Filter5x5',
      '                                Size: XLarge',
      '                                DepthRange: {}',
      '                                PartitionMode: !LightDirectionalShadowMap.PartitionLogarithmic {}',
      '                                ComputeTransmittance: false',
      '                                BiasParameters:',
      '                                    DepthBias: 0.0015',
      '                        Intensity: 5.0',
      '        -   Entity:',
      '                Id: e3',
      '                Name: Sky',
      '                Components:',
      '                    t3: !TransformComponent',
      '                        Id: tc3',
      '                        Children: {}',
      '                    l3: !LightComponent',
      '                        Id: lc3',
      '                        Type: !LightSkybox',
      `                            Skybox: ${ids.skybox}:Sky`,
      '                        Intensity: 1.5',
      '                    b3: !BackgroundComponent',
      '                        Id: bc3',
      `                        Texture: ${ids.skyTexture}:SkyTexture`,
      '                        Intensity: 3.0',
    ].join('\n'),
  };

  const writeProject = async () => {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    return StrideProject.open([{ package: 'Game', dir: path.join(dir, 'Assets') }]);
  };
  const readMaterial = async (out: string) => JSON.parse(await readFile(path.join(out, 'Game/Materials/Red.material.json'), 'utf8')) as MaterialFile;

  test('实体、父子、模型、材质、贴图、光源、天空盒、背景；不认识的组件计数', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    const result = await importer.importScene(project.byPath('Game/Main')!);
    expect(result).toMatchObject({
      scene: 'Game/Main',
      entities: 3,
      models: ['Game/Models/Tri'],
      materials: ['Game/Materials/Red'],
      textures: ['Game/Textures/Checker', 'Game/SkyTexture'],
      skyboxes: ['Game/Sky'],
    });
    // 游戏的脚本按类型名和属性导出，不算跳过
    expect([...result.skipped]).toEqual([]);

    const scene = JSON.parse(await readFile(path.join(out, 'Game/Main.scene.json'), 'utf8')) as SceneFile;
    // 父实体排在前面，即使文件里子实体在前
    expect(scene.entities.map((e) => [e.name, e.parent])).toEqual([['Root', null], ['Child', 'e2'], ['Sky', null]]);
    expect(scene.entities[1]!.components.scripts).toEqual([{ type: 'Game.Spinner', props: {} }]);
    expect(scene.entities[2]!.components).toEqual({ light: { type: 'skybox', skybox: 'Game/Sky', intensity: 1.5 }, background: { type: 'cubemap', texture: 'Game/SkyTexture', intensity: 3 } });

    // 恒定的天空：球谐的常数项就是天空的颜色；镜面的预滤波在运行时做，这里只引用源立方体贴图（和背景是同一个文件）
    const skybox = JSON.parse(await readFile(path.join(out, 'Game/Sky.skybox.json'), 'utf8')) as SkyboxFile;
    expect([skybox.radiance, skybox.specularSize]).toEqual(['Game/SkyTexture', 16]);
    expect(skybox.diffuseSH.slice(0, 3).map((c) => Math.round(c * 100) / 100)).toEqual([0.5, 1, 2]);
    const radiance = decodeCubemap((await readFile(path.join(out, 'Game/SkyTexture.cubemap'))).buffer as ArrayBuffer);
    expect([radiance.size, radiance.format, radiance.levels.length]).toEqual([8, 'rgb9e5ufloat', 4]); // 8、4、2、1：从第 0 级重建的 mip
    expect(fromRgb9e5(new DataView(radiance.levels[0]!.buffer, radiance.levels[0]!.byteOffset).getUint32(0, true))).toEqual([0.5, 1, 2]);
    expect(scene.entities[1]!.position).toEqual([0, 2, 0]);
    expect(scene.entities[0]!.components.light).toEqual({
      type: 'directional', color: [1, 0.5, 0], intensity: 5,
      shadow: {
        size: 'xlarge', filter: 'pcf5x5', cascadeCount: 'four', depthBias: 0.0015, normalOffsetScale: 10, stabilization: 'projectionSnapping',
        pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 50, blendCascades: true,
      },
    });
    expect(scene.entities[1]!.components.model).toEqual({ model: 'Game/Models/Tri', materials: [], isShadowCaster: false });

    const model = decodeModel((await readFile(path.join(out, 'Game/Models/Tri.model'))).buffer as ArrayBuffer);
    expect(model.materials).toEqual(['Game/Materials/Red']);
    // 默认压缩：三角形很小，位置和 UV 都量化，16 字节的顶点、meshopt
    expect(model.meshes.map((m) => [m.material, m.indexCount, m.compression, m.layout.position])).toEqual([[0, 3, 'meshopt', 'unorm16x4']]);

    const material = JSON.parse(await readFile(path.join(out, 'Game/Materials/Red.material.json'), 'utf8')) as MaterialFile;
    // 红色加贴图：uv 缩放是贴图的 Scale 乘材质的 UVScale；cavity 0.5 按 DiffuseCavity 1、SpecularCavity 0.5 插值
    expect(material).toEqual({
      name: 'Red',
      baseColor: [1, 0, 0, 1],
      baseColorTexture: { texture: 'Game/Textures/Checker', srgb: true, scale: [2, 6], offset: [0.5, 0] },
      baseColorOperator: 'add',
      metalness: 0.25,
      roughness: 0.25,
      emissive: [2, 2, 0],
      cavity: { diffuse: 0.5, specular: 0.75 },
    });
    expect(result.warnings).toEqual([]);

    const ktx2 = new Uint8Array(await readFile(path.join(out, 'Game/Textures/Checker.ktx2')));
    expect([...ktx2.subarray(0, 8)]).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]);
  });

  test('物理：静态体的复合和网格碰撞体、角色，仿真设置来自 GameSettings；不支持的形状跳过并警告', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-physics');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    const result = await importer.importScene(project.byPath('Game/Physics')!);
    expect(result.skipped.size).toBe(0);
    expect(result.warnings.filter((w) => w.includes('ConvexHullCollider'))).toHaveLength(1);
    const scene = JSON.parse(await readFile(path.join(out, 'Game/Physics.scene.json'), 'utf8')) as SceneFile;
    expect(scene.physics).toEqual({ gravity: [0, -40, 0], linearDamping: 0.05, angularDamping: 0.05, fixedTimeStep: 0.02, maxStepsPerFrame: 3 });
    const [wall, ramp, player] = scene.entities.map((e) => e.components);
    expect(wall!.static).toEqual({
      shapes: [
        { type: 'box', size: [1, 2, 3], position: [0, 1, 0], rotation: [0, 0, 0, 1], mass: 1 },
        { type: 'capsule', radius: 0.35, length: 0.5, position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 2 },
      ],
      layer: 1,
      friction: 0.3,
    });
    expect(ramp!.static).toEqual({ shapes: [{ type: 'mesh', model: 'Game/Models/Tri', position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }], layer: 0, friction: 1 });
    expect(player!.character).toMatchObject({ layer: 2, friction: 0.5, speed: 10, jumpForce: 13, slopeAngle: 45, maximumHorizontalForce: 200, interpolated: true, gravity: true });
    expect(player!.character!.shapes).toEqual([{ type: 'capsule', radius: 0.4, length: 1.2, position: [0, 0.95, 0], rotation: [0, 0, 0, 1], mass: 1 }]);

    // 没有物理组件的场景不写仿真设置
    await importer.importScene(project.byPath('Game/Bumpy')!);
    expect((JSON.parse(await readFile(path.join(out, 'Game/Bumpy.scene.json'), 'utf8')) as SceneFile).physics).toBeUndefined();
  });

  test('法线贴图：材质记下贴图（线性）和开关，用它的网格生成切线（snorm8x4）', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-normal');
    const result = await new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'smallest' }).importScene(project.byPath('Game/Bumpy')!);
    expect(result.warnings).toEqual([]);
    const material = JSON.parse(await readFile(path.join(out, 'Game/Materials/Bumpy.material.json'), 'utf8')) as MaterialFile;
    expect(material.normalMap).toEqual({ texture: 'Game/Textures/Bumps', encoding: 'png', srgb: false, scale: [4, 4], offset: [0, 0], scaleAndBias: true, isXYNormal: true, invertY: true });
    const model = decodeModel((await readFile(path.join(out, 'Game/Models/Quad.model'))).buffer as ArrayBuffer);
    expect(model.meshes.map((m) => [m.vertexCount, m.layout.tangent])).toEqual([[4, 'snorm8x4']]);
    // 主场景的三角形没有法线贴图：没有切线
    await new StrideImporter(project, tools, out, { specularCubemapSize: 16 }).importScene(project.byPath('Game/Main')!);
    expect(decodeModel((await readFile(path.join(out, 'Game/Models/Tri.model'))).buffer as ArrayBuffer).meshes[0]!.layout.tangent).toBeUndefined();
  });

  test('材质：镜面颜色乘强度、遮蔽贴图的通道、贴图乘 Float4 的自发光（不做 sRGB 转换）、透明混合；材质层警告', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-glass');
    const result = await new StrideImporter(project, tools, out, { specularCubemapSize: 16 }).importScene(project.byPath('Game/Glassy')!);
    expect(result.warnings).toEqual([expect.stringContaining('HingeConstraintComponent has no B body'), expect.stringContaining('material layers are not supported yet')]);
    const material = JSON.parse(await readFile(path.join(out, 'Game/Materials/Glass.material.json'), 'utf8')) as MaterialFile;
    const checker = { texture: 'Game/Textures/Checker', srgb: true, offset: [0, 0] };
    expect(material).toEqual({
      name: 'Glass',
      baseColor: [1, 1, 1, 1],
      specular: [0.5, 0.5, 0.5],
      roughness: 1,
      emissive: [10, 18, 100],
      emissiveTexture: { ...checker, scale: [1, 1], filter: 'point', addressU: 'mirror' },
      ambientOcclusion: { value: 1, texture: { ...checker, scale: [2, 2], channel: 'g' }, directLighting: 0.5 },
      transparency: { type: 'blend', alpha: 0.25 },
    });
    const scene = JSON.parse(await readFile(path.join(out, 'Game/Glassy.scene.json'), 'utf8')) as SceneFile;
    expect(scene.entities[0]!.components.camera).toEqual({ verticalFieldOfView: 45, nearClipPlane: 0.1, farClipPlane: 1000, projection: 'orthographic', orthographicSize: 21 });
    // Vector2 的脚本属性是数组
    expect(scene.entities[0]!.components.scripts![0]!.props['speed']).toEqual([5, 2]);
    expect(scene.entities[1]!.components.instance).toEqual({ master: 'g3' });
    expect(scene.entities[1]!.components.body!.shapes).toEqual([{ type: 'empty', position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }]);
    expect(scene.entities[2]!.components.instancing).toEqual({});
    expect(scene.entities[2]!.components.light).toEqual({ type: 'spot', color: [0, 0, 1], intensity: 300, range: 200, angleInner: 50, angleOuter: 90 });
    expect(scene.entities[1]!.components.constraints).toEqual([
      { type: 'oneBodyAngularMotor', enabled: false, bodyA: 'g2', settings: { targetVelocity: [0, 10, 0], motorDamping: 50, motorMaximumForce: 10000000 } },
    ]);
    // 脚本属性引用的预制体导出成 .prefab.json：父实体在前，引用换成预制体里的实体 id
    expect(scene.entities[0]!.components.scripts![0]!.props['spawn']).toEqual({ $asset: 'Game/Prefabs/Crate', kind: 'prefab' });
    const prefab = JSON.parse(await readFile(path.join(out, 'Game/Prefabs/Crate.prefab.json'), 'utf8')) as PrefabFile;
    expect(prefab.entities.map((e) => [e.name, e.parent])).toEqual([['Crate', null], ['Label', 'p1']]);
    expect(prefab.entities[0]!.components.body!.shapes[0]).toMatchObject({ type: 'box', size: [1, 1, 1] });
    expect(prefab.entities[1]!.components.scripts).toEqual([{ type: 'Game.Follower', props: { target: { $entity: 'p1' } } }]);
  });

  test('覆盖目录里的 SVG 代替源图片，原样导出，材质的贴图槽记下编码和栅格化尺寸', async () => {
    const project = await writeProject();
    const overrides = path.join(dir, 'overrides');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#888"/></svg>';
    await mkdir(path.join(overrides, 'Game/Textures'), { recursive: true });
    await writeFile(path.join(overrides, 'Game/Textures/Checker.svg'), svg);
    const out = path.join(dir, 'content-svg');
    await new StrideImporter(project, tools, out, { specularCubemapSize: 16, overrides }).importScene(project.byPath('Game/Main')!);
    expect((await readMaterial(out)).baseColorTexture).toEqual({ texture: 'Game/Textures/Checker', encoding: 'svg', size: [64, 32], srgb: true, scale: [2, 6], offset: [0.5, 0] });
    expect(await readFile(path.join(out, 'Game/Textures/Checker.svg'), 'utf8')).toBe(svg);
  });

  test('textureEncoding：source 复制 PNG 源文件；smallest 取 PNG 和 KTX2 里小的（这张 16x16 的 PNG 更小）', async () => {
    const project = await writeProject();
    for (const textureEncoding of ['source', 'smallest'] as const) {
      const out = path.join(dir, `content-${textureEncoding}`);
      await new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding }).importScene(project.byPath('Game/Main')!);
      expect((await readMaterial(out)).baseColorTexture).toEqual({ texture: 'Game/Textures/Checker', encoding: 'png', srgb: true, scale: [2, 6], offset: [0.5, 0] });
      expect(await readFile(path.join(out, 'Game/Textures/Checker.png'))).toEqual(files['Resources/checker.png']);
    }
  });

  test('svgSize：width、height 是像素时用它们，否则用 viewBox，都没有时 undefined', () => {
    expect(svgSize('<svg width="512" height="256px" viewBox="0 0 10 10">')).toEqual([512, 256]);
    expect(svgSize('<svg width="100%" viewBox="0 0 300 150">')).toEqual([300, 150]);
    expect(svgSize('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg">')).toBeUndefined();
  });
});

describe('图形合成器', () => {
  // AnimatedModel 的合成器的结构：第二个槽位的相机渲染到纹理，主画面引用共享的前向渲染器，字段名带覆盖标记 *
  const compositor = parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    a1:
        Id: main-slot
        Name: Main
    b2*:
        Id: second-slot
        Name: Second
SharedRenderers:
    s1: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine
        Id: main-forward
        Clear:
            Color: {R: 0.5, G: 0.5, B: 0.5, A: 1.0}
        PostEffects: null
    s2: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine
        Id: texture-forward
        Clear:
            Color: {R: 1.0, G: 0.0, B: 0.0, A: 1.0}
        TransparentRenderStage: null
Game*: !Stride.Rendering.Compositing.SceneRendererCollection,Stride.Rendering
    Children:
        c1: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
            Camera: ref!! second-slot
            Child: !Stride.Rendering.Compositing.RenderTextureSceneRenderer,Stride.Rendering
                RenderTexture: rt-id:RenderTexture
                Child: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine ref!! texture-forward
        c2: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
            Camera: ref!! main-slot
            Child: !Stride.Rendering.Compositing.SceneRendererCollection,Stride.Rendering
                Children:
                    f: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine ref!! main-forward
`);

  test('相机槽位按列表编号；主画面是槽位 0 的相机下的前向渲染器，清屏色换到线性空间', () => {
    const { cameraSlots, main } = importCompositor(compositor);
    expect([...cameraSlots]).toEqual([['main-slot', 0], ['second-slot', 1]]);
    expect(main?.postEffects).toBe(false);
    expect(main?.transparent).toBe(true);
    expect(main?.clearColor.map((c) => +c.toFixed(4))).toEqual([0.214, 0.214, 0.214, 1]);
  });

  test('相机画进渲染目标贴图的分支：槽位、贴图、里面的前向渲染器（不画透明阶段）', () => {
    const texture = { renderTexture: 'Game/RenderTexture', width: 320, height: 568, hdr: false, srgb: true };
    const { main } = importCompositor(compositor, (id) => (id === 'rt-id' ? texture : undefined));
    expect(main?.textureCameras).toEqual([{ cameraSlot: 1, texture, clearColor: [1, 0, 0, 1], postEffects: true, transparent: false }]);
  });

  test('没有合成器时没有槽位，用默认设置', () => {
    expect(importCompositor(undefined)).toEqual({ cameraSlots: new Map(), main: undefined });
  });

  test('字典的键去掉项的 id 前缀', () => {
    expect([dictionaryKey('32dcc5bc~Idle'), dictionaryKey('Run'), dictionaryKey('a~b~c')]).toEqual(['Idle', 'Run', 'b~c']);
  });
});
