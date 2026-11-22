import { describe, expect, test } from 'vitest';
import { classifyMap, materialSet, scannedMaterial } from '../src/shared/materialSet.ts';
import { ASSET_FIELDS, checkFields } from '@stride-ts/engine/editor-fields';

describe('扫描的材质', () => {
  test('按文件名认用途：ambientCG、Poly Haven 的命名，分辨率后缀不算', () => {
    expect(classifyMap('Tiles074_2K-JPG_Color.jpg')).toMatchObject({ role: 'baseColor', prefix: 'Tiles074_2K_JPG' });
    expect(classifyMap('Tiles074_2K-JPG_NormalGL.jpg')?.role).toBe('normalGl');
    expect(classifyMap('Tiles074_2K-JPG_NormalDX.jpg')?.role).toBe('normalDx');
    expect(classifyMap('Tiles074_2K-JPG_AmbientOcclusion.jpg')?.role).toBe('occlusion');
    expect(classifyMap('concrete_floor_diff_2k.jpg')).toMatchObject({ role: 'baseColor', prefix: 'concrete_floor' });
    expect(classifyMap('concrete_floor_nor_gl_2k.png')).toMatchObject({ role: 'normalGl', prefix: 'concrete_floor' });
    expect(classifyMap('concrete_floor_rough_2k.jpg')?.role).toBe('roughness');
    expect(classifyMap('readme.txt')).toBeUndefined();
    expect(classifyMap('holiday.jpg')).toBeUndefined();
  });

  test('一批文件：前缀相同、有颜色贴图和别的贴图才算一套', () => {
    const set = materialSet(['Metal032_1K-PNG_Color.png', 'Metal032_1K-PNG_Roughness.png', 'Metal032_1K-PNG_Metalness.png', 'notes.txt']);
    expect(set?.name).toBe('Metal032_1K_PNG');
    expect(set?.maps.map((map) => map.role).sort()).toEqual(['baseColor', 'metalness', 'roughness']);
    expect(materialSet(['T_Color.jpg', 'T_NormalGL.jpg', 'T_NormalDX.jpg', 'T.png'])?.maps.map((map) => map.role).sort()).toEqual(['baseColor', 'normalGl']);
    expect(materialSet(['a_Color.png'])).toBeUndefined();
    expect(materialSet(['a_Color.png', 'b_Roughness.png'])).toBeUndefined();
  });

  test('写出的材质：按米铺、粗糙度贴图取反当光泽度、DirectX 的法线翻 y，带来源；照字段描述检查通过', () => {
    const material = scannedMaterial('Tiles', { baseColor: 'M/Tiles/Tiles_baseColor', normalDx: 'M/Tiles/Tiles_normalDx', roughness: 'M/Tiles/Tiles_roughness' }, {
      tileSize: 2, metalness: 0, credit: { source: 'https://ambientcg.com/view?id=Tiles074', license: 'CC0 1.0' },
    });
    expect(material.baseColorTexture).toMatchObject({ texture: 'M/Tiles/Tiles_baseColor', scale: [0.5, 0.5], srgb: true });
    expect(material.glossinessTexture).toMatchObject({ invert: true, channel: 'r', srgb: false });
    expect(material.normalMap).toMatchObject({ invertY: true, scaleAndBias: true });
    expect(material.credit).toEqual({ source: 'https://ambientcg.com/view?id=Tiles074', license: 'CC0 1.0' });
    expect(checkFields(material, { kind: 'object', fields: ASSET_FIELDS.material }, 'Tiles')).toEqual([]);
  });
});
