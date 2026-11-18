import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Background,
  Camera,
  ContentManager,
  Cubemap,
  decodeCubemap,
  decodeModel,
  encodeCubemap,
  encodeModel,
  CUBEMAP_TEXEL_BYTES,
  FLOAT_LAYOUT,
  plainMesh,
  Game,
  ktx2Decoder,
  Light,
  Material,
  Mesh,
  Model,
  Skybox,
  Transform,
  VERTEX_FLOATS,
  type GraphicsDevice,
  type MaterialFile,
  type SceneFile,
  type SkyboxFile,
} from '../src/index';

// 内容格式和加载：不碰 GPU。读文件换成从内存里的 Map 取。

const vertices = (count: number, x = 0) => {
  const data = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) data.set([x + v, 0, 0, 0, 1, 0, v / count, 0], v * VERTEX_FLOATS);
  return data;
};

describe('模型文件', () => {
  test('编码再解码，网格、布局、索引格式和材质槽原样还原；字节数对不上时报错', () => {
    const bytes = encodeModel({
      materials: ['materials/Grid', null],
      meshes: [plainMesh('a', 0, vertices(3), new Uint16Array([0, 1, 2])), plainMesh('b', null, vertices(4, 10), new Uint32Array([0, 1, 2, 0, 2, 3]))],
    });
    const model = decodeModel(bytes.buffer as ArrayBuffer);
    expect(model.materials).toEqual(['materials/Grid', null]);
    expect(model.meshes.map((m) => [m.name, m.material, m.vertexCount, m.indexFormat, m.compression, m.layout])).toEqual([
      ['a', 0, 3, 'uint16', 'none', FLOAT_LAYOUT],
      ['b', null, 4, 'uint32', 'none', FLOAT_LAYOUT],
    ]);
    const b = model.meshes[1]!;
    expect(new Float32Array(b.vertices.slice().buffer)[0]).toBe(10);
    expect([...new Uint32Array(b.indices.slice().buffer)]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(() => decodeModel(new ArrayBuffer(16))).toThrow('not a model file');
    expect(() => encodeModel({ materials: [], meshes: [{ ...plainMesh('c', null, vertices(3), new Uint16Array([0, 1, 2])), vertexCount: 4 }] })).toThrow("model mesh 'c': 4 vertices need 128 bytes, got 96");
  });

  test('meshopt 压缩、量化的网格经 meshoptDecoder 解码，反量化参数和布局带到 Mesh 上', async () => {
    const [native, tools] = await Promise.all([createStrideNative({ workerThreads: 1 }), createStrideTools({ workerThreads: 1 })]);
    try {
      // 两个顶点、一个退化的三角形就够看格式：位置 unorm16x4、法线八面体 snorm16x2、UV unorm16x2，16 字节
      const layout = { position: 'unorm16x4', normal: 'snorm16x2', uv: 'unorm16x2' } as const;
      const raw = new Uint16Array([0, 65535, 0, 0, 0, 32767, 0, 65535, 65535, 0, 65535, 0, 32767, 0, 65535, 0]);
      const indices = new Uint32Array([0, 1, 1]);
      const dequantize = { positionOffset: [1, 2, 3], positionScale: [4, 4, 4], uvOffset: [0, 0], uvScale: [2, 2] } as const;
      const model = encodeModel({
        materials: [],
        meshes: [{
          name: 'q', material: null, layout, dequantize, compression: 'meshopt', vertexCount: 2, indexCount: 3, indexFormat: 'uint16',
          vertices: tools.encodeVertices(new Uint8Array(raw.buffer), 16), indices: tools.encodeIndices(indices, 2),
        }],
      });
      const content = new ContentManager({ root: 'https://game.test/content/', read: async () => model.slice().buffer });
      await expect(content.loadModel('Q')).rejects.toThrow('need a meshoptDecoder');
      content.meshoptDecoder = (requests) => native.decodeMeshoptBatch(requests);
      const { meshes: [loaded] } = await content.loadModel('Q');
      const mesh = loaded!.mesh;
      expect([mesh.layout, mesh.vertexStride, mesh.vertexCount, [...mesh.data.indices]]).toEqual([layout, 16, 2, [0, 1, 1]]);
      expect(new Uint16Array(mesh.data.vertices.slice().buffer)).toEqual(raw);
      // 量化的位置：包围盒就是反量化的范围
      expect(mesh.bounds).toEqual({ min: [1, 2, 3], max: [5, 6, 7] });
    } finally {
      native.shutdown();
      tools.shutdown();
    }
  });
});

describe('ContentManager', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
  const files = new Map<string, ArrayBuffer>([
    ['https://game.test/content/models/Wall.model', encodeModel({
      materials: ['materials/Grid'],
      meshes: [
        plainMesh('wall', 0, vertices(3), new Uint16Array([0, 1, 2])),
        plainMesh('trim', null, vertices(3), new Uint16Array([0, 1, 2])),
      ],
    }).buffer as ArrayBuffer],
    ['https://game.test/content/materials/Grid.material.json', json({ name: 'Grid', baseColor: [1, 1, 1, 1] } satisfies MaterialFile)],
    ['https://game.test/content/materials/Red.material.json', json({ name: 'Red', baseColor: [1, 0, 0, 1] } satisfies MaterialFile)],
    ['https://game.test/content/scenes/Main.scene.json', json({
      name: 'Main',
      entities: [
        { id: 'root', name: 'Root', parent: null, position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'directional', color: [1, 1, 1], intensity: 5 } } },
        { id: 'wall', name: 'Wall', parent: 'root', position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { model: { model: 'models/Wall', materials: ['materials/Red'] } } },
        { id: 'camera', name: 'Camera', parent: null, position: [0, 3, 10], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { camera: { verticalFieldOfView: 45, nearClipPlane: 0.1, farClipPlane: 1000 } } },
      ],
    } satisfies SceneFile)],
  ]);

  test('场景实例化：父子、多网格拆成子实体、按槽覆盖材质、光源和相机；同一个模型只加载一次', async () => {
    const reads: string[] = [];
    const content = new ContentManager({
      root: 'https://game.test/content/',
      read: async (url) => {
        reads.push(url.href);
        const file = files.get(url.href);
        if (!file) throw new Error(`no ${url.href}`);
        return file;
      },
    });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);

    const scene = await content.loadScene('scenes/Main', game.entities);
    const wall = scene.entities.get('wall')!;
    expect(wall.require(Transform).parent).toBe(scene.entities.get('root'));
    // 第一个网格用覆盖的材质 Red；第二个网格没有材质槽，挂成子实体，用默认材质
    expect(Material.byId(wall.require(Model).material)!.name).toBe('Red');
    expect(Mesh.byId(wall.require(Model).mesh)!.name).toBe('models/Wall/wall');
    const [trim] = wall.require(Transform).children;
    expect(Material.byId(trim!.require(Model).material)).toBe(content.defaultMaterial);
    expect(scene.entities.get('root')!.require(Light).intensity).toBe(5);
    expect(scene.entities.get('camera')!.has(Camera)).toBe(true);

    game.transforms.update();
    expect([...wall.require(Transform).world.subarray(12, 15)]).toEqual([1, 2, 0]);

    await content.loadModel('models/Wall');
    expect(reads.filter((r) => r.endsWith('Wall.model'))).toHaveLength(1);
    await expect(content.loadMaterial('materials/Missing')).rejects.toThrow('no https://game.test/content/materials/Missing.material.json');
  });
});

