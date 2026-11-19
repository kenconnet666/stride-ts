/**
 * 粒子材质（Stride 的 ParticleMaterial）编译成 WGSL 函数 `materialColor() -> vec4f`（Stride 的 Shading()：组件的颜色乘材质的颜色），
 * 每种不同的代码一个着色器，同样的代码共用流水线。函数从共用的 `streams`（MaterialStreams，见 shaderClass.ts）读 UV、粒子的颜色、
 * 组件的颜色、时间；渲染器之后把 alpha 乘 1 - AlphaAdditive。
 *
 * 引擎的材质是 ParticleMaterialComputeColor：组件的颜色 · 颜色树。游戏的材质继承 ParticleMaterial、导出就按类名登记（同粒子模块），
 * 用 MaterialCompiler 把颜色树编成表达式、拼自己的函数体。颜色树的节点照 Stride 的 ComputeColor：
 * - ComputeTextureColor：采样贴图（按预乘 alpha 用，同 Stride 编译贴图时预乘），UV 乘 Scale 加 Offset，TexcoordIndex 选哪套 UV；
 *   没有贴图时用 FallbackValue；
 * - ComputeTextureScalar：采样贴图的一个通道（Channel，默认 R），四个分量都是它；
 * - ComputeVertexStreamColor：粒子的颜色（顶点颜色）；
 * - ComputeFloat4、ComputeFloat：常量；ComputeColor：常量颜色，换到线性空间、预乘 alpha（同 Stride 的 ToColorSpace、PremultiplyAlpha）；
 * - ComputeBinaryColor：两个子节点按 Operator 合成（现在有 Multiply、Add、Subtract、Overlay，别的先当 Multiply 并警告）；
 * - ComputeShaderClassColor：游戏登记的着色器类（Stride 的 .sdsl 着色器类写成 WGSL），泛型参数按名字传。
 * 认不出的节点当白色。
 */
import type { ParticleModuleFile, ParticleValue, TextureRef, TextureSampler } from '../content/format';
import { srgbToLinear } from '../mathematics/vectors';
import type { ShaderClass } from '../rendering/shaderClass';
import type { Texture } from '../rendering/Texture';
import { value, type ParticleModuleKind } from './modules';

/** 粒子的 UV 帧 [u, v, 宽, 高]（按剩下的寿命，材质的 UVBuilder：翻页或滚动）。 */
export type UVFrame = (remainingLife: number) => readonly [number, number, number, number];

/** 两套 UV 的帧（顶点里的 TEXCOORD0、TEXCOORD1，都从形状给的 UV 变换出来）。 */
export interface UVFrames {
  readonly uv: UVFrame;
  readonly uv1: UVFrame;
}

/** 一个材质编译出来的着色器片段和它用到的贴图（按绑定的顺序）。 */
export interface MaterialProgram extends UVFrames {
  /** 贴图（`t0`、`s0`、`t1`、`s1`……）、函数和 `fn materialColor() -> vec4f`。 */
  readonly code: string;
  readonly textures: readonly { readonly texture: Texture; readonly sampler: TextureSampler }[];
  /** 乘在 alpha 上的系数：1 - AlphaAdditive（0 就是加法混合）。 */
  readonly alphaFactor: number;
}

/** 编译材质要的外部东西。 */
export interface MaterialContext {
  /** 按内容路径给加载好的贴图。 */
  readonly texture: (path: string) => Texture | undefined;
  /** 按名字（Stride 的 MixinReference）找游戏登记的着色器类。 */
  readonly shaderClass: (name: string) => ShaderClass | undefined;
}

const WHOLE = [0, 0, 1, 1] as const;
const WHITE = 'vec4f(1.0)';
/** 二元运算里写成函数的（Stride 的 ComputeColorOverlay：b <= 0.5 时取 screen 那一支，照抄 Stride 的 step(b, 0.5)）。 */
const OPERATORS: Readonly<Record<string, string>> = {
  overlay: 'fn overlay(a: vec4f, b: vec4f) -> vec4f {\n  return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(b, vec4f(0.5)));\n}\n',
};
const warned = new Set<string>();

