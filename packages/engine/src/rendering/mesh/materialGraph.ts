/**
 * 材质节点图（材质文件的 graph，格式见 content/formats/nodeGraph.ts）：节点库和编译成 WGSL。参考 Substance Designer、Material Maker、
 * ArmorPaint 的节点：输入（UV、位置、时间、数、颜色、贴图）、生成器（噪声、Voronoi、砖块、棋盘格、渐变、圆）、运算（加减乘、
 * 混合、反相、色阶、幂、颜色渐变）、法线（从高度算）、UV 变换，滤镜（烘焙、模糊、扭曲）。
 *
 * 编成一个 `materialGraph()`：按依赖排好的节点每个算一次（一个输出接到好几处也只算一次），结果写进私有变量 `graph_<输出>`；
 * 网格着色器在片元着色器里最先调的材质层函数（layerNormal）开头调它一次，图的输出当最后一层（权重 1）盖到表面上（见 Material.ts
 * 的 MaterialShaderTrees.graph、meshShader.ts 的 layersCode）。一般不烘焙：在着色器里直接求值，改了参数马上看得到。
 *
 * 滤镜节点（BAKED，要读邻近的点：模糊；或者要换个地方取值：扭曲）把 `value` 输入的上游烘进一张贴图：上游在 0..1 的 UV 平面上
 * 画一遍（materialGraphBake.ts），材质里按节点自己的 uv 采样。所以滤镜的上游按 UV 空间算——接了世界位置、屏幕遮蔽这些的，
 * 烘的时候用平面上的替身（同节点的预览）。
 *
 * 端口的种类不同时自动转换：数到向量是重复，向量到数取第一个分量，颜色是 vec4（alpha）。颜色参数和颜色常量都是线性的。
 */
import type { FieldType } from '../../editor/fields/index';
import { sortGraph, type GraphFile, type GraphLink, type NodeSpec, type PortSpec, type PortType } from '../../content/formats/nodeGraph';
import type { ColorTreeCompiler } from './colorTree';

/** 材质的哪些属性能接到图上，各是什么种类。 */
export const MATERIAL_GRAPH_OUTPUTS = {
  baseColor: 'color',
  metalness: 'float',
  roughness: 'float',
  /** 切线空间的法线（-1..1），一般接"从高度算法线"。 */
  normal: 'vec3',
  /** 线性颜色，乘过强度的。 */
  emissive: 'color',
  occlusion: 'float',
} as const satisfies Record<string, PortType>;

export type MaterialGraphOutput = keyof typeof MATERIAL_GRAPH_OUTPUTS;

/** 一种材质节点：端口（没接时的值）、参数，和生成 WGSL 的函数。 */
interface MaterialNode extends NodeSpec {
  readonly inputs: readonly (PortSpec & { readonly fallback: string })[];
  /** 按输入的表达式（已经换成端口的种类）、参数生成每个输出的表达式。 */
  readonly emit: (inputs: Readonly<Record<string, string>>, params: Readonly<Record<string, unknown>>, context: EmitContext) => Readonly<Record<string, string>>;
}

interface EmitContext {
  /** 用到的库函数，每个只放一次。 */
  addFunction(name: string, code: string): void;
  /** 采样一张贴图资源（内容路径）；还没加载出来时是 undefined。 */
  sample(texture: string, uv: string): string | undefined;
  /** 滤镜节点：采样这个节点烘好的贴图（`value` 输入的上游，materialGraphBake.ts 烘）。 */
  baked(uv: string): string | undefined;
}

/** 滤镜节点在 sample 里用的"贴图"：烘好的那张（加载材质、预览时按它找到烘焙的结果）。 */
export const bakedTextureKey = (node: string): string => `#bake:${node}`;

const WGSL_TYPES: Readonly<Record<PortType, string>> = { float: 'f32', vec2: 'vec2f', vec3: 'vec3f', color: 'vec4f' };

