import { describe, expect, test } from 'vitest';
import type { SceneEntityFile, SceneFile } from '../src/content/formats/format';
import { changedEntities } from '../src/content/SceneBuilder';
import { SceneDocument, UndoStack } from '../src/editor/SceneDocument';

const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id.toUpperCase(), parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });

const scene = (): SceneFile => ({
  name: 'Test',
  entities: [
    entity('a', null, { components: { light: { type: 'directional', color: [1, 1, 1], intensity: 1 } } as SceneEntityFile['components'] }),
    entity('b', 'a', { components: { scripts: [{ type: 'Game.Spin', props: { speed: 2 } }] } as SceneEntityFile['components'] }),
    entity('c', 'b'),
  ],
});

describe('场景文档（SceneDocument）', () => {
  test('改一条路径上的值：得到新的文件，没动的实体还是原来的对象；返回的修改能撤回去', () => {
    const document = new SceneDocument(scene());
    const before = document.file;
    const inverse = document.apply({ type: 'set', entity: 'a', path: ['components', 'light', 'intensity'], value: 3 });
    expect(document.get('a', ['components', 'light', 'intensity'])).toBe(3);
    expect(before.entities[0]!.components.light!.intensity).toBe(1);
    expect(changedEntities(before.entities, document.file.entities)).toEqual({ added: [], removed: [], changed: [[before.entities[0], document.entity('a')]] });
    expect(changedEntities(before.entities, before.entities).changed).toEqual([]);
    expect(document.file.entities[1]).toBe(before.entities[1]);
    expect(inverse).toEqual({ type: 'set', entity: 'a', path: ['components', 'light', 'intensity'], value: 1 });
    document.apply(inverse);
    expect(document.file).toEqual(before);
    expect(document.version).toBe(2);
    // 数组里的值、脚本的属性
    document.apply({ type: 'set', entity: 'b', path: ['position', 1], value: 5 });
    document.apply({ type: 'set', entity: 'b', path: ['components', 'scripts', 0, 'props', 'speed'], value: 9 });
    expect([document.entity('b')!.position, document.get('b', ['components', 'scripts', 0, 'props', 'speed'])]).toEqual([[0, 5, 0], 9]);
    // 加一个键、再删掉（undefined）
    const added = document.apply({ type: 'set', entity: 'c', path: ['components', 'model'], value: { model: 'Game/Models/Box', materials: [] } });
    expect(added).toEqual({ type: 'set', entity: 'c', path: ['components', 'model'], value: undefined });
    document.apply(added);
    expect('model' in document.entity('c')!.components).toBe(false);
  });

  test('列表：末尾加一项、去掉最后一项；去掉中间的要把整个列表设成新的', () => {
    const document = new SceneDocument(scene());
    const push = document.apply({ type: 'set', entity: 'b', path: ['components', 'scripts', 1], value: { type: 'Game.Bob', props: {} } });
    expect((document.get('b', ['components', 'scripts']) as unknown[]).length).toBe(2);
    document.apply(push);
    expect((document.get('b', ['components', 'scripts']) as unknown[]).length).toBe(1);
    document.apply({ type: 'set', entity: 'b', path: ['components', 'scripts', 1], value: { type: 'Game.Bob', props: {} } });
    expect(() => document.apply({ type: 'set', entity: 'b', path: ['components', 'scripts', 0], value: undefined })).toThrow(/whole list/);
    const replaced = document.apply({ type: 'set', entity: 'b', path: ['components', 'scripts'], value: [{ type: 'Game.Bob', props: {} }] });
    document.apply(replaced);
    expect((document.get('b', ['components', 'scripts']) as { type: string }[]).map((s) => s.type)).toEqual(['Game.Spin', 'Game.Bob']);
  });

  test('加、删实体：父实体要排在前面，还有子实体的不能删；一次可以加、删几个（一棵子树）', () => {
    const document = new SceneDocument(scene());
    const original = document.file;
    const add = (...entities: { entity: SceneEntityFile; index: number }[]) => document.apply({ type: 'add', entities });
    expect(() => add({ entity: entity('a'), index: 0 })).toThrow(/already exists/);
    expect(() => add({ entity: entity('d', 'c'), index: 1 })).toThrow(/after its parent/);
    expect(() => add({ entity: entity('d', 'nope'), index: 3 })).toThrow(/after its parent/);
    expect(() => add({ entity: entity('d'), index: 9 })).toThrow(/ascending positions/);
    expect(() => add({ entity: entity('e'), index: 2 }, { entity: entity('d'), index: 1 })).toThrow(/ascending positions/);
    expect(() => add({ entity: entity('d'), index: 0 }, { entity: entity('d'), index: 1 })).toThrow(/added twice/);
    expect(() => document.apply({ type: 'remove', entities: ['b'] })).toThrow(/still has children/);
    expect(() => document.apply({ type: 'remove', entities: ['c', 'c'] })).toThrow(/removed twice/);
    expect(() => document.apply({ type: 'set', entity: 'b', path: ['parent'], value: null })).toThrow(/cannot be set/);
    expect(() => document.apply({ type: 'set', entity: 'zzz', path: ['name'], value: 'x' })).toThrow(/no entity/);
    // 出错的修改不动文档
    expect(document.file).toBe(original);
    const removeD = add({ entity: entity('d', 'c'), index: 3 });
    expect(document.children('c').map((e) => e.id)).toEqual(['d']);
    document.apply(removeD);
    // 一次加几个，插在中间：父实体可以是同一次加的，也可以是被挤到后面的原有实体（只要还排在前面）
    const removeThree = add({ entity: entity('x'), index: 0 }, { entity: entity('y', 'x'), index: 2 }, { entity: entity('z', 'b'), index: 4 });
    expect(document.file.entities.map((e) => e.id)).toEqual(['x', 'a', 'y', 'b', 'z', 'c']);
    expect(() => add({ entity: entity('w', 'c'), index: 5 })).toThrow(/after its parent/);
    expect(removeThree).toEqual({ type: 'remove', entities: ['x', 'y', 'z'] });
    document.apply(removeThree);
    expect(document.file.entities).toEqual(original.entities);
    const restore = document.apply(document.removeSubtree('b'));
    expect(document.file.entities.map((e) => e.id)).toEqual(['a']);
    expect(changedEntities(original.entities, document.file.entities)).toEqual({ added: [], removed: ['b', 'c'], changed: [] });
    // 一样多但对不上位置（删一个、加一个）：按 id 对
    const swapped = [original.entities[0]!, entity('x'), original.entities[2]!];
    expect(changedEntities(original.entities, swapped)).toEqual({ added: [swapped[1]], removed: ['b'], changed: [] });
    // 撤回：实体回到原来的位置，还是原来的对象
    document.apply(restore);
    expect(document.file.entities).toEqual(original.entities);
    expect(document.file.entities[2]).toBe(original.entities[2]);
    // 一批里有一个不合法：整批不生效
    expect(() => document.apply({ type: 'batch', edits: [{ type: 'set', entity: 'a', path: ['name'], value: 'X' }, { type: 'remove', entities: ['nope'] }] })).toThrow();
    expect(document.entity('a')!.name).toBe('A');
  });

  test('挪子树：换父实体、排在新兄弟里的第几个，后代跟着走；一步撤销；不能挪进自己的后代', () => {
    const file: SceneFile = { name: 'Move', entities: [entity('a'), entity('a1', 'a'), entity('a2', 'a'), entity('x'), entity('x1', 'x'), entity('x1a', 'x1'), entity('y')] };
    const document = new SceneDocument(file);
    const order = () => document.file.entities.map((e) => `${e.id}<${e.parent ?? ''}`);
    // x（连着 x1、x1a）挪到 a 下面，排第 1 个：在 a1 后面、a2 前面
    const inverse = document.apply(document.moveSubtree('x', 'a', 1));
    expect(order()).toEqual(['a<', 'a1<a', 'x<a', 'x1<x', 'x1a<x1', 'a2<a', 'y<']);
    // 本地的值没变
    expect(document.entity('x')!.position).toEqual([0, 0, 0]);
    document.apply(inverse);
    expect(document.file).toEqual(file);
    // 挪到最上层的最后、挪到没有子实体的实体下面、挪到第 0 个
    document.apply(document.moveSubtree('a1', null, 99));
    expect(order().at(-1)).toBe('a1<');
    document.apply(document.moveSubtree('a2', 'y', 0));
    expect(order().slice(-3)).toEqual(['y<', 'a2<y', 'a1<']);
    document.apply(document.moveSubtree('y', null, 0));
    expect(order().slice(0, 2)).toEqual(['y<', 'a2<y']);
    expect(() => document.moveSubtree('x', 'x1a', 0)).toThrow('cannot move entity x under itself or its descendant x1a');
    // 加子实体：排在父实体的子实体最后
    document.apply(document.addChild(entity('x2', 'x')));
    expect(order().indexOf('x2<x')).toBe(order().indexOf('x1a<x1') + 1);
    document.apply(document.addChild(entity('z')));
    expect(order().at(-1)).toBe('z<');
  });

  test('撤销重做；连着改同一个值（同一个 mergeKey）并成一步，commit 以后另起一步', () => {
    const document = new SceneDocument(scene());
    const undo = new UndoStack(document);
    const move = (x: number) => undo.apply({ type: 'set', entity: 'a', path: ['position'], value: [x, 0, 0] }, 'move a');
    move(1);
    move(2);
    move(3);
    undo.commit();
    move(4);
    move(5);
    undo.apply({ type: 'set', entity: 'a', path: ['name'], value: 'Sun' });
    expect([document.entity('a')!.position, document.entity('a')!.name]).toEqual([[5, 0, 0], 'Sun']);
    expect(undo.undo()).toBe(true);
    expect(document.entity('a')!.name).toBe('A');
    undo.undo();
    expect(document.entity('a')!.position).toEqual([3, 0, 0]);
    undo.undo();
    expect(document.entity('a')!.position).toEqual([0, 0, 0]);
    expect([undo.canUndo, undo.undo()]).toEqual([false, false]);
    // 重做回到每一步做完的样子
    undo.redo();
    expect(document.entity('a')!.position).toEqual([3, 0, 0]);
    undo.redo();
    undo.redo();
    expect([document.entity('a')!.position, document.entity('a')!.name, undo.canRedo]).toEqual([[5, 0, 0], 'Sun', false]);
    // 新的修改把重做的记录清掉
    undo.undo();
    undo.apply({ type: 'set', entity: 'a', path: ['name'], value: 'Moon' });
    expect(undo.canRedo).toBe(false);
  });

  test('挂在预制体实例成员下面的实体（父实体是 `<实例>/<成员>`）算实例的后代：挪、删、加在后面都带着它', () => {
    const file: SceneFile = { name: 'Test', entities: [entity('a'), entity('i', null, { prefab: { path: 'Game/Enemy' } }), entity('g', 'i/weapon'), entity('z')] };
    const document = new SceneDocument(file);
    expect(document.removeSubtree('i')).toEqual({ type: 'remove', entities: ['i', 'g'] });
    expect(() => document.apply({ type: 'remove', entities: ['i'] })).toThrow(/still has children/);
    document.apply(document.moveSubtree('i', 'a', 0));
    expect(document.file.entities.map((e) => e.id)).toEqual(['a', 'i', 'g', 'z']);
    // 加在 i 后面的兄弟排在 g 后面；成员下面的实体要排在实例后面
    document.apply(document.addChild(entity('n', 'a')));
    expect(document.file.entities.map((e) => e.id)).toEqual(['a', 'i', 'g', 'n', 'z']);
    expect(() => document.apply({ type: 'add', entities: [{ entity: entity('m', 'i/body'), index: 0 }] })).toThrow(/after its parent/);
    // 加在成员下面（紧跟实例）、挪到成员下面；挪实例到自己的成员下面报错，父实体是不在文档里的实例的"成员"也报错
    document.apply(document.addChild(entity('m', 'i/body')));
    expect(document.file.entities.map((e) => e.id)).toEqual(['a', 'i', 'm', 'g', 'n', 'z']);
    document.apply(document.moveSubtree('z', 'i/weapon', Infinity));
    expect(document.file.entities.map((e) => e.id)).toEqual(['a', 'i', 'm', 'g', 'z', 'n']);
    expect(() => document.moveSubtree('i', 'i/body', 0)).toThrow(/under itself/);
    expect(() => document.addChild(entity('x', 'a/body'))).toThrow(/no entity a\/body/);
    expect(document.owner('i/weapon/inner')?.id).toBe('i');
  });

  test('改场景自己的设置（物理、导航、偏移、合成器）：只换改了的那一支，实体列表还是原来的；撤销回去；别的键报错', () => {
    const file: SceneFile = { ...scene(), physics: { gravity: [0, -9.8, 0], linearDamping: 0, angularDamping: 0, fixedTimeStep: 1 / 60 } };
    const document = new SceneDocument(file);
    const undo = new UndoStack(document);
    undo.apply({ type: 'scene', path: ['physics', 'gravity', 1], value: -3 });
    undo.apply({ type: 'scene', path: ['offset'], value: [1, 2, 3] });
    expect([document.file.physics!.gravity, document.file.offset]).toEqual([[0, -3, 0], [1, 2, 3]]);
    expect(document.file.entities).toBe(file.entities);
    expect(document.entity('b')).toBe(file.entities[1]);
    undo.undo();
    expect('offset' in document.file).toBe(false);
    undo.undo();
    expect(document.file).toEqual(file);
    expect(() => document.apply({ type: 'scene', path: ['entities'], value: [] })).toThrow(/not a scene setting/);
    expect(() => document.apply({ type: 'scene', path: ['name'], value: 'X' })).toThrow(/not a scene setting/);
  });
});
