import { describe, expect, test } from 'vitest';
import { Registry } from '../src/engine/registry';
import { Mesh } from '../src/rendering/mesh/Mesh';
import { MESH_EFFECT_PARAMETERS, meshEffect, meshEffectCode } from '../src/rendering/mesh/meshEffect';

/** 一个三角形（每个顶点 8 个 float：位置、法线、UV）。 */
function triangle(): Mesh {
  const vertices = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1]);
  return new Mesh('triangle', { vertices, indices: new Uint16Array([0, 1, 2]) });
}

describe('网格效果（Stride 的效果文件在 StrideForwardShadingEffect 上 mixin 的着色器）', () => {
  test('游戏没定义的钩子补上默认实现，定义了的不补；没有效果时四个都是默认', () => {
    const effect = meshEffect('fn effectShading(color: vec4f, fromVertex: vec4f) -> vec4f { return color * 0.5; }');
    const code = meshEffectCode(effect);
    expect(code).toContain('struct MeshEffectParameters');
    expect(code.match(/fn effectShading\b/g)).toHaveLength(1);
    expect(code).toContain('return color * 0.5;');
    for (const hook of ['effectWorldPosition', 'effectUv', 'effectVarying']) expect(code).toContain(`fn ${hook}(`);
    expect(meshEffectCode(undefined).match(/\bfn effect\w+\(/g)).toHaveLength(4);
  });

  test('默认参数补到 16 个，多了报错；网格改过的参数（NaN 是没改）', () => {
    expect([...meshEffect('', [1, 2]).defaults]).toEqual([1, 2, ...Array<number>(14).fill(0)]);
    expect(() => meshEffect('', Array<number>(MESH_EFFECT_PARAMETERS + 1).fill(0))).toThrow(/at most 16/);
    const mesh = triangle();
    expect(mesh.effectParameters).toBeUndefined();
    mesh.setEffectParameters([0, 0.25], 8);
    expect(mesh.effectVersion).toBe(1);
    expect(Array.from(mesh.effectParameters!.subarray(7, 11), (v) => (Number.isNaN(v) ? 'unset' : v))).toEqual(['unset', 0, 0.25, 'unset']);
    expect(() => mesh.setEffectParameters([1, 2], 15)).toThrow(RangeError);
  });

  test('模块导出的网格效果按导出名登记（同 Stride 合成器里的 EffectName）', () => {
    const registry = new Registry();
    const SpaceEscapeEffectMain = meshEffect('');
    registry.registerModules({ './game/SpaceEscapeEffectMain.ts': { SpaceEscapeEffectMain } });
    expect(registry.meshEffect('SpaceEscapeEffectMain')).toBe(SpaceEscapeEffectMain);
    expect(registry.meshEffect('spaceEscapeEffectMain')).toBeUndefined();
  });
});