const num = (min?: number, max?: number, step = 0.05): FieldType => ({ kind: 'number', step, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
const int = (min: number, max: number): FieldType => ({ kind: 'number', integer: true, min, max });
const vec2: FieldType = { kind: 'vector', size: 2 };
const color: FieldType = { kind: 'color', alpha: false, space: 'linear' };

const UV_IN = { name: 'uv', type: 'vec2', fallback: 'streams.uv' } as const;
/** 滤镜节点烘焙的输入：上游在 UV 平面上画进贴图。 */
const BAKED_IN = { name: 'value', type: 'color', fallback: 'vec4f(0.0, 0.0, 0.0, 1.0)' } as const;
/** 烘焙的分辨率（边长，像素）。 */
const RESOLUTION = { name: 'resolution', type: { kind: 'enum', values: ['256', '512', '1024', '2048'] }, default: '512', description: 'size of the baked texture (pixels)' } as const satisfies MaterialNode['params'][number];
const MISSING = 'vec4f(1.0, 0.0, 1.0, 1.0)';

/** 2D 的哈希和噪声（值都在 0..1）：梯度噪声叠几层（fBm）、Voronoi 的最近距离和格子的随机数。 */
const HASH = `fn graphHash2(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
`;
const NOISE = `fn graphGradientNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let g00 = dot(graphHash2(i) * 2.0 - 1.0, f);
  let g10 = dot(graphHash2(i + vec2f(1.0, 0.0)) * 2.0 - 1.0, f - vec2f(1.0, 0.0));
  let g01 = dot(graphHash2(i + vec2f(0.0, 1.0)) * 2.0 - 1.0, f - vec2f(0.0, 1.0));
  let g11 = dot(graphHash2(i + vec2f(1.0, 1.0)) * 2.0 - 1.0, f - vec2f(1.0, 1.0));
  return mix(mix(g00, g10, u.x), mix(g01, g11, u.x), u.y);
}
fn graphFbm(p: vec2f, octaves: i32, roughness: f32) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  var q = p;
  for (var i = 0; i < octaves; i++) {
    sum += graphGradientNoise(q) * amplitude;
    total += amplitude;
    amplitude *= roughness;
    q = q * 2.0 + vec2f(17.3, 9.1);
  }
  return clamp(sum / total * 0.85 + 0.5, 0.0, 1.0);
}
`;
/** x：到最近的点的距离，y：这个格子的随机数，z：到格子边界的距离（第二近减第一近的一半，裂缝、鹅卵石的缝用它）。 */
const VORONOI = `fn graphVoronoi(p: vec2f, randomness: f32) -> vec3f {
  let i = floor(p);
  var best = 8.0;
  var second = 8.0;
  var cell = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i + vec2f(f32(x), f32(y));
      let h = graphHash2(c);
      let d = length(c + 0.5 + (h - 0.5) * randomness - p);
      if (d < best) { second = best; best = d; cell = h.x; }
      else if (d < second) { second = d; }
    }
  }
  return vec3f(best, cell, (second - best) * 0.5);
}
`;
const BRICKS = `fn graphBricks(uv: vec2f, columns: f32, rows: f32, mortar: f32, shift: f32) -> vec2f {
  var p = uv * vec2f(columns, rows);
  let row = floor(p.y);
  p.x += shift * (row % 2.0);
  let cell = floor(p);
  let f = fract(p);
  let m = vec2f(mortar * columns, mortar * rows);
  let inside = step(m.x, f.x) * step(m.y, f.y) * step(f.x, 1.0 - m.x) * step(f.y, 1.0 - m.y);
  return vec2f(inside, graphHash2(cell).x);
}
`;
/** 随机圆点：x 盖住的程度（圆里是 1），y 圆顶的高度（球冠），z 这个圆的随机数；size 是圆占格子的比例，density 是有圆的格子的比例。 */
const SPOTS = `fn graphSpots(p: vec2f, size: f32, variation: f32, density: f32) -> vec3f {
  let i = floor(p);
  var best = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i + vec2f(f32(x), f32(y));
      let h = graphHash2(c);
      let h2 = graphHash2(c + vec2f(37.7, 11.3));
      if (h2.x > density) { continue; }
      let radius = max(size * 0.5 * (1.0 - variation * h2.y), 1e-4);
      let d = length(c + 0.2 + h * 0.6 - p) / radius;
      let inside = 1.0 - smoothstep(0.8, 1.0, d);
      if (inside > best.x) { best = vec3f(inside, sqrt(max(1.0 - d * d, 0.0)), h.y); }
    }
  }
  return best;
}
`;
/** 随机的划痕：每个格子（density 的比例）一条随机方向、长短的线段。 */
const SCRATCHES = `fn graphSegmentDistance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
fn graphScratches(p: vec2f, segment: f32, width: f32, angle: f32, spread: f32, density: f32) -> f32 {
  let i = floor(p);
  var m = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = i + vec2f(f32(x), f32(y));
      let h = graphHash2(c);
      let h2 = graphHash2(c + vec2f(11.3, 73.1));
      if (h2.y > density) { continue; }
      let a = angle + (h2.x - 0.5) * spread;
      let half = vec2f(cos(a), sin(a)) * segment * (0.25 + 0.5 * h.x);
      let d = graphSegmentDistance(p, c + h - half, c + h + half);
      m = max(m, (1.0 - smoothstep(0.0, width, d)) * (0.35 + 0.65 * h2.x));
    }
  }
  return m;
}
`;
/** 六边形格子：x 到边的距离（中心 1、边 0），yz 格子的编号。 */
const HEX = `fn graphHex(p: vec2f) -> vec3f {
  let r = vec2f(1.0, 1.7320508);
  let h = r * 0.5;
  let a = p - r * floor(p / r) - h;
  let q = p - h;
  let b = q - r * floor(q / r) - h;
  let gv = select(b, a, dot(a, a) < dot(b, b));
  let g = abs(gv);
  let c = max(dot(g, vec2f(0.5, 0.8660254)), g.x);
  return vec3f((0.5 - c) * 2.0, p.x - gv.x, p.y - gv.y);
}
`;
/** 编织：x 是这一格上面的线（经线 1、纬线 0），y 线的横截面高度（0..1），z 这根线的随机数；pattern 0 平纹，1 斜纹 2/2，2 篮纹 2/2。 */
const WEAVE = `fn graphWeave(uv: vec2f, count: vec2f, pattern: i32) -> vec3f {
  let p = uv * count;
  let cell = floor(p);
  let f = fract(p);
  var over = 0.0;
  if (pattern == 0) { over = select(0.0, 1.0, (cell.x + cell.y) % 2.0 < 1.0); }
  else if (pattern == 1) { over = select(0.0, 1.0, (cell.x - cell.y + 400.0) % 4.0 < 2.0); }
  else { over = select(0.0, 1.0, (floor(cell.x * 0.5) + floor(cell.y * 0.5)) % 2.0 < 1.0); }
  let height = select(sin(3.1415927 * f.y), sin(3.1415927 * f.x), over > 0.5);
  let thread = select(graphHash2(vec2f(0.0, cell.y)).x, graphHash2(vec2f(cell.x, 0.0)).x, over > 0.5);
  return vec3f(over, height, thread);
}
`;
/** HSV 和 RGB 互转（色相 0..1）。 */
const HSV = `fn graphRgbToHsv(c: vec3f) -> vec3f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.b, c.g, k.w, k.z), vec4f(c.g, c.b, k.x, k.y), step(c.b, c.g));
  let q = mix(vec4f(p.x, p.y, p.w, c.r), vec4f(c.r, p.y, p.z, p.x), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
fn graphHsvToRgb(c: vec3f) -> vec3f {
  let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
  return c.z * mix(k.xxx, clamp(p - k.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}
`;
/** 混合模式（Photoshop 的几种）：base 是下面的，top 是上面的。 */
const BLEND = `fn graphBlend(base: vec3f, top: vec3f, mode: i32) -> vec3f {
  switch (mode) {
    case 0: { return 1.0 - (1.0 - base) * (1.0 - top); }
    case 1: { return (1.0 - 2.0 * top) * base * base + 2.0 * top * base; }
    case 2: { return select(1.0 - 2.0 * (1.0 - base) * (1.0 - top), 2.0 * base * top, top < vec3f(0.5)); }
    case 3: { return abs(base - top); }
    case 4: { return max(base, top); }
    case 5: { return min(base, top); }
    case 6: { return min(base / max(1.0 - top, vec3f(1e-3)), vec3f(1.0)); }
    default: { return max(base + top - 1.0, vec3f(0.0)); }
  }
}
`;
/** 0..1：v 在 [lo, hi] 里是 1，两头各按 width 宽的平滑过渡（width 是 0 时是硬边）。 */
const RANGE = `fn graphRange(v: f32, lo: f32, hi: f32, width: f32) -> f32 {
  let w = max(width, 1e-4) * 0.5;
  return smoothstep(lo - w, lo + w, v) * (1.0 - smoothstep(hi - w, hi + w, v));
}
`;
/** 三平面投影：法线各分量的 sharpness 次方归一当三个方向的权重，按它混三次采样。 */
const TRIPLANAR = `fn graphTriplanarWeights(n: vec3f, sharpness: f32) -> vec3f {
  let w = pow(abs(n), vec3f(sharpness));
  return w / max(w.x + w.y + w.z, 1e-5);
}

fn graphTriplanar(x: vec4f, y: vec4f, z: vec4f, w: vec3f) -> vec4f {
  return x * w.x + y * w.y + z * w.z;
}
`;
/** 这个像素的屏幕空间环境光遮蔽（网格着色器的 screenAmbient）；没有像素坐标（顶点阶段）时当作没遮住。 */
const SCREEN_OCCLUSION = `fn graphScreenOcclusion() -> f32 {
  if (streams.pixel.x < 0.0) { return 1.0; }
  return screenAmbient(vec4f(streams.pixel, 0.0, 1.0)).w;
}
`;
/** 这个像素的表面曲率（网格着色器的 screenCurvature，GTAO 顺带算的）：凸的大于 0；没有像素坐标时当作平的。 */
const SCREEN_CURVATURE = `fn graphScreenCurvature() -> f32 {
  if (streams.pixel.x < 0.0) { return 0.0; }
  return screenCurvature(vec4f(streams.pixel, 0.0, 1.0));
}
`;
/** Overlay：底色暗于 0.5 时乘、亮于 0.5 时滤色。 */
const OVERLAY = `fn graphOverlay(base: vec3f, detail: vec3f) -> vec3f {
  return select(1.0 - 2.0 * (1.0 - base) * (1.0 - detail), 2.0 * base * detail, base < vec3f(0.5));
}
`;
/** 高度的导数换成切线空间的法线：按 UV 的导数把屏幕空间的高度梯度换到 UV 空间（x 沿 U、y 沿 V）。 */
const HEIGHT_NORMAL = `fn graphHeightNormal(height: f32, uv: vec2f, strength: f32) -> vec3f {
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  let dh = vec2f(dpdx(height), dpdy(height));
  let det = dx.x * dy.y - dx.y * dy.x;
  let inv = select(0.0, 1.0 / det, abs(det) > 1e-12);
  let gradient = vec2f(dh.x * dy.y - dh.y * dx.y, dh.y * dx.x - dh.x * dy.x) * inv;
  return normalize(vec3f(-gradient * strength * 0.01, 1.0));
}
`;

const binary = (type: string, operator: string): MaterialNode => ({
  type, category: 'math',
  inputs: [{ name: 'a', type: 'color', fallback: 'vec4f(0.0)' }, { name: 'b', type: 'color', fallback: operator === '*' ? 'vec4f(1.0)' : 'vec4f(0.0)' }],
  outputs: [{ name: 'out', type: 'color' }], params: [],
  emit: ({ a, b }) => ({ out: `(${a} ${operator} ${b})` }),
});

/** 节点库，按"加节点"菜单的顺序。 */
export const MATERIAL_NODES: readonly MaterialNode[] = [
  // 输入
  {
    type: 'uv', category: 'input', inputs: [], outputs: [{ name: 'uv', type: 'vec2' }],
    params: [{ name: 'scale', type: vec2, default: [1, 1] }, { name: 'offset', type: vec2, default: [0, 0] }],
    emit: (_, p) => ({ uv: `(streams.uv * ${v2(p['scale'])} + ${v2(p['offset'])})` }),
  },
  { type: 'position', category: 'input', inputs: [], outputs: [{ name: 'position', type: 'vec3' }], params: [], emit: () => ({ position: 'streams.position' }) },
  { type: 'time', category: 'input', inputs: [], outputs: [{ name: 'time', type: 'float' }], params: [], emit: () => ({ time: 'streams.time' }) },
  { type: 'worldPosition', category: 'input', inputs: [], outputs: [{ name: 'position', type: 'vec3' }], params: [], emit: () => ({ position: 'streams.world' }) },
  { type: 'worldNormal', category: 'input', inputs: [], outputs: [{ name: 'normal', type: 'vec3' }], params: [], emit: () => ({ normal: 'streams.normal' }) },
  {
    // 世界坐标的 x、z 当 UV（从上往下投）：大地形上贴图按米铺，不跟着块、模型的 UV 走
    type: 'worldUv', category: 'mapping', inputs: [], outputs: [{ name: 'uv', type: 'vec2' }],
    params: [{ name: 'scale', type: num(0, undefined, 0.01), default: 0.1, description: 'repeats per meter (0.1 = one tile every 10 m)' }],
    emit: (_, p) => ({ uv: `(streams.world.xz * ${f(p['scale'])})` }),
  },
  // 遮罩：0..1，在 [最小, 最大] 里是 1，两头按 blend 的宽度过渡（地形按坡度、高度混材质：陡处是岩石、高处是雪……）
  // 坡度是表面和水平面的夹角：朝下的面（悬垂、物体的底面）算 90°，不会因为超过 90° 又落回平地那一档
  {
    type: 'slopeMask', category: 'mask', inputs: [], outputs: [{ name: 'mask', type: 'float' }],
    params: [
      { name: 'minAngle', type: { kind: 'number', step: 5, min: 0, max: 90, unit: 'deg' }, default: 30, description: 'slope (degrees from flat) where the mask starts' },
      { name: 'maxAngle', type: { kind: 'number', step: 5, min: 0, max: 90, unit: 'deg' }, default: 90, description: 'slope where it ends' },
      { name: 'blend', type: { kind: 'number', step: 1, min: 0, unit: 'deg' }, default: 10, description: 'width of the soft edges' },
    ],
    emit: (_, p, context) => {
      context.addFunction('graphRange', RANGE);
      // 范围顶到 0° 或 90° 时那一头不过渡（过渡是以边界为中心的：平地、竖直面上会只有一半）
      const lo = Number(p['minAngle']) <= 0 ? -1000 : p['minAngle'], hi = Number(p['maxAngle']) >= 90 ? 1000 : p['maxAngle'];
      return { mask: `graphRange(degrees(acos(clamp(streams.normal.y, 0.0, 1.0))), ${f(lo)}, ${f(hi)}, ${f(p['blend'])})` };
    },
  },
  {
    type: 'heightMask', category: 'mask', inputs: [], outputs: [{ name: 'mask', type: 'float' }],
    params: [
      { name: 'minHeight', type: num(undefined, undefined, 10), default: 200, description: 'world height (m) where the mask starts' },
      { name: 'maxHeight', type: num(undefined, undefined, 10), default: 100000, description: 'world height where it ends' },
      { name: 'blend', type: num(0, undefined, 5), default: 30, description: 'width of the soft edges (m)' },
    ],
    emit: (_, p, context) => {
      context.addFunction('graphRange', RANGE);
      return { mask: `graphRange(streams.world.y, ${f(p['minHeight'])}, ${f(p['maxHeight'])}, ${f(p['blend'])})` };
    },
  },
  { type: 'value', category: 'input', inputs: [], outputs: [{ name: 'value', type: 'float' }], params: [{ name: 'value', type: num(), default: 0.5 }], emit: (_, p) => ({ value: f(p['value']) }) },
  { type: 'color', category: 'input', inputs: [], outputs: [{ name: 'color', type: 'color' }], params: [{ name: 'color', type: color, default: [0.8, 0.8, 0.8] }], emit: (_, p) => ({ color: rgb(p['color']) }) },
  {
    type: 'texture', category: 'input', inputs: [UV_IN], outputs: [{ name: 'color', type: 'color' }],
    params: [{ name: 'texture', type: { kind: 'asset', asset: 'texture', form: 'path' }, default: null, description: 'a texture asset (an imported image)' }],
    emit: ({ uv }, p, context) => ({ color: (typeof p['texture'] === 'string' ? context.sample(p['texture'], uv!) : undefined) ?? 'vec4f(1.0, 0.0, 1.0, 1.0)' }),
  },
  {
    // 三平面投影（扫描的贴图用在白盒、SDF 这些按面投影 UV 的模型上：接缝、拉伸都没有）：沿世界的三个轴各采一次，按法线的
    // 各分量的 sharpness 次方混；scale 是每米重复几次
    type: 'triplanar', category: 'mapping', inputs: [], outputs: [{ name: 'color', type: 'color' }],
    params: [
      { name: 'texture', type: { kind: 'asset', asset: 'texture', form: 'path' }, default: null, description: 'a texture asset (an imported image)' },
      { name: 'scale', type: num(0, undefined, 0.05), default: 0.5, description: 'repeats per meter' },
      { name: 'sharpness', type: num(1, 16, 0.5), default: 4, description: 'how quickly the three projections hand over at slanted faces' },
    ],
    emit: (_, p, context) => {
      if (typeof p['texture'] !== 'string') return { color: 'vec4f(1.0, 0.0, 1.0, 1.0)' };
      const at = (uv: string) => context.sample(p['texture'] as string, `(${uv} * ${f(p['scale'])})`);
      const x = at('streams.world.zy'), y = at('streams.world.xz'), z = at('streams.world.xy');
      if (!x || !y || !z) return { color: 'vec4f(1.0, 0.0, 1.0, 1.0)' };
      context.addFunction('graphTriplanarWeights', TRIPLANAR);
      return { color: `graphTriplanar(${x}, ${y}, ${z}, graphTriplanarWeights(streams.normal, ${f(p['sharpness'])}))` };
    },
  },
  // 生成器
  {
    type: 'noise', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'value', type: 'float' }],
    params: [{ name: 'scale', type: num(0, undefined, 0.5), default: 8 }, { name: 'octaves', type: int(1, 8), default: 4 }, { name: 'roughness', type: num(0, 1), default: 0.5 }, { name: 'seed', type: num(), default: 0 }, { name: 'ridged', type: num(0, 1), default: 0, description: '0 smooth clouds .. 1 sharp ridges (veins, rock strata, cracks in dry earth)' }],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphFbm', NOISE);
      const n = `graphFbm(${uv} * ${f(p['scale'])} + vec2f(${f(p['seed'])} * 7.13), ${Math.round(Number(p['octaves']))}, ${f(p['roughness'])})`;
      return { value: Number(p['ridged']) > 0 ? `mix(${n}, 1.0 - abs(${n} * 2.0 - 1.0), ${f(p['ridged'])})` : n };
    },
  },
  {
    type: 'voronoi', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'distance', type: 'float' }, { name: 'cell', type: 'float' }, { name: 'edge', type: 'float' }],
    params: [{ name: 'scale', type: num(0, undefined, 0.5), default: 8 }, { name: 'randomness', type: num(0, 1), default: 1 }],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphVoronoi', VORONOI);
      const v = `graphVoronoi(${uv} * ${f(p['scale'])}, ${f(p['randomness'])})`;
      return { distance: `${v}.x`, cell: `${v}.y`, edge: `${v}.z` };
    },
  },
  {
    type: 'bricks', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }, { name: 'brick', type: 'float' }],
    params: [{ name: 'columns', type: num(1, undefined, 1), default: 4 }, { name: 'rows', type: num(1, undefined, 1), default: 8 }, { name: 'mortar', type: num(0, 0.5, 0.005), default: 0.02 }, { name: 'shift', type: num(0, 1), default: 0.5 }],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphBricks', BRICKS);
      const v = `graphBricks(${uv}, ${f(p['columns'])}, ${f(p['rows'])}, ${f(p['mortar'])}, ${f(p['shift'])})`;
      return { mask: `${v}.x`, brick: `${v}.y` };
    },
  },
  {
    type: 'checker', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'value', type: 'float' }],
    params: [{ name: 'scale', type: num(0, undefined, 1), default: 8 }],
    emit: ({ uv }, p) => ({ value: `(floor(${uv}.x * ${f(p['scale'])}) + floor(${uv}.y * ${f(p['scale'])})) % 2.0` }),
  },
  {
    type: 'gradient', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'value', type: 'float' }],
    params: [
      { name: 'angle', type: { kind: 'number', step: 5, unit: 'deg' }, default: 0, description: 'linear: the direction; angular: where the sweep starts' },
      { name: 'shape', type: { kind: 'enum', values: ['linear', 'radial', 'angular'] }, default: 'linear', description: 'straight, from the center out, or a sweep around the center' },
    ],
    emit: ({ uv }, p) => {
      const a = (Number(p['angle']) * Math.PI) / 180;
      if (p['shape'] === 'radial') return { value: `clamp(distance(${uv}, vec2f(0.5)) * 2.0, 0.0, 1.0)` };
      if (p['shape'] === 'angular') return { value: `fract(atan2(${uv}.y - 0.5, ${uv}.x - 0.5) / 6.2831853 + 0.5 - ${f(a / (2 * Math.PI))})` };
      return { value: `clamp(dot(${uv} - 0.5, vec2f(${f(Math.cos(a))}, ${f(Math.sin(a))})) + 0.5, 0.0, 1.0)` };
    },
  },
  {
    type: 'circle', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }],
    params: [{ name: 'center', type: vec2, default: [0.5, 0.5] }, { name: 'radius', type: num(0), default: 0.3 }, { name: 'softness', type: num(0, undefined, 0.01), default: 0.02 }, { name: 'repeat', type: num(1, undefined, 1), default: 1 }],
    emit: ({ uv }, p) => ({ mask: `(1.0 - smoothstep(${f(p['radius'])} - ${f(p['softness'])}, ${f(p['radius'])} + ${f(p['softness'])}, distance(fract(${uv} * ${f(p['repeat'])}), ${v2(p['center'])})))` }),
  },
  {
    // 随机的圆点：孔洞、石子、芝麻、麻点、雨滴。size 是圆占格子的比例，variation 是大小的差异，density 是有圆的格子的比例
    type: 'spots', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }, { name: 'dome', type: 'float' }, { name: 'id', type: 'float' }],
    params: [
      { name: 'scale', type: num(0, undefined, 0.5), default: 12 },
      { name: 'size', type: num(0, 1, 0.02), default: 0.5, description: 'how much of a cell a spot fills' },
      { name: 'variation', type: num(0, 1, 0.05), default: 0.5, description: 'how much the sizes differ' },
      { name: 'density', type: num(0, 1, 0.05), default: 1, description: 'share of cells that have a spot' },
      { name: 'seed', type: num(), default: 0 },
    ],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphSpots', SPOTS);
      const v = `graphSpots(${uv} * ${f(p['scale'])} + vec2f(${f(p['seed'])} * 7.13), ${f(p['size'])}, ${f(p['variation'])}, ${f(p['density'])})`;
      return { mask: `${v}.x`, dome: `${v}.y`, id: `${v}.z` };
    },
  },
  {
    // 划痕：随机方向、长短的细线。scale 是每个方向上的格数（每格一条），length 是线段的长度（格子的倍数），angle 是主方向，
    // spread 是方向散开多少（360 是各个方向）
    type: 'scratches', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }],
    params: [
      { name: 'scale', type: num(0, undefined, 0.5), default: 10 },
      { name: 'length', type: num(0, 2, 0.05), default: 1 },
      { name: 'width', type: num(0, 0.5, 0.005), default: 0.03 },
      { name: 'angle', type: { kind: 'number', step: 5, unit: 'deg' }, default: 0 },
      { name: 'spread', type: { kind: 'number', step: 5, min: 0, max: 360, unit: 'deg' }, default: 40 },
      { name: 'density', type: num(0, 1, 0.05), default: 0.6 },
      { name: 'seed', type: num(), default: 0 },
    ],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphScratches', SCRATCHES);
      const rad = (v: unknown) => f((Number(v) * Math.PI) / 180);
      return { mask: `graphScratches(${uv} * ${f(p['scale'])} + vec2f(${f(p['seed'])} * 7.13), ${f(p['length'])}, ${f(p['width'])}, ${rad(p['angle'])}, ${rad(p['spread'])}, ${f(p['density'])})` };
    },
  },
  {
    // 六边形的砖：屋顶瓦、六角砖、蜂窝。gap 是缝的宽度（六边形中心到边的比例）
    type: 'hexTiles', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }, { name: 'edge', type: 'float' }, { name: 'id', type: 'float' }],
    params: [{ name: 'scale', type: num(0, undefined, 0.5), default: 6 }, { name: 'gap', type: num(0, 0.5, 0.005), default: 0.04 }],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphHex', HEX);
      const v = `graphHex(${uv} * ${f(p['scale'])})`;
      return { mask: `step(${f(p['gap'])}, ${v}.x)`, edge: `${v}.x`, id: `graphHash2(${v}.yz).x` };
    },
  },
  {
    // 编织：经线纬线交错（平纹、斜纹、篮纹）。count 是每个方向上的线数；warp 是这一格上面的线（经线 1、纬线 0），
    // height 是线的横截面（给法线），thread 是这根线的随机数（每根线颜色略不同）
    type: 'weave', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'warp', type: 'float' }, { name: 'height', type: 'float' }, { name: 'thread', type: 'float' }],
    params: [
      { name: 'count', type: vec2, default: [24, 24] },
      { name: 'pattern', type: { kind: 'enum', values: ['plain', 'twill', 'basket'] }, default: 'plain' },
    ],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphWeave', WEAVE);
      const v = `graphWeave(${uv}, ${v2(p['count'])}, ${Math.max(['plain', 'twill', 'basket'].indexOf(String(p['pattern'])), 0)})`;
      return { warp: `${v}.x`, height: `${v}.y`, thread: `${v}.z` };
    },
  },
  {
    // 木纹：年轮（沿 U 的方向一圈一圈，锯齿形：春材渐变、秋材突然变深）加细纤维。rings 是 UV 里的年轮数，distortion 是年轮
    // 歪多少，fiberScale 是纤维的细密。木板沿 V 方向长：UV 的 V 方向拉长（用"UV"节点的 scale）
    type: 'woodGrain', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'rings', type: 'float' }, { name: 'fibers', type: 'float' }],
    params: [
      { name: 'rings', type: num(0, undefined, 0.5), default: 8 },
      { name: 'distortion', type: num(0, undefined, 0.05), default: 1.2 },
      { name: 'fiberScale', type: num(0, undefined, 1), default: 60 },
      { name: 'seed', type: num(), default: 0 },
    ],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphFbm', NOISE);
      const q = `(${uv} + vec2f(${f(p['seed'])} * 7.13, 0.0))`;
      const warp = `(graphFbm(${q} * vec2f(3.0, 0.6), 4, 0.5) - 0.5) * ${f(p['distortion'])}`;
      return {
        rings: `fract(${q}.x * ${f(p['rings'])} + ${warp} * ${f(p['rings'])} * 0.35)`,
        fibers: `graphFbm(${q} * vec2f(${f(p['fiberScale'])}, ${f(Number(p['fiberScale']) * 0.04)}), 3, 0.6)`,
      };
    },
  },
  {
    // 裂缝：Voronoi 的格子边（先用噪声扭一下，裂得不规则）。mask 是缝（1 在缝里），height 是格子的高度（缝里低）
    type: 'cracks', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'mask', type: 'float' }, { name: 'height', type: 'float' }],
    params: [
      { name: 'scale', type: num(0, undefined, 0.5), default: 5 },
      { name: 'width', type: num(0, 0.5, 0.005), default: 0.03 },
      { name: 'warp', type: num(0, undefined, 0.05), default: 0.6, description: 'how crooked the cracks run' },
      { name: 'seed', type: num(), default: 0 },
    ],
    emit: ({ uv }, p, context) => {
      context.addFunction('graphHash2', HASH);
      context.addFunction('graphFbm', NOISE);
      context.addFunction('graphVoronoi', VORONOI);
      const bend = `(vec2f(graphFbm(${uv} * ${f(Number(p['scale']) * 1.7)} + vec2f(3.1, 8.2), 3, 0.5), graphFbm(${uv} * ${f(Number(p['scale']) * 1.7)} + vec2f(9.4, 1.7), 3, 0.5)) - 0.5) * ${f(p['warp'])}`;
      const e = `graphVoronoi(${uv} * ${f(p['scale'])} + vec2f(${f(p['seed'])} * 7.13) + ${bend}, 1.0).z`;
      return { mask: `(1.0 - smoothstep(0.0, ${f(p['width'])}, ${e}))`, height: `smoothstep(0.0, ${f(Number(p['width']) * 2.5)}, ${e})` };
    },
  },
  {
    // 波：沿一个方向的周期图案，波纹铁皮、水波、条纹。frequency 是 UV 里的周期数
    type: 'wave', category: 'generator', inputs: [UV_IN], outputs: [{ name: 'value', type: 'float' }],
    params: [
      { name: 'frequency', type: num(0, undefined, 0.5), default: 8 },
      { name: 'angle', type: { kind: 'number', step: 5, unit: 'deg' }, default: 0 },
      { name: 'shape', type: { kind: 'enum', values: ['sine', 'triangle', 'square', 'sawtooth'] }, default: 'sine' },
    ],
    emit: ({ uv }, p) => {
      const a = (Number(p['angle']) * Math.PI) / 180;
      const t = `(dot(${uv}, vec2f(${f(Math.cos(a))}, ${f(Math.sin(a))})) * ${f(p['frequency'])})`;
      const shapes: Record<string, string> = {
        sine: `(0.5 + 0.5 * sin(${t} * 6.2831853))`,
        triangle: `abs(fract(${t}) * 2.0 - 1.0)`,
        square: `step(0.5, fract(${t}))`,
        sawtooth: `fract(${t})`,
      };
      return { value: shapes[String(p['shape'])] ?? shapes['sine']! };
    },
  },
  // 运算
  binary('add', '+'),
  binary('subtract', '-'),
  binary('multiply', '*'),
  {
    type: 'mix', category: 'math',
    inputs: [{ name: 'a', type: 'color', fallback: 'vec4f(0.0, 0.0, 0.0, 1.0)' }, { name: 'b', type: 'color', fallback: 'vec4f(1.0)' }, { name: 't', type: 'float', fallback: '0.5' }],
    outputs: [{ name: 'out', type: 'color' }], params: [],
    emit: ({ a, b, t }) => ({ out: `mix(${a}, ${b}, clamp(${t}, 0.0, 1.0))` }),
  },
  { type: 'invert', category: 'math', inputs: [{ name: 'in', type: 'color', fallback: 'vec4f(0.0)' }], outputs: [{ name: 'out', type: 'color' }], params: [], emit: (i) => ({ out: `vec4f(1.0 - ${i['in']}.rgb, ${i['in']}.a)` }) },
  {
    type: 'levels', category: 'math', inputs: [{ name: 'in', type: 'color', fallback: 'vec4f(0.5)' }], outputs: [{ name: 'out', type: 'color' }],
    params: [{ name: 'inMin', type: num(0, 1), default: 0 }, { name: 'inMax', type: num(0, 1), default: 1 }, { name: 'gamma', type: num(0.01, undefined), default: 1 }, { name: 'outMin', type: num(0, 1), default: 0 }, { name: 'outMax', type: num(0, 1), default: 1 }],
    emit: (i, p) => {
      const t = `pow(clamp((${i['in']}.rgb - ${f(p['inMin'])}) / max(${f(p['inMax'])} - ${f(p['inMin'])}, 1e-5), vec3f(0.0), vec3f(1.0)), vec3f(1.0 / ${f(p['gamma'])}))`;
      return { out: `vec4f(mix(vec3f(${f(p['outMin'])}), vec3f(${f(p['outMax'])}), ${t}), ${i['in']}.a)` };
    },
  },
  {
    type: 'power', category: 'math', inputs: [{ name: 'in', type: 'color', fallback: 'vec4f(0.5)' }], outputs: [{ name: 'out', type: 'color' }],
    params: [{ name: 'exponent', type: num(0, undefined, 0.1), default: 2 }],
    emit: (i, p) => ({ out: `vec4f(pow(max(${i['in']}.rgb, vec3f(0.0)), vec3f(${f(p['exponent'])})), ${i['in']}.a)` }),
  },
  {
    // 叠加（Photoshop 的 Overlay）：细节贴图压在底色上，暗处更暗、亮处更亮，0.5 的灰不改；amount 是叠多少
    type: 'overlay', category: 'math',
    inputs: [{ name: 'base', type: 'color', fallback: 'vec4f(0.5)' }, { name: 'detail', type: 'color', fallback: 'vec4f(0.5)' }, { name: 'amount', type: 'float', fallback: '1.0' }],
    outputs: [{ name: 'out', type: 'color' }], params: [],
    emit: ({ base, detail, amount }, _, context) => {
      context.addFunction('graphOverlay', OVERLAY);
      return { out: `vec4f(mix(${base}.rgb, graphOverlay(${base}.rgb, ${detail}.rgb), clamp(${amount}, 0.0, 1.0)), ${base}.a)` };
    },
  },
  {
    // 缝隙、墙角、物体底下这些被遮住的地方是 1、敞开的是 0：读屏幕空间的环境光遮蔽（GTAO，场景的 postEffects.ambientOcclusion
    // 要开；没开、或者不在主画面里画时是 0）。脏污、灰尘、积水往这些地方攒
    type: 'occlusionMask', category: 'mask', inputs: [], outputs: [{ name: 'mask', type: 'float' }],
    params: [
      { name: 'from', type: num(0, 1, 0.05), default: 0.1, description: 'how occluded a spot must be before the mask starts (0 open, 1 fully occluded)' },
      { name: 'to', type: num(0, 1, 0.05), default: 0.6, description: 'occlusion where the mask reaches 1' },
    ],
    emit: (_, p, context) => {
      context.addFunction('graphScreenOcclusion', SCREEN_OCCLUSION);
      return { mask: `smoothstep(${f(p['from'])}, max(${f(p['to'])}, ${f(p['from'])} + 1e-3), 1.0 - graphScreenOcclusion())` };
    },
  },
  {
    // 边角和缝：凸起的棱边（edges，磨损、掉漆、磨亮的地方）和凹进去的缝（cavities，积灰、锈）。读屏幕空间的曲率（GTAO 顺带算的，
    // 同 occlusionMask 要场景开环境光遮蔽；量的是在约 3 厘米上弯了多少），白盒、SDF 这些没有唯一 UV 的模型也有。from、to 是曲率
    // 从哪儿开始算、到哪儿算满
    type: 'curvatureMask', category: 'mask', inputs: [], outputs: [{ name: 'edges', type: 'float' }, { name: 'cavities', type: 'float' }],
    params: [
      { name: 'from', type: num(0, 1, 0.02), default: 0.1, description: 'how sharply the surface must bend before the mask starts' },
      { name: 'to', type: num(0, 1, 0.02), default: 0.4, description: 'bend where the mask reaches 1' },
    ],
    emit: (_, p, context) => {
      context.addFunction('graphScreenCurvature', SCREEN_CURVATURE);
      const ramp = (x: string) => `smoothstep(${f(p['from'])}, max(${f(p['to'])}, ${f(p['from'])} + 1e-3), ${x})`;
      return { edges: ramp('graphScreenCurvature()'), cavities: ramp('-graphScreenCurvature()') };
    },
  },
  {
    // 离相机近是 1、远是 0（细节贴图只在近处叠：远处一个像素盖住好多个纹素，叠上去只剩闪烁和摩尔纹）
    type: 'distanceFade', category: 'mask', inputs: [], outputs: [{ name: 'mask', type: 'float' }],
    params: [
      { name: 'near', type: num(0, undefined, 1), default: 5, description: 'distance (m) up to which the mask is 1' },
      { name: 'far', type: num(0, undefined, 1), default: 20, description: 'distance where it reaches 0' },
    ],
    emit: (_, p) => ({ mask: `(1.0 - smoothstep(${f(p['near'])}, max(${f(p['far'])}, ${f(p['near'])} + 1e-3), distance(streams.world, view.eye.xyz)))` }),
  },
  {
    // 调色（HSV）：色相偏移（0..1 一圈）、饱和度和明度的倍数
    type: 'adjustHsv', category: 'math', inputs: [{ name: 'in', type: 'color', fallback: 'vec4f(0.5)' }], outputs: [{ name: 'out', type: 'color' }],
    params: [{ name: 'hue', type: num(-1, 1, 0.01), default: 0 }, { name: 'saturation', type: num(0, undefined, 0.05), default: 1 }, { name: 'value', type: num(0, undefined, 0.05), default: 1 }],
    emit: (i, p, context) => {
      context.addFunction('graphHsv', HSV);
      const hsv = `graphRgbToHsv(${i['in']}.rgb)`;
      return { out: `vec4f(graphHsvToRgb(vec3f(fract(${hsv}.x + ${f(p['hue'])}), clamp(${hsv}.y * ${f(p['saturation'])}, 0.0, 1.0), ${hsv}.z * ${f(p['value'])})), ${i['in']}.a)` };
    },
  },
  {
    // 混合模式：上面的（b）按模式压在下面的（a）上，t 是压多少
    type: 'blend', category: 'math',
    inputs: [{ name: 'a', type: 'color', fallback: 'vec4f(0.5)' }, { name: 'b', type: 'color', fallback: 'vec4f(0.5)' }, { name: 't', type: 'float', fallback: '1.0' }],
    outputs: [{ name: 'out', type: 'color' }],
    params: [{ name: 'mode', type: { kind: 'enum', values: ['screen', 'softLight', 'hardLight', 'difference', 'lighten', 'darken', 'colorDodge', 'linearBurn'] }, default: 'screen' }],
    emit: ({ a, b, t }, p, context) => {
      context.addFunction('graphBlend', BLEND);
      const mode = ['screen', 'softLight', 'hardLight', 'difference', 'lighten', 'darken', 'colorDodge', 'linearBurn'].indexOf(String(p['mode']));
      return { out: `vec4f(mix(${a}.rgb, graphBlend(${a}.rgb, ${b}.rgb, ${Math.max(mode, 0)}), clamp(${t}, 0.0, 1.0)), ${a}.a)` };
    },
  },
  {
    // 函数：对输入的每个分量做一个小运算。a、b 是运算的参数（阶跃、平滑阶跃的边，波的频率……）
    type: 'function', category: 'math', inputs: [{ name: 'in', type: 'color', fallback: 'vec4f(0.5)' }], outputs: [{ name: 'out', type: 'color' }],
    params: [
      { name: 'operation', type: { kind: 'enum', values: ['abs', 'sin', 'fract', 'floor', 'sqrt', 'square', 'step', 'smoothstep', 'triangle', 'clamp', 'remap'] }, default: 'smoothstep' },
      { name: 'a', type: num(undefined, undefined, 0.05), default: 0.3, description: 'step: the edge; smoothstep and clamp: the low edge; sin: the frequency; remap: the new minimum' },
      { name: 'b', type: num(undefined, undefined, 0.05), default: 0.7, description: 'smoothstep and clamp: the high edge; remap: the new maximum' },
    ],
    emit: (i, p) => {
      const x = `${i['in']}.rgb`, a = f(p['a']), b = f(p['b']);
      const ops: Record<string, string> = {
        abs: `abs(${x})`,
        sin: `(0.5 + 0.5 * sin(${x} * ${a} * 6.2831853))`,
        fract: `fract(${x})`,
        floor: `floor(${x})`,
        sqrt: `sqrt(max(${x}, vec3f(0.0)))`,
        square: `(${x} * ${x})`,
        step: `step(vec3f(${a}), ${x})`,
        smoothstep: `smoothstep(vec3f(${a}), vec3f(${b}), ${x})`,
        triangle: `abs(fract(${x}) * 2.0 - 1.0)`,
        clamp: `clamp(${x}, vec3f(${a}), vec3f(${b}))`,
        remap: `mix(vec3f(${a}), vec3f(${b}), clamp(${x}, vec3f(0.0), vec3f(1.0)))`,
      };
      return { out: `vec4f(${ops[String(p['operation'])] ?? ops['smoothstep']!}, ${i['in']}.a)` };
    },
  },
  {
    type: 'colorRamp', category: 'math', inputs: [{ name: 't', type: 'float', fallback: '0.5' }], outputs: [{ name: 'color', type: 'color' }],
    params: [
      { name: 'from', type: color, default: [0, 0, 0], description: 'color at 0' },
      { name: 'to', type: color, default: [1, 1, 1], description: 'color at 1' },
      {
        name: 'colorStops',
        type: { kind: 'list', item: { kind: 'object', fields: [{ name: 'position', type: num(0, 1, 0.01) }, { name: 'color', type: color }] } },
        default: [],
        description: 'more colors in between: position (0..1) and color',
      },
      { name: 'interpolation', type: { kind: 'enum', values: ['linear', 'smooth', 'constant'] }, default: 'linear', description: 'between two stops: straight, eased, or a hard step' },
    ],
    emit: ({ t }, p) => ({ color: colorRamp(t!, p) }),
  },
  // 法线和映射
  {
    type: 'normalFromHeight', category: 'normal', inputs: [{ name: 'height', type: 'float', fallback: '0.0' }, UV_IN], outputs: [{ name: 'normal', type: 'vec3' }],
    params: [{ name: 'strength', type: num(0, undefined, 0.1), default: 1 }],
    emit: ({ height, uv }, p, context) => {
      context.addFunction('graphHeightNormal', HEIGHT_NORMAL);
      return { normal: `graphHeightNormal(${height}, ${uv}, ${f(p['strength'])})` };
    },
  },
  {
    type: 'uvTransform', category: 'mapping', inputs: [UV_IN], outputs: [{ name: 'uv', type: 'vec2' }],
    params: [{ name: 'scale', type: vec2, default: [1, 1] }, { name: 'rotation', type: { kind: 'number', step: 5, unit: 'deg' }, default: 0 }, { name: 'offset', type: vec2, default: [0, 0] }],
    emit: ({ uv }, p) => {
      const a = (Number(p['rotation']) * Math.PI) / 180;
      return { uv: `(mat2x2f(${f(Math.cos(a))}, ${f(Math.sin(a))}, ${f(-Math.sin(a))}, ${f(Math.cos(a))}) * ((${uv} - 0.5) * ${v2(p['scale'])}) + 0.5 + ${v2(p['offset'])})` };
    },
  },
  // 滤镜：value 的上游烘进贴图（见文件开头），材质里按 uv 采样
  {
    // 烘焙：把一串贵的节点（多层噪声）算一次存成贴图，材质里只采样一次；也能当缓存换个 uv 平铺
    type: 'bake', category: 'filter', inputs: [BAKED_IN, UV_IN], outputs: [{ name: 'color', type: 'color' }],
    params: [RESOLUTION],
    emit: ({ uv }, _, context) => ({ color: context.baked(uv!) ?? MISSING }),
  },
  {
    // 模糊：高斯模糊，烘的时候在 GPU 上做（横竖两遍、四边按平铺接上）；半径大时在小一级的 mip 上模糊，开销不随半径涨
    type: 'blur', category: 'filter', inputs: [BAKED_IN, UV_IN], outputs: [{ name: 'color', type: 'color' }],
    params: [{ name: 'radius', type: num(0, 0.25, 0.005), default: 0.02, description: 'blur radius in UV (0.02 is 2% of the texture)' }, RESOLUTION],
    emit: ({ uv }, _, context) => ({ color: context.baked(uv!) ?? MISSING }),
  },
  {
    // 扭曲（Substance 的 Directional Warp）：在 uv 挪开 amount · strength 的地方取 value，方向是 angle；amount 不烘，
    // 接噪声就是被噪声扭过的图案（大理石的纹、木纹）
    type: 'warp', category: 'filter', inputs: [BAKED_IN, { name: 'amount', type: 'float', fallback: '0.0' }, UV_IN], outputs: [{ name: 'color', type: 'color' }],
    params: [
      { name: 'strength', type: num(undefined, undefined, 0.01), default: 0.1, description: 'how far to move, in UV, when amount is 1' },
      { name: 'angle', type: { kind: 'number', step: 5, unit: 'deg' }, default: 0, description: 'direction to move (0 is +u)' },
      RESOLUTION,
    ],
    emit: ({ amount, uv }, p, context) => {
      const a = (Number(p['angle']) * Math.PI) / 180;
      // 取到百万分之一：90° 的 cos 不是正好 0
      const along = (x: number) => f(Math.round(x * Number(p['strength']) * 1e6) / 1e6);
      const direction = `vec2f(${along(Math.cos(a))}, ${along(Math.sin(a))})`;
      return { color: context.baked(`(${uv} + ${amount} * ${direction})`) ?? MISSING };
    },
  },
];

