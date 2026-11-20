import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { texture } from '@stride-ts/native/texture';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assetRef,
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
  LiveScene,
  Instance,
  Instancing,
  Light,
  Material,
  Mesh,
  Model,
  prop,
  SceneDocument,
  Skybox,
  Sprite,
  SpriteSheet,
  SyncScript,
  Transform,
  UndoStack,
  VERTEX_FLOATS,
  type GraphicsDevice,
  type MaterialFile,
  type PrefabFile,
  type SceneFile,
  type SpriteSheetFile,
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
    // 按句柄加载（生成的 assets.gen.ts 里就是这种句柄）：种类在句柄里，和按路径加载的是同一个
    expect(await content.load(assetRef('material', 'materials/Red'))).toBe(await content.loadMaterial('materials/Red'));
    expect((await content.load(assetRef('model', 'models/Wall'))).meshes).toHaveLength(2);
    expect(await content.load(assetRef('scene', 'scenes/Main'))).toEqual({ path: 'scenes/Main' });
    await expect(content.loadMaterial('materials/Missing')).rejects.toThrow('no https://game.test/content/materials/Missing.material.json');
  });

  test('编辑状态的场景（LiveScene）：文档改了以后只动变了的实体，位置和名字直接改、组件按种类重建，加、删、换父实体；实体还是原来的', async () => {
    const content = new ContentManager({
      root: 'https://game.test/content/',
      read: async (url) => {
        const file = files.get(url.href);
        if (!file) throw new Error(`no ${url.href}`);
        return file;
      },
    });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    game.content = content;
    const original = JSON.parse(new TextDecoder().decode(files.get('https://game.test/content/scenes/Main.scene.json')!)) as SceneFile;
    const document = new SceneDocument(original);
    const undo = new UndoStack(document);
    const live = await LiveScene.open(game, document);
    expect(game.rootScene).toBe(live.instance);
    const root = live.entity('root')!, wall = live.entity('wall')!, camera = live.entity('camera')!;
    const count = game.entities.count;

    // 位置和名字直接改：组件没动（网格的子实体还是那个）
    const [trim] = wall.require(Transform).children;
    undo.apply({ type: 'set', entity: 'wall', path: ['position'], value: [0, 5, 0] });
    undo.apply({ type: 'set', entity: 'wall', path: ['name'], value: 'Big wall' });
    await live.sync();
    expect([wall.name, { ...wall.require(Transform).position }, wall.require(Transform).children[0]]).toEqual(['Big wall', { x: 0, y: 5, z: 0 }, trim]);

    // 组件的值变了：那一种组件重建，别的不动；换材质时模型重建，多出来的网格还是一个子实体
    undo.apply({ type: 'set', entity: 'root', path: ['components', 'light', 'intensity'], value: 9 });
    undo.apply({ type: 'set', entity: 'wall', path: ['components', 'model', 'materials'], value: ['materials/Grid'] });
    await live.sync();
    expect(root.require(Light).intensity).toBe(9);
    expect(Material.byId(wall.require(Model).material)!.name).toBe('Grid');
    expect(wall.require(Transform).children).toHaveLength(1);
    expect([live.entity('wall'), live.entity('root'), game.entities.count]).toEqual([wall, root, count]);
    // 点到引擎另建的子实体算点到它挂着的那个
    expect([live.idOf(wall.require(Transform).children[0]!), live.idOf(root), live.idOf(game.entities.create({ name: 'other' }))]).toEqual(['wall', 'root', undefined]);

    // 加实体、去掉一个组件
    const lampFile = { id: 'lamp', name: 'Lamp', parent: 'wall', position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'point', color: [1, 1, 1], intensity: 2, radius: 3 } } } as const;
    undo.apply({ type: 'add', entities: [{ entity: lampFile, index: 3 }] });
    undo.apply({ type: 'set', entity: 'camera', path: ['components', 'camera'], value: undefined });
    await live.sync();
    const lamp = live.entity('lamp')!;
    expect([lamp.require(Transform).parent, lamp.scene, lamp.require(Light).radius, camera.has(Camera), live.idOf(lamp)]).toEqual([wall, live.instance, 3, false, 'lamp']);

    // 换父实体（文档里是删了再加在别处）：还是那个实体
    undo.apply({ type: 'batch', edits: [{ type: 'remove', entities: ['lamp'] }, { type: 'add', entities: [{ entity: { ...lampFile, parent: 'root' }, index: 1 }] }] });
    await live.sync();
    expect([live.entity('lamp'), lamp.require(Transform).parent]).toEqual([lamp, root]);

    // 删一棵子树；连着两次 sync 排队，后一次没事可做
    undo.apply(document.removeSubtree('wall'));
    await Promise.all([live.sync(), live.sync()]);
    expect([wall.alive, live.entity('wall'), lamp.alive, live.idOf(lamp)]).toEqual([false, undefined, true, 'lamp']);

    // 新引用的资源加载不了：sync 报错，实体停在上一次的样子；改回去以后接着用
    undo.apply({ type: 'set', entity: 'root', path: ['components', 'model'], value: { model: 'models/Missing', materials: [] } });
    await expect(live.sync()).rejects.toThrow('no https://game.test/content/models/Missing.model');
    expect(root.has(Model)).toBe(false);
    undo.undo();
    await live.sync();

    // 一路撤销回最初的文档：场景回到加载时的样子
    while (undo.undo());
    await live.sync();
    expect(document.file).toEqual(original);
    const restored = live.entity('wall')!;
    expect([restored.alive, restored.name, restored.require(Transform).parent, Material.byId(restored.require(Model).material)!.name]).toEqual([true, 'Wall', root, 'Red']);
    expect([lamp.alive, live.entity('lamp'), root.require(Light).intensity, camera.has(Camera), game.entities.count]).toEqual([false, undefined, 5, true, count + 1]);
    game.transforms.update();
    expect([...restored.require(Transform).world.subarray(12, 15)]).toEqual([1, 2, 0]);
  });

  test('场景里的脚本：按类名对上 TS 脚本，实体引用换成 id、资源引用换成加载好的资源；找不到的脚本和属性警告后跳过；同类的第二个挂到子实体上', async () => {
    class Follower extends SyncScript.props({
      target: prop.entity().optional(),
      speed: prop.number().default(1),
      keys: prop.list(prop.string()).default([]),
      look: prop.asset('material').optional(),
      next: prop.asset('scene').optional(),
    }) {}
    class Renamed extends SyncScript.props({ value: prop.number().default(0), profiling: prop.bool().default(false).renamedFrom('enabled') }) {}
    const scene: SceneFile = {
      name: 'Scripts',
      entities: [
        { id: 'a', name: 'A', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { scripts: [
          { type: 'MyGame.Ai.Follower', props: { target: { $entity: 'b' }, speed: 3, keys: ['W', 'Up'], look: { $asset: 'materials/Grid', kind: 'material' }, next: { $asset: 'scenes/Other', kind: 'scene' }, notInTs: 1 } },
          { type: 'MyGame.Missing', props: {} },
          { type: 'MyGame.Ai.Follower', props: { speed: 7 } },
          { type: 'MyGame.OldName', props: { value: 7, enabled: true } },
        ] } },
        { id: 'b', name: 'B', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
      ],
    };
    const content = new ContentManager({
      root: 'https://game.test/content/',
      read: async (url) => (url.href.endsWith('Scripts.scene.json') ? json(scene) : files.get(url.href) ?? Promise.reject(new Error(`no ${url.href}`))),
    });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(8);
    game.registry.registerModules({ './ai/Follower.ts': { Follower } });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => void warnings.push(message);
    try {
      const loaded = await content.loadScene('scenes/Scripts', game.entities, { scripts: { 'MyGame.OldName': Renamed } });
      const follower = loaded.entities.get('a')!.require(Follower);
      expect(follower.target).toBe(loaded.entities.get('b')!.id);
      expect(follower.speed).toBe(3);
      expect(follower.keys).toEqual(['W', 'Up']);
      expect(follower.look).toBe(await content.loadMaterial('materials/Grid'));
      // 引用的场景只记路径，不加载（场景之间常常互相引用）
      expect(follower.next).toEqual({ path: 'scenes/Other' });
      expect(loaded.entities.get('a')!.require(Renamed).value).toBe(7);
      // 场景里按旧名字（renamedFrom）存的值也读进来
      expect(loaded.entities.get('a')!.require(Renamed).profiling).toBe(true);
      // 同一个实体上第二个同类脚本挂到子实体上
      const [extra] = loaded.entities.get('a')!.require(Transform).children;
      expect([extra!.name, extra!.require(Follower).speed]).toEqual(['A', 7]);
      // 游戏开在编辑状态时，它加载的场景照建实体、不挂脚本；场景记着是从哪个内容路径加载的
      game.content = content;
      game.editing = true;
      const edited = await game.loadScene('scenes/Scripts');
      expect([edited.entities.get('a')!.scripts.size, edited.entities.get('a')!.require(Transform).children, edited.path]).toEqual([0, [], 'scenes/Scripts']);
      game.editing = false;
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([
      expect.stringContaining('MyGame.Ai.Follower.notInTs is not a prop of the TS script'),
      expect.stringContaining('no TS script named Missing for MyGame.Missing'),
    ]);
  });

  test('脚本属性引用的脚本排在后面也能挂上（同 Stride，TopDownRPG 的 CrateScript 引用同一实体上的 Trigger）；引用不存在的脚本时报错', async () => {
    class Signal extends SyncScript {}
    class Listener extends SyncScript.props({ source: prop.component(() => Signal) }) {}
    const entity = (id: string, scripts: { type: string; props: Record<string, never> | { source: { $entity: string } } }[]) =>
      ({ id, name: id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { scripts } }) as const;
    const scene = (scripts: Parameters<typeof entity>[1]): SceneFile => ({ name: 'Order', entities: [entity('a', scripts)] });
    const load = async (file: SceneFile) => {
      const game = new Game();
      game.native = native;
      game.transforms = native.createTransforms(8);
      game.registry.registerModules({ './Order.ts': { Signal, Listener } });
      const content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(file) });
      return content.loadScene('scenes/Order', game.entities);
    };
    const loaded = await load(scene([{ type: 'G.Listener', props: { source: { $entity: 'a' } } }, { type: 'G.Signal', props: {} }]));
    const a = loaded.entities.get('a')!;
    expect(a.require(Listener).source).toBe(a.require(Signal));
    await expect(load(scene([{ type: 'G.Listener', props: { source: { $entity: 'a' } } }]))).rejects.toThrow(/has no Signal/);
  });

  test('场景的偏移（Stride 的 Scene.Offset）在场景上：实体的世界位置带着它，本地位置不带；可以运行时改；子场景的偏移接在父场景后面', async () => {
    const entity = (id: string, parent: string | null) => ({ id, name: id, parent, position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {} }) as const;
    const scene: SceneFile = { name: 'Chunk', offset: [-20, 0, 5], entities: [entity('root', null), entity('child', 'root')] };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(8);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(scene) });
    const loaded = await content.loadScene('scenes/Chunk', game.entities);
    game.transforms.update();
    const root = loaded.entities.get('root')!, child = loaded.entities.get('child')!;
    const world = (entity: typeof root) => [...entity.require(Transform).world.subarray(12, 15)];
    expect([world(root), world(child)]).toEqual([[-19, 0, 5], [-18, 0, 5]]);
    expect([{ ...root.require(Transform).position }, root.require(Transform).parent]).toEqual([{ x: 1, y: 0, z: 0 }, undefined]);
    expect(child.require(Transform).parent).toBe(root);

    // 运行时改场景的偏移；子场景的偏移接在父场景的后面
    loaded.offset.y = 2;
    const nested = await content.loadScene('scenes/Chunk', game.entities, { parent: loaded, offset: [0, 0, 1] });
    // 运行时放进场景的实体跟着场景的偏移；移出来就不跟了；有父实体的不受影响
    const placed = game.entities.create({ name: 'placed', scene: loaded, components: [Transform.with({ position: [0, 1, 0] })] });
    const later = game.entities.create({ name: 'later', components: [Transform] });
    later.scene = nested;
    game.transforms.update();
    expect([world(root), world(nested.entities.get('root')!), world(placed), world(later)]).toEqual([[-19, 2, 5], [-19, 2, 6], [-20, 3, 5], [-20, 2, 6]]);
    later.scene = undefined;
    child.scene = nested;
    game.transforms.update();
    expect([world(later), world(child)]).toEqual([[0, 0, 0], [-18, 2, 5]]);
    // 从父实体下面拿出来的实体回到它所在场景的根下面
    child.scene = loaded;
    child.require(Transform).parent = undefined;
    game.transforms.update();
    expect(world(child)).toEqual([-19, 2, 5]);

    // 场景的根释放以后，还留着的实体不再带偏移
    nested.root!.dispose();
    loaded.root!.dispose();
    game.transforms.update();
    expect([world(root), world(placed)]).toEqual([[1, 0, 0], [0, 1, 0]]);
  });

  test('模型实例化：实例引用的主实体排在后面也能挂上，主实体带 Instancing；没有主实体的实例是 -1', async () => {
    const entity = (id: string, components: SceneFile['entities'][number]['components']) => ({ id, name: id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components }) as const;
    const scene: SceneFile = { name: 'Instances', entities: [entity('a', { instance: { master: 'm' } }), entity('b', { instance: { master: null } }), entity('m', { instancing: {} })] };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(8);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(scene) });
    const loaded = await content.loadScene('scenes/Instances', game.entities);
    const master = loaded.entities.get('m')!;
    expect(master.has(Instancing)).toBe(true);
    expect(loaded.entities.get('a')!.require(Instance).master).toBe(master.id);
    expect(loaded.entities.get('b')!.require(Instance).master).toBe(-1);
  });

  test('预制体：脚本属性拿到加载好的 Prefab，每次实例化建一组新实体（根实体按顺序返回），预制体里的脚本引用的是这一组的实体', async () => {
    class Label extends SyncScript.props({ target: prop.entity().optional() }) {}
    class Spawner extends SyncScript.props({ prefab: prop.asset('prefab').optional() }) {}
    const entity = (id: string, parent: string | null, components: SceneFile['entities'][number]['components']) =>
      ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components }) as const;
    const prefab: PrefabFile = { name: 'Crate', entities: [entity('crate', null, {}), entity('label', 'crate', { scripts: [{ type: 'Game.Label', props: { target: { $entity: 'crate' } } }] })] };
    const scene: SceneFile = { name: 'Spawning', entities: [entity('spawner', null, { scripts: [{ type: 'Game.Spawner', props: { prefab: { $asset: 'prefabs/Crate', kind: 'prefab' } } }] })] };
    const files: Record<string, unknown> = { 'prefabs/Crate.prefab.json': prefab, 'scenes/Spawning.scene.json': scene };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    game.registry.registerModules({ './Label.ts': { Label }, './Spawner.ts': { Spawner } });
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => json(files[url.pathname.slice('/content/'.length)]) });
    const loaded = await content.loadScene('scenes/Spawning', game.entities);
    const crate = loaded.entities.get('spawner')!.require(Spawner).prefab!;
    expect(crate).toBe(await content.loadPrefab('prefabs/Crate'));
    const [first] = crate.instantiate(game.entities);
    const [second] = crate.instantiate(game.entities);
    expect(first!.id).not.toBe(second!.id);
    const [label] = second!.require(Transform).children;
    expect(label!.require(Label).target).toBe(second!.id);
  });

  test('场景里的预制体实例（docs/prefabs.md）：实例就是预制体的根，成员展开出来、id 拼出来，覆盖照用，引用指向这一组', async () => {
    class Label extends SyncScript.props({ target: prop.entity().optional(), size: prop.number().default(1) }) {}
    const entity = (id: string, parent: string | null, components: SceneFile['entities'][number]['components'], extra = {}) =>
      ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components, ...extra }) as const;
    const prefab: PrefabFile = { name: 'Crate', entities: [entity('crate', null, {}), entity('label', 'crate', { scripts: [{ type: 'Game.Label', props: { target: { $entity: 'crate' }, size: 1 } }] })] };
    const scene: SceneFile = {
      name: 'Instances', entities: [
        entity('a', null, {}, { position: [3, 0, 0], prefab: { path: 'prefabs/Crate', set: [{ entity: 'label', path: ['components', 'scripts', 'Game.Label', 'props', 'size'], value: 5 }] } }),
        entity('b', null, {}, { prefab: { path: 'prefabs/Crate', removed: ['label'] } }),
        entity('extra', 'a/label', {}),
      ],
    };
    const files: Record<string, unknown> = { 'prefabs/Crate.prefab.json': prefab, 'scenes/Instances.scene.json': scene };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    game.registry.registerModules({ './Label.ts': { Label } });
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => json(files[url.pathname.slice('/content/'.length)]) });
    const loaded = await content.loadScene('scenes/Instances', game.entities);
    expect([...loaded.entities.keys()]).toEqual(['a', 'a/label', 'b', 'extra']);
    // 实例就是预制体的根：成员挂在它下面，成员引用的根换成实例；场景里加的实体挂在成员下面
    const label = loaded.entities.get('a/label')!.require(Label);
    expect([label.size, label.target]).toEqual([5, loaded.entities.get('a')!.id]);
    expect(loaded.entities.get('a/label')!.require(Transform).parent).toBe(loaded.entities.get('a'));
    expect(loaded.entities.get('extra')!.require(Transform).parent).toBe(loaded.entities.get('a/label'));
  });

  test('场景模板（SpaceEscape 的 LevelBlocks）：不建实体；模板实体连同子实体实例化成新实体，脚本带着属性；读脚本属性时实体引用换成名字', async () => {
    class Info extends SyncScript.props({ maxObstacles: prop.int().default(0) }) {}
    const entity = (id: string, parent: string | null, components: SceneFile['entities'][number]['components']) =>
      ({ id, name: id, parent, position: [0, 0, 5], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components }) as const;
    const scene: SceneFile = {
      name: 'Blocks',
      entities: [
        entity('generator', null, { scripts: [{ type: 'Game.Generator', props: { block: { $entity: 'block' }, count: 2 } }] }),
        entity('block', null, { scripts: [{ type: 'Game.Info', props: { maxObstacles: 3 } }] }),
        entity('part', 'block', {}),
      ],
    };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    game.registry.registerModules({ './Info.ts': { Info } });
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(scene) });
    const template = await content.loadSceneTemplate('Blocks');
    expect(game.entities.count).toBe(0);
    expect(template.scriptProps('generator', 'Generator')).toEqual({ block: 'block', count: 2 });
    expect(template.scriptProps('block', 'Generator')).toBeUndefined();
    const [first] = template.prefab('block').instantiate(game.entities);
    const [second] = template.prefab('block').instantiate(game.entities);
    expect(first!.id).not.toBe(second!.id);
    expect([first!.name, first!.require(Transform).children.map((child) => child.name), first!.require(Info).maxObstacles]).toEqual(['block', ['part'], 3]);
    expect(game.entities.count).toBe(4);
    expect(() => template.prefab('missing')).toThrow(/no entity named 'missing'/);
  });

  test('换根场景：新场景加载好后销毁旧根场景的实体（连同子实体），另建的实体不动；连着换按顺序来', async () => {
    const sceneFile = (name: string): SceneFile => ({
      name,
      entities: [
        { id: 'root', name: `${name} root`, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
        { id: 'child', name: `${name} child`, parent: 'root', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {} },
      ],
    });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    game.content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => json(sceneFile(url.pathname.split('/').at(-1)!.split('.')[0]!)) });
    const first = await game.setRootScene('scenes/First');
    const spawned = game.entities.create({ name: 'spawned' });
    expect(game.rootScene).toBe(first);
    const [second, third] = await Promise.all([game.setRootScene({ path: 'scenes/Second' }), game.setRootScene('scenes/Third')]);
    expect(game.rootScene).toBe(third);
    expect([...first.entities.values(), ...second!.entities.values()].some((e) => game.entities.isAlive(e.id))).toBe(false);
    expect([...third!.entities.values()].map((e) => e.name)).toEqual(['Third root', 'Third child']);
    expect(game.entities.isAlive(spawned.id)).toBe(true);

    // 子场景（Stride 的 scene.Parent）：带偏移加载；换根场景时跟着父场景一起卸载，自己先卸载的不再管
    const child = await game.loadScene({ path: 'scenes/Child' }, { parent: third, offset: [0, 0.5, 0] });
    const early = await game.loadScene('scenes/Early', { parent: third });
    // 偏移在场景上：实体的本地位置不带，世界位置带；对脚本来说它还是根
    const childRoot = child.entities.get('root')!.require(Transform);
    game.transforms.update();
    expect([{ ...childRoot.position }, { ...child.offset }, [...childRoot.world.subarray(12, 15)], childRoot.parent]).toEqual([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 }, [0, 0.5, 0], undefined]);
    game.unloadScene(early);
    const fourth = await game.setRootScene('scenes/Fourth');
    expect([...child.entities.values(), ...early.entities.values()].some((e) => game.entities.isAlive(e.id))).toBe(false);
    expect([...fourth.entities.values()].every((e) => game.entities.isAlive(e.id))).toBe(true);
  });
});

