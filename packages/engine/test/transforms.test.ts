import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { component, Game, prop, SyncScript, system, tag, Transform, transformSlot, type Entity, type EntityId, type TransformColumns } from '../src/index';

// Transform 的数据在原生内存里：测试直接加载 stride-native（Node 里也是多线程的 wasm）
let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1, features: [physics] });
});

afterAll(() => native?.shutdown());

/** 带原生变换存储、但不跑帧循环的游戏；每个测试一个新存储。 */
function createGame(maxTransforms = 64): Game {
  const game = new Game();
  game.native = native;
  game.transforms = native.createTransforms(maxTransforms);
  return game;
}

const translation = (entity: Entity) => [...entity.require(Transform).world.subarray(12, 15)];
const near = (actual: readonly number[], expected: readonly number[]) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 4));
const Health = component({ current: 100 });

describe('Transform', () => {
  test('取值写进原生存储；视图直接读写，update 后得到世界矩阵', () => {
    const game = createGame();
    const box = game.entities.create({ components: [Transform.with({ position: [1, 2, 3], scale: [2, 2, 2] })] });
    const transform = box.require(Transform);
    expect([transform.position.x, transform.position.y, transform.position.z]).toEqual([1, 2, 3]);
    expect([transform.rotation.w, transform.scale.y]).toEqual([1, 2]);

    transform.position.y = 5;
    expect(game.transforms.position[transformSlot(box) * 3 + 1]).toBe(5);
    game.transforms.update();
    near(translation(box), [1, 5, 3]);
    expect(transform.world[0]).toBeCloseTo(2);
  });

  test('父子层级：世界矩阵按父节点组合，子实体列表、环和去掉组件都有检查', () => {
    const game = createGame();
    const s = Math.SQRT1_2;
    const root = game.entities.create({ name: 'root', components: [Transform.with({ position: [10, 0, 0], rotation: [0, s, 0, s] })] });
    const child = game.entities.create({ name: 'child', components: [Transform.with({ position: [1, 0, 0] })] });
    child.require(Transform).parent = root;
    expect(child.require(Transform).parent).toBe(root);
    expect(root.require(Transform).children).toEqual([child]);

    game.transforms.update();
    // 子实体的 (1, 0, 0) 绕 Y 转 90° 成 (0, 0, -1)
    near(translation(child), [10, 0, -1]);

    expect(() => (root.require(Transform).parent = child)).toThrow('descendant of itself');
    expect(() => root.remove(Transform)).toThrow('has 1 child entities');
    expect(() => (child.require(Transform).parent = game.entities.create({ components: [Health] }))).toThrow('has no Transform');

    child.require(Transform).parent = undefined;
    expect(root.require(Transform).children).toEqual([]);
    root.remove(Transform);
    expect(root.has(Transform)).toBe(false);
  });

  test('updateWorldMatrix 现在就算出这个实体和祖先的世界矩阵（Stride 的 UpdateWorldMatrix）', () => {
    const game = createGame();
    const parent = game.entities.create({ components: [Transform.with({ position: [10, 0, 0] })] });
    const child = game.entities.create({ components: [Transform.with({ position: [0, 2, 0] })] });
    child.require(Transform).parent = parent;
    const transform = child.require(Transform);
    expect(transform.world[12]).toBe(0);
    transform.updateWorldMatrix();
    expect([transform.world[12], transform.world[13]]).toEqual([10, 2]);
    expect(parent.require(Transform).world[12]).toBe(10);
  });

  test('localMatrix、setLocalMatrix 在本地位置、旋转、缩放和矩阵之间来回换（Stride 的 LocalMatrix、Decompose）', () => {
    const game = createGame();
    const s = Math.SQRT1_2;
    const entity = game.entities.create({ components: [Transform.with({ position: [1, 2, 3], rotation: [0, s, 0, s], scale: [2, 2, 2] })] });
    const transform = entity.require(Transform);
    const local = transform.localMatrix();
    // 绕 Y 转 90° 再放大 2 倍：本地 +X 变成 -Z 方向、长 2
    expect([local[0], local[2], local[12], local[13], local[14]].map((v) => +v!.toFixed(5) + 0)).toEqual([0, -2, 1, 2, 3]);
    const other = game.entities.create({ components: [Transform.with({})] }).require(Transform);
    other.setLocalMatrix(local);
    expect([other.position.x, other.position.y, other.position.z, other.scale.y]).toEqual([1, 2, 3, 2]);
    expect(other.rotation.y).toBeCloseTo(s, 6);
    expect(other.rotation.w).toBeCloseTo(s, 6);
  });

  test('销毁父实体时子孙实体一起销毁，槽位回收', () => {
    const game = createGame(4);
    const [a, b, c] = ['a', 'b', 'c'].map((name) => game.entities.create({ name, components: [Transform] }));
    b!.require(Transform).parent = a;
    c!.require(Transform).parent = b;
    a!.destroy();
    expect([a, b, c].map((e) => e!.alive)).toEqual([false, false, false]);
    // 3 个槽位都回收了：再建 4 个正好用满
    for (let i = 0; i < 4; i++) game.entities.create({ components: [Transform] });
    expect(() => game.entities.create({ components: [Transform] })).toThrow('capacity 4 reached');
  });

  test('系统按槽位读写原生列；实体搬表后槽位和取值不变', () => {
    const game = createGame();
    const batch = game.entities.spawn(10, [Transform]);
    const lift = system({
      with: { transform: Transform },
      update({ transform, count }) {
        const columns: TransformColumns = transform;
        for (let i = 0; i < count; i++) {
          const y = columns.slot[i]! * 3 + 1;
          columns.position[y] = columns.position[y]! + 1;
        }
      },
    });
    game.entities.addSystems(lift);
    game.updateTime.advance(1 / 60);
    game.entities.update(game.updateTime);

    const moved = game.entities.entity(batch.ids[3]!);
    const slot = transformSlot(moved);
    moved.add(Health);
    expect(transformSlot(moved)).toBe(slot);
    expect(moved.require(Transform).position.y).toBe(1);
    game.entities.update(game.updateTime);
    expect(moved.require(Transform).position.y).toBe(2);
  });

  test('物理世界绑定实体的槽位：步进后位姿直接写回 Transform', () => {
    const game = createGame();
    using world = native.createPhysicsWorld(8, { transforms: game.transforms });
    world.addBox({ position: [0, -1, 0], halfExtent: [50, 1, 50], motion: 'static' });
    const box = game.entities.create({ components: [Transform.with({ position: [0, 5, 0] })] });
    world.addBox({ halfExtent: [0.5, 0.5, 0.5], transform: transformSlot(box) });
    for (let i = 0; i < 180; i++) world.step(1 / 60);
    expect(box.require(Transform).position.y).toBeCloseTo(0.5, 1);
  });

  test('没有原生存储时给出说明', () => {
    const game = new Game();
    expect(() => game.entities.create({ components: [Transform] })).toThrow('after Game.run has loaded the native module');
  });
});