/** 滤镜节点的种类：value 输入烘进贴图的。 */
export const BAKED_NODE_TYPES: ReadonlySet<string> = new Set(['bake', 'blur', 'warp']);

const NODES_BY_TYPE = new Map(MATERIAL_NODES.map((node) => [node.type, node]));

/** 节点库的描述（编辑器的节点图面板用）。 */
export const MATERIAL_NODE_SPECS: readonly NodeSpec[] = MATERIAL_NODES;

/** 节点（贴图、三平面投影）引用的贴图资源（内容路径）：加载材质时先加载它们，编辑器改名、移动时改写。 */
export function materialGraphTextures(graph: GraphFile): string[] {
  return graph.nodes.flatMap((node) => (typeof node.params?.['texture'] === 'string' ? [node.params['texture']] : []));
}

/** 编译的结果：WGSL（私有变量和 materialGraph 函数）和接上了的输出。 */
export interface CompiledMaterialGraph {
  readonly code: string;
  readonly outputs: ReadonlySet<MaterialGraphOutput>;
}

/**
 * 编成 WGSL。compiler 是同一份材质里颜色树用的编译器（贴图的绑定、库函数共用）；textures 给加载好的贴图资源（内容路径 →
 * 贴图在 compiler 里的采样，由调用方实现）。认不出的节点、接错的端口报错（where 用在消息里）。suffix 区分同一个材质里的
 * 几张图（材质的和各个绘制层的）：函数是 `materialGraph<suffix>()`，输出在 `graph<suffix>_<输出>` 里。
 */
