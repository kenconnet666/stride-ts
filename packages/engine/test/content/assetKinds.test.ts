import { describe, expect, test } from 'vitest';
import { assetKindExtension, isJsonAssetKind, registerAssetKind } from '../../src/content/assetKinds';
import { assetReferences } from '../../src/content/references';
import { allAssetFields, assetFields, registerAssetFields } from '../../src/editor/fields/assets/index.ts';
import { asset, fields, string } from '../../src/content/schema/builders';
import type { AssetKind } from '../../src/content/references';

interface LampFile {
  readonly name: string;
  readonly material: string;
  readonly shade?: string;
}

// 照文档的写法：声明合并给自定义的种类类型
declare module '../../src/content/assetKinds' {
  interface CustomAssetKinds {
    lamp: LampFile;
  }
}

describe('资源种类的登记', () => {
  test('自定义种类：扩展名、是不是 JSON、引用（和内置的走同一条路）、属性面板的字段', () => {
    registerAssetKind('lamp', {
      extension: '.lamp.json',
      references: (file, refs) => {
        refs.add('material', file, 'material');
        if (file.shade) refs.add('model', file, 'shade');
      },
    });
    const lamp: AssetKind = 'lamp';
    expect(assetKindExtension(lamp)).toBe('.lamp.json');
    expect(isJsonAssetKind(lamp)).toBe(true);
    expect(assetReferences(lamp, 'Lamps/Desk', { name: 'Desk', material: 'Materials/Brass', shade: 'Models/Shade' } satisfies LampFile))
      .toEqual([{ kind: 'material', path: 'Materials/Brass' }, { kind: 'model', path: 'Models/Shade' }]);
    expect(assetFields('lamp')).toBeUndefined();
    registerAssetFields('lamp', fields<LampFile>({ name: { type: string }, material: { type: asset('material') }, shade: { type: asset('model'), optional: true } }));
    expect(assetFields('lamp')?.map((field) => field.name)).toEqual(['name', 'material', 'shade']);
    expect(allAssetFields().has('lamp')).toBe(true);
    // 内置的照旧
    expect(assetKindExtension('material')).toBe('.material.json');
    expect(isJsonAssetKind('model')).toBe(true);
    expect(isJsonAssetKind('splats')).toBe(false);
    expect(assetKindExtension('image')).toBeUndefined();
  });

  test('不能和内置的种类、别的种类的扩展名重；同一个种类再登记是替换', () => {
    expect(() => registerAssetKind('material', { extension: '.my.json' })).toThrow(/built-in/);
    expect(() => registerAssetKind('lamp2', { extension: '.material.json' })).toThrow(/already the extension of 'material'/);
    expect(() => registerAssetKind('lamp3', { extension: 'lamp3.json' })).toThrow(/must start with a dot/);
    registerAssetKind('light2', { extension: '.light2.json' });
    registerAssetKind('light2', { extension: '.light2.json' });
    expect(() => registerAssetKind('light3', { extension: '.light2.json' })).toThrow(/light2/);
    expect(() => registerAssetFields('material', [])).toThrow(/built-in/);
  });
});
