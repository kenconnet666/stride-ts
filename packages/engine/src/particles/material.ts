/**
 * 粒子材质（Stride 的 ParticleMaterialComputeColor）的颜色树编译成 WGSL 函数 `materialColor(uv, color)`：每种不同的树一个着色器，
 * 同样的树共用流水线。节点照 Stride 的 ComputeColor：
 * - ComputeTextureColor：采样贴图（按预乘 alpha 用，同 Stride 编译贴图时预乘），UV 乘 Scale 加 Offset；没有贴图时用 FallbackValue；
 * - ComputeTextureScalar：采样贴图的一个通道（Channel，默认 R），四个分量都是它；
 * - ComputeVertexStreamColor：粒子的颜色（顶点颜色）；
 * - ComputeFloat4、ComputeFloat：常量；ComputeColor：常量颜色，换到线性空间、预乘 alpha（同 Stride 的 ToColorSpace、PremultiplyAlpha）；
 * - ComputeBinaryColor：两个子节点按 Operator 合成（现在有 Multiply、Add、Subtract，别的先当 Multiply 并警告）。
 * 认不出的节点当白色。
 */
import type { ParticleModuleFile, ParticleValue, TextureRef, TextureSampler } from '../content/format';
import { srgbToLinear } from '../mathematics/vectors';
import type { Texture } from '../rendering/Texture';
import { value } from './modules';

/** 一个材质编译出来的着色器片段和它用到的贴图（按绑定的顺序）。 */
export interface MaterialProgram {
  /** `fn materialColor(uv: vec2f, color: vec4f) -> vec4f`，用到的贴图是 `t0`、`s0`、`t1`、`s1`…… */
  readonly code: string;
  readonly textures: readonly { readonly texture: Texture; readonly sampler: TextureSampler }[];
  /** 乘在 alpha 上的系数：1 - AlphaAdditive（0 就是加法混合）。 */
  readonly alphaFactor: number;
  /** 粒子的 UV 帧 [u, v, 宽, 高]（材质的 UVBuilder；没有时整张）。 */
  readonly uv: (remainingLife: number) => readonly [number, number, number, number];
}

const WHOLE = [0, 0, 1, 1] as const;

const WHITE = 'vec4f(1.0)';
const warned = new Set<string>();

/** 编译材质；textures 按内容路径给加载好的贴图。 */
export function compileMaterial(material: ParticleModuleFile, textures: (path: string) => Texture | undefined): MaterialProgram {
  const bound: { texture: Texture; sampler: TextureSampler }[] = [];
  const literal = (values: readonly number[]) => `vec4f(${values.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`;

  const sample = (node: ParticleModuleFile): string | undefined => {
    const ref = node['texture'] as TextureRef | null | undefined;
    const texture = ref ? textures(ref.texture) : undefined;
    if (!texture) return undefined;
    const i = bound.push({ texture, sampler: samplerOf(node) }) - 1;
    const [sx, sy] = value(node, 'scale', [1, 1]), [ox, oy] = value(node, 'offset', [0, 0]);
    return `textureSample(t${i}, s${i}, uv * vec2f(${sx}, ${sy}) + vec2f(${ox}, ${oy}))`;
  };

  const expression = (node: ParticleValue | undefined): string => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return WHITE;
    const file = node as ParticleModuleFile;
    switch (file.$type) {
      case 'computeTextureColor': {
        const texel = sample(file);
        if (texel) return `premultiply(${texel})`;
        const fallback = value(value(file, 'fallbackValue', {} as ParticleModuleFile), 'value', [1, 1, 1, 1]) as number[];
        return literal(fallback);
      }
      case 'computeTextureScalar': {
        const texel = sample(file);
        const channel = String(file['channel'] ?? 'r').toLowerCase();
        return texel ? `vec4f(${texel}.${'rgba'.includes(channel) && channel.length === 1 ? channel : 'r'})` : literal([value(file, 'fallbackValue', 1) as number]);
      }
      case 'computeVertexStreamColor':
        return 'color';
      case 'computeFloat4':
        return literal(value(file, 'value', [1, 1, 1, 1]) as number[]);
      case 'computeFloat': {
        const v = value(file, 'value', 1) as number;
        return literal([v, v, v, v]);
      }
      case 'computeColor': {
        const [r, g, b, a] = value(file, 'value', [1, 1, 1, 1]) as number[];
        const premultiply = value(file, 'premultiplyAlpha', true) ? a! : 1;
        return literal([srgbToLinear(r!) * premultiply, srgbToLinear(g!) * premultiply, srgbToLinear(b!) * premultiply, a!]);
      }
      case 'computeBinaryColor': {
        const left = expression(file['leftChild']), right = expression(file['rightChild']);
        const operator = String(file['operator'] ?? 'multiply');
        if (operator === 'add') return `(${left} + ${right})`;
        if (operator === 'subtract') return `(${left} - ${right})`;
        if (operator !== 'multiply') warnOnce(`binary color operator ${operator}`);
        return `(${left} * ${right})`;
      }
      default:
        warnOnce(`color node ${String(file.$type)}`);
        return WHITE;
    }
  };

  const body = expression(material['computeColor']);
  const declarations = bound.map((_, i) => `@group(1) @binding(${i * 2}) var t${i}: texture_2d<f32>;\n@group(1) @binding(${i * 2 + 1}) var s${i}: sampler;`).join('\n');
  return {
    code: `${declarations}\nfn materialColor(uv: vec2f, color: vec4f) -> vec4f {\n  return ${body};\n}\n`,
    textures: bound,
    alphaFactor: 1 - (value(material, 'alphaAdditive', 0) as number),
    uv: uvBuilder(material['uvBuilder'] as ParticleModuleFile | null | undefined),
  };
}

function uvBuilder(file: ParticleModuleFile | null | undefined): MaterialProgram['uv'] {
  return file?.$type === 'uvBuilderFlipbook' ? flipbookOf(file) : () => WHOLE;
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

function warnOnce(what: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[stride] particle material: ${what} is not supported yet; using a fallback`);
}
