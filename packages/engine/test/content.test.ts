import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Camera, ContentManager, decodeModel, encodeModel, Game, ktx2Decoder, Light, Material, Mesh, Model, Transform, VERTEX_FLOATS, type GraphicsDevice, type MaterialFile, type SceneFile } from '../src/index';

// 内容格式和加载：不碰 GPU。读文件换成从内存里的 Map 取。

const vertices = (count: number, x = 0) => {
  const data = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) data.set([x + v, 0, 0, 0, 1, 0, v / count, 0], v * VERTEX_FLOATS);
  return data;
};

describe('模型文件', () => {
  test('编码再解码，网格、索引格式和材质槽原样还原', () => {
    const bytes = encodeModel({
      materials: ['materials/Grid', null],
      meshes: [
        { name: 'a', material: 0, vertices: vertices(3), indices: new Uint16Array([0, 1, 2]) },
        { name: 'b', material: null, vertices: vertices(4, 10), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
      ],
    });
    const model = decodeModel(bytes.buffer as ArrayBuffer);
    expect(model.materials).toEqual(['materials/Grid', null]);
    expect(model.meshes.map((m) => [m.name, m.material, m.vertices.length / VERTEX_FLOATS, m.indices.constructor.name])).toEqual([
      ['a', 0, 3, 'Uint16Array'],
      ['b', null, 4, 'Uint32Array'],
    ]);
    expect(model.meshes[1]!.vertices[0]).toBe(10);
    expect([...model.meshes[1]!.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(() => decodeModel(new ArrayBuffer(16))).toThrow('not a model file');
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
        { name: 'wall', material: 0, vertices: vertices(3), indices: new Uint16Array([0, 1, 2]) },
        { name: 'trim', material: null, vertices: vertices(3), indices: new Uint16Array([0, 1, 2]) },
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
