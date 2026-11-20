import { describe, expect, test } from 'vitest';
import type { SceneEntityFile } from '../src/content/format';
import { expandPrefabInstances, memberId, prefabPaths, setPath } from '../src/content/prefabInstances';

const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });

// 敌人：身体（脚本里引用武器）、武器（挂在身体下面）、一盏灯（约束连着身体）
const enemy: SceneEntityFile[] = [
  entity('body', null, { components: { scripts: [{ type: 'Game.Health', props: { max: 100, weapon: { $entity: 'weapon' } } }] } as SceneEntityFile['components'] }),
  entity('weapon', 'body', { components: { model: { model: 'Game/Models/Sword', materials: [null] } } as SceneEntityFile['components'] }),
  entity('lamp', null, { components: { constraints: [{ type: 'ballSocket', enabled: true, bodyA: 'body', bodyB: 'lamp', settings: {} }] } as SceneEntityFile['components'] }),
];

describe('预制体实例的展开', () => {
  test('实例是容器，预制体的根挂在它下面；成员的 id 拼出来，成员之间的引用跟着换', () => {
    const scene = [entity('level'), entity('e1', 'level', { position: [4, 0, 0], prefab: { path: 'Game/Enemy' } })];
    const warnings: string[] = [];
    const out = expandPrefabInstances(scene, new Map([['Game/Enemy', enemy]]), (m) => warnings.push(m));
    expect(out.map((e) => `${e.id}<${e.parent}`)).toEqual(['level<null', 'e1<level', 'e1/body<e1', 'e1/weapon<e1/body', 'e1/lamp<e1']);
    expect(out[1]).not.toHaveProperty('prefab');
    expect(out[1]!.position).toEqual([4, 0, 0]);
    expect(out[2]!.components.scripts![0]!.props['weapon']).toEqual({ $entity: memberId('e1', 'weapon') });
    expect(out[4]!.components.constraints![0]).toMatchObject({ bodyA: 'e1/body', bodyB: 'e1/lamp' });
    expect(warnings).toEqual([]);
    // 预制体本身没被改
    expect(enemy[0]!.components.scripts![0]!.props['weapon']).toEqual({ $entity: 'weapon' });
  });

  test('覆盖：脚本按类型名指，材质槽按下标；去掉的连后代；指不到的跳过并报出来', () => {
    const scene = [entity('e1', null, {
      prefab: {
        path: 'Game/Enemy',
        set: [
          { entity: 'body', path: ['components', 'scripts', 'Game.Health', 'props', 'max'], value: 120 },
          { entity: 'weapon', path: ['components', 'model', 'materials', 0], value: 'Game/Materials/Red' },
          { entity: 'body', path: ['components', 'scripts', 'Game.Mana', 'props', 'max'], value: 5 },
          { entity: 'ghost', path: ['name'], value: 'x' },
        ],
        removed: ['lamp', 'nope'],
      },
    })];
    const warnings: string[] = [];
    const out = expandPrefabInstances(scene, new Map([['Game/Enemy', enemy]]), (m) => warnings.push(m));
    expect(out.map((e) => e.id)).toEqual(['e1', 'e1/body', 'e1/weapon']);
    expect(out[1]!.components.scripts![0]!.props['max']).toBe(120);
    expect(out[2]!.components.model!.materials).toEqual(['Game/Materials/Red']);
    expect(warnings).toEqual([
      'instance e1 of prefab Game/Enemy removes entity nope, which is not in the prefab',
      'instance e1 of prefab Game/Enemy: components.scripts.Game.Mana.props.max does not exist on entity body',
      'instance e1 of prefab Game/Enemy overrides entity ghost, which is not in the prefab',
    ]);
    // 去掉身体：武器跟着去掉
    const withoutBody = expandPrefabInstances([entity('e2', null, { prefab: { path: 'Game/Enemy', removed: ['body'] } })], new Map([['Game/Enemy', enemy]]), () => {});
    expect(withoutBody.map((e) => e.id)).toEqual(['e2', 'e2/lamp']);
  });

  test('嵌套：预制体里的实例一层层展开、id 一层层拼；成环时报错', () => {
    const squad = [entity('leader', null, { prefab: { path: 'Game/Enemy', set: [{ entity: 'body', path: ['name'], value: 'Boss' }] } })];
    const prefabs = new Map<string, readonly SceneEntityFile[]>([['Game/Enemy', enemy], ['Game/Squad', squad]]);
    const out = expandPrefabInstances([entity('s', null, { prefab: { path: 'Game/Squad', set: [{ entity: 'leader/weapon', path: ['name'], value: 'Axe' }] } })], prefabs, () => {});
    expect(out.map((e) => `${e.id}:${e.name}`)).toEqual(['s:s', 's/leader:leader', 's/leader/body:Boss', 's/leader/weapon:Axe', 's/leader/lamp:lamp']);
    expect(prefabPaths([entity('s', null, { prefab: { path: 'Game/Squad' } }), entity('x')])).toEqual(['Game/Squad']);
    const loop = new Map<string, readonly SceneEntityFile[]>([['A', [entity('b', null, { prefab: { path: 'B' } })]], ['B', [entity('a', null, { prefab: { path: 'A' } })]]]);
    expect(() => expandPrefabInstances([entity('x', null, { prefab: { path: 'A' } })], loop, () => {})).toThrow('prefab A contains itself (A -> B -> A)');
  });

  test('没有实例时原样返回；实例和预制体都没变时展开出同一批对象（编辑器改别处时它不重建）', () => {
    const plain = [entity('a')];
    expect(expandPrefabInstances(plain, new Map(), () => {})).toBe(plain);
    const instance = entity('e1', null, { prefab: { path: 'Game/Enemy' } });
    const prefabs = new Map([['Game/Enemy', enemy]]);
    const first = expandPrefabInstances([instance], prefabs, () => {});
    const second = expandPrefabInstances([instance, entity('other')], prefabs, () => {});
    expect(second[1]).toBe(first[1]);
    // 预制体换了：重新展开
    const changed = expandPrefabInstances([instance], new Map([['Game/Enemy', enemy.slice(0, 2)]]), () => {});
    expect(changed.map((e) => e.id)).toEqual(['e1', 'e1/body', 'e1/weapon']);
  });

  test('setPath：不改原对象；路径走不通时是 undefined', () => {
    const e = enemy[1]!;
    expect(setPath(e, ['position', 1], 2)!.position).toEqual([0, 2, 0]);
    expect(e.position).toEqual([0, 0, 0]);
    expect(setPath(e, ['components', 'light', 'intensity'], 1)).toBeUndefined();
  });
});
