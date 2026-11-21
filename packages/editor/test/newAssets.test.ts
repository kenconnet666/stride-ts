import { describe, expect, test } from 'vitest';
import { parseProceduralModel, readModelFile } from '@stride-ts/engine/content-format';
import { freeAssetPath, NEW_ASSET_OPTIONS } from '../src/newAssets.ts';

describe('"新建"出来的资源', () => {
  test('每种形状都有一项，建出的 JSON 模型合法、能生成网格；场景、材质、UI 页面带上名字', () => {
    const models = NEW_ASSET_OPTIONS.filter((option) => option.kind === 'model');
    expect(models.map((option) => option.id)).toEqual(['model:cube', 'model:plane', 'model:sphere', 'model:geoSphere', 'model:capsule', 'model:cylinder', 'model:torus', 'model:cone', 'model:teapot']);
    for (const option of models) {
      const bytes = new TextEncoder().encode(JSON.stringify(option.content('X', []))).buffer;
      expect(parseProceduralModel(bytes, option.id).format).toBe(1);
      expect(readModelFile(bytes, option.id).meshes[0]!.indexCount).toBeGreaterThan(0);
    }
    const byId = (id: string) => NEW_ASSET_OPTIONS.find((option) => option.id === id)!;
    expect(byId('scene').content('Level1', [])).toEqual({ name: 'Level1', entities: [] });
    expect(byId('material').content('Red', [])).toMatchObject({ name: 'Red' });
    expect(byId('ui').content('Hud', [])).toMatchObject({ name: 'Hud', root: 0, elements: [{ type: 'Canvas' }] });
    // 3D 文字先用工程里的第一个字体
    expect(byId('text').content('Sign', [{ kind: 'model', path: 'Coin' }, { kind: 'font', path: 'UI/Sans' }])).toMatchObject({ name: 'Sign', font: 'UI/Sans' });
  });

  test('名字被占了加数字；不同种类的同名资源不算占', () => {
    const taken = new Set(['model:Game/Cube', 'model:Game/Cube2', 'material:Game/Sphere']);
    expect(freeAssetPath('Game', 'Cube', 'model', taken)).toBe('Game/Cube3');
    expect(freeAssetPath('Game', 'Sphere', 'model', taken)).toBe('Game/Sphere');
    expect(freeAssetPath('', 'Cube', 'model', taken)).toBe('Cube');
  });
});