describe('贴图', () => {
  let native: StrideNative;
  let tools: StrideTools;
  beforeAll(async () => {
    [native, tools] = await Promise.all([createStrideNative({ workerThreads: 1, features: [texture] }), createStrideTools({ workerThreads: 1 })]);
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

  test('精灵表：场景里的精灵引用精灵表和默认帧，同一张源图只解一次；帧号循环取（负数也是）', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const sprite = (name: string, x: number) => ({ name, texture: { texture: 'sheets/Hero/hero', encoding: 'png' as const, srgb: true }, region: [x, 0, 16, 20] as const, pixelsPerUnit: 16, center: [0, 0] as const, centerFromMiddle: true });
    const files = new Map<string, Uint8Array>([
      ['https://game.test/content/sheets/Hero/hero.png', new Uint8Array([1])],
      ['https://game.test/content/sheets/Hero.sheet.json', encode({ name: 'Hero', sprites: [sprite('idle_0', 0), sprite('idle_1', 16), sprite('run_0', 32)] } satisfies SpriteSheetFile)],
      ['https://game.test/content/scenes/Sprites.scene.json', encode({
        name: 'Sprites',
        entities: [{
          id: 'hero', name: 'Hero', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
          components: { sprite: { sheet: 'sheets/Hero', frame: 2, enabled: false, type: 'sprite', color: [1, 1, 1, 1], intensity: 1, isTransparent: true, premultipliedAlpha: true, ignoreDepth: false, isAlphaCutoff: true, blendMode: 'auto', sampler: 'pointClamp' } },
        }],
      } satisfies SceneFile)],
    ]);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => files.get(url.href)!.slice().buffer });
    let decoded = 0;
    content.imageDecoder = async () => {
      decoded++;
      return { format: 'rgba8unorm-srgb', width: 64, height: 32, levels: [new Uint8Array(64 * 32 * 4)] };
    };
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(8);
    const scene = await content.loadScene('scenes/Sprites', game.entities);
    const hero = scene.entities.get('hero')!.require(Sprite);
    expect([hero.frame, hero.enabled, hero.texture]).toEqual([2, false, 0]);
    const sheet = SpriteSheet.byId(hero.sheet)!;
    expect(decoded).toBe(1);
    expect(sheet.sprites.map((s) => s.texture)).toEqual([sheet.sprites[0]!.texture, sheet.sprites[0]!.texture, sheet.sprites[0]!.texture]);
    expect([sheet.frame(3)!.name, sheet.frame(-1)!.name, sheet.indexOf('idle_1')]).toEqual(['idle_0', 'run_0', 1]);
  });

  test('svg、png 的贴图槽交给 imageDecoder：按编码选扩展名，带上栅格化尺寸，颜色贴图是 sRGB', async () => {
    const svg = new TextEncoder().encode('<svg/>');
    const files = new Map<string, Uint8Array>([
      ['https://game.test/content/textures/Grid.svg', svg],
      ['https://game.test/content/materials/Grid.material.json', new TextEncoder().encode(JSON.stringify({
        name: 'Grid',
        baseColor: [1, 1, 1, 1],
        baseColorTexture: { texture: 'textures/Grid', encoding: 'svg', size: [256, 128], scale: [1, 1], offset: [0, 0] },
      } satisfies MaterialFile))],
    ]);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => files.get(url.href)!.slice().buffer });
    await expect(content.loadMaterial('materials/Grid')).rejects.toThrow('no imageDecoder');
    const calls: unknown[] = [];
    content.imageDecoder = async (bytes, options) => {
      calls.push([new TextDecoder().decode(bytes), options]);
      return { format: 'rgba8unorm-srgb', width: 256, height: 128, levels: [new Uint8Array(256 * 128 * 4)], generateMipmaps: true };
    };
    const material = await content.loadMaterial('materials/Grid');
    expect(calls).toEqual([['<svg/>', { encoding: 'svg', srgb: true, size: [256, 128] }]]);
    expect(material.baseColorTexture!.texture.data).toMatchObject({ width: 256, generateMipmaps: true });
  });

  test('材质的自发光贴图、遮蔽贴图、镜面颜色、透明：贴图引用写了 srgb 就按它，没写按用途（遮蔽是线性的）；同一张图按 sRGB 和线性各解一次', async () => {
    const png = (texture: string, srgb?: boolean) => ({ texture, encoding: 'png' as const, ...(srgb === undefined ? {} : { srgb }), scale: [1, 1] as const, offset: [0, 0] as const });
    const files = new Map<string, Uint8Array>([
      ['https://game.test/content/textures/Mask.png', new Uint8Array([1])],
      ['https://game.test/content/textures/Occlusion.png', new Uint8Array([2])],
      ['https://game.test/content/materials/Glow.material.json', new TextEncoder().encode(JSON.stringify({
        name: 'Glow',
        baseColor: [1, 1, 1, 1],
        specular: [0.2, 0.2, 0.2],
        emissive: [5, 9, 50],
        emissiveTexture: png('textures/Mask'),
        ambientOcclusion: { value: 1, texture: { ...png('textures/Mask'), channel: 'a' }, directLighting: 0 },
        transparency: { type: 'blend', alpha: 0.25 },
      } satisfies MaterialFile))],
      ['https://game.test/content/materials/Box.material.json', new TextEncoder().encode(JSON.stringify({
        name: 'Box',
        baseColor: [1, 1, 1, 1],
        ambientOcclusion: { value: 1, texture: { ...png('textures/Occlusion', true), channel: 'r' }, directLighting: 0.5 },
      } satisfies MaterialFile))],
    ]);
    const content = new ContentManager({ root: 'https://game.test/content/', read: async (url) => files.get(url.href)!.slice().buffer });
    const decoded: string[] = [];
    content.imageDecoder = async (bytes, { srgb }) => {
      decoded.push(`${bytes[0]} ${srgb}`);
      return { format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', width: 1, height: 1, levels: [new Uint8Array(4)], generateMipmaps: false };
    };
    const glow = await content.loadMaterial('materials/Glow');
    expect([glow.specular, glow.isTransparent, glow.transparency, glow.emissive]).toEqual([[0.2, 0.2, 0.2], true, { alpha: 0.25, specularAlpha: 0.25, tint: [1, 1, 1] }, [5, 9, 50]]);
    expect(glow.emissiveTexture!.texture.data.format).toBe('rgba8unorm-srgb');
    expect(glow.ambientOcclusion.texture).toMatchObject({ channel: 'a' });
    expect(glow.ambientOcclusion.texture!.texture.data.format).toBe('rgba8unorm');
    const box = await content.loadMaterial('materials/Box');
    expect(box.ambientOcclusion).toMatchObject({ value: 1, directLighting: 0.5 });
    expect(box.ambientOcclusion.texture!.texture.data.format).toBe('rgba8unorm-srgb');
    expect(decoded.sort()).toEqual(['1 false', '1 true', '2 true']);
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
          entities: [{ id: 'sky', name: 'Sky', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'skybox', skybox: 'Sky', intensity: 1.5 }, background: { type: 'cubemap', texture: 'SkyTexture', intensity: 3 } } }],
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
