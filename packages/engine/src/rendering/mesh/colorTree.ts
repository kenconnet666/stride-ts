/**
 * 颜色树（Stride 材质的 IComputeColor、IComputeScalar）编译成 WGSL 表达式，粒子材质和网格材质共用。表达式从共用的 `streams`
 * （MaterialStreams，见 shaderClass.ts）读 UV、顶点颜色、时间。节点照 Stride 的 ComputeColor：
 * - ComputeTextureColor：采样贴图（按预乘 alpha 用，同 Stride 编译贴图时预乘），UV 乘 Scale 加 Offset，TexcoordIndex 选哪套 UV；
 *   没有贴图时用 FallbackValue；UseRandomTextureCoordinates 时每个 UV 格子里的贴图随机翻转、旋转、平移（清漆的金属碎片）；
 * - ComputeTextureScalar：采样贴图的一个通道（Channel，默认 R），四个分量都是它；
 * - ComputeVertexStreamColor：顶点颜色（粒子的颜色）；
 * - ComputeFloat4、ComputeFloat：常量；ComputeColor：常量颜色，换到线性空间、预乘 alpha（同 Stride 的 ToColorSpace、PremultiplyAlpha）；
 * - ComputeBinaryColor、ComputeBinaryScalar：两个子节点按 Operator 合成（现在有 Multiply、Add、Subtract、Overlay，别的先当 Multiply 并警告）；
 * - ComputeSoftCircle（我们加的）：柔和的圆点，粒子的默认材质用；
 * - ComputeShaderClassColor：游戏登记的着色器类（Stride 的 .sdsl 着色器类写成 WGSL），泛型参数按名字传。
 * 认不出的节点当白色。树的格式同粒子模块（ParticleModuleFile：$type 是首字母小写的类名，贴图是 TextureRef）。
 */
import { textOf } from '../../data/text.ts';
import type { ParticleModuleFile, ParticleValue, TextureRef, TextureSampler } from '../../content/formats/format';
import { srgbToLinear } from '../../data/vectors';
import type { ShaderClass } from '../shaderClass';
import type { Texture } from '../../graphics/Texture';

/** 编译颜色树要的外部东西。 */
export interface MaterialContext {
  /** 按内容路径给加载好的贴图。 */
  readonly texture: (path: string) => Texture | undefined;
  /** 按名字（Stride 的 MixinReference）找游戏登记的着色器类。 */
  readonly shaderClass: (name: string) => ShaderClass | undefined;
}

const WHITE = 'vec4f(1.0)';
/** 二元运算里写成函数的（Stride 的 ComputeColorOverlay：b <= 0.5 时取 screen 那一支，照抄 Stride 的 step(b, 0.5)）。 */
const OPERATORS: Readonly<Record<string, string>> = {
  overlay: 'fn overlay(a: vec4f, b: vec4f) -> vec4f {\n  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(b, vec4f(0.5)));\n}\n',
};
/**
 * UseRandomTextureCoordinates（Stride 的 ComputeColorTextureScaledOffsetDynamicSamplerRandomUV）：按 UV 所在的整数格子取一个伪随机数，
 * 决定格子里的贴图怎么翻转、转 90° 的几倍、平移四分之几，256 种里挑一种；平铺的小贴图看不出重复。
 * 和 Stride 不同：采样时用打乱之前的坐标的导数（textureSampleGrad）。打乱以后的坐标在格子边上是断的，照它自己的导数选 mip，
 * 每个格子的边上会取到最小的一级，画出一圈模糊的线。
 */
const RANDOM_UV = `fn randomUv(uv: vec2f) -> vec2f {
  var pattern = u32(fract(sin(dot(floor(uv), vec2f(12.9898, 78.233) * 2.0)) * 43758.5453) * 256.0) % 256u;
  var r = fract(uv);
  r.x = select(r.x, 1.0 - r.x, pattern % 2u != 0u);
  pattern /= 2u;
  r.y = select(r.y, 1.0 - r.y, pattern % 2u != 0u);
  pattern /= 2u;
  let turn = pattern % 4u;
  r = select(select(select(r, vec2f(r.y, 1.0 - r.x), turn == 1u), vec2f(1.0 - r.y, r.x), turn == 2u), 1.0 - r, turn == 3u);
  pattern /= 4u;
  return r + vec2f(f32(pattern % 4u), f32((pattern / 4u) % 4u)) * 0.25;
}
`;
/** TextureRef.invertY 的贴图采样后翻转绿色通道。 */
const FLIP_GREEN = 'fn flipGreen(texel: vec4f) -> vec4f {\n  return vec4f(texel.r, 1.0 - texel.g, texel.b, texel.a);\n}\n';
const warned = new Set<string>();

/** 节点的属性：没写时取默认值。 */
function get<T extends ParticleValue>(node: ParticleModuleFile | undefined, key: string, fallback: T): T {
  const found = node?.[key];
  return (found === undefined || found === null ? fallback : found) as T;
}

