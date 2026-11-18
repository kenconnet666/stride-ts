/**
 * 泛光、光芒、镜头光晕的结果按 Stride 的 BlendStates.Additive（源乘源的 alpha）加回画面。
 * 和 Stride 不同（只为省全分辨率的通道）：Stride 是每个效果各自画一遍全屏叠加，这里不单独画，各层在色调映射的着色器里
 * 读出来加上（ToneMap.draw 的 layers），省掉一遍全分辨率 rgba16float 的读写；Expanded 放大的层（泛光）先在它自己的
 * 小图上做一次 9 点卷积（prefilter），全分辨率上就只采一次。9 个点的偏移是小图的整数个纹素，双线性插值和整数平移可以交换，
 * 所以两种做法相等，只有画面最外圈半个小图纹素（4K 下 2 个像素）里 clamp 的方式不同。
 * 4K（3840x1810，RTX 3050 笔记本静谧模式）下，叠加从单独一遍 3.5 ms 变成色调映射多出的 1.2 ms 加预滤波 0.2 ms。
 */
import type { ImageEffectContext, UniformArena } from './ImageEffect';

/** 一层：texture 乘 color，按 ImageScaler 的规则采样（expanded 时 9 点），再按 Additive 加上去。 */
export interface AdditiveLayer {
  readonly texture: GPUTexture;
  readonly expanded: boolean;
  /** 默认白色。 */
  readonly color?: readonly [number, number, number, number];
}

export const MAX_ADDITIVE_LAYERS = 3;

/** 着色器里的各层：从 firstBinding 起是参数、MAX_ADDITIVE_LAYERS 张纹理、采样器；additiveLayers(uv) 是要加上的颜色。 */
export const additiveLayersShader = (firstBinding: number) => /* wgsl */ `
struct AdditiveLayer { color: vec4f, enabled: f32 };
@group(0) @binding(${firstBinding}) var<uniform> additive: array<AdditiveLayer, ${MAX_ADDITIVE_LAYERS}>;
${Array.from({ length: MAX_ADDITIVE_LAYERS }, (_, i) => `@group(0) @binding(${firstBinding + 1 + i}) var additiveLayer${i}: texture_2d<f32>;`).join('\n')}
@group(0) @binding(${firstBinding + 1 + MAX_ADDITIVE_LAYERS}) var additiveSampler: sampler;

// BlendStates.Additive 的源项：rgb · a
fn additiveLayer(source: texture_2d<f32>, layer: AdditiveLayer, uv: vec2f) -> vec3f {
  if (layer.enabled == 0.0) {
    return vec3f(0.0);
  }
  let color = textureSampleLevel(source, additiveSampler, uv, 0.0) * layer.color;
  return color.rgb * color.a;
}

fn additiveLayers(uv: vec2f) -> vec3f {
  return ${Array.from({ length: MAX_ADDITIVE_LAYERS }, (_, i) => `additiveLayer(additiveLayer${i}, additive[${i}], uv)`).join(' + ')};
}`;

/** Expanded 的层先在小图上做 9 点卷积，换成只采一次的层。 */
export function prefilterLayers({ encoder, pool, arena, scaler }: ImageEffectContext, layers: readonly AdditiveLayer[]): AdditiveLayer[] {
  return layers.map((layer) => {
    if (!layer.expanded) return layer;
    const { texture } = layer;
    const filtered = pool.acquire(texture.width, texture.height, texture.format, 'AdditiveLayers prefilter');
    scaler.draw(encoder, arena, texture, filtered, { expanded: true });
    return { ...layer, texture: filtered, expanded: false };
  });
}

/** additiveLayersShader 的绑定资源；空着的槽位绑 fallback（不会采样）。 */
export function additiveLayerResources(arena: UniformArena, layers: readonly AdditiveLayer[], fallback: GPUTexture, sampler: GPUSampler): [GPUBufferBinding, ...GPUTexture[], GPUSampler] {
  if (layers.length > MAX_ADDITIVE_LAYERS) throw new RangeError(`At most ${MAX_ADDITIVE_LAYERS} additive layers are supported, got ${layers.length}`);
  const parameters = new Float32Array(MAX_ADDITIVE_LAYERS * 8);
  layers.forEach(({ expanded, color = [1, 1, 1, 1] }, i) => {
    if (expanded) throw new Error('Expanded additive layers must be prefiltered (prefilterLayers) first');
    parameters.set([...color, 1], i * 8);
  });
  const textures = Array.from({ length: MAX_ADDITIVE_LAYERS }, (_, i) => layers[i]?.texture ?? fallback);
  return [arena.push(parameters), ...textures, sampler];
}