/** 把一个材质的颜色树编成 WGSL 表达式，收集用到的贴图和函数，最后拼成 MaterialProgram。 */
export class MaterialCompiler {
  readonly #material: ParticleModuleFile;
  readonly #context: MaterialContext;
  readonly #bound: { texture: Texture; sampler: TextureSampler }[] = [];
  /** 名字 → 函数的代码（着色器类、运算符），每个只放一次。 */
  readonly #functions = new Map<string, string>();

  constructor(material: ParticleModuleFile, context: MaterialContext) {
    this.#material = material;
    this.#context = context;
  }

  /** 颜色树（IComputeColor）的 vec4f 表达式。 */
  color(node: ParticleValue | undefined): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return WHITE;
    const file = node as ParticleModuleFile;
    switch (file.$type) {
      case 'computeTextureColor': {
        const texel = this.#sample(file);
        if (texel) return `premultiply(${texel})`;
        return literal4(value(value(file, 'fallbackValue', {} as ParticleModuleFile), 'value', [1, 1, 1, 1]));
      }
      case 'computeTextureScalar': {
        const scalar = this.scalar(file);
        return `vec4f(${scalar})`;
      }
      case 'computeVertexStreamColor':
        return 'streams.color';
      case 'computeFloat4':
        return literal4(value(file, 'value', [1, 1, 1, 1]));
      case 'computeFloat':
        return `vec4f(${float(value(file, 'value', 1))})`;
      case 'computeColor': {
        const [r, g, b, a] = value(file, 'value', [1, 1, 1, 1]);
        const premultiply = value(file, 'premultiplyAlpha', true) ? a! : 1;
        return literal4([srgbToLinear(r!) * premultiply, srgbToLinear(g!) * premultiply, srgbToLinear(b!) * premultiply, a!]);
      }
      case 'computeBinaryColor': {
        const left = this.color(file['leftChild']), right = this.color(file['rightChild']);
        const operator = String(file['operator'] ?? 'multiply');
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
        return this.#shaderClass(file);
      default:
        warnOnce(`color node ${String(file.$type)}`);
        return WHITE;
    }
  }

  /** 标量树（IComputeScalar：ComputeFloat、ComputeTextureScalar）的 f32 表达式；别的节点取颜色树的 r。 */
  scalar(node: ParticleValue | undefined): string {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return '1.0';
    const file = node as ParticleModuleFile;
    switch (file.$type) {
      case 'computeFloat':
        return float(value(file, 'value', 1));
      case 'computeTextureScalar': {
        const texel = this.#sample(file);
        if (!texel) return float(value(file, 'fallbackValue', 1));
        const channel = String(file['channel'] ?? 'r').toLowerCase();
        return `${texel}.${channel.length === 1 && 'rgba'.includes(channel) ? channel : 'r'}`;
      }
      default:
        return `${this.color(node)}.r`;
    }
  }

  /** 拼成程序：body 是 materialColor 的函数体；uv0、uv1 是两套 UV 的 UVBuilder；AlphaAdditive 读材质文件。 */
  program(body: string, uvBuilders: { readonly uv0?: ParticleModuleFile | null | undefined; readonly uv1?: ParticleModuleFile | null | undefined } = {}): MaterialProgram {
    const declarations = this.#bound.map((_, i) => `@group(1) @binding(${i * 2}) var t${i}: texture_2d<f32>;\n@group(1) @binding(${i * 2 + 1}) var s${i}: sampler;\n`).join('');
    return {
      code: `${declarations}${[...this.#functions.values()].join('')}fn materialColor() -> vec4f {\n${body}\n}\n`,
      textures: this.#bound,
      alphaFactor: 1 - value(this.#material, 'alphaAdditive', 0),
      uv: uvBuilder(uvBuilders.uv0),
      uv1: uvBuilder(uvBuilders.uv1),
    };
  }

  /** 贴图节点的采样表达式（没有贴图时是 undefined）：TexcoordIndex 是 Texcoord1 时用第二套 UV。 */
  #sample(node: ParticleModuleFile): string | undefined {
    const ref = node['texture'] as TextureRef | null | undefined;
    const texture = ref ? this.#context.texture(ref.texture) : undefined;
    if (!texture) return undefined;
    const i = this.#bound.push({ texture, sampler: samplerOf(node) }) - 1;
    const [sx, sy] = value(node, 'scale', [1, 1]), [ox, oy] = value(node, 'offset', [0, 0]);
    const uv = value<string>(node, 'texcoordIndex', 'texcoord0') === 'texcoord1' ? 'streams.uv1' : 'streams.uv';
    return `textureSample(t${i}, s${i}, ${uv} * vec2f(${float(sx!)}, ${float(sy!)}) + vec2f(${float(ox!)}, ${float(oy!)}))`;
  }