/** 把颜色树编成 WGSL 表达式，收集用到的贴图（声明在 group 组）和函数。 */
export class ColorTreeCompiler {
  readonly #context: MaterialContext;
  readonly #group: number;
  readonly #bound: { texture: Texture; sampler: TextureSampler }[] = [];
  /** 名字 → 函数的代码（着色器类、运算符），每个只放一次。 */
  readonly #functions = new Map<string, string>();
  /** 正在编译顶点着色器里的树：贴图按第 0 级 mip 取（顶点着色器里没有导数，不能用 textureSample）。 */
  #vertex = false;

  /** group：贴图绑定在哪个绑定组（第 i 张在绑定 2i、采样器在 2i + 1）。 */
  constructor(context: MaterialContext, group: number) {
    this.#context = context;
    this.#group = group;
  }

  /** 用到的贴图，按绑定的顺序。 */
  get textures(): readonly { readonly texture: Texture; readonly sampler: TextureSampler }[] {
    return this.#bound;
  }

  /** 贴图的声明和用到的函数，放在调用表达式的函数前面。 */
  get declarations(): string {
    const textures = this.#bound.map((_, i) => `@group(${this.#group}) @binding(${i * 2}) var t${i}: texture_2d<f32>;\n@group(${this.#group}) @binding(${i * 2 + 1}) var s${i}: sampler;\n`).join('');
    return `${textures}${[...this.#functions.values()].join('')}`;
  }

  /** 颜色树（IComputeColor）的 vec4f 表达式。 */
  color(node: ParticleValue | undefined): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return WHITE;
    const file = node as ParticleModuleFile;
    switch (file.$type) {
      case 'computeTextureColor': {
        const texel = this.#sample(file);
        if (texel) return `premultiply(${texel})`;
        return literal4(get(get(file, 'fallbackValue', {} as ParticleModuleFile), 'value', [1, 1, 1, 1]));
      }
      case 'computeTextureScalar': {
        const scalar = this.scalar(file);
        return `vec4f(${scalar})`;
      }
      case 'computeVertexStreamColor':
        return 'streams.color';
      case 'computeSoftCircle': {
        // 和 Stride 不同（我们加的）：UV 中心到边上从 1 渐变到 0 的圆点（粒子不用另带一张圆点贴图），乘上粒子的颜色（预乘的，
        // 颜色随时间这类更新器给的；同 Stride 里贴图乘顶点流颜色的常见写法）；hardness 越大中间实的越多
        const hardness = Math.min(Math.max(get(file, 'hardness', 0), 0), 0.99);
        return `(streams.color * (1.0 - smoothstep(${float(hardness)}, 1.0, length(streams.uv * 2.0 - 1.0))))`;
      }
      case 'computeFloat4':
        return literal4(get(file, 'value', [1, 1, 1, 1]));
      case 'computeFloat':
        return `vec4f(${float(get(file, 'value', 1))})`;
      case 'computeColor': {
        const [r, g, b, a] = get(file, 'value', [1, 1, 1, 1]);
        const premultiply = get(file, 'premultiplyAlpha', true) ? a! : 1;
        return literal4([srgbToLinear(r!) * premultiply, srgbToLinear(g!) * premultiply, srgbToLinear(b!) * premultiply, a!]);
      }
      case 'computeBinaryColor':
      case 'computeBinaryScalar': {
        const left = this.color(file['leftChild']), right = this.color(file['rightChild']);
        const operator = textOf(file['operator'], 'multiply');
        if (operator === 'add') return `(${left} + ${right})`;
        if (operator === 'subtract') return `(${left} - ${right})`;
        if (operator in OPERATORS) {
          this.#functions.set(operator, OPERATORS[operator]!);
          return `${operator}(${left}, ${right})`;
        }
        if (operator !== 'multiply') warnOnce(`binary color operator ${operator}`);
        return `(${left} * ${right})`;
      }
      case 'computeShaderClassColor':
      case 'computeShaderClassScalar':
        return this.#shaderClass(file);
      default:
        warnOnce(`color node ${String(file.$type)}`);
        return WHITE;
    }
  }

  /** 顶点着色器里的标量树（位移贴图）的 f32 表达式。 */
  vertexScalar(node: ParticleValue | undefined): string {
    this.#vertex = true;
    try {
      return this.scalar(node);
    } finally {
      this.#vertex = false;
    }
  }

  /** 标量树（IComputeScalar：ComputeFloat、ComputeTextureScalar）的 f32 表达式；别的节点取颜色树的 r。 */
  scalar(node: ParticleValue | undefined): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return '1.0';
    const file = node as ParticleModuleFile;
    switch (file.$type) {
      case 'computeFloat':
        return float(get(file, 'value', 1));
      case 'computeTextureScalar': {
        const texel = this.#sample(file);
        // FallbackValue 是 ComputeFloat，导出成 { value }
        if (!texel) return float(get(get(file, 'fallbackValue', {} as ParticleModuleFile), 'value', 1));
        const channel = textOf(file['channel'], 'r').toLowerCase();
        return `${texel}.${channel.length === 1 && 'rgba'.includes(channel) ? channel : 'r'}`;
      }
      default:
        return `${this.color(node)}.r`;
    }
  }

  /** 登记一个库函数（按名字，每个只放一次）；材质节点图（materialGraph.ts）用。 */
  addFunction(name: string, code: string): void {
    this.#functions.set(name, code);
  }

  /** 在 uv（WGSL 表达式）处采样一张贴图，绑定和颜色树的贴图共用；材质节点图用。值是贴图原样的颜色（不预乘）。 */
  sampleTexture(texture: Texture, uv: string, sampler: TextureSampler = {}): string {
    const i = this.#bound.push({ texture, sampler }) - 1;
    return this.#vertex ? `textureSampleLevel(t${i}, s${i}, ${uv}, 0.0)` : `textureSample(t${i}, s${i}, ${uv})`;
  }

  /** 贴图节点的采样表达式（没有贴图时是 undefined）：TexcoordIndex 是 Texcoord1 时用第二套 UV。 */
  #sample(node: ParticleModuleFile): string | undefined {
    const ref = node['texture'] as TextureRef | null | undefined;
    const texture = ref ? this.#context.texture(ref.texture) : undefined;
    if (!texture) return undefined;
    const i = this.#bound.push({ texture, sampler: samplerOf(node) }) - 1;
    const [sx, sy] = get(node, 'scale', [1, 1]), [ox, oy] = get(node, 'offset', [0, 0]);
    const uv = get<string>(node, 'texcoordIndex', 'texcoord0') === 'texcoord1' ? 'streams.uv1' : 'streams.uv';
    const scaled = `${uv} * vec2f(${float(sx!)}, ${float(sy!)}) + vec2f(${float(ox!)}, ${float(oy!)})`;
    const random = get(node, 'useRandomTextureCoordinates', false);
    if (random) this.#functions.set('randomUv', RANDOM_UV);
    const at = random ? `randomUv(${scaled})` : scaled;
    const texel = this.#vertex ? `textureSampleLevel(t${i}, s${i}, ${at}, 0.0)`
      : random ? `textureSampleGrad(t${i}, s${i}, ${at}, dpdx(${scaled}), dpdy(${scaled}))`
      : `textureSample(t${i}, s${i}, ${at})`;
    if (!ref!.invertY) return texel;
    this.#functions.set('flipGreen', FLIP_GREEN);
    return `flipGreen(${texel})`;
  }

  /** 着色器类：调用游戏登记的 WGSL 函数，泛型参数（ComputeColorParameter*）按着色器类声明的顺序传。 */
  #shaderClass(node: ParticleModuleFile): string {
    const name = textOf(node['mixinReference']);
    const found = this.#context.shaderClass(name);
    if (!found) {
      warnOnce(`shader class ${name} (no WGSL registered under that name)`);
      return WHITE;
    }
    this.#functions.set(`class:${name}`, found.code);
    const generics = (node['generics'] as ParticleModuleFile | null | undefined) ?? {};
    const args = found.generics.map((generic) => {
      const parameter = generics[generic] as ParticleModuleFile | undefined;
      if (!parameter) warnOnce(`shader class ${name}: generic ${generic} is missing; using 0`);
      return parameterLiteral(parameter);
    });
    return `${name}(${args.join(', ')})`;
  }
}

