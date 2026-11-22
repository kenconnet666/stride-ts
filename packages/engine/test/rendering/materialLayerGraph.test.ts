import { describe, expect, test } from 'vitest';
import { ContentManager } from '../../src/content/ContentManager';
import type { MaterialFile } from '../../src/content/formats/format';

const load = (file: MaterialFile) => new ContentManager({ root: 'https://game.test/content/', read: async () => new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer }).loadMaterial('materials/Test');

describe('材质层和节点图', () => {
  test('材质的节点图是最底下一层（权重 1），绘制层叠在它上面；层的图当这层的填充，没接的输出照旧用树', async () => {
    const material = await load({
      name: 'Painted', baseColor: [1, 1, 1, 1], metalness: 0,
      graph: { nodes: [{ id: 'n', type: 'noise' }], outputs: { baseColor: { node: 'n' } } },
      layers: [{
        blend: { $type: 'computeFloat', value: 0.5 },
        metalness: { $type: 'computeFloat', value: 0.25 },
        diffuse: { $type: 'computeColor', value: [1, 0, 0, 1] },
        graph: { nodes: [{ id: 'paint', type: 'color', params: { color: [0, 0, 1] } }, { id: 'r', type: 'value', params: { value: 0.3 } }], outputs: { baseColor: { node: 'paint' }, roughness: { node: 'r' } } },
      }],
    });
    const trees = material.shaderTrees!;
    expect(trees.graphs).toEqual(['materialGraph', 'materialGraphL0']);
    expect(trees.layers).toEqual([
      { diffuse: true, specular: false, metalness: false, emissive: false },
      { diffuse: true, specular: false, metalness: true, emissive: false, glossiness: { invert: true } },
    ]);
    expect(trees.code).toContain('fn layer0Blend() -> f32 {\n  return 1.0;');
    expect(trees.code).toContain('fn layer0Diffuse() -> vec4f {\n  return graph_baseColor;');
    // 第 0 个绘制层是着色器里的第 1 层：颜色、粗糙度来自它的图，金属度来自它的树，红色的树被图盖掉
    expect(trees.code).toContain('fn layer1Diffuse() -> vec4f {\n  return graphL0_baseColor;');
    expect(trees.code).toContain('fn layer1Gloss() -> f32 {\n  return graphL0_roughness;');
    expect(trees.code).toMatch(/fn layer1Metalness\(\) -> f32 \{\n {2}return [^\n]*0\.25/);
    expect(trees.code.match(/fn layer1Diffuse/g)).toHaveLength(1);
    expect(trees.code).toContain('fn materialGraphL0() {');
  });

  test('没有材质的节点图时绘制层从第 0 层开始', async () => {
    const material = await load({
      name: 'Plain', baseColor: [1, 1, 1, 1], metalness: 0,
      layers: [{ blend: { $type: 'computeFloat', value: 1 }, graph: { nodes: [{ id: 'c', type: 'color' }], outputs: { baseColor: { node: 'c' } } } }],
    });
    expect(material.shaderTrees!.graphs).toEqual(['materialGraphL0']);
    expect(material.shaderTrees!.code).toContain('fn layer0Diffuse() -> vec4f {\n  return graphL0_baseColor;');
  });
});
