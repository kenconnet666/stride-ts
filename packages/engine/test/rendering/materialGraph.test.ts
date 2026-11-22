import { describe, expect, test } from 'vitest';
import type { GraphFile } from '../../src/content/formats/nodeGraph';
import { sortGraph } from '../../src/content/formats/nodeGraph';
import { ColorTreeCompiler } from '../../src/rendering/mesh/colorTree';
import { compileMaterialGraph, MATERIAL_NODE_SPECS, materialGraphTextures } from '../../src/rendering/mesh/materialGraph';

const compiler = () => new ColorTreeCompiler({ texture: () => undefined, shaderClass: () => undefined }, 3);

/** 砖墙：砖块的遮罩混两种颜色当基础色，同一个遮罩（只算一次）算出高度、再算法线；噪声调粗糙度。 */
const BRICK_WALL: GraphFile = {
  nodes: [
    { id: 'uv', type: 'uv', params: { scale: [2, 2] } },
    { id: 'bricks', type: 'bricks', inputs: { uv: { node: 'uv' } } },
    { id: 'noise', type: 'noise', inputs: { uv: { node: 'uv' } }, params: { scale: 32 } },
    { id: 'mortar', type: 'color', params: { color: [0.6, 0.6, 0.55] } },
    { id: 'brick', type: 'color', params: { color: [0.5, 0.15, 0.08] } },
    { id: 'albedo', type: 'mix', inputs: { a: { node: 'mortar' }, b: { node: 'brick' }, t: { node: 'bricks', output: 'mask' } } },
    { id: 'normal', type: 'normalFromHeight', inputs: { height: { node: 'bricks', output: 'mask' }, uv: { node: 'uv' } }, params: { strength: 2 } },
    { id: 'unused', type: 'checker' },
  ],
  outputs: { baseColor: { node: 'albedo' }, roughness: { node: 'noise' }, normal: { node: 'normal' } },
};

