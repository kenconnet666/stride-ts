import { describe, expect, test } from 'vitest';
import type { GraphFile } from '../../src/content/formats/nodeGraph';
import { bakedTextureKey, compileMaterialGraph } from '../../src/rendering/mesh/materialGraph';
import { bakedMaterialGraphNodes, bakedSize, materialGraphBakeShader, materialGraphOutputShader } from '../../src/rendering/mesh/materialGraphBake';
import { materialGraphPreviewShader } from '../../src/rendering/mesh/materialGraphPreview';

// 噪声 → 模糊 → 扭曲（扭曲的量是另一个噪声，不烘）→ 基础色；砖块没接到别处
const graph: GraphFile = {
  nodes: [
    { id: 'noise', type: 'noise', params: { scale: 8 } },
    { id: 'blur', type: 'blur', params: { radius: 0.02 }, inputs: { value: { node: 'noise' } } },
    { id: 'wobble', type: 'noise', params: { scale: 3 } },
    { id: 'warp', type: 'warp', params: { strength: 0.1, angle: 90 }, inputs: { value: { node: 'blur' }, amount: { node: 'wobble' } } },
    { id: 'bricks', type: 'bricks' },
  ],
  outputs: { baseColor: { node: 'warp' } },
};

const compile = (file: GraphFile) => {
  const sampled: string[] = [];
  const compiled = compileMaterialGraph(file, { addFunction: () => {} }, (key, uv) => {
    sampled.push(key);
    return `sample(${key}, ${uv})`;
  }, 'test');
  return { ...compiled, sampled };
};

describe('材质节点图的滤镜（烘焙）', () => {
  test('材质里滤镜是一次采样：value 的上游不在材质里算，扭曲的 amount 照常算', () => {
    const { code, sampled } = compile(graph);
    expect(sampled).toEqual([bakedTextureKey('warp')]);
    expect(code).not.toContain('g_noise_value');
    expect(code).not.toContain('g_blur_color');
    expect(code).toContain('g_wobble_value');
    // 竖着挪：angle 90° 的方向是 (0, strength)
    expect(code).toContain('sample(#bake:warp, (streams.uv + g_wobble_value * vec2f(0.0, 0.1)))');
  });

  test('烘焙着色器只算 value 的上游，上游的滤镜是一次采样，输出换成颜色', () => {
    const blur = materialGraphBakeShader(graph, 'blur', 'test');
    expect(blur.textures).toEqual([]);
    expect(blur.code).toContain('let g_noise_value');
    expect(blur.code).not.toContain('g_wobble');
    expect(blur.code).toContain('return vec4f(vec3f(g_noise_value), 1.0);');
    const warp = materialGraphBakeShader(graph, 'warp', 'test');
    expect(warp.textures).toEqual([bakedTextureKey('blur')]);
    expect(warp.code).toContain('textureSample(bakeTexture0, bakeSampler, streams.uv)');
    expect(warp.code).not.toContain('g_noise_value');
    expect(bakedMaterialGraphNodes(graph)).toEqual(['blur', 'warp']);
  });

  test('没接 value 的滤镜烘成黑的；接错输出时报错', () => {
    expect(materialGraphBakeShader({ nodes: [{ id: 'b', type: 'bake' }], outputs: {} }, 'b', 'test').code).toContain('return vec4f(0.0, 0.0, 0.0, 1.0);');
    const wrong: GraphFile = { nodes: [{ id: 'n', type: 'noise' }, { id: 'b', type: 'bake', inputs: { value: { node: 'n', output: 'nope' } } }], outputs: {} };
    expect(() => materialGraphBakeShader(wrong, 'b', 'bad graph')).toThrow(/bad graph, baking node 'b': input value of node 'b' is linked to output 'nope' of node 'n'/);
  });

  test('模糊的半径超过 24 像素就在小一级的 mip 上做，结果的边长跟着减半', () => {
    expect(bakedSize({ id: 'a', type: 'bake', params: { resolution: '1024' } })).toEqual({ resolution: 1024, level: 0, size: 1024, radius: 0 });
    expect(bakedSize({ id: 'b', type: 'blur', params: { radius: 0.02, resolution: '512' } })).toMatchObject({ level: 0, size: 512 });
    const wide = bakedSize({ id: 'c', type: 'blur', params: { radius: 0.2, resolution: '512' } });
    expect(wide).toMatchObject({ level: 3, size: 64 });
    expect(wide.radius).toBeCloseTo(12.8);
  });

  test('预览里滤镜节点也是采样烘好的贴图，上游照样每个节点一格；滤镜按接进来的值显示（灰度的数不按颜色编码）', () => {
    const shader = materialGraphPreviewShader(graph, 'test');
    expect(shader.code).toContain('case 1u: { shown = vec3f(g_blur_color.r); }');
    expect(shader.code).toContain('case 3u: { shown = linearToSrgb(g_warp_color.rgb); }');
    expect(shader.nodes).toEqual(['noise', 'blur', 'wobble', 'warp', 'bricks']);
    expect([...shader.textures].sort()).toEqual([bakedTextureKey('blur'), bakedTextureKey('warp')]);
  });

  test('导出贴图：颜色换成 sRGB，法线按 0.5 偏移，数是灰度；没接的输出没有着色器', () => {
    const file: GraphFile = {
      nodes: [{ id: 'n', type: 'noise' }, { id: 'h', type: 'normalFromHeight', inputs: { height: { node: 'n' } } }],
      outputs: { baseColor: { node: 'n' }, normal: { node: 'h' }, roughness: { node: 'n' } },
    };
    expect(materialGraphOutputShader(file, 'baseColor', 'test')!.code).toContain('return vec4f(linearToSrgb(vec4f(vec3f(g_n_value), 1.0).rgb), 1.0);');
    expect(materialGraphOutputShader(file, 'normal', 'test')!.code).toContain('return vec4f(g_h_normal * 0.5 + 0.5, 1.0);');
    expect(materialGraphOutputShader(file, 'roughness', 'test')!.code).toContain('return vec4f(vec3f(g_n_value), 1.0);');
    expect(materialGraphOutputShader(file, 'emissive', 'test')).toBeUndefined();
    expect(() => materialGraphOutputShader({ nodes: [{ id: 'n', type: 'noise' }], outputs: { roughness: { node: 'n', output: 'nope' } } }, 'roughness', 'bad')).toThrow(/bad, exporting roughness: output roughness is linked to output 'nope' of node 'n'/);
  });
});
