import { describe, expect, test } from 'vitest';
import type { SceneEntityFile, SceneFile } from '../src/content/formats/format';
import { expandPrefabInstances } from '../src/content/prefabInstances';
import { makePrefab } from '../src/editor/makePrefab';
import { SceneDocument, UndoStack } from '../src/editor/SceneDocument';

type Components = SceneEntityFile['components'];
const entity = (id: string, parent: string | null = null, extra: Partial<SceneEntityFile> = {}): SceneEntityFile =>
  ({ id, name: id, parent, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra });

// 金币：底座 coin 在 (3, 1, 0)，下面挂着发光的 glow；场景里的 hud 的脚本指着 glow 和 coin，ground 不相干
const scene = (): SceneFile => ({
  name: 'Level',
  entities: [
    entity('ground'),
    entity('coin', null, { position: [3, 1, 0], scale: [2, 2, 2], components: { model: { model: 'Models/Coin', materials: [] } } }),
    entity('glow', 'coin', { position: [0, 0.5, 0], components: { light: { type: 'point', color: [1, 0.8, 0], intensity: 2, radius: 3 } } as Components }),
    entity('hud', null, { components: { scripts: [{ type: 'Game.Hud', props: { coin: { $entity: 'coin' }, glow: { $entity: 'glow' } } }] } as unknown as Components }),
  ],
});

describe('做成预制体', () => {
  test('子树存成预制体（根的变换归零），场景里原地换成实例；展开以后和原来一样；指向后代的引用改成实例成员的 id；一步撤销', () => {
    const document = new SceneDocument(scene());
    const undo = new UndoStack(document);
    const { prefab, edit } = makePrefab(document.file, 'coin', 'Prefabs/Coin');
    expect(prefab.name).toBe('Coin');
    expect(prefab.entities.map((e) => [e.id, e.parent, e.position, e.scale])).toEqual([['coin', null, [0, 0, 0], [1, 1, 1]], ['glow', 'coin', [0, 0.5, 0], [1, 1, 1]]]);
    undo.apply(edit);
    expect(document.file.entities.map((e) => e.id)).toEqual(['ground', 'coin', 'hud']);
    expect(document.file.entities[1]).toEqual({ ...entity('coin', null, { position: [3, 1, 0], scale: [2, 2, 2] }), prefab: { path: 'Prefabs/Coin' } });
    const props = (document.file.entities[2]!.components.scripts![0]!.props as Record<string, { $entity: string }>);
    expect([props['coin']!.$entity, props['glow']!.$entity]).toEqual(['coin', 'coin/glow']);
    // 展开实例：根带回它的组件，后代成了 coin/glow
    const expanded = expandPrefabInstances(document.file.entities, new Map([['Prefabs/Coin', prefab.entities]]), (message) => { throw new Error(message); });
    expect(expanded.map((e) => [e.id, e.parent, e.position])).toEqual([['ground', null, [0, 0, 0]], ['coin', null, [3, 1, 0]], ['coin/glow', 'coin', [0, 0.5, 0]], ['hud', null, [0, 0, 0]]]);
    expect(expanded[1]!.components.model?.model).toBe('Models/Coin');
    undo.undo();
    expect(document.file).toEqual(scene());
  });

  test('实例、实例的成员、不在文档里的实体不能做', () => {
    const file: SceneFile = { name: 'L', entities: [entity('i', null, { prefab: { path: 'Prefabs/Coin' } })] };
    expect(() => makePrefab(file, 'i', 'Prefabs/X')).toThrow(/already an instance of Prefabs\/Coin/);
    expect(() => makePrefab(file, 'i/glow', 'Prefabs/X')).toThrow(/not an entity of this document/);
  });
});
