import { describe, expect, test } from 'vitest';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import { convertInstances, type StrideBase } from '../src/stride/instances.ts';

const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });
const health = (max: number, target: string) => ({ scripts: [{ type: 'Game.Health', props: { max, target: { $entity: target } } }] }) as SceneEntityFile['components'];

// 预制体：body（脚本引用 weapon）下面挂 weapon
const enemy = { entities: [entity('body', null, { components: health(100, 'weapon') }), entity('weapon', 'body')], renamed: new Map<string, string>() };
const prefabs = new Map([['Game/Enemy', enemy]]);

describe('导入时把 Stride 的预制体实例转成引用', () => {
  test('每个根成一个实例；成员换成 实例/预制体里的 id；值不同的成覆盖；场景里引用成员的跟着换', () => {
    // Stride 的场景：两个实例（s1、s2 是身体，w1、w2 是武器），一个实例改了血量；另一个实体的脚本引用 w1；还有一个挂在 w2 下面
    const files = [
      entity('s1', null, { position: [1, 0, 0], components: health(100, 'w1') }),
      entity('w1', 's1', { name: 'weapon' }),
      entity('s2', null, { position: [2, 0, 0], components: health(150, 'w2') }),
      entity('w2', 's2', { name: 'Axe' }),
      entity('hud', null, { components: { scripts: [{ type: 'Game.Hud', props: { weapon: { $entity: 'w1' } } }] } as SceneEntityFile['components'] }),
      entity('gem', 'w2'),
    ];
    const bases = new Map<string, StrideBase>([
      ['s1', { prefab: 'Game/Enemy', part: 'body', instance: 'i1' }],
      ['w1', { prefab: 'Game/Enemy', part: 'weapon', instance: 'i1' }],
      ['s2', { prefab: 'Game/Enemy', part: 'body', instance: 'i2' }],
      ['w2', { prefab: 'Game/Enemy', part: 'weapon', instance: 'i2' }],
    ]);
    const { entities, renamed, failure } = convertInstances(files, bases, prefabs);
    expect(failure).toBeUndefined();
    expect(entities.map((e) => `${e.id}<${e.parent}`)).toEqual(['s1<null', 's2<null', 'hud<null', 'gem<s2/weapon']);
    expect(entities[0]!.prefab).toEqual({ path: 'Game/Enemy' });
    expect(entities[0]!.position).toEqual([1, 0, 0]);
    expect(entities[1]!.prefab).toEqual({
      path: 'Game/Enemy',
      set: [
        { entity: 'body', path: ['components', 'scripts', 'Game.Health', 'props', 'max'], value: 150 },
        { entity: 'weapon', path: ['name'], value: 'Axe' },
      ],
    });
    expect(entities[2]!.components.scripts![0]!.props['weapon']).toEqual({ $entity: 's1/weapon' });
    expect(renamed.get('w1')).toBe('s1/weapon');
  });

  test('预制体里有、场景里没有的成员记成去掉', () => {
    const files = [entity('s1', null, { components: health(100, 'w1') })];
    const bases = new Map<string, StrideBase>([['s1', { prefab: 'Game/Enemy', part: 'body', instance: 'i1' }]]);
    const { entities, failure } = convertInstances(files, bases, prefabs);
    expect(failure).toBeUndefined();
    // 脚本引用的武器去掉了：引用原样留着（指向不存在的实体，和 Stride 文件里的一样）
    expect(entities[0]!.prefab).toMatchObject({ removed: ['weapon'] });
  });

  test('Base 指着预制体里已经没有的实体：当普通实体，实例照常转', () => {
    const files = [entity('s1', null, { components: health(100, 'w1') }), entity('w1', 's1', { name: 'weapon' }), entity('x1', 's1')];
    const bases = new Map<string, StrideBase>([
      ['s1', { prefab: 'Game/Enemy', part: 'body', instance: 'i1' }],
      ['w1', { prefab: 'Game/Enemy', part: 'weapon', instance: 'i1' }],
      ['x1', { prefab: 'Game/Enemy', part: 'gone', instance: 'i1' }],
    ]);
    const { entities, failure } = convertInstances(files, bases, prefabs);
    expect(failure).toBeUndefined();
    expect(entities.map((e) => `${e.id}<${e.parent}`)).toEqual(['s1<null', 'x1<s1']);
    expect(entities[0]!.prefab).toEqual({ path: 'Game/Enemy' });
  });

  test('转不了（实例的根对应预制体里不是根的实体）就整个场景照旧展开着，并说出原因', () => {
    const files = [entity('w1')];
    const bases = new Map<string, StrideBase>([['w1', { prefab: 'Game/Enemy', part: 'weapon', instance: 'i1' }]]);
    const result = convertInstances(files, bases, prefabs);
    expect(result.entities).toBe(files);
    expect(result.failure).toBe('entity w1 is based on weapon, which is not a root of prefab Game/Enemy');
  });
});
