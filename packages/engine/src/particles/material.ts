/**
 * 粒子材质（Stride 的 ParticleMaterial）编译成 WGSL 函数 `materialColor() -> vec4f`（Stride 的 Shading()：组件的颜色乘材质的颜色），
 * 每种不同的代码一个着色器，同样的代码共用流水线。函数从共用的 `streams`（MaterialStreams，见 shaderClass.ts）读 UV、粒子的颜色、
 * 组件的颜色、时间；渲染器之后把 alpha 乘 1 - AlphaAdditive。
 *
 * 引擎的材质是 ParticleMaterialComputeColor：组件的颜色 · 颜色树。游戏的材质继承 ParticleMaterial、导出就按类名登记（同粒子模块），
 * 用 MaterialCompiler 把颜色树编成表达式（节点见 colorTree.ts）、拼自己的函数体。
 */
import type { ParticleModuleFile, TextureSampler } from '../content/format';
import { ColorTreeCompiler, type MaterialContext } from '../rendering/mesh/colorTree';
import type { Texture } from '../graphics/Texture';
import { value, type ParticleModuleKind } from './modules';

export type { MaterialContext } from '../rendering/mesh/colorTree';

/** 粒子的 UV 帧 [u, v, 宽, 高]（按剩下的寿命，材质的 UVBuilder：翻页或滚动）。 */
export type UVFrame = (remainingLife: number) => readonly [number, number, number, number];

/**
 * UVBuilder 的参数（GPU 的粒子在顶点着色器里算 UV 帧，见 particles/gpu）：整张、翻页（每行几帧、几行、起始帧、速度）、
 * 滚动（起止帧的 [左, 上, 右, 下]）。
 */
export type UVBuilderParams =
  | { readonly kind: 'whole' }
  | { readonly kind: 'flipbook'; readonly x: number; readonly y: number; readonly start: number; readonly speed: number }
  | { readonly kind: 'scroll'; readonly start: readonly [number, number, number, number]; readonly end: readonly [number, number, number, number] };

/** 两套 UV 的帧（顶点里的 TEXCOORD0、TEXCOORD1，都从形状给的 UV 变换出来）。 */
export interface UVFrames {
  readonly uv: UVFrame;
  readonly uv1: UVFrame;
  /** 同样的两套帧的参数；游戏自己的材质拼的程序可以没有（这样的发射器只能在 CPU 上画）。 */
  readonly uvParams?: { readonly uv: UVBuilderParams; readonly uv1: UVBuilderParams };
}

/** 一个材质编译出来的着色器片段和它用到的贴图（按绑定的顺序）。 */
export interface MaterialProgram extends UVFrames {
  /** 贴图（`t0`、`s0`、`t1`、`s1`……）、函数和 `fn materialColor() -> vec4f`。 */
  readonly code: string;
  readonly textures: readonly { readonly texture: Texture; readonly sampler: TextureSampler }[];
  /** 乘在 alpha 上的系数：1 - AlphaAdditive（0 就是加法混合）。 */
  readonly alphaFactor: number;
}

const WHOLE = [0, 0, 1, 1] as const;

/** 粒子材质的编译器：颜色树（贴图在绑定组 1），最后拼成 MaterialProgram。 */
export class MaterialCompiler extends ColorTreeCompiler {
  readonly #material: ParticleModuleFile;

  constructor(material: ParticleModuleFile, context: MaterialContext) {
    super(context, 1);
    this.#material = material;
  }

  /** 拼成程序：body 是 materialColor 的函数体；uv0、uv1 是两套 UV 的 UVBuilder；AlphaAdditive 读材质文件。 */
  program(body: string, uvBuilders: { readonly uv0?: ParticleModuleFile | null | undefined; readonly uv1?: ParticleModuleFile | null | undefined } = {}): MaterialProgram {
    return {
      code: `${this.declarations}fn materialColor() -> vec4f {\n${body}\n}\n`,
      textures: this.textures,
      alphaFactor: 1 - value(this.#material, 'alphaAdditive', 0),
      uv: uvBuilder(uvBuilders.uv0),
      uv1: uvBuilder(uvBuilders.uv1),
      uvParams: { uv: uvBuilderParams(uvBuilders.uv0), uv1: uvBuilderParams(uvBuilders.uv1) },
    };
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

/** UVBuilder 的参数（默认值同 flipbookOf、scrollOf）。 */
export function uvBuilderParams(file: ParticleModuleFile | null | undefined): UVBuilderParams {
  if (file?.$type === 'uvBuilderFlipbook') {
    const x = Math.max(1, value(file, 'xDivisions', 4)), y = Math.max(1, value(file, 'yDivisions', 4));
    return { kind: 'flipbook', x, y, start: Math.min(value(file, 'startingFrame', 0), x * y), speed: value(file, 'animationSpeed', 16) };
  }
  if (file?.$type === 'uvBuilderScroll') {
    const quad = (key: string, fallback: [number, number, number, number]) => [...value(file, key, fallback)] as unknown as [number, number, number, number];
    return { kind: 'scroll', start: quad('startFrame', [0, 0, 1, 1]), end: quad('endFrame', [0, 1, 1, 2]) };
  }
  return { kind: 'whole' };
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
