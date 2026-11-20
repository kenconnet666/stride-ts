import { describe, expect, test } from 'vitest';
import type { SceneEntityFile, SceneFile } from '../src/content/format';
import { expandPrefabInstances } from '../src/content/prefabInstances';
import { copyEntities, duplicateEntities, pasteEntities, positionAfter } from '../src/editor/copyEntities';
import { SceneDocument, UndoStack } from '../src/editor/SceneDocument';

type Components = SceneEntityFile['components'];
const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });

// 敌人：身体下面挂武器，武器的 nodeLink 指着身体
const enemy: SceneEntityFile[] = [
  entity('body'),
  entity('weapon', 'body', { components: { nodeLink: { target: 'body', nodeName: 'hand' } } as Components }),
];
const prefabs = new Map([['Game/Enemy', enemy]]);

/** 计数的 id：p1、p2…… */
const counter = () => {
  let n = 0;
  return () => `p${++n}`;
};

const scene = (): SceneFile => ({
  name: 'Level',
  entities: [
    entity('a'),
    // b 的脚本指着 c（子树里面）和 a（子树外面），约束指着 c
    entity('b', 'a', { components: { scripts: [{ type: 'Game.Follow', props: { target: { $entity: 'c' }, home: { $entity: 'a' } } }], constraints: [{ type: 'ballSocket', bodyA: 'c' }] } as unknown as Components }),
    entity('c', 'b', { position: [1, 2, 3] }),
    entity('d', 'a'),
    // 实例 e1：武器改了名字，覆盖指着场景里的 c；成员 weapon 下面挂着文档实体 g
    entity('e1', null, { prefab: { path: 'Game/Enemy', set: [{ entity: 'weapon', path: ['components', 'nodeLink', 'target'], value: 'c' }, { entity: 'weapon', path: ['name'], value: 'c' }] } }),
    entity('g', 'e1/weapon'),
  ],
});

const ids = (entities: readonly SceneEntityFile[]) => entities.map((e) => e.id);

