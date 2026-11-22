import { describe, expect, test } from 'vitest';
import type { GraphFile } from '../../src/content/formats/nodeGraph';
import { materialGraphPreviewShader } from '../../src/rendering/mesh/materialGraphPreview';

const graph: GraphFile = {
  nodes: [
    { id: 'noise', type: 'noise', params: { scale: 8 } },
    { id: 'ramp', type: 'colorRamp', inputs: { t: { node: 'noise' } } },
    { id: 'tex', type: 'texture', params: { texture: 'Textures/Bark' } },
    { id: 'bump', type: 'normalFromHeight', inputs: { height: { node: 'noise' } } },
  ],
  outputs: { baseColor: { node: 'ramp' }, normal: { node: 'bump' } },
};

describe('材质节点图的预览着色器', () => {
  test('每个节点一格（按节点的顺序），按第一个输出的种类显示：数是灰度、法线按 0.5 偏移、颜色换成 sRGB', () => {
    const shader = materialGraphPreviewShader(graph, 'test');
    expect(shader.nodes).toEqual(['noise', 'ramp', 'tex', 'bump']);
    expect(shader.code).toContain('case 0u: { shown = vec3f(g_noise_');
    expect(shader.code).toMatch(/case 1u: \{ shown = linearToSrgb\(g_ramp_\w+\.rgb\); \}/);
    expect(shader.code).toMatch(/case 3u: \{ shown = \(g_bump_\w+ \* 0\.5 \+ 0\.5\); \}/);
    // 节点按依赖算一次，在 switch 之前（一致的控制流：贴图采样、导数）
    expect(shader.code.indexOf('let g_noise_')).toBeLessThan(shader.code.indexOf('switch in.tile'));
  });

  test('贴图节点按出现的顺序绑定，屏幕空间遮蔽和相机有替身，图有错时抛错', () => {
    const shader = materialGraphPreviewShader(graph, 'test');
    expect(shader.textures).toEqual(['Textures/Bark']);
    expect(shader.code).toContain('@group(0) @binding(1) var previewTexture0: texture_2d<f32>;');
    expect(shader.code).toContain('textureSample(previewTexture0, previewSampler,');
    expect(shader.code).toContain('fn screenAmbient(');
    expect(shader.code).toContain('var<private> view: PlaneView;');
    expect(() => materialGraphPreviewShader({ nodes: [{ id: 'x', type: 'nope' }], outputs: {} }, 'bad graph')).toThrow(/bad graph: node 'x' has the unknown type 'nope'/);
  });
});