export function compileMaterialGraph(graph: GraphFile, compiler: Pick<ColorTreeCompiler, 'addFunction'>, sample: (texture: string, uv: string) => string | undefined, where: string, suffix = ''): CompiledMaterialGraph {
  const { lines, values } = emitMaterialGraphNodes(graph, compiler, sample, where);
  const outputs = new Set<MaterialGraphOutput>();
  const declarations: string[] = [];
  for (const [name, type] of Object.entries(MATERIAL_GRAPH_OUTPUTS) as [MaterialGraphOutput, PortType][]) {
    const link = graph.outputs[name];
    if (!link) continue;
    outputs.add(name);
    declarations.push(`var<private> graph${suffix}_${name}: ${WGSL_TYPES[type]};`);
    lines.push(`  graph${suffix}_${name} = ${convertGraphValue(linked(values, link, `output ${name}`, where), type)};`);
  }
  return { code: `${declarations.join('\n')}\nfn materialGraph${suffix}() {\n${lines.join('\n')}\n}\n`, outputs };
}

/** 一个节点算出的值：WGSL 的变量名和种类。 */
export interface MaterialGraphValue {
  readonly expr: string;
  readonly type: PortType;
}

/**
 * 按依赖排好的节点每个算一次：每个输出一行 `let g_<节点>_<输出> = …;`。values 按 `节点:输出` 找到变量（`节点:` 是第一个输出）。
 * compileMaterialGraph 和节点的预览（materialGraphPreview.ts）共用；all 时没接到输出的节点也算（预览要每个节点）。
 */