describe('克隆实体（Stride 的 Entity.Clone）', () => {
  const Aim = component({ target: prop.entity().default(-1 as EntityId), spread: prop.vec3().default([0, 0, 0]) });
  /** 只有运行时状态：系统挂的，克隆时不抄。 */
  const Handle = component({ handle: prop.u32().default(0).transient() });
  const Marked = tag();
  class Partner extends SyncScript.props({ label: 'none' }) {}
  class Follower extends SyncScript.props({
    target: prop.entity().optional(),
    speed: prop.number().default(1).stat(),
    path: prop.list(prop.object({ at: prop.vec3(), stop: prop.entity().optional() })).default([]),
    partner: prop.component(() => Partner).optional(),
    cooldown: prop.number().default(0).transient(),
  }) {
    notes: string[] = [];
    owner: Entity | undefined;
    override cloneFrom(source: this, cloneOf: (entity: Entity) => Entity): void {
      this.notes = [...source.notes];
      this.owner = source.owner && cloneOf(source.owner);
    }
  }

  test('连同子实体再建一份：组件和脚本属性照抄现在的值，子树里的引用换成克隆的，子树外的照旧；根没有父实体', () => {
    const game = createGame();
    const outside = game.entities.create({ name: 'outside', components: [Transform] });
    const root = game.entities.create({ name: 'root', components: [Transform.with({ position: [1, 2, 3] }), Health, Marked] });
    const child = game.entities.create({ name: 'child', components: [Transform.with({ position: [0, 1, 0], scale: [2, 2, 2] }), Handle.with({}), Partner.with({ label: 'p' })] });
    root.require(Transform).parent = outside;
    child.require(Transform).parent = root;
    child.add(Aim.with({ target: root.id, spread: [1, 2, 3] }));
    root.add(Follower.with({ target: child.id, speed: 4, path: [{ at: [1, 0, 0], stop: child.id }, { at: [2, 0, 0], stop: outside.id }], partner: child.require(Partner) }));
    // 克隆抄的是现在的值，不是创建时的
    root.require(Health).current = 40;
    root.require(Transform).position.x = 9;
    child.require(Handle).handle = 7;
    const follower = root.require(Follower);
    follower.stats.speed.multiply(10);
    follower.cooldown = 3;
    follower.notes.push('seen');
    follower.owner = child;
    follower.enabled = false;

    const clone = root.clone();
    const [cloneChild] = clone.require(Transform).children;
    expect([clone.name, cloneChild!.name]).toEqual(['root', 'child']);
    expect(clone.require(Transform).parent).toBeUndefined();
    expect({ ...clone.require(Transform).position }).toEqual({ x: 9, y: 2, z: 3 });
    expect(cloneChild!.require(Transform).scale.y).toBe(2);
    expect([clone.require(Health).current, clone.has(Marked)]).toEqual([40, true]);
    // 数据组件里的实体引用；只有运行时状态的组件不抄
    expect(cloneChild!.require(Aim).target).toBe(clone.id);
    expect({ ...cloneChild!.require(Aim).spread }).toEqual({ x: 1, y: 2, z: 3 });
    expect(cloneChild!.has(Handle)).toBe(false);
    // 脚本：属性（含嵌套的引用、组件引用）、stat 的基础值、enabled；transient 的属性取默认值；cloneFrom 抄属性以外的
    const copy = clone.require(Follower);
    expect(copy).not.toBe(follower);
    expect(copy.target).toBe(cloneChild!.id);
    expect(copy.path.map((p) => [p.at.x, p.stop])).toEqual([[1, cloneChild!.id], [2, outside.id]]);
    expect(copy.path[0]!.at).not.toBe(follower.path[0]!.at);
    expect(copy.partner).toBe(cloneChild!.require(Partner));
    expect([copy.speed, follower.speed, copy.cooldown, copy.enabled]).toEqual([4, 40, 0, false]);
    expect([copy.notes, copy.owner]).toEqual([['seen'], cloneChild]);
    // 原来的不受影响
    expect([root.require(Transform).children.length, follower.target]).toEqual([1, child.id]);
  });

  test('onClone：系统拿到这次克隆的每一对实体，给克隆补上自己挂的运行时状态', () => {
    const game = createGame();
    const root = game.entities.create({ name: 'root', components: [Transform, Handle.with({})] });
    const child = game.entities.create({ name: 'child', components: [Transform] });
    child.require(Transform).parent = root;
    const seen: string[][] = [];
    const stop = game.entities.onClone((clones) => {
      seen.push([...clones].map(([source, clone]) => `${source.name}:${source.id !== clone.id}`));
      for (const [source, clone] of clones) if (source.has(Handle)) clone.add(Handle.with({}));
    });
    const clone = root.clone();
    expect(seen).toEqual([['root:true', 'child:true']]);
    expect(clone.has(Handle)).toBe(true);
    stop[Symbol.dispose]();
    root.clone();
    expect(seen).toHaveLength(1);
  });
});

describe('实体所在的场景（Stride 的 Entity.Scene）', () => {
  test('运行时建的实体放进场景后随场景卸载；没放进去的跟着父实体，根实体不动', () => {
    const game = createGame();
    const scene = { name: 'Level', entities: new Map<string, Entity>() };
    const fromFile = game.entities.create({ name: 'fromFile', scene, components: [Transform] });
    const child = game.entities.create({ name: 'child', components: [Transform] });
    child.require(Transform).parent = fromFile;
    const loose = game.entities.create({ name: 'loose', components: [Transform] });
    const placed = fromFile.clone();
    expect([fromFile.scene, child.scene, loose.scene, placed.scene]).toEqual([scene, scene, undefined, undefined]);
    placed.scene = fromFile.scene;
    expect(game.entities.inScene(scene).map((entity) => entity.name)).toEqual(['fromFile', 'fromFile']);

    game.unloadScene(scene);
    expect([fromFile.alive, child.alive, placed.alive, loose.alive]).toEqual([false, false, false, true]);
  });
});