describe('贴图', () => {
  let native: StrideNative;
  let tools: StrideTools;
  beforeAll(async () => {
    [native, tools] = await Promise.all([createStrideNative({ workerThreads: 1 }), createStrideTools({ workerThreads: 1 })]);
  });
  afterAll(() => {
    native?.shutdown();
    tools?.shutdown();
  });

  const ktx2 = (size: number, srgb: boolean) => tools.encodeBasis(new Uint8Array(size * size * 4).fill(200), size, size, { srgb, mipmaps: true });

  test('KTX2 按设备的转码目标解码，sRGB 标记决定格式；尺寸不是 4 的倍数时退回 RGBA8', async () => {
    const decode = ktx2Decoder(native, { textureTarget: 'bc7' } as GraphicsDevice);
    const color = await decode(await ktx2(16, true));
    expect([color.format, color.width, color.levels.length]).toEqual(['bc7-rgba-unorm-srgb', 16, 5]);
    expect(color.levels[0]!.byteLength).toBe(4 * 4 * 16);
    const linear = await decode(await ktx2(6, false));
    expect([linear.format, linear.levels[0]!.byteLength]).toEqual(['rgba8unorm', 6 * 6 * 4]);
  });

  test('材质引用的贴图经 textureDecoder 加载，uv 变换和运算符带到材质上', async () => {
    const encoded = await ktx2(8, true);
    const files = new Map<string, Uint8Array>([
      ['https://game.test/content/textures/Checker.ktx2', encoded],
      ['https://game.test/content/materials/Grid.material.json', new TextEncoder().encode(JSON.stringify({
        name: 'Grid',
        baseColor: [0.1, 0.2, 0.3, 1],
        baseColorTexture: { texture: 'textures/Checker', scale: [2, 3], offset: [0.5, 0] },
        baseColorOperator: 'add',
      } satisfies MaterialFile))],
    ]);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => files.get(url.href)!.slice().buffer });
    await expect(content.loadMaterial('materials/Grid')).rejects.toThrow('no textureDecoder');
    content.textureDecoder = ktx2Decoder(native, { textureTarget: 'rgba8' } as GraphicsDevice);
    const material = await content.loadMaterial('materials/Grid');
    expect(material.baseColorOperator).toBe('add');
    expect(material.baseColorTexture).toMatchObject({ scale: [2, 3], offset: [0.5, 0] });
    expect(material.baseColorTexture!.texture.data).toMatchObject({ format: 'rgba8unorm-srgb', width: 8, height: 8 });
    expect(await content.loadTexture('textures/Checker')).toBe(material.baseColorTexture!.texture);
  });
});