export function emitMaterialGraphNodes(graph: GraphFile, compiler: Pick<ColorTreeCompiler, 'addFunction'>, sample: (texture: string, uv: string) => string | undefined, where: string, options: { readonly all?: boolean } = {}): { readonly lines: string[]; readonly values: ReadonlyMap<string, MaterialGraphValue> } {
  // 滤镜节点的 value 已经烘进贴图：它的上游不用在材质里再算一遍（只给它烘的，预览要每个节点时照样算）
  const live = { ...graph, nodes: graph.nodes.map((node) => (BAKED_NODE_TYPES.has(node.type) && node.inputs?.['value'] ? { ...node, inputs: withoutKey(node.inputs, 'value') } : node)) };
  const order = sortGraph(live, where, options);
  const lines: string[] = [];
  const values = new Map<string, MaterialGraphValue>();
  for (const node of order) {
    const context: EmitContext = { addFunction: (name, code) => compiler.addFunction(name, code), sample, baked: (uv) => sample(bakedTextureKey(node.id), uv) };
    const spec = NODES_BY_TYPE.get(node.type);
    if (!spec) throw new Error(`${where}: node '${node.id}' has the unknown type '${node.type}'`);
    const inputs: Record<string, string> = {};
    for (const port of spec.inputs) {
      const link = node.inputs?.[port.name];
      inputs[port.name] = link ? convertGraphValue(linked(values, link, `input ${port.name} of node '${node.id}'`, where), port.type) : port.fallback;
    }
    for (const name of Object.keys(node.inputs ?? {})) if (!spec.inputs.some((port) => port.name === name)) throw new Error(`${where}: node '${node.id}' (${node.type}) has no input '${name}'`);
    const params = Object.fromEntries(spec.params.map((param) => [param.name, node.params?.[param.name] ?? param.default]));
    const emitted = spec.emit(inputs, params, context);
    for (const output of spec.outputs) {
      const variable = `g_${safe(node.id)}_${output.name}`;
      lines.push(`  let ${variable} = ${emitted[output.name]};`);
      values.set(`${node.id}:${output.name}`, { expr: variable, type: output.type });
      // 没写输出名的连线接第一个输出
      if (output === spec.outputs[0]) values.set(`${node.id}:`, { expr: variable, type: output.type });
    }
  }
  return { lines, values };
}

