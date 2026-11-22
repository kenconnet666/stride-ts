import { describe, expect, test } from 'vitest';
import type { SceneEntityFile, SceneFile } from '../src/content/formats/format';
import { expandPrefabInstances } from '../src/content/prefabInstances';
import { SceneDocument } from '../src/editor/SceneDocument';
import { instanceMember, toDocumentEdit } from '../src/editor/prefabEdits';

const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });

// 敌人：身体（血量脚本）下面挂武器（模型，一个材质槽）
const enemy: SceneEntityFile[] = [
  entity('body', null, { components: { scripts: [{ type: 'Game.Health', props: { max: 100 } }, { type: 'Game.Mana', props: { max: 5 } }] } as SceneEntityFile['components'] }),
  entity('weapon', 'body', { components: { model: { model: 'Game/Models/Sword', materials: [null] } } as SceneEntityFile['components'] }),
];
const prefabs = new Map([['Game/Enemy', enemy]]);
const scene = (prefab: SceneEntityFile['prefab'] = { path: 'Game/Enemy' }): SceneFile =>
  ({ name: 'Level', entities: [entity('e1', null, { prefab }), entity('plain')] }) as SceneFile;

/** 在展开的场景上做 edit（换成文档上的修改），返回改完的文档和展开的实体。 */
function edit(file: SceneFile, ...edits: Parameters<typeof toDocumentEdit>[2][]) {
  const document = new SceneDocument(file);
  for (const one of edits) document.apply(toDocumentEdit(document.file, prefabs, one));
  return { file: document.file, expanded: expandPrefabInstances(document.file.entities, prefabs, () => {}) };
}

describe('编辑器里改预制体的实例', () => {
  test('成员和根的组件成覆盖（脚本的下标换成类型名）；实例自己的名字、变换照常改；普通实体不动', () => {
    const { file, expanded } = edit(
      scene(),
      { type: 'set', entity: 'e1/weapon', path: ['components', 'model', 'materials', 0], value: 'Game/Materials/Red' },
      { type: 'set', entity: 'e1', path: ['components', 'scripts', 1, 'props', 'max'], value: 9 },
      { type: 'set', entity: 'e1', path: ['position'], value: [3, 0, 0] },
      { type: 'set', entity: 'plain', path: ['name'], value: 'Floor' },
    );
    expect(file.entities[0]!.prefab).toEqual({
      path: 'Game/Enemy',
      set: [
        { entity: 'weapon', path: ['components', 'model', 'materials', 0], value: 'Game/Materials/Red' },
        { entity: 'body', path: ['components', 'scripts', 'Game.Mana', 'props', 'max'], value: 9 },
      ],
    });
    expect(file.entities[0]!.position).toEqual([3, 0, 0]);
    expect(file.entities[1]!.name).toBe('Floor');
    expect(expanded[1]!.components.model!.materials).toEqual(['Game/Materials/Red']);
  });

  test('同一处再改换掉原来的覆盖，改回预制体的值去掉覆盖（都去掉了就没有 set）', () => {
    const first = edit(scene(), { type: 'set', entity: 'e1/weapon', path: ['name'], value: 'Axe' }, { type: 'set', entity: 'e1/weapon', path: ['name'], value: 'Club' });
    expect(first.file.entities[0]!.prefab!.set).toEqual([{ entity: 'weapon', path: ['name'], value: 'Club' }]);
    const back = edit(first.file, { type: 'set', entity: 'e1/weapon', path: ['name'], value: 'weapon' });
    expect(back.file.entities[0]!.prefab).toEqual({ path: 'Game/Enemy' });
  });

  test('加、去掉列表的一项是整个列表的覆盖，之后改列表里的值改进这条覆盖', () => {
    const { file, expanded } = edit(
      scene(),
      { type: 'set', entity: 'e1', path: ['components', 'scripts', 0], value: undefined },
      { type: 'set', entity: 'e1', path: ['components', 'scripts', 0, 'props', 'max'], value: 7 },
    );
    expect(file.entities[0]!.prefab!.set).toEqual([{ entity: 'body', path: ['components', 'scripts'], value: [{ type: 'Game.Mana', props: { max: 7 } }] }]);
    expect(expanded[0]!.components.scripts).toEqual([{ type: 'Game.Mana', props: { max: 7 } }]);
  });

  test('一步里改同一个实例的几处（拖操纵器的 batch）都留下；能撤销回去', () => {
    const document = new SceneDocument(scene());
    const inverse = document.apply(toDocumentEdit(document.file, prefabs, {
      type: 'batch',
      edits: [
        { type: 'set', entity: 'e1/weapon', path: ['position'], value: [0, 1, 0] },
        { type: 'set', entity: 'e1/weapon', path: ['scale'], value: [2, 2, 2] },
      ],
    }));
    expect(document.file.entities[0]!.prefab!.set!.map((override) => override.path[0])).toEqual(['position', 'scale']);
    document.apply(inverse);
    expect(document.file.entities[0]!.prefab).toEqual({ path: 'Game/Enemy' });
  });

  test('改一个成员的位置：别的成员、它的组件还是上一次展开的对象（游戏里只动变了的）', () => {
    const before = edit(scene()).expanded;
    const after = edit(scene(), { type: 'set', entity: 'e1/weapon', path: ['position'], value: [0, 2, 0] }).expanded;
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.components).toBe(before[1]!.components);
    expect(after[1]!.rotation).toBe(before[1]!.rotation);
  });

  test('删成员记进 removed，和文档实体一起删是一步；实例自己也删了的不记', () => {
    const file = { ...scene(), entities: [...scene().entities, entity('gem', 'e1/weapon')] } as SceneFile;
    const { file: after, expanded } = edit(file, { type: 'remove', entities: ['e1/weapon', 'gem'] });
    expect(after.entities.map((e) => e.id)).toEqual(['e1', 'plain']);
    expect(after.entities[0]!.prefab).toEqual({ path: 'Game/Enemy', removed: ['weapon'] });
    expect(expanded.map((e) => e.id)).toEqual(['e1', 'plain']);
    expect(toDocumentEdit(file, prefabs, { type: 'remove', entities: ['e1', 'e1/weapon', 'gem'] })).toEqual({ type: 'remove', entities: ['e1', 'gem'] });
  });

  test('instanceMember：实例的根、成员（嵌套的拼了几层）、普通实体', () => {
    const file = scene();
    expect(instanceMember(file, prefabs, 'e1')).toMatchObject({ member: 'body' });
    expect(instanceMember(file, prefabs, 'e1/weapon')).toMatchObject({ member: 'weapon' });
    expect(instanceMember(file, prefabs, 'e1/leader/weapon')).toMatchObject({ member: 'leader/weapon' });
    expect(instanceMember(file, prefabs, 'plain')).toBeUndefined();
  });
});