describe('立方体贴图和天空盒', () => {
  test('立方体贴图文件往返，两种纹素格式；每一级的长度要对得上', () => {
    for (const format of ['rgba16float', 'rgb9e5ufloat'] as const) {
      const texel = CUBEMAP_TEXEL_BYTES[format];
      const levels = [4, 2, 1].map((edge, i) => new Uint8Array(6 * edge * edge * texel).fill(i + 1));
      const decoded = decodeCubemap(encodeCubemap({ size: 4, format, levels }).buffer as ArrayBuffer, 'sky.cubemap');
      expect([decoded.size, decoded.format, decoded.levels.map((l) => l.byteLength), decoded.levels[2]![0]]).toEqual([4, format, [96, 24, 6].map((n) => n * texel), 3]);
    }
    expect(() => encodeCubemap({ size: 4, format: 'rgb9e5ufloat', levels: [new Uint8Array(10)] })).toThrow('cubemap level 0 must hold 6 * 4² rgb9e5ufloat texels');
    expect(() => decodeCubemap(new ArrayBuffer(16), 'x')).toThrow('x is not a cubemap file');
  });

  test('场景里的天空盒光和背景变成 Light（skybox）和 Background；PBR 参数带到材质上', async () => {
    const native = await createStrideNative({ workerThreads: 1 });
    try {
      const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer;
      const cube = (size: number) => encodeCubemap({ size, format: 'rgb9e5ufloat', levels: [new Uint8Array(6 * size * size * 4)] }).buffer as ArrayBuffer;
      const sh = Array.from({ length: 27 }, (_, i) => i);
      const files = new Map<string, ArrayBuffer>([
        ['https://game.test/content/Sky.skybox.json', json({ diffuseSH: sh, radiance: 'SkyTexture', specularSize: 64 } satisfies SkyboxFile)],
        ['https://game.test/content/SkyTexture.cubemap', cube(4)],
        ['https://game.test/content/Metal.material.json', json({ name: 'Metal', baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.2, emissive: [0, 1, 2], cavity: { diffuse: 0.5, specular: 0.75 } } satisfies MaterialFile)],
        ['https://game.test/content/Main.scene.json', json({
          name: 'Main',
          entities: [{ id: 'sky', name: 'Sky', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'skybox', skybox: 'Sky', intensity: 1.5 }, background: { texture: 'SkyTexture', intensity: 3 } } }],
        } satisfies SceneFile)],
      ]);
      const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => files.get(url.href)! });
      const game = new Game();
      game.native = native;
      game.transforms = native.createTransforms(8);
      const scene = await content.loadScene('Main', game.entities);
      const sky = scene.entities.get('sky')!;
      const light = sky.require(Light);
      expect([light.type, light.intensity]).toEqual(['skybox', 1.5]);
      const skybox = Skybox.byId(light.skybox)!;
      expect([skybox.name, skybox.diffuseSH[26], skybox.specularSize, skybox.specularLevels]).toEqual(['Sky', 26, 64, 7]);
      // 天空盒光照和背景用同一张源立方体贴图，只加载一次
      const background = sky.require(Background);
      expect(Cubemap.byId(background.texture)).toBe(skybox.radiance);
      expect([skybox.radiance.data.size, background.intensity]).toEqual([4, 3]);

      const metal = await content.loadMaterial('Metal');
      expect([metal.metalness, metal.roughness, metal.emissive, metal.cavity]).toEqual([1, 0.2, [0, 1, 2], { diffuse: 0.5, specular: 0.75 }]);
      expect([content.defaultMaterial.metalness, content.defaultMaterial.roughness]).toEqual([undefined, 1]);
    } finally {
      native.shutdown();
    }
  });
});