function linked(values: ReadonlyMap<string, MaterialGraphValue>, link: GraphLink, what: string, where: string): MaterialGraphValue {
  const found = values.get(`${link.node}:${link.output ?? ''}`);
  if (!found) throw new Error(`${where}: ${what} is linked to output '${link.output ?? ''}' of node '${link.node}', which it does not have`);
  return found;
}

/** 种类之间的转换：数到向量是重复（颜色的 alpha 是 1），向量到数取第一个分量。 */
export function convertGraphValue({ expr, type }: MaterialGraphValue, to: PortType): string {
  if (type === to) return expr;
  const component = { float: expr, vec2: `${expr}.x`, vec3: `${expr}.x`, color: `${expr}.r` }[type];
  switch (to) {
    case 'float': return component;
    case 'vec2': return type === 'float' ? `vec2f(${expr})` : `${expr}.xy`;
    case 'vec3': return type === 'float' ? `vec3f(${expr})` : type === 'vec2' ? `vec3f(${expr}, 0.0)` : `${expr}.rgb`;
    case 'color': return type === 'float' ? `vec4f(vec3f(${expr}), 1.0)` : type === 'vec2' ? `vec4f(${expr}, 0.0, 1.0)` : `vec4f(${expr}, 1.0)`;
  }
}