describe('复制、粘贴实体', () => {
  test('复制子树（祖孙都选中时只算最上面的），粘贴换新 id；子树里的引用跟着换，子树外的照旧；名字、本地变换不变', () => {
    const file = scene();
    const copied = copyEntities(file, prefabs, ['c', 'b']);
    expect(ids(copied)).toEqual(['b', 'c']);
    const { edit, roots } = pasteEntities(file, copied, { parent: null, position: Infinity }, counter());
    expect(roots).toEqual(['p1']);
    const document = new SceneDocument(file);
    document.apply(edit);
    expect(ids(document.file.entities)).toEqual(['a', 'b', 'c', 'd', 'e1', 'g', 'p1', 'p2']);
    const [b, c] = [document.entity('p1')!, document.entity('p2')!];
    expect([b.parent, b.name, c.parent, c.position]).toEqual([null, 'b', 'p1', [1, 2, 3]]);
    expect(b.components.scripts![0]!.props).toEqual({ target: { $entity: 'p2' }, home: { $entity: 'a' } });
    expect(b.components.constraints![0]!.bodyA).toBe('p2');
    // 原来的没动
    expect(document.entity('b')).toBe(file.entities[1]);
  });

  test('粘贴到兄弟里的第几个；撤销一步回去；父实体不在文档里（也不是文档里的实例的成员）时报错', () => {
    const file = scene();
    const document = new SceneDocument(file);
    const undo = new UndoStack(document);
    const copied = copyEntities(file, prefabs, ['d']);
    undo.apply(pasteEntities(document.file, copied, { parent: 'a', position: positionAfter(document.file, document.entity('b')!) }, counter()).edit);
    expect(document.children('a').map((e) => e.id)).toEqual(['b', 'p1', 'd']);
    // 子树连着：插在 b 的后代后面
    expect(ids(document.file.entities)).toEqual(['a', 'b', 'c', 'p1', 'd', 'e1', 'g']);
    undo.undo();
    expect(document.file).toEqual(file);
    expect(() => pasteEntities(file, copied, { parent: 'nope', position: 0 })).toThrow(/no entity nope/);
    expect(() => pasteEntities(file, copied, { parent: 'a/weapon', position: 0 })).toThrow(/no entity a\/weapon/);
  });

  test('复制实例还是引用加覆盖：成员不拷，挂在成员下面的文档实体跟着；覆盖里指着拷贝的引用跟着换', () => {
    const file = scene();
    const copied = copyEntities(file, prefabs, ['e1', 'c']);
    expect(ids(copied)).toEqual(['c', 'e1', 'g']);
    const { edit, roots } = pasteEntities(file, copied, { parent: null, position: Infinity }, counter());
    expect(roots).toEqual(['p1', 'p2']);
    const document = new SceneDocument(file);
    document.apply(edit);
    const instance = document.entity('p2')!;
    expect(instance.prefab).toEqual({ path: 'Game/Enemy', set: [{ entity: 'weapon', path: ['components', 'nodeLink', 'target'], value: 'p1' }, { entity: 'weapon', path: ['name'], value: 'c' }] });
    expect(document.entity('p3')!.parent).toBe('p2/weapon');
    const expanded = expandPrefabInstances(document.file.entities, prefabs, (message) => { throw new Error(message); });
    const weapon = expanded.find((e) => e.id === 'p2/weapon')!;
    expect([weapon.parent, weapon.name, weapon.components.nodeLink!.target]).toEqual(['p2', 'c', 'p1']);
  });

  test('复制实例的成员：拷展开以后的样子（成了普通实体），挂在它下面的文档实体跟着', () => {
    const file = scene();
    const copied = copyEntities(file, prefabs, ['e1/weapon']);
    expect(ids(copied)).toEqual(['e1/weapon', 'g']);
    const document = new SceneDocument(file);
    document.apply(pasteEntities(file, copied, { parent: null, position: Infinity }, counter()).edit);
    const [weapon, g] = [document.entity('p1')!, document.entity('p2')!];
    expect([weapon.prefab, weapon.parent, weapon.name, weapon.components.nodeLink!.target, g.parent]).toEqual([undefined, null, 'c', 'c', 'p1']);
  });

  test('复制一份：每个选中的放在原来的后面、同一个父实体下（实例的成员放在文档兄弟的最前面），一步撤销', () => {
    const file = scene();
    const document = new SceneDocument(file);
    const { edit, roots } = duplicateEntities(file, prefabs, ['b', 'd', 'e1/weapon'], counter());
    expect(roots).toEqual(['p1', 'p3', 'p4']);
    const undo = new UndoStack(document);
    undo.apply(edit);
    expect(document.children('a').map((e) => e.id)).toEqual(['b', 'p1', 'd', 'p3']);
    expect(document.children('e1').map((e) => e.id)).toEqual(['p4']);
    expect(document.entity('p2')!.parent).toBe('p1');
    undo.undo();
    expect(document.file).toEqual(file);
  });

  test('粘贴到实例的成员下面：文档里的普通实体，父实体写成员的 id，展开时挂在成员上', () => {
    const file = scene();
    const document = new SceneDocument(file);
    const { edit, roots } = pasteEntities(file, copyEntities(file, prefabs, ['b']), { parent: 'e1/body', position: Infinity }, counter());
    document.apply(edit);
    expect(roots).toEqual(['p1']);
    // 成员下面还没有文档实体：紧跟实例
    expect(ids(document.file.entities)).toEqual(['a', 'b', 'c', 'd', 'e1', 'p1', 'p2', 'g']);
    const expanded = expandPrefabInstances(document.file.entities, prefabs, (message) => { throw new Error(message); });
    expect(expanded.find((e) => e.id === 'p1')!.parent).toBe('e1/body');
    // 复制一份挂在成员下面的实体：还在这个成员下面，排在原来的后面
    const twice = duplicateEntities(document.file, prefabs, ['p1'], () => 'q' + Math.random().toString(36).slice(2, 6));
    document.apply(twice.edit);
    expect(document.file.entities.filter((e) => e.parent === 'e1/body').map((e) => e.id)).toEqual(['p1', twice.roots[0]]);
  });
});
