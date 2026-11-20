import { describe, expect, test } from 'vitest';
import type { SceneEntityFile } from '../src/content/format';
import { assetReferenceSlots, assetReferences, entityAssetReferences } from '../src/content/references';

const instance: SceneEntityFile = {
  id: 'e1', name: 'Enemy', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {},
  prefab: {
    path: 'Game/Enemy',
    set: [
      { entity: 'weapon', path: ['components', 'model', 'materials', 1], value: 'Game/Materials/Red' },
      { entity: 'body', path: ['components', 'model'], value: { model: 'Game/Models/Big', materials: [null, 'Game/Materials/Skin'] } },
      { entity: 'body', path: ['components', 'scripts', 'Game.Gun', 'props', 'bullet'], value: { $asset: 'Game/Prefabs/Bullet', kind: 'prefab' } },
      { entity: 'body', path: ['components', 'scripts', 'Game.Hud'], value: { type: 'Game.Hud', props: { page: { $asset: 'Game/UI/Hud', kind: 'uiPage' } } } },
      { entity: 'body', path: ['name'], value: 'Boss' },
      { entity: 'body', path: ['components', 'light', 'intensity'], value: 2 },
    ],
  },
};

describe('预制体实例的覆盖里的资源路径', () => {
  test('换材质、换整个模型、脚本属性引用的资源都算引用；不是路径的覆盖不算', () => {
    expect(assetReferences('scene', 'Game/Level', { name: 'Level', entities: [instance] }).map((ref) => `${ref.kind} ${ref.path}`)).toEqual([
      'material Game/Materials/Red',
      'model Game/Models/Big',
      'material Game/Materials/Skin',
      'prefab Game/Prefabs/Bullet',
      'ui Game/UI/Hud',
      'prefab Game/Enemy',
    ]);
  });

  test('移动资源时按找到的位置改写的是覆盖本身', () => {
    const file = structuredClone({ name: 'Level', entities: [instance] });
    for (const slot of assetReferenceSlots('scene', file)) (slot.owner as Record<string | number, string>)[slot.key] = slot.path.replace('Game/', 'Moved/');
    const set = file.entities[0]!.prefab!.set!;
    expect(set[0]!.value).toBe('Moved/Materials/Red');
    expect(set[1]!.value).toEqual({ model: 'Moved/Models/Big', materials: [null, 'Moved/Materials/Skin'] });
    expect(set[2]!.value).toEqual({ $asset: 'Moved/Prefabs/Bullet', kind: 'prefab' });
    expect(set[3]!.value).toEqual({ type: 'Game.Hud', props: { page: { $asset: 'Moved/UI/Hud', kind: 'uiPage' } } });
    expect(file.entities[0]!.prefab!.path).toBe('Moved/Enemy');
  });
});

test('空路径（编辑器里刚加上、还没选资源的槽）不算引用', () => {
  const entity: SceneEntityFile = { id: 'e', name: 'e', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { model: { model: '', materials: ['', 'Materials/Red'] } } };
  expect(entityAssetReferences([entity])).toEqual([{ kind: 'material', path: 'Materials/Red' }]);
});