describe('材质节点图', () => {
  test('排序：被依赖的在前，共用的节点只出现一次，没接到输出的不算', () => {
    const order = sortGraph(BRICK_WALL, 'wall').map((node) => node.id);
    expect(order).not.toContain('unused');
    expect(order.filter((id) => id === 'bricks')).toHaveLength(1);
    expect(order.indexOf('uv')).toBeLessThan(order.indexOf('bricks'));
    expect(order.indexOf('bricks')).toBeLessThan(order.indexOf('albedo'));
  });

  test('编成 materialGraph()：每个节点一次 let，输出写进 graph_ 变量，种类按端口换', () => {
    const c = compiler();
    const { code, outputs } = compileMaterialGraph(BRICK_WALL, c, () => undefined, 'wall');
    expect([...outputs].sort()).toEqual(['baseColor', 'normal', 'roughness']);
    expect(code).toContain('var<private> graph_baseColor: vec4f;');
    expect(code).toContain('var<private> graph_roughness: f32;');
    expect(code.match(/let g_bricks_mask = /g)).toHaveLength(1);
    // 粗糙度是数，噪声的输出也是数：不用转换；混合的 t 是数，砖块的遮罩接上去
    expect(code).toContain('graph_roughness = g_noise_value;');
    expect(code).toContain('mix(g_mortar_color, g_brick_color, clamp(g_bricks_mask, 0.0, 1.0))');
    // 库函数登记到颜色树的编译器里（贴图、函数共用）
    expect(c.declarations).toContain('fn graphBricks(');
    expect(c.declarations).toContain('fn graphHeightNormal(');
  });

  test('坡度、高度遮罩和世界 UV：读材质流的世界坐标和法线，遮罩用一个 graphRange', () => {
    const c = compiler();
    const graph: GraphFile = {
      nodes: [
        { id: 'uv', type: 'worldUv', params: { scale: 0.05 } },
        { id: 'grain', type: 'noise', inputs: { uv: { node: 'uv' } } },
        { id: 'steep', type: 'slopeMask', params: { minAngle: 30, maxAngle: 90, blend: 10 } },
        { id: 'high', type: 'heightMask', params: { minHeight: 200, maxHeight: 1000, blend: 50 } },
        { id: 'snow', type: 'multiply', inputs: { a: { node: 'steep' }, b: { node: 'high' } } },
        { id: 'color', type: 'mix', inputs: { a: { node: 'grain' }, t: { node: 'snow' } } },
      ],
      outputs: { baseColor: { node: 'color' } },
    };
    const { code } = compileMaterialGraph(graph, c, () => undefined, 'terrain');
    expect(code).toContain('(streams.world.xz * 0.05)');
    expect(code).toContain('graphRange(degrees(acos(clamp(streams.normal.y, 0.0, 1.0))), 30.0, 1000.0, 10.0)');
    expect(code).toContain('graphRange(streams.world.y, 200.0, 1000.0, 50.0)');
    // 两个遮罩共用一份库函数
    expect(c.declarations.match(/fn graphRange\(/g)).toHaveLength(1);
  });

  test('三平面投影、细节叠加、按距离淡出：沿世界三个轴各采一次，按法线混；细节在近处 overlay 上去', () => {
    const c = compiler();
    const sampled: string[] = [];
    const graph: GraphFile = {
      nodes: [
        { id: 'base', type: 'triplanar', params: { texture: 'M/Concrete_baseColor', scale: 0.5 } },
        { id: 'detail', type: 'triplanar', params: { texture: 'M/Grain', scale: 8, sharpness: 2 } },
        { id: 'near', type: 'distanceFade', params: { near: 2, far: 10 } },
        { id: 'color', type: 'overlay', inputs: { base: { node: 'base' }, detail: { node: 'detail' }, amount: { node: 'near' } } },
      ],
      outputs: { baseColor: { node: 'color' } },
    };
    const { code } = compileMaterialGraph(graph, c, (texture, uv) => (sampled.push(`${texture} ${uv}`), `sample(${texture})`), 'concrete');
    expect(sampled).toContain('M/Concrete_baseColor (streams.world.zy * 0.5)');
    expect(sampled).toContain('M/Grain (streams.world.xz * 8.0)');
    expect(sampled).toHaveLength(6);
    expect(code).toContain('graphTriplanarWeights(streams.normal, 2.0)');
    expect(code).toContain('distance(streams.world, view.eye.xyz)');
    expect(code).toContain('graphOverlay(');
    expect(c.declarations.match(/fn graphTriplanarWeights\(/g)).toHaveLength(1);
    // 三平面投影的贴图也算材质引用的贴图（加载、改名时改写）
    expect(materialGraphTextures(graph)).toEqual(['M/Concrete_baseColor', 'M/Grain']);
  });

  test('遮蔽遮罩：读这个像素的屏幕空间遮蔽，按 from、to 映射；没有像素坐标时当作没遮住', () => {
    const c = compiler();
    const graph: GraphFile = { nodes: [{ id: 'dirt', type: 'occlusionMask', params: { from: 0.2, to: 0.7 } }], outputs: { roughness: { node: 'dirt' } } };
    const { code } = compileMaterialGraph(graph, c, () => undefined, 'dirt');
    expect(code).toContain('smoothstep(0.2, max(0.7, 0.2 + 1e-3), 1.0 - graphScreenOcclusion())');
    expect(c.declarations).toContain('if (streams.pixel.x < 0.0) { return 1.0; }');
  });

  test('错误：认不出的节点、不存在的输出、没有的输入、环、指向不存在的节点', () => {
    const fails = (graph: GraphFile) => () => compileMaterialGraph(graph, compiler(), () => undefined, 'bad');
    expect(fails({ nodes: [{ id: 'a', type: 'nope' }], outputs: { baseColor: { node: 'a' } } })).toThrow("bad: node 'a' has the unknown type 'nope'");
    expect(fails({ nodes: [{ id: 'a', type: 'noise' }], outputs: { baseColor: { node: 'a', output: 'color' } } })).toThrow(/output 'color' of node 'a'/);
    expect(fails({ nodes: [{ id: 'a', type: 'noise', inputs: { scale: { node: 'a' } } }], outputs: { baseColor: { node: 'a' } } })).toThrow(/cycle/);
    expect(fails({ nodes: [{ id: 'v', type: 'value' }, { id: 'a', type: 'noise', inputs: { colour: { node: 'v' } } }], outputs: { baseColor: { node: 'a' } } })).toThrow("bad: node 'a' (noise) has no input 'colour'");
    expect(fails({ nodes: [], outputs: { baseColor: { node: 'missing' } } })).toThrow("bad: output baseColor is linked to node 'missing', which does not exist");
  });

  test('节点库：每种节点的参数都有默认值，类型不重复', () => {
    const types = MATERIAL_NODE_SPECS.map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
    for (const spec of MATERIAL_NODE_SPECS) for (const param of spec.params) expect(param.default, `${spec.type}.${param.name}`).not.toBeUndefined();
  });

  test('sortGraph 的 all：没接到输出的节点也排进去（节点的预览用），被依赖的仍在前', () => {
    const order = sortGraph(BRICK_WALL, 'wall', { all: true }).map((node) => node.id);
    expect(order).toContain('unused');
    expect(new Set(order).size).toBe(BRICK_WALL.nodes.length);
    expect(order.indexOf('uv')).toBeLessThan(order.indexOf('bricks'));
  });

  test('多段的颜色渐变：起点、中间的色标（按位置排）、终点连成一串，线性、平滑、阶梯三种插值', () => {
    const ramp = (params: Record<string, unknown>) => {
      const graph: GraphFile = { nodes: [{ id: 'ramp', type: 'colorRamp', params }], outputs: { baseColor: { node: 'ramp' } } };
      const { code } = compileMaterialGraph(graph, compiler(), () => undefined, 'ramp');
      const expr = /let g_ramp_color = (.*);/.exec(code)![1]!.replace(/clamp\(0\.5,/g, 'clamp(T,');
      // WGSL 的几个函数换成 JS 求值：颜色是数组
      const vec4f = (...c: number[]) => c;
      const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);
      const step = (edge: number, x: number) => (x >= edge ? 1 : 0);
      const smoothstep = (a: number, b: number, x: number) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
      const mix = (x: number[], y: number[], w: number) => x.map((v, i) => v + (y[i]! - v) * w);
      // oxlint-disable-next-line typescript/no-implied-eval -- 测试里求值生成的表达式
      const at = new Function('T', 'vec4f', 'clamp', 'step', 'smoothstep', 'mix', `return ${expr};`) as (...a: unknown[]) => number[];
      return (t: number) => at(t, vec4f, clamp, step, smoothstep, mix).slice(0, 3).map((v) => Math.round(v * 1000) / 1000);
    };
    // 没写色标：同原来，起点到终点
    expect(ramp({ from: [0, 0, 0], to: [1, 1, 1] })(0.25)).toEqual([0.25, 0.25, 0.25]);
    // 中间一个红色在 0.5：0.25 是黑到红的一半，0.75 是红到白的一半；色标的顺序不要紧
    const red = { from: [0, 0, 0], to: [1, 1, 1], colorStops: [{ position: 0.5, color: [1, 0, 0] }] };
    expect(ramp(red)(0.25)).toEqual([0.5, 0, 0]);
    expect(ramp(red)(0.75)).toEqual([1, 0.5, 0.5]);
    expect(ramp(red)(0)).toEqual([0, 0, 0]);
    expect(ramp(red)(1)).toEqual([1, 1, 1]);
    const two = { from: [0, 0, 0], to: [1, 1, 1], colorStops: [{ position: 0.8, color: [0, 0, 1] }, { position: 0.2, color: [1, 0, 0] }] };
    expect(ramp(two)(0.5)).toEqual([0.5, 0, 0.5]);
    // 阶梯：到了色标的位置才换；平滑：段中间一样、靠近两头变化慢
    expect(ramp({ ...red, interpolation: 'constant' })(0.4)).toEqual([0, 0, 0]);
    expect(ramp({ ...red, interpolation: 'constant' })(0.6)).toEqual([1, 0, 0]);
    expect(ramp({ ...red, interpolation: 'smooth' })(0.25)).toEqual([0.5, 0, 0]);
    expect(ramp({ ...red, interpolation: 'smooth' })(0.05)[0]).toBeLessThan(0.1 * 1);
  });
});
