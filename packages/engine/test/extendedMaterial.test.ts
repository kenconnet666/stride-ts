import { describe, expect, test } from 'vitest';
import { ContentManager } from '../src/content/ContentManager';
import type { MaterialFile } from '../src/content/format';
import { Material } from '../src/rendering/mesh/Material';

describe('扩展材质：光泽和各向异性', () => {
  test('默认没有；各向异性的转角默认 0；改了版本号加一', () => {
    const plain = new Material('plain');
    expect([plain.sheen, plain.anisotropy]).toEqual([undefined, undefined]);
    const cloth = new Material('cloth', { sheen: { color: [0.8, 0.2, 0.2], roughness: 0.6 }, anisotropy: { strength: 0.5 } });
    expect(cloth.anisotropy).toEqual({ strength: 0.5, rotation: 0 });
    const version = cloth.version;
    cloth.setSheen(undefined);
    cloth.setAnisotropy({ strength: -0.3, rotation: 1 });
    expect([cloth.sheen, cloth.anisotropy, cloth.version]).toEqual([undefined, { strength: -0.3, rotation: 1 }, version + 2]);
  });

  test('材质文件里的 sheen、anisotropy 读进材质', async () => {
    const file: MaterialFile = { name: 'Velvet', baseColor: [0.2, 0.05, 0.05, 1], metalness: 0, sheen: { color: [1, 0.6, 0.6], roughness: 0.4 }, anisotropy: { strength: 0.7, rotation: 0.5 } };
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer });
    const material = await content.loadMaterial('materials/Velvet');
    expect(material.sheen).toEqual({ color: [1, 0.6, 0.6], roughness: 0.4 });
    expect(material.anisotropy).toEqual({ strength: 0.7, rotation: 0.5 });
  });
});
