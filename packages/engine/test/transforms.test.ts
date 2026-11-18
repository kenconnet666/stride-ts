import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { physics } from '@stride-ts/native/physics';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { component, Game, system, Transform, transformSlot, type Entity, type TransformColumns } from '../src/index';

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
