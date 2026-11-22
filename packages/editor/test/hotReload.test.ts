import { describe, expect, test } from 'vitest';
import type { AssetRecord } from '../src/shared/protocol.ts';
import { assetsToReload } from '../src/ui/session/EditorSession.ts';

const record = (kind: AssetRecord['kind'], path: string, references: AssetRecord['references'] = []): AssetRecord =>
  ({ kind, path, files: [], bytes: 0, modified: 0, references });

describe('资源热重载要重新加载的', () => {
  test('改了的资源加上一路引用它的（材质 → 模型 → 引用模型的别的资源），场景、预制体不算，不相干的不动', () => {
    const assets = [
      record('material', 'Materials/Ground'),
      record('model', 'Models/Ground', [{ kind: 'material', path: 'Materials/Ground' }]),
      record('model', 'Models/Rock', [{ kind: 'material', path: 'Materials/Stone' }]),
      record('prefab', 'Prefabs/Field', [{ kind: 'model', path: 'Models/Ground' }]),
      record('scene', 'MainScene', [{ kind: 'model', path: 'Models/Ground' }]),
      // 同名不同种的不算引用
      record('ui', 'Hud', [{ kind: 'texture', path: 'Materials/Ground' }]),
    ];
    expect(assetsToReload(assets, [assets[0]!]).sort()).toEqual(['Materials/Ground', 'Models/Ground']);
    expect(assetsToReload(assets, [assets[2]!])).toEqual(['Models/Rock']);
  });
});