/**
 * 多段的颜色渐变：起点（0）、中间的色标（按位置排好）、终点（1）连成一串 mix。每一段的比例在 t 之前的段上是 1、之后的段上
 * 是 0，所以结果正好是 t 所在那一段的插值；不用分支，也不用数组。
 */
function colorRamp(t: string, p: Readonly<Record<string, unknown>>): string {
  const middle = (Array.isArray(p['colorStops']) ? (p['colorStops'] as { position?: unknown; color?: unknown }[]) : [])
    .map((stop) => ({ at: Math.min(Math.max(Number(stop.position) || 0, 0), 1), color: stop.color }))
    .sort((a, b) => a.at - b.at);
  const stops = [{ at: 0, color: p['from'] }, ...middle, { at: 1, color: p['to'] }];
  const x = `clamp(${t}, 0.0, 1.0)`;
  let result = rgb(stops[0]!.color);
  for (let k = 1; k < stops.length; k++) {
    const a = stops[k - 1]!.at, b = stops[k]!.at;
    const fraction = b - a > 1e-6 ? `clamp((${x} - ${f(a)}) / ${f(b - a)}, 0.0, 1.0)` : `step(${f(b)}, ${x})`;
    const weight = p['interpolation'] === 'constant' ? `step(${f(b)}, ${x})` : p['interpolation'] === 'smooth' ? `smoothstep(0.0, 1.0, ${fraction})` : fraction;
    result = `mix(${result}, ${rgb(stops[k]!.color)}, ${weight})`;
  }
  return result;
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function f(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0';
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

function v2(value: unknown): string {
  const [x, y] = (Array.isArray(value) ? value : [0, 0]) as number[];
  return `vec2f(${f(x)}, ${f(y)})`;
}

function rgb(value: unknown): string {
  const [r, g, b] = (Array.isArray(value) ? value : [1, 1, 1]) as number[];
  return `vec4f(${f(r)}, ${f(g)}, ${f(b)}, 1.0)`;
}