  /** 着色器类：调用游戏登记的 WGSL 函数，泛型参数（ComputeColorParameter*）按着色器类声明的顺序传。 */
  #shaderClass(node: ParticleModuleFile): string {
    const name = String(node['mixinReference'] ?? '');
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

/** 粒子材质（Stride 的 ParticleMaterial）。游戏的材质继承它，构造参数是场景里的属性。 */
export abstract class ParticleMaterial {
  /** Registry 按它认出粒子模块。 */
  static readonly particleModuleKind: ParticleModuleKind = 'material';
  readonly file: ParticleModuleFile;

  constructor(file: ParticleModuleFile) {
    this.file = file;
  }

  abstract compile(compiler: MaterialCompiler): MaterialProgram;
}

/** Stride 的 ParticleMaterialComputeColor：组件的颜色 · 颜色树（ComputeColor），一套 UV（UVBuilder）。 */
export class ParticleMaterialComputeColor extends ParticleMaterial {
  compile(compiler: MaterialCompiler): MaterialProgram {
    const body = `  return streams.colorScale * ${compiler.color(this.file['computeColor'])};`;
    return compiler.program(body, { uv0: this.file['uvBuilder'] as ParticleModuleFile | null | undefined });
  }
}

function uvBuilder(file: ParticleModuleFile | null | undefined): UVFrame {
  if (file?.$type === 'uvBuilderFlipbook') return flipbookOf(file);
  if (file?.$type === 'uvBuilderScroll') return scrollOf(file);
  return () => WHOLE;
}

/** UV 滚动（Stride 的 UVBuilderScroll）：按走过的寿命从 StartFrame 线性移到 EndFrame（两个都是 [左, 上, 右, 下]）。 */
export function scrollOf(file: ParticleModuleFile): (remainingLife: number) => [number, number, number, number] {
  const start = value(file, 'startFrame', [0, 0, 1, 1]), end = value(file, 'endFrame', [0, 1, 1, 2]);
  return (remainingLife) => {
    const t = 1 - remainingLife;
    const [left, top, right, bottom] = start.map((s, k) => s + (end[k]! - s) * t) as [number, number, number, number];
    return [left, top, right - left, bottom - top];
  };
}

/** 翻页动画（Stride 的 UVBuilderFlipbook）：按走过的寿命取第几帧，返回这一帧在贴图上的 [u, v, 宽, 高]。 */
export function flipbookOf(file: ParticleModuleFile): (remainingLife: number) => [number, number, number, number] {
  const x = Math.max(1, value(file, 'xDivisions', 4)), y = Math.max(1, value(file, 'yDivisions', 4));
  const start = Math.min(value(file, 'startingFrame', 0), x * y);
  const speed = value(file, 'animationSpeed', 16);
  return (remainingLife) => {
    const frame = start + Math.trunc((1 - remainingLife) * speed);
    return [(frame % x) / x, Math.floor(frame / x) / y, 1 / x, 1 / y];
  };
}

/** 贴图节点的采样器（Stride 的 Filtering、AddressModeU/V；Border 当 Clamp，MirrorOnce 当 Mirror）。 */
function samplerOf(node: ParticleModuleFile): TextureSampler {
  const address = (key: string): TextureSampler['addressU'] => {
    const mode = String(node[key] ?? 'wrap');
    return mode === 'clamp' || mode === 'border' ? 'clamp' : mode.startsWith('mirror') ? 'mirror' : undefined;
  };
  const filtering = String(node['filtering'] ?? 'linear');
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
  console.warn(`[stride] particle material: ${what} is not supported yet; using a fallback`);
}
