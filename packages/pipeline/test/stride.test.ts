import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { crc32, deflateSync } from 'node:zlib';
import path from 'node:path';
import { decodeCubemap, decodeModel, type MaterialFile, type PrefabFile, type SceneFile, type SkyboxFile, type SpriteSheetFile, type UIFile } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { DerivedDataCache } from '../src/cache';
import { lowerFirst } from '../src/stride/yaml';
import { cleanNodeName, strideNodeNames, dictionaryKey, floatToHalf, fromRgb9e5, halfToFloat, importCompositor, renderGroupMask, renderGroupOf, parseAssetReference, parseObjectReference, parseStrideYaml, readDdsCubemap, regenerateMips, StrideImporter, StrideProject, svgSize, toRgb9e5 } from '../src/index';

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
    plain: '11111111-0000-0000-0000-0000000000f1',
    odd: '11111111-0000-0000-0000-0000000000f2',
    oddTexture: '11111111-0000-0000-0000-0000000000f3',
    floor: '11111111-0000-0000-0000-0000000000a5',
    muted: '11111111-0000-0000-0000-0000000000a6',
    pipe: '11111111-0000-0000-0000-0000000000a7',
    pane: '11111111-0000-0000-0000-0000000000a8',
    lacquer: '11111111-0000-0000-0000-0000000000a9',
    knight: '11111111-0000-0000-0000-0000000000aa',
    heroSheet: '11111111-0000-0000-0000-0000000000f4',
    bumpy: '11111111-0000-0000-0000-000000000009',
    bumps: '11111111-0000-0000-0000-00000000000a',
    physicsScene: '11111111-0000-0000-0000-00000000000b',
    gameSettings: '11111111-0000-0000-0000-00000000000c',
    glass: '11111111-0000-0000-0000-00000000000d',
    glassScene: '11111111-0000-0000-0000-00000000000e',
    cratePrefab: '11111111-0000-0000-0000-00000000000f',
    menuScene: '11111111-0000-0000-0000-0000000000f5',
    menuPage: '11111111-0000-0000-0000-0000000000f6',
    clickSound: '11111111-0000-0000-0000-0000000000a1',
    laser: '11111111-0000-0000-0000-0000000000a2',
    leaf: '11111111-0000-0000-0000-0000000000a3',
    wave: '11111111-0000-0000-0000-0000000000a4',
    menuLibrary: '11111111-0000-0000-0000-0000000000f7',
    skin: '11111111-0000-0000-0000-0000000000b1',
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
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature',
      '        DiffuseMap: !ComputeBinaryColor',
      '            Operator: Add',
      '            LeftChild: !ComputeColor',
      '                Value: {R: 1.0, G: 0.0, B: 0.0, A: 1.0}',
      '            RightChild: !ComputeTextureColor',
      `                Texture: ${ids.texture}:Textures/Checker`,
      '                Scale: {X: 2.0, Y: 2.0}',
      '                Offset: {X: 0.5, Y: 0.0}',
      '    SpecularModel: !MaterialSpecularMicrofacetModelFeature {}', '    Specular: !MaterialMetalnessMapFeature',
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
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature',
      '        DiffuseMap: !ComputeColor',
      '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    Occlusion: !MaterialOcclusionMapFeature', '        AmbientOcclusionMap: !ComputeTextureScalar', `            Texture: ${ids.texture}:Textures/Checker`,
      '        DirectLightingFactor: !ComputeFloat', '            Value: 0.25',
      '        CavityMap: !ComputeTextureScalar', '            FallbackValue:', '                Value: 1.0',
    ].join('\n'),
    // 法线贴图默认 InvertY（OpenGL 的 Y+）
    'Assets/Textures/Bumps.sdtex': ['!Texture', `Id: ${ids.bumps}`, 'Source: ../../Resources/checker.png', 'Type: !NormalMapTextureType {}'].join('\n'),
    // PhysicsSample 用到的材质特性：镜面颜色、遮蔽贴图（G 通道）、贴图乘 Float4 的自发光、透明混合；材质层还不支持
    'Assets/Materials/Glass.sdmat': [
      '!MaterialAsset', `Id: ${ids.glass}`, 'Attributes:',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    SpecularModel: !MaterialSpecularMicrofacetModelFeature {}', '    Specular: !MaterialSpecularMapFeature', '        SpecularMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
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
    // ParticlesSample 的激光：自发光是有着色器类的颜色树（整棵导出）、加法透明、两面都画
    'Assets/Materials/Laser.sdmat': [
      '!MaterialAsset', `Id: ${ids.laser}`, 'Attributes:',
      '    Emissive: !MaterialEmissiveMapFeature', '        EmissiveMap: !ComputeBinaryColor', '            Operator: Multiply',
      '            LeftChild: !ComputeShaderClassColor', '                MixinReference: ComputeColorTextureScroll', '                Generics:',
      '                    2c0b~UvSpeed: !ComputeColorParameterFloat', '                        Value: -0.5', '                CompositionNodes: {}',
      '            RightChild: !ComputeTextureColor', `                Texture: ${ids.texture}:Textures/Checker`,
      '        Intensity: !ComputeFloat', '            Value: 2.0', '        UseAlpha: true',
      '    Transparency: !MaterialTransparencyAdditiveFeature', '        Alpha: !ComputeFloat', '            Value: 0.5',
      '        Tint: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    CullMode: None',
      'Layers: {}',
    ].join('\n'),
    // SpaceEscape 的 ef00：Alpha 裁剪
    'Assets/Materials/Leaf.sdmat': [
      '!MaterialAsset', `Id: ${ids.leaf}`, 'Attributes:',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    Transparency: !MaterialTransparencyCutoffFeature', '        Alpha: !ComputeFloat', '            Value: 0.3',
      'Layers: {}',
    ].join('\n'),
    // MaterialShader 的水面：位移贴图和法线贴图都是着色器类
    'Assets/Materials/Wave.sdmat': [
      '!MaterialAsset', `Id: ${ids.wave}`, 'Attributes:',
      '    Displacement: !MaterialDisplacementMapFeature', '        DisplacementMap: !ComputeShaderClassScalar', '            MixinReference: Wave',
      '            Generics:', '                g1~Speed: !ComputeColorParameterFloat', '                    Value: -0.03', '            CompositionNodes: {}',
      '        Intensity: !ComputeFloat', '            Value: 2.0', '        ScaleAndBias: false', '        Stage: Vertex',
      '    Surface: !MaterialNormalMapFeature', '        NormalMap: !ComputeShaderClassColor', '            MixinReference: WaveNormal', '            Generics: {}', '            CompositionNodes: {}',
      'Layers: {}',
    ].join('\n'),
    'Assets/Glassy.sdscene': [
      '!SceneAsset', `Id: ${ids.glassScene}`, 'Hierarchy:', '    Parts:', '        -   Entity:', '                Id: g1', '                Name: Holder', '                Components:',
      '                    t: !TransformComponent', '                        Id: tg1', '                        Children: {}',
      '                    s: !Game.Holder,Game', '                        Id: sg1', `                        Look: ${ids.glass}:Materials/Glass`, '                        Speed: {X: 5.0, Y: 2.0}',
      `                        Spawn: ${ids.cratePrefab}:Prefabs/Crate`,
      `                        Beam: ${ids.laser}:Materials/Laser`,
      `                        Foliage: ${ids.leaf}:Materials/Leaf`,
      `                        Water: ${ids.wave}:Materials/Wave`,
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
      // 聚光（BepuSample 的 Cube Mixer），加上阴影（CSharpIntermediate 的 SceneB 里是点光的）
      '                    l: !LightComponent', '                        Id: lg3', '                        Type: !LightSpot', '                            Color: !ColorRgbProvider',
      '                                Value: {R: 0.0, G: 0.0, B: 1.0}', '                            Range: 200.0', '                            AngleInner: 50.0', '                            AngleOuter: 90.0',
      '                            Shadow:', '                                Enabled: true', '                                Size: Small',
      '                                Filter: !LightShadowMapFilterTypePcf', '                                    FilterSize: Filter5x5',
      '                                BiasParameters:', '                                    DepthBias: 0.02',
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
      // 带类型标签的组件引用（TopDownRPG 的 SceneStreaming.Trigger）；Priority 是脚本基类的执行顺序，不导入
      '                        Body: !Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics ref!! bp1', '                        Priority: 20000',
    ].join('\n'),
    // OBJ 没写 usemtl、没有法线：Stride 的模型资源里只有一个叫 DefaultMaterial 的槽位（BepuSample 的 bridge.obj）
    'Resources/plain.obj': ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3', ''].join('\n'),
    'Assets/Models/Plain.sdm3d': [
      '!Model', `Id: ${ids.plain}`, 'Source: !file ../../Resources/plain.obj', 'Materials:', '    7c8e:', '        Name: DefaultMaterial', '        MaterialInstance:',
      `            Material: ${ids.odd}:Materials/Odd`,
    ].join('\n'),
    // 宽高不是 4 的倍数的贴图（BepuSample 的 Github.png 是 1015x1015）
    'Resources/odd.png': encodePng(6, 5, new Uint8Array(6 * 5 * 4).fill(255)),
    'Assets/Textures/Odd.sdtex': ['!Texture', `Id: ${ids.oddTexture}`, 'Source: ../../Resources/odd.png', 'Type: !ColorTextureType {}'].join('\n'),
    'Assets/Materials/Odd.sdmat': [
      '!MaterialAsset', `Id: ${ids.odd}`, 'Attributes:', '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeTextureColor',
      `            Texture: ${ids.oddTexture}:Textures/Odd`,
    ].join('\n'),
    // SamplesAssetPackage 的木地板（board1B）：光泽度是"贴图 × 0.3"（反相），镜面带贴图，法线贴图乘一个数
    'Assets/Materials/Floor.sdmat': [
      '!MaterialAsset', `Id: ${ids.floor}`, 'Attributes:',
      '    Surface: !MaterialNormalMapFeature', '        NormalMap: !ComputeBinaryColor', '            Operator: Multiply',
      '            LeftChild: !ComputeTextureColor', `                Texture: ${ids.bumps}:Textures/Bumps`,
      '            RightChild: !ComputeFloat4', '                Value: {X: 0.02, Y: 0.02, Z: 1.0, W: 1.0}',
      '        ScaleAndBias: false', '        IsXYNormal: true',
      '    MicroSurface: !MaterialGlossinessMapFeature', '        GlossinessMap: !ComputeBinaryScalar', '            Operator: Multiply',
      '            LeftChild: !ComputeTextureScalar', `                Texture: ${ids.texture}:Textures/Checker`,
      '            RightChild: !ComputeFloat', '                Value: 0.3', '        Invert: true',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}', '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    Specular: !MaterialSpecularMapFeature', '        SpecularMap: !ComputeTextureColor', `            Texture: ${ids.texture}:Textures/Checker`,
      '        Intensity: !ComputeFloat', '            Value: 0.3',
      'Layers: {}',
    ].join('\n'),
    // CSharpIntermediate 的 Red：停用的自发光（Enabled: false）；漫反射的贴图节点停用了，用后备颜色
    'Assets/Materials/Muted.sdmat': [
      '!MaterialAsset', `Id: ${ids.muted}`, 'Attributes:',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeTextureColor', `            Texture: ${ids.texture}:Textures/Checker`,
      '            FallbackValue:', '                Value: {R: 1.0, G: 0.0, B: 0.0, A: 1.0}', '            Enabled: false',
      '    Emissive: !MaterialEmissiveMapFeature', '        Enabled: false', '        EmissiveMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '        Intensity: !ComputeFloat', '            Value: 5.0',
      'Layers: {}',
    ].join('\n'),
    // CSharpIntermediate 的 Transparent：玻璃的镜面模型，有漫反射的颜色（玻璃的颜色）、没有漫反射的着色模型，两面都画
    'Assets/Materials/Pane.sdmat': [
      '!MaterialAsset', `Id: ${ids.pane}`, 'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 0.0, G: 1.0, B: 0.0, A: 1.0}',
      '    Specular: !MaterialMetalnessMapFeature', '        MetalnessMap: !ComputeFloat', '            Value: 0.08',
      '    SpecularModel: !MaterialSpecularThinGlassModelFeature', '        RefractiveIndex: 1.563',
      '    CullMode: None',
      'Layers: {}',
    ].join('\n'),
    // UIElementLink 的骑士那样的微表面模型（Blinn-Phong、隐式可见性），加一个不认识的环境项和关了抖动阴影的透明
    'Assets/Materials/Knight.sdmat': [
      '!MaterialAsset', `Id: ${ids.knight}`, 'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}',
      '    Specular: !MaterialMetalnessMapFeature', '        MetalnessMap: !ComputeFloat', '            Value: 0.0',
      '    SpecularModel: !MaterialSpecularMicrofacetModelFeature',
      '        Fresnel: !MaterialSpecularMicrofacetFresnelSchlick {}',
      '        Visibility: !MaterialSpecularMicrofacetVisibilityImplicit {}',
      '        NormalDistribution: !MaterialSpecularMicrofacetNormalDistributionBlinnPhong {}',
      '        Environment: !MaterialSpecularMicrofacetEnvironmentThinGlass {}',
      '    Transparency: !MaterialTransparencyBlendFeature', '        Alpha: !ComputeFloat', '            Value: 0.5', '        DitheredShadows: false',
      'Layers: {}',
    ].join('\n'),
    // CSharpIntermediate 的 Yellow：清漆的车漆，碎片的法线贴图按随机的贴图坐标取；没写的输入用 Stride 的默认值
    'Assets/Materials/Lacquer.sdmat': [
      '!MaterialAsset', `Id: ${ids.lacquer}`, 'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}',
      '    Specular: !MaterialMetalnessMapFeature', '        MetalnessMap: !ComputeFloat', '            Value: 0.0',
      '    SpecularModel: !MaterialSpecularMicrofacetModelFeature {}',
      '    ClearCoat: !MaterialClearCoatFeature',
      '        BasePaintDiffuseMap: !ComputeColor', '            Value: {R: 0.0, G: 0.0, B: 1.0, A: 1.0}',
      '        MetalFlakesMetalnessMap: !ComputeFloat', '            Value: 1.0',
      '        MetalFlakesNormalMap: !ComputeTextureColor', `            Texture: ${ids.bumps}:Textures/Bumps`,
      '            Scale: {X: 128.0, Y: 128.0}', '            UseRandomTextureCoordinates: true',
      '        ClearCoatGlossinessMap: !ComputeFloat', '            Value: 1.0',
      '        OrangePeelScaleAndBias: false', '        OrangePeelIsXYNormal: true',
      'Layers: {}',
    ].join('\n'),
    // 次表面散射：宽度和核的强度写了，透光度、衰减用 Stride 的默认值
    'Assets/Materials/Skin.sdmat': [
      '!MaterialAsset', `Id: ${ids.skin}`, 'Attributes:',
      '    Diffuse: !MaterialDiffuseMapFeature', '        DiffuseMap: !ComputeColor', '            Value: {R: 1.0, G: 0.8, B: 0.7, A: 1.0}',
      '    DiffuseModel: !MaterialDiffuseLambertModelFeature {}',
      '    SubsurfaceScattering: !MaterialSubsurfaceScatteringFeature', '        ScatteringWidth: 0.03',
      '        TranslucencyMap: !ComputeTextureScalar', '            FallbackValue: {Value: 1.0}',
      '        ProfileFunction: !MaterialSubsurfaceScatteringScatteringProfileSkin {}',
      '        KernelFunction: !MaterialSubsurfaceScatteringScatteringKernelSkin', '            Strength: {R: 0.5, G: 0.4, B: 0.3}',
      'Layers: {}',
    ].join('\n'),
    // 没给材质的程序模型（CSharpIntermediate 的激光：圆柱，材质由实体的 Materials 覆盖）
    'Assets/Models/Pipe.sdpromodel': [
      '!ProceduralModelAsset', `Id: ${ids.pipe}`, 'Type: !CylinderProceduralModel', '    Height: 2.0', '    Radius: 0.5', '    MaterialInstance:', '        Material: null',
    ].join('\n'),
    // 精灵表（Platformer2D 的 knight_sheet）：两张源图，精灵按区域取
    'Assets/Sprites/Hero.sdsheet': [
      '!SpriteSheet', `Id: ${ids.heroSheet}`, 'Type: Sprite2D', 'Packing: {}', 'Sprites:',
      '    s1:', '        Source: !file ../../Resources/checker.png', '        Name: idle_0', '        TextureRegion: {X: 0, Y: 0, Width: 8, Height: 4}',
      '        PixelsPerUnit: 16.0', '        Center: {X: 0.0, Y: 0.0}', '        Borders: {X: 0.0, Y: 0.0, Z: 0.0, W: 0.0}',
      '    s2:', '        Source: !file ../../Resources/checker.png', '        Name: idle_1', '        TextureRegion: {X: 8, Y: 0, Width: 8, Height: 4}',
      '        PixelsPerUnit: 16.0', '        Center: {X: 1.0, Y: 2.0}', '        CenterFromMiddle: false',
      '    s3:', '        Source: !file ../../Resources/odd.png', '        Name: jump_0', '        TextureRegion: {X: 0, Y: 0, Width: 6, Height: 5}',
      '        PixelsPerUnit: 8.0', '        Center: {X: 0.0, Y: 0.0}', '        Borders: {X: 1.0, Y: 0.0, Z: 0.0, W: 0.0}',
    ].join('\n'),
    // UI 页面（GameMenu 的 Main 的缩小版）：Grid 的行定义、附加属性（行、Canvas 的相对位置带 NaN、Grid 的层不导入）、
    // 精灵表的图片、Thickness、颜色；ContentDecorator 的内容和面板的子元素是 ref!! 引用；派生元素的覆盖标记 `*`
    'Assets/UI/Menu.sduipage': [
      '!UIPageAsset', `Id: ${ids.menuPage}`, 'Design:', '    Resolution: {X: 640.0, Y: 1136.0, Z: 1000.0}', 'Hierarchy:', '    RootParts:',
      '        - !Grid ref!! g1', '    Parts:',
      '        -   UIElement: !Grid', '                Id: g1', '                DependencyProperties: {}', '                Name: mainLayout',
      '                Depth: 10.0', '                DepthAlignment: Stretch',
      '                Children:', '                    a1: !ContentDecorator ref!! d1', '                    a2: !Canvas ref!! c1',
      '                RowDefinitions:', '                    r1:', '                        MaximumSize: 150.0', '                        SizeValue: 15.0',
      '                    r2:', '                        Type: Fixed', '                        SizeValue: 25.0', '                    r3: {}',
      '                ColumnDefinitions:', '                    k1: {}', '                LayerDefinitions:', '                    l1: {}',
      '        -   UIElement: !ContentDecorator', '                Id: d1', '                DependencyProperties:',
      '                    f429*~GridBase.RowPropertyKey: 1', '                    f430~GridBase.LayerPropertyKey: 0',
      '                BackgroundColor: {R: 0, G: 0, B: 0, A: 0}', '                DrawLayerNumber: 2', '                HorizontalAlignment: Center',
      '                Margin: {Left: 10.0}', '                Padding: {}', '                Name*: controlStatus',
      '                Content: !ImageElement ref!! i1',
      '                BackgroundImage: !SpriteFromSheet', `                    Sheet: ${ids.heroSheet}:Sprites/Hero`, '                    CurrentFrame*: 2',
      '            Base:', `                BasePartAsset: ${ids.menuLibrary}:UI/Lib`, '                BasePartId: x', '                InstanceId: y',
      '        -   UIElement: !ImageElement', '                Id: i1', '                DependencyProperties: {}', '                StretchDirection: DownOnly',
      // 不带引号的数字样的名字是字符串（GameMenu 的 Text: 000）
      '                Name: 007',
      '                Color: {R: 255, G: 0, B: 51, A: 255}',
      '        -   UIElement: !Canvas', '                Id: c1', '                DependencyProperties:',
      '                    3c3d~Canvas.PinOriginPropertyKey: {X: 1.0, Y: 0.0, Z: 0.0}', '                    6549~Canvas.RelativeSizePropertyKey: {X: NaN, Y: 0.4, Z: 1.0}',
      '                    0184~Panel.ZIndexPropertyKey: -1', '                Visibility: Collapsed', '                Children: {}',
    ].join('\n'),
    // UI 库：公开的元素按名字列出
    'Assets/UI/Lib.sduilib': [
      '!UILibraryAsset', `Id: ${ids.menuLibrary}`, 'Design:', '    Resolution: {X: 640.0, Y: 1136.0, Z: 1000.0}', 'PublicUIElements:', '    m1: Popup',
      'Hierarchy:', '    RootParts:', '        - !ModalElement ref!! m1', '    Parts:',
      '        -   UIElement: !ModalElement', '                Id: m1', '                DependencyProperties: {}', '                Name: Popup',
      '                OverlayColor: {R: 0, G: 0, B: 0, A: 153}', '                Content: null',
    ].join('\n'),
    // 声音：浏览器能解的源文件原样复制
    'Assets/Sounds/Click.sdsnd': ['!Sound', `Id: ${ids.clickSound}`, 'Source: !file click.wav', 'StreamFromDisk: false', 'Spatialized: true'].join('\n'),
    'Assets/Sounds/click.wav': 'RIFF....WAVE',
    'Assets/Menu.sdscene': [
      '!SceneAsset', `Id: ${ids.menuScene}`, 'Hierarchy:', '    Parts:', '        -   Entity:', '                Id: u1', '                Name: UI', '                Components:',
      '                    t: !TransformComponent', '                        Id: tu1', '                        Children: {}',
      '                    s: !Game.MenuScript,Game', '                        Id: su1', `                        UILibrary: ${ids.menuLibrary}:UI/Lib`,
      `                        Images: ${ids.heroSheet}:Sprites/Hero`, `                        Click: ${ids.clickSound}:Sounds/Click`,
      '                    u: !UIComponent', '                        Id: uu1', `                        Page: ${ids.menuPage}:UI/Menu`,
      '                        Resolution: {X: 640.0, Y: 1136.0, Z: 1000.0}', '                        Size: {X: 1.0, Y: 1.0, Z: 1.0}',
      '                        ResolutionStretch: FixedWidthFixedHeight', '                        IsBillboard: false',
      // UIElementLinkComponent：Target 引用 UIComponent、Camera 引用 CameraComponent 的 Id，换成实体
      '        -   Entity:', '                Id: u2', '                Name: Follower', '                Components:',
      '                    t: !TransformComponent', '                        Id: tu2', '                        Children: {}',
      '                    l: !UIElementLinkComponent', '                        Id: lu2', '                        Target: ref!! uu1',
      '                        Camera: ref!! missing', '                        NodeName: ElementName',
    ].join('\n'),
    'Assets/Bumpy.sdscene': [
      '!SceneAsset', `Id: ${ids.bumpyScene}`, 'Hierarchy:', '    Parts:', '        -   Entity:', '                Id: q1', '                Name: Quad', '                Components:',
      '                    t: !TransformComponent', '                        Id: tq1', '                        Children: {}',
      '                    m: !ModelComponent', '                        Id: mq1', `                        Model: ${ids.quad}:Models/Quad`, '                        Materials: {}',
      '        -   Entity:', '                Id: q2', '                Name: Plain', '                Components:',
      '                    t: !TransformComponent', '                        Id: tq2', '                        Children: {}',
      '                    m: !ModelComponent', '                        Id: mq2', `                        Model: ${ids.plain}:Models/Plain`, '                        Materials: {}',
      '        -   Entity:', '                Id: q3', '                Name: Hero', '                Components:',
      '                    t: !TransformComponent', '                        Id: tq3', '                        Children: {}',
      '                    s: !SpriteComponent', '                        Id: sq3', '                        Enabled: false', '                        RenderGroup: Group2', '                        SpriteProvider: !SpriteFromSheet',
      `                            Sheet: ${ids.heroSheet}:Sprites/Hero`, '                            CurrentFrame: 1',
      '                        Color: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}', '                        IsAlphaCutoff: true', '                        Sampler: PointClamp',
    ].join('\n'),
    // TPP 的仿真设置；BepuSimulations 里没写的字段取 Stride 的默认值
    'Assets/GameSettings.sdgamesettings': [
      '!GameSettingsAsset', `Id: ${ids.gameSettings}`, `DefaultScene: ${ids.physicsScene}:Physics`, 'Defaults:',
      '    - !Stride.BepuPhysics.BepuConfiguration,Stride.BepuPhysics', '        BepuSimulations:',
      '            -   AssociatedScene: null', '                FixedTimeStepSeconds: 0.02', '                PoseGravity: {X: 0.0, Y: -40.0, Z: 0.0}',
      // 碰撞矩阵（TopDownRPG）：层 4、15 只和层 5 碰撞
      '                Layer4: Layer5', '                Layer15: Layer5',
      // TopDownRPG 的导航设置：没写的取 Stride 的默认值
      '    - !RecastNavigationConfiguration', '        BuildSettings:', '            CellSize: 0.1', '            AgentRadius: 0.5', '            MinRegionSize: 10',
      '            IncludedLayers: Layer0, Layer6', '            PartitionType: WATERSHED', '        PathfindingSettings:', '            MaxAllowedVisitedTiles: 16',
    ].join('\n'),
    'Assets/Physics.sdscene': [
      // Offset：TopDownRPG 的分块场景用它摆位置
      '!SceneAsset', `Id: ${ids.physicsScene}`, 'Offset: {X: -20.0, Y: 0.0, Z: 0.0}', 'Hierarchy:', '    Parts:',
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
      '                        RenderGroup: Group3',
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
    expect(scene.entities[1]!.components.model).toEqual({ model: 'Game/Models/Tri', materials: [], isShadowCaster: false, renderGroup: 3 });

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
    const others = (0xffffffff & ~(1 << 4) & ~(1 << 15)) >>> 0;
    expect(scene.physics).toEqual({
      gravity: [0, -40, 0], linearDamping: 0.05, angularDamping: 0.05, fixedTimeStep: 0.02,
      collisionMasks: Array.from({ length: 32 }, (_, layer) => (layer === 4 || layer === 15 ? 1 << 5 : layer === 5 ? 0xffffffff : others)),
    });
    expect(scene.offset).toEqual([-20, 0, 0]);
    expect(scene.navigation).toEqual({
      build: {
        cellSize: 0.1, cellHeight: 0.2, agentHeight: 2, agentRadius: 0.5, agentMaxClimb: 0.9, agentMaxSlopeDegrees: 45, tileSize: 32,
        maxEdgeLength: 12, maxSimplificationError: 1.3, minRegionSize: 10, mergeRegionSize: 20, detailSampleDistance: 6, detailSampleMaxError: 1,
      },
      includedLayers: (1 << 0) | (1 << 6),
    });
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
    // 精灵表的九宫格警告见精灵表的测试
    expect(result.warnings.filter((warning) => !warning.includes('nine-slice'))).toEqual([]);
    const material = JSON.parse(await readFile(path.join(out, 'Game/Materials/Bumpy.material.json'), 'utf8')) as MaterialFile;
    expect(material.normalMap).toEqual({ texture: 'Game/Textures/Bumps', encoding: 'png', srgb: false, scale: [4, 4], offset: [0, 0], scaleAndBias: true, isXYNormal: true, invertY: true });
    const model = decodeModel((await readFile(path.join(out, 'Game/Models/Quad.model'))).buffer as ArrayBuffer);
    expect(model.meshes.map((m) => [m.vertexCount, m.layout.tangent])).toEqual([[4, 'snorm8x4']]);
    // 没有材质的 OBJ 网格用 DefaultMaterial 槽位
    const plain = decodeModel((await readFile(path.join(out, 'Game/Models/Plain.model'))).buffer as ArrayBuffer);
    expect([plain.materials, plain.meshes.map((m) => m.material)]).toEqual([['Game/Materials/Odd'], [0]]);
    // 主场景的三角形没有法线贴图：没有切线
    await new StrideImporter(project, tools, out, { specularCubemapSize: 16 }).importScene(project.byPath('Game/Main')!);
    expect(decodeModel((await readFile(path.join(out, 'Game/Models/Tri.model'))).buffer as ArrayBuffer).meshes[0]!.layout.tangent).toBeUndefined();
  });

  test('精灵表：每张源图一张贴图（不生成 mip），精灵记下区域、尺寸和原点；精灵组件引用精灵表和默认帧', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-sheet');
    const result = await new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'source' }).importScene(project.byPath('Game/Bumpy')!);
    expect(result.warnings).toEqual([]);
    const sheet = JSON.parse(await readFile(path.join(out, 'Game/Sprites/Hero.sheet.json'), 'utf8')) as SpriteSheetFile;
    expect(sheet).toEqual({
      name: 'Hero',
      sprites: [
        { name: 'idle_0', texture: { texture: 'Game/Sprites/Hero/checker', encoding: 'png', srgb: true }, region: [0, 0, 8, 4], pixelsPerUnit: 16, center: [0, 0], centerFromMiddle: true },
        { name: 'idle_1', texture: { texture: 'Game/Sprites/Hero/checker', encoding: 'png', srgb: true }, region: [8, 0, 8, 4], pixelsPerUnit: 16, center: [1, 2], centerFromMiddle: false },
        // 6x5 的源图要补到 8x8，编成 KTX2
        // 九宫格的边框：左、上、右、下
        { name: 'jump_0', texture: { texture: 'Game/Sprites/Hero/odd', encoding: 'png', srgb: true }, region: [0, 0, 6, 5], pixelsPerUnit: 8, center: [0, 0], centerFromMiddle: true, borders: [1, 0, 0, 0] },
      ],
    });
    const scene = JSON.parse(await readFile(path.join(out, 'Game/Bumpy.scene.json'), 'utf8')) as SceneFile;
    const sprite = scene.entities.find((e) => e.name === 'Hero')!.components.sprite!;
    expect(sprite).toMatchObject({ sheet: 'Game/Sprites/Hero', frame: 1, enabled: false, renderGroup: 2, isAlphaCutoff: true, sampler: 'pointClamp' });
  });

  test('UI：页面和库的元素平铺成数组，引用换成下标，属性按 UIValue 换；UIComponent 引用页面，脚本属性引用 UI 库、精灵表和声音（源文件原样复制）', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-ui');
    const result = await new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'source' }).importScene(project.byPath('Game/Menu')!);
    expect(result.warnings).toEqual([expect.stringMatching(/UI element link camera missing is not in this scene; using null$/)]);
    const page = JSON.parse(await readFile(path.join(out, 'Game/UI/Menu.ui.json'), 'utf8')) as UIFile;
    expect(page).toEqual({
      name: 'Menu',
      designResolution: [640, 1136],
      root: 0,
      elements: [
        // 深度方向的属性和 Grid 的层不导入；行列定义只写和默认值不同的
        {
          type: 'Grid',
          props: { name: 'mainLayout', rowDefinitions: [{ sizeValue: 15, maximumSize: 150 }, { type: 'fixed', sizeValue: 25 }, {}], columnDefinitions: [{}] },
          children: [1, 3],
        },
        {
          type: 'ContentDecorator',
          props: {
            backgroundColor: [0, 0, 0, 0], drawLayerNumber: 2, horizontalAlignment: 'center', margin: [10, null, null, null], padding: [null, null, null, null], name: 'controlStatus',
            backgroundImage: { sheet: 'Game/Sprites/Hero', frame: 2 },
          },
          attached: { gridRow: 1 },
          content: 2,
        },
        { type: 'ImageElement', props: { stretchDirection: 'downOnly', name: '007', color: [1, 0, 0.2, 1] } },
        { type: 'Canvas', props: { visibility: 'collapsed' }, attached: { canvasPinOrigin: [1, 0], canvasRelativeSize: [null, 0.4], panelZIndex: -1 }, children: [] },
      ],
    } satisfies UIFile);
    const library = JSON.parse(await readFile(path.join(out, 'Game/UI/Lib.ui.json'), 'utf8')) as UIFile;
    expect(library).toEqual({
      name: 'Lib',
      designResolution: [640, 1136],
      templates: { Popup: 0 },
      elements: [{ type: 'ModalElement', props: { name: 'Popup', overlayColor: [0, 0, 0, 0.6] } }],
    } satisfies UIFile);
    const scene = JSON.parse(await readFile(path.join(out, 'Game/Menu.scene.json'), 'utf8')) as SceneFile;
    const { ui, scripts } = scene.entities[0]!.components;
    expect(scene.entities[1]!.components.uiElementLink).toEqual({ target: 'u1', camera: null, nodeName: 'ElementName' });
    expect(ui).toEqual({ page: 'Game/UI/Menu', resolution: [640, 1136, 1000], size: [1, 1, 1], resolutionStretch: 'fixedWidthFixedHeight', isBillboard: false });
    expect(scripts).toEqual([{
      type: 'Game.MenuScript',
      props: { uiLibrary: { $asset: 'Game/UI/Lib', kind: 'uiLibrary' }, images: { $asset: 'Game/Sprites/Hero', kind: 'spriteSheet' }, click: { $asset: 'Game/Sounds/Click', kind: 'sound' } },
    }]);    expect(JSON.parse(await readFile(path.join(out, 'Game/Sounds/Click.sound.json'), 'utf8'))).toEqual({ name: 'Click', encoding: 'wav', streamFromDisk: false, spatialized: true });
    expect(await readFile(path.join(out, 'Game/Sounds/Click.wav'), 'utf8')).toBe('RIFF....WAVE');
  });

  test('材质自己的属性化不成固定槽时整棵树导出：镜面、光泽度放进最底下一层盖满的材质层，法线是 normalTree', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-surface-trees');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'source' });
    await importer.importAsset(project.byPath('Game/Materials/Floor')!);
    const floor = JSON.parse(await readFile(path.join(out, 'Game/Materials/Floor.material.json'), 'utf8')) as MaterialFile;
    const checker = { texture: 'Game/Textures/Checker', encoding: 'png', srgb: true };
    // 固定槽里是占位的值（镜面工作流、粗糙度不看），真的值在层里；材质没有 SpecularModel：不画镜面反射
    expect([floor.specular, floor.glossinessTexture, floor.normalMap, floor.specularShading]).toEqual([[0, 0, 0], undefined, undefined, false]);
    expect(floor.layers).toEqual([{
      blend: { $type: 'computeFloat', value: 1 },
      specular: { color: { $type: 'computeTextureColor', texture: checker }, intensity: { $type: 'computeFloat', value: 0.3 } },
      glossiness: {
        tree: { $type: 'computeBinaryScalar', operator: 'multiply', leftChild: { $type: 'computeTextureScalar', texture: checker }, rightChild: { $type: 'computeFloat', value: 0.3 } },
        invert: true,
      },
    }]);
    // 法线贴图的绿色通道翻转记在树里的贴图上
    expect(floor.normalTree).toEqual({
      tree: {
        $type: 'computeBinaryColor', operator: 'multiply',
        leftChild: { $type: 'computeTextureColor', texture: { texture: 'Game/Textures/Bumps', encoding: 'png', srgb: false, invertY: true } },
        rightChild: { $type: 'computeFloat4', value: [0.02, 0.02, 1, 1] },
      },
      scaleAndBias: false, isXYNormal: true,
    });
    // 常量的镜面、光泽度照旧在固定槽里，没有多出来的层
    await importer.importAsset(project.byPath('Game/Materials/Glass')!);
    const glass = JSON.parse(await readFile(path.join(out, 'Game/Materials/Glass.material.json'), 'utf8')) as MaterialFile;
    expect([glass.specular, glass.specularShading, glass.layers?.length]).toEqual([[0.5, 0.5, 0.5], undefined, 1]);
  });

  test('贴图编码的结果进缓存：第二次导入同样的贴图不再编，导出的文件一样', async () => {
    const project = await writeProject();
    const run = async (out: string) => {
      const cache = new DerivedDataCache(path.join(dir, 'derived-cache'));
      await new StrideImporter(project, tools, path.join(dir, out), { specularCubemapSize: 16, cache }).importScene(project.byPath('Game/Bumpy')!);
      return { hits: cache.hits, misses: cache.misses, texture: await readFile(path.join(dir, out, 'Game/Textures/Bumps.ktx2')) };
    };
    const first = await run('content-cache-a'), second = await run('content-cache-b');
    expect(first.hits).toBe(0);
    expect(first.misses).toBeGreaterThan(0);
    expect([second.hits, second.misses]).toEqual([first.misses, 0]);
    expect(second.texture.equals(first.texture)).toBe(true);
  });

  test('程序模型没给材质时也有一个（空的）材质槽，实体的 Materials 才能按槽覆盖', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-procedural');
    await new StrideImporter(project, tools, out, { specularCubemapSize: 16 }).importAsset(project.byPath('Game/Models/Pipe')!);
    const pipe = decodeModel((await readFile(path.join(out, 'Game/Models/Pipe.model'))).buffer as ArrayBuffer);
    expect([pipe.materials, pipe.meshes.map((m) => m.material)]).toEqual([[null], [0]]);
  });

  test('停用的特性（Enabled: false）不导入；停用的贴图节点用后备值', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-disabled');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'source' });
    await importer.importAsset(project.byPath('Game/Materials/Muted')!);
    const muted = JSON.parse(await readFile(path.join(out, 'Game/Materials/Muted.material.json'), 'utf8')) as MaterialFile;
    expect(muted).toEqual({ name: 'Muted', baseColor: [1, 0, 0, 1], roughness: 1 });
  });

  test('清漆的各个输入导出成颜色树，没写的用 Stride 的默认值', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-coat');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    await importer.importAsset(project.byPath('Game/Materials/Lacquer')!);
    expect(importer.warnings).toEqual([]);
    const { clearCoat, ...rest } = JSON.parse(await readFile(path.join(out, 'Game/Materials/Lacquer.material.json'), 'utf8')) as MaterialFile;
    expect(rest).toEqual({ name: 'Lacquer', baseColor: [1, 1, 1, 1], metalness: 0, roughness: 1 });
    const float = (value: number) => ({ $type: 'computeFloat', value });
    expect(clearCoat).toMatchObject({
      lodDistance: float(1),
      basePaint: { diffuse: { $type: 'computeColor', value: [0, 0, 1, 1] }, glossiness: float(0), invert: false },
      metalFlakes: {
        diffuse: { $type: 'computeColor', value: [0, 0, 0, 1] }, glossiness: float(0), invert: false, metalness: float(1),
        normal: { tree: { $type: 'computeTextureColor', texture: { texture: 'Game/Textures/Bumps', invertY: true }, scale: [128, 128], useRandomTextureCoordinates: true }, scaleAndBias: true, isXYNormal: false },
      },
      coat: { glossiness: float(1), invert: false, metalness: float(0), normal: { tree: { $type: 'computeColor', value: [0, 0, 0, 1] }, scaleAndBias: false, isXYNormal: true } },
    });
  });

  test('次表面散射导出宽度、透光度和散射核，没写的用 Stride 皮肤的默认值', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-skin');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    await importer.importAsset(project.byPath('Game/Materials/Skin')!);
    expect(importer.warnings).toEqual([]);
    const skin = JSON.parse(await readFile(path.join(out, 'Game/Materials/Skin.material.json'), 'utf8')) as MaterialFile;
    expect(skin.subsurfaceScattering).toEqual({ width: 0.03, translucency: 0.83, strength: [0.5, 0.4, 0.3], falloff: [1, 0.37, 0.3] });
  });

  test('玻璃的镜面模型导出折射率；漫反射缺着色模型时不算漫反射光照', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-glass');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    await importer.importAsset(project.byPath('Game/Materials/Pane')!);
    expect(importer.warnings).toEqual([]);
    const pane = JSON.parse(await readFile(path.join(out, 'Game/Materials/Pane.material.json'), 'utf8')) as MaterialFile;
    expect(pane).toEqual({ name: 'Pane', baseColor: [0, 1, 0, 1], metalness: 0.08, diffuseShading: false, glass: { refractiveIndex: 1.563 }, roughness: 1, doubleSided: true });
  });

  test('微表面模型只记和默认不同的项，不认识的项警告；透明关了抖动阴影时记下', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-knight');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    await importer.importAsset(project.byPath('Game/Materials/Knight')!);
    expect(importer.warnings).toEqual([expect.stringMatching(/Environment MaterialSpecularMicrofacetEnvironmentThinGlass is not supported/)]);
    const knight = JSON.parse(await readFile(path.join(out, 'Game/Materials/Knight.material.json'), 'utf8')) as MaterialFile;
    expect([knight.microfacet, knight.transparency]).toEqual([{ distribution: 'blinnPhong', visibility: 'implicit' }, { type: 'blend', alpha: 0.5, ditheredShadows: false }]);
  });

  test('单独导入脚本用代码加载的资源（Content.Load 的材质）；场景不能这样导入', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-asset');
    const importer = new StrideImporter(project, tools, out, { specularCubemapSize: 16 });
    expect(await importer.importAsset(project.byPath('Game/Materials/Odd')!)).toBe('Game/Materials/Odd');
    expect(Object.keys(JSON.parse(await readFile(path.join(out, 'Game/Materials/Odd.material.json'), 'utf8')) as object)).toContain('name');
    expect(() => importer.importAsset(project.byPath('Game/Main')!)).toThrow(/importing SceneAsset on its own is not supported/);
  });

  test("压缩的贴图宽高补到 4 的倍数（Lanczos3 缩放，同 Stride）；'source' 时缩放过的不原样复制源文件，写成缩放后的 PNG", async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-odd');
    await new StrideImporter(project, tools, out, { specularCubemapSize: 16, textureEncoding: 'source' }).importScene(project.byPath('Game/Bumpy')!);
    // PNG 的 IHDR：8 字节标识、块长和类型，然后是宽、高（大端）
    const png = await readFile(path.join(out, 'Game/Textures/Odd.png'));
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([header.getUint32(16), header.getUint32(20)]).toEqual([8, 8]);
    // 默认的策略照常编成 KTX2（头里 12 字节标识、vkFormat、typeSize，然后是 pixelWidth、pixelHeight）
    const compressed = path.join(dir, 'content-odd-ktx2');
    await new StrideImporter(project, tools, compressed, { specularCubemapSize: 16 }).importScene(project.byPath('Game/Bumpy')!);
    const ktx2 = await readFile(path.join(compressed, 'Game/Textures/Odd.ktx2'));
    const ktx2Header = new DataView(ktx2.buffer, ktx2.byteOffset, ktx2.byteLength);
    expect([ktx2Header.getUint32(20, true), ktx2Header.getUint32(24, true)]).toEqual([8, 8]);
  });

  test('材质：镜面颜色乘强度、遮蔽贴图的通道、贴图乘 Float4 的自发光（不做 sRGB 转换）、透明混合、材质层', async () => {
    const project = await writeProject();
    const out = path.join(dir, 'content-glass');
    const result = await new StrideImporter(project, tools, out, { specularCubemapSize: 16 }).importScene(project.byPath('Game/Glassy')!);
    expect(result.warnings).toEqual([expect.stringContaining('HingeConstraintComponent has no B body')]);
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
      // 层没写 BlendMap：Stride 的默认 ComputeTextureScalar（后备值 1，整层盖上）；子材质的漫反射和法线贴图导出成颜色树
      layers: [{
        blend: { $type: 'computeTextureScalar' },
        diffuse: { $type: 'computeColor', value: [1, 1, 1, 1] },
        // 层的环境光遮蔽：贴图的树和直射光受影响的程度（没有贴图的 cavity 不起作用，不报警告）
        occlusion: { tree: expect.objectContaining({ $type: 'computeTextureScalar', texture: expect.objectContaining({ texture: 'Game/Textures/Checker' }) }), directLighting: 0.25 },
        normal: { tree: expect.objectContaining({ $type: 'computeTextureColor', texture: expect.objectContaining({ texture: 'Game/Textures/Bumps' }), scale: [4, 4] }), scaleAndBias: true, isXYNormal: true },
      }],
    });
    const laser = JSON.parse(await readFile(path.join(out, 'Game/Materials/Laser.material.json'), 'utf8')) as MaterialFile;
    expect(laser).toMatchObject({
      emissiveTree: {
        tree: {
          $type: 'computeBinaryColor', operator: 'multiply',
          leftChild: { $type: 'computeShaderClassColor', mixinReference: 'ComputeColorTextureScroll', generics: { UvSpeed: { $type: 'computeColorParameterFloat', value: -0.5 } } },
          rightChild: { $type: 'computeTextureColor', texture: { texture: 'Game/Textures/Checker', srgb: true } },
        },
        intensity: 2,
        useAlpha: true,
      },
      transparency: { type: 'blend', alpha: 0, specularAlpha: 1 },
      doubleSided: true,
    });
    expect(laser.emissive).toBeUndefined();
    // Alpha 裁剪不是透明混合：材质仍不透明，只记阈值
    const leaf = JSON.parse(await readFile(path.join(out, 'Game/Materials/Leaf.material.json'), 'utf8')) as MaterialFile;
    expect([leaf.alphaCutoff, leaf.transparency]).toEqual([0.3, undefined]);
    // 着色器类的位移贴图、法线贴图整棵导出
    const wave = JSON.parse(await readFile(path.join(out, 'Game/Materials/Wave.material.json'), 'utf8')) as MaterialFile;
    expect(wave.displacementTree).toEqual({ tree: { $type: 'computeShaderClassScalar', mixinReference: 'Wave', generics: { Speed: { $type: 'computeColorParameterFloat', value: -0.03 } }, compositionNodes: {} }, intensity: 2, scaleAndBias: false });
    expect(wave.normalTree).toMatchObject({ tree: { $type: 'computeShaderClassColor', mixinReference: 'WaveNormal' }, scaleAndBias: true, isXYNormal: true });
    expect(wave.normalMap).toBeUndefined();
    const scene = JSON.parse(await readFile(path.join(out, 'Game/Glassy.scene.json'), 'utf8')) as SceneFile;
    expect(scene.entities[0]!.components.camera).toEqual({ verticalFieldOfView: 45, nearClipPlane: 0.1, farClipPlane: 1000, projection: 'orthographic', orthographicSize: 21 });
    // Vector2 的脚本属性是数组
    expect(scene.entities[0]!.components.scripts![0]!.props['speed']).toEqual([5, 2]);
    expect(scene.entities[1]!.components.instance).toEqual({ master: 'g3' });
    expect(scene.entities[1]!.components.body!.shapes).toEqual([{ type: 'empty', position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 }]);
    expect(scene.entities[2]!.components.instancing).toEqual({});
    expect(scene.entities[2]!.components.light).toEqual({
      type: 'spot', color: [0, 0, 1], intensity: 300, range: 200, angleInner: 50, angleOuter: 90,
      shadow: { size: 'small', filter: 'pcf5x5', depthBias: 0.02, normalOffsetScale: 10 },
    });
    expect(scene.entities[1]!.components.constraints).toEqual([
      { type: 'oneBodyAngularMotor', enabled: false, bodyA: 'g2', settings: { targetVelocity: [0, 10, 0], motorDamping: 50, motorMaximumForce: 10000000 } },
    ]);
    // 脚本属性引用的预制体导出成 .prefab.json：父实体在前，引用换成预制体里的实体 id
    expect(scene.entities[0]!.components.scripts![0]!.props['spawn']).toEqual({ $asset: 'Game/Prefabs/Crate', kind: 'prefab' });
    const prefab = JSON.parse(await readFile(path.join(out, 'Game/Prefabs/Crate.prefab.json'), 'utf8')) as PrefabFile;
    expect(prefab.entities.map((e) => [e.name, e.parent])).toEqual([['Crate', null], ['Label', 'p1']]);
    expect(prefab.entities[0]!.components.body!.shapes[0]).toMatchObject({ type: 'box', size: [1, 1, 1] });
    expect(prefab.entities[1]!.components.scripts).toEqual([{ type: 'Game.Follower', props: { target: { $entity: 'p1' }, body: { $entity: 'p1' } } }]);
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

  const main = (asset: ReturnType<typeof parseStrideYaml>) => importCompositor(asset).main;

  test('相机槽位按列表编号；主画面是槽位 0 的相机下的前向渲染器，清屏色换到线性空间', () => {
    const { cameraSlots, main } = importCompositor(compositor);
    expect([...cameraSlots]).toEqual([['main-slot', 0], ['second-slot', 1]]);
    expect(main?.postEffects).toBeNull();
    expect(main?.transparent).toBe(true);
    expect(main?.clearColor.map((c) => +c.toFixed(4))).toEqual([0.214, 0.214, 0.214, 1]);
  });

  test('阴影：ForwardLightingRenderFeature 的 ShadowMapRenderer 是 null 时整个合成器不画阴影，没写时画', () => {
    expect(main(compositor)?.shadows).toBeUndefined();
    const lighting = (shadowMapRenderer: string) => parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    a1:
        Id: main-slot
RenderFeatures:
    r1: !Stride.Rendering.MeshRenderFeature,Stride.Rendering
        RenderFeatures:
            f1: !Stride.Rendering.Lights.ForwardLightingRenderFeature,Stride.Rendering
                ShadowMapRenderer: ${shadowMapRenderer}
Game: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Camera: ref!! main-slot
    Child: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine {}
`);
    expect(main(lighting('null'))?.shadows).toBe(false);
    expect(main(lighting('!Stride.Rendering.Shadows.ShadowMapRenderer,Stride.Rendering {}'))?.shadows).toBeUndefined();
  });

  test('粒子画在 UI 上面：粒子的透明阶段由主画面里的 SingleStageRenderer 画；在前向渲染器的阶段里时不算', () => {
    expect(main(compositor)?.particlesOverUI).toBeUndefined();
    const particles = (stage: string) => parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    a1:
        Id: main-slot
RenderFeatures:
    r1: !Stride.Particles.Rendering.ParticleEmitterRenderFeature,Stride.Particles
        RenderStageSelectors:
            s1: !Stride.Particles.Rendering.ParticleEmitterTransparentRenderStageSelector,Stride.Particles
                OpaqueRenderStage: ref!! ${stage}
                TransparentRenderStage: ref!! ${stage}
Game: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Camera: ref!! main-slot
    Child: !Stride.Rendering.Compositing.SceneRendererCollection,Stride.Rendering
        Children:
            c1: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine {}
            c2: !Stride.Rendering.Compositing.SingleStageRenderer,Stride.Rendering
                RenderStage: ref!! particles-stage
`);
    expect(main(particles('particles-stage'))?.particlesOverUI).toBe(true);
    expect(main(particles('transparent-stage'))?.particlesOverUI).toBeUndefined();
  });

  test('相机画进渲染目标贴图的分支：槽位、贴图、里面的前向渲染器（不画透明阶段）', () => {
    const texture = { renderTexture: 'Game/RenderTexture', width: 320, height: 568, hdr: false, srgb: true };
    const { main } = importCompositor(compositor, (id) => (id === 'rt-id' ? texture : undefined));
    expect(main?.textureCameras).toEqual([{ cameraSlot: 1, texture, clearColor: [1, 0, 0, 1], postEffects: null, transparent: false }]);
  });

  test('根是游戏程序集里的渲染器时给出类型名和设置；Stride 自己的类型不算；相机下面是游戏的渲染器时主画面不做后处理', () => {
    const custom = importCompositor(parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Game*: !SpriteFonts.FontRenderer,SpriteFonts.Game
    Id: r
    StaticFont: f1:StaticFont
`));
    expect(custom.gameRenderer?.type).toBe('SpriteFonts.FontRenderer');
    expect(custom.gameRenderer?.settings['StaticFont']).toBe('f1:StaticFont');
    expect(importCompositor(compositor).gameRenderer).toBeUndefined();
    // 根是主相机的 SceneCameraRenderer、下面是游戏的渲染器（JumpyJet 的 JumpyJetRenderer）
    const underCamera = importCompositor(parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    s0:
        Id: slot0
        Name: Main
RenderStages:
    a1:
        Id: stage-opaque
        Name: Opaque
    a2:
        Id: stage-transparent
        Name: Transparent
Game*: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Id: cam
    Camera: ref!! slot0
    Child*: !JumpyJet.JumpyJetRenderer,JumpyJet.Game
        Id: r
        ParallaxBackgrounds: p1:ParallaxBackgrounds
        OpaqueRenderStage: ref!! stage-opaque
`));
    expect(underCamera.gameRenderer?.type).toBe('JumpyJet.JumpyJetRenderer');
    expect(underCamera.gameRenderer?.settings['ParallaxBackgrounds']).toBe('p1:ParallaxBackgrounds');
    // 渲染阶段按 Id 记下名字：游戏的渲染器引用阶段的属性导出成阶段的名字
    expect([...underCamera.renderStages]).toEqual([['stage-opaque', 'Opaque'], ['stage-transparent', 'Transparent']]);
    // 网格的效果名不是默认的 StrideForwardShadingEffect 时带上（SpaceEscape 的 SpaceEscapeEffectMain）
    const withEffect = (name: string) => importCompositor(parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    s0:
        Id: slot0
RenderFeatures:
    f1: !Stride.Rendering.MeshRenderFeature,Stride.Rendering
        RenderStageSelectors:
            r1: !Stride.Rendering.MeshTransparentRenderStageSelector,Stride.Rendering
                EffectName*: ${name}
Game: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Id: cam
    Camera: ref!! slot0
    Child: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine
        Id: fw
`)).main?.meshEffect;
    expect([withEffect('SpaceEscapeEffectMain'), withEffect('StrideForwardShadingEffect')]).toEqual(['SpaceEscapeEffectMain', undefined]);
    // 相机渲染器的 RenderMask：全部时不写，否则换成位（第 g 位是第 g 组）
    const withMask = (mask: string) => importCompositor(parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    s0:
        Id: slot0
        Name: Main
Game: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Id: cam
    Camera: ref!! slot0
    RenderMask: ${mask}
    Child: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine
        Id: fw
`)).main?.renderMask;
    expect([withMask('All'), withMask('Group0, Group4'), withMask('Group31'), withMask('None')]).toEqual([undefined, 0b10001, 0x80000000, 0]);
    expect([renderGroupOf('Group4'), renderGroupOf('Group0'), renderGroupOf(undefined)]).toEqual([4, 0, 0]);
    expect([renderGroupMask('All'), renderGroupMask(undefined), renderGroupMask('Group1')]).toEqual([undefined, undefined, 2]);
    // 运行时借前向渲染器画场景：不做后处理（Stride 里游戏的渲染器直接画到输出上）
    expect(underCamera.main).toEqual({ clearColor: [0, 0, 0, 1], postEffects: null, transparent: true });
    expect(custom.main).toBeUndefined();
  });

  test('后处理：共享的 PostProcessingEffects，没写的效果开着，ToneMap 看颜色变换组里的那一项，Antialiasing 为 null 时关', () => {
    const withEffects = (effects: string) => importCompositor(parseStrideYaml(`!GraphicsCompositorAsset
Id: c
Cameras:
    a1:
        Id: main-slot
SharedRenderers:
    s1: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine
        Id: main-forward
        PostEffects: !PostProcessingEffects ref!! effects
    s2: !PostProcessingEffects
        Id: effects
${effects}
Game: !Stride.Rendering.Compositing.SceneCameraRenderer,Stride.Engine
    Camera: ref!! main-slot
    Child: !Stride.Rendering.Compositing.ForwardRenderer,Stride.Engine ref!! main-forward
`)).main?.postEffects;
    // BepuSample：色调映射关掉，其余开着
    expect(withEffects(`        BrightFilter:
            Enabled*: true
        LensFlare: {}
        ColorTransforms:
            Enabled*: true
            Transforms:
                t1: !ToneMap
                    Enabled*: false
                    Operator: !ToneMapHejl2Operator {}
                t2: !FilmGrain
                    Enabled*: false
        Antialiasing: !FXAAEffect
            Quality*: 8`)).toEqual({ brightFilter: true, bloom: true, lightStreak: true, lensFlare: true, toneMap: false, antialiasing: true, ambientOcclusion: { radius: 1 } });
    expect(withEffects(`        Bloom:
            Enabled: false
        ColorTransforms:
            Transforms:
                t1: !ToneMap
                    Operator: !ToneMapHejl2Operator {}
        Antialiasing: null`)).toEqual({ brightFilter: true, bloom: false, lightStreak: true, lensFlare: true, toneMap: true, antialiasing: false, ambientOcclusion: { radius: 1 } });
    // 环境光遮蔽：Stride 默认开着（样例里关着的都写了 Enabled: false），带上半径
    expect(withEffects(`        AmbientOcclusion:
            Enabled: false`)?.ambientOcclusion).toBeUndefined();
    expect(withEffects(`        AmbientOcclusion:
            Enabled*: true
            ParamRadius*: 2.5`)?.ambientOcclusion).toEqual({ radius: 2.5 });
    // 颜色变换组里没有 ToneMap 就不做色调映射
    expect(withEffects('        Fog: {}')?.toneMap).toBe(false);
  });

  test('没有合成器时没有槽位，用默认设置', () => {
    expect(importCompositor(undefined)).toEqual({ cameraSlots: new Map(), main: undefined, gameRenderer: undefined, renderStages: new Map() });
  });

  test('节点名同 Stride 的 CleanNodeName：FBX 的命名空间只留最后一段，去掉 # 和 __ 之后的部分、空格', () => {
    expect(['mannequinModel:CATRigHub001', 'a:b:Hand', 'Bone#1', 'Arm__end', 'Left Hand', 'Trailing:', ''].map(cleanNodeName))
      .toEqual(['CATRigHub001', 'Hand', 'Bone', 'Arm', 'LeftHand', 'Trailing_', '']);
  });

  test('重名的节点同 Stride 的 GenerateUniqueNames：深度优先先序，重名的都按顺序加 _1、_2（第一个也加）', () => {
    // 根下面是 b、jet、c，b 下面是 jet、ns:jet。数组的顺序不是先序：先序是 0、1、2、4、3、5
    const nodes = [
      { name: 'root', parent: -1 },
      { name: 'b', parent: 0 },
      { name: 'jet', parent: 1 },
      { name: 'jet', parent: 0 },
      { name: 'ns:jet', parent: 1 },
      { name: 'c', parent: 0 },
    ];
    expect(strideNodeNames(nodes)).toEqual(['root', 'b', 'jet_1', 'jet_3', 'jet_2', 'c']);
  });

  test('键名首字母小写：开头的缩写整个小写，后面的单词不变', () => {
    expect(['Speed', 'UILibrary', 'IMESelectionColor', 'URL', 'AEntity', 'X', 'x'].map(lowerFirst)).toEqual(['speed', 'uiLibrary', 'imeSelectionColor', 'url', 'aEntity', 'x', 'x']);
  });

  test('字典的键去掉项的 id 前缀', () => {
    expect([dictionaryKey('32dcc5bc~Idle'), dictionaryKey('Run'), dictionaryKey('a~b~c')]).toEqual(['Idle', 'Run', 'b~c']);
  });
});