/** 贴图节点的采样器（Stride 的 Filtering、AddressModeU/V；Border 当 Clamp，MirrorOnce 当 Mirror）。 */
function samplerOf(node: ParticleModuleFile): TextureSampler {
  const address = (key: string): TextureSampler['addressU'] => {
    const mode = textOf(node[key], 'wrap');
    return mode === 'clamp' || mode === 'border' ? 'clamp' : mode.startsWith('mirror') ? 'mirror' : undefined;
  };
  const filtering = textOf(node['filtering'], 'linear');
  const filter = filtering === 'point' ? 'point' : filtering === 'anisotropic' ? 'anisotropic' : undefined;
  const addressU = address('addressModeU'), addressV = address('addressModeV');
  return { ...(filter ? { filter } : {}), ...(addressU ? { addressU } : {}), ...(addressV ? { addressV } : {}) };
}

/** WGSL 的浮点字面量（整数也带小数点）。 */
function float(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

function literal4(values: readonly number[]): string {
  return `vec4f(${[0, 1, 2, 3].map((k) => float(values[k] ?? 0)).join(', ')})`;
}

/** 着色器类的泛型参数（Stride 的 ComputeColorParameterFloat、Float2、Float3、Float4、Int）的字面量；没有时是 0。 */
function parameterLiteral(parameter: ParticleModuleFile | undefined): string {
  const v = parameter?.['value'];
  switch (parameter?.$type) {
    case 'computeColorParameterFloat4': return literal4(v as number[]);
    case 'computeColorParameterFloat3': return `vec3f(${(v as number[]).slice(0, 3).map(float).join(', ')})`;
    case 'computeColorParameterFloat2': return `vec2f(${(v as number[]).slice(0, 2).map(float).join(', ')})`;
    case 'computeColorParameterInt': return `${Math.trunc(Number(v ?? 0))}i`;
    default: return float(Number(v ?? 0));
  }
}

function warnOnce(what: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[stride] material color tree: ${what} is not supported yet; using a fallback`);
}
