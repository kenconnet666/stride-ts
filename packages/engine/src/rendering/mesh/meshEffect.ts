/**
 * 网格效果：Stride 的效果文件（.sdfx）在 StrideForwardShadingEffect 上再 mixin 的着色器，比如 SpaceEscape 的
 * TransformationBendWorld（走廊往远处弯）、CustomFogEffect（远处起雾）。游戏导出 `meshEffect(...)` 的结果，按导出名登记
 * （名字同合成器里 MeshRenderFeature 的 EffectName，见 Registry.meshEffect）；场景的合成器用这个效果名时，网格都用它画。
 *
 * code 里可以定义这几个 WGSL 函数，没定义的用默认（什么都不改）：
 * - `fn effectWorldPosition(world: vec3f, p: MeshEffectParameters) -> vec3f`：投影前改世界位置（TransformationBase.PreTransformPosition）；
 * - `fn effectUv(uv: vec2f, p: MeshEffectParameters) -> vec2f`：顶点的 UV（TransformationTextureUV 那样的 UV 变换）；
 * - `fn effectVarying(clip: vec4f, world: vec3f, p: MeshEffectParameters) -> vec4f`：传给片元着色器的值（PostTransformPosition 里算的流，比如雾因子）；
 * - `fn effectShading(color: vec4f, fromVertex: vec4f) -> vec4f`：改最终颜色（ShadingBase.Shading，color 是预乘 alpha 的线性颜色）。
 *
 * MeshEffectParameters 是每个网格的 4 个 vec4f（Stride 的 Mesh.Parameters 里效果用的键），默认值是 defaults（不足 16 个的补 0），
 * 脚本用 Mesh.setEffectParameters 改某个网格的（同一个模型资源的所有实例一起变，同 Stride）。只在顶点着色器里能读，片元着色器
 * 要用的经 effectVarying 传过去。
 *
 *   export const SpaceEscapeEffectMain = meshEffect(`fn effectWorldPosition(world: vec3f, p: MeshEffectParameters) -> vec3f { ... }`, [1, 1, 0, 0]);
 */

/** 每个网格的效果参数有几个 float（4 个 vec4f）。 */
export const MESH_EFFECT_PARAMETERS = 16;

export interface MeshEffect {
  readonly isMeshEffect: true;
  readonly code: string;
  /** 16 个参数的默认值。 */
  readonly defaults: Float32Array;
}

/** 定义网格效果：code 里定义上面那几个钩子函数（可以只定义一部分），defaults 是参数的默认值。 */
export function meshEffect(code: string, defaults: readonly number[] = []): MeshEffect {
  if (defaults.length > MESH_EFFECT_PARAMETERS) throw new RangeError(`a mesh effect has at most ${MESH_EFFECT_PARAMETERS} parameters, got ${defaults.length}`);
  const values = new Float32Array(MESH_EFFECT_PARAMETERS);
  values.set(defaults);
  return { isMeshEffect: true, code, defaults: values };
}

export function isMeshEffect(value: unknown): value is MeshEffect {
  return typeof value === 'object' && value !== null && (value as Partial<MeshEffect>).isMeshEffect === true;
}

const HOOKS: Readonly<Record<string, string>> = {
  effectWorldPosition: 'fn effectWorldPosition(world: vec3f, p: MeshEffectParameters) -> vec3f { return world; }',
  effectUv: 'fn effectUv(uv: vec2f, p: MeshEffectParameters) -> vec2f { return uv; }',
  effectVarying: 'fn effectVarying(clip: vec4f, world: vec3f, p: MeshEffectParameters) -> vec4f { return vec4f(0.0); }',
  effectShading: 'fn effectShading(color: vec4f, fromVertex: vec4f) -> vec4f { return color; }',
};

/** 网格着色器里效果的 WGSL：参数的结构，加上效果的代码和它没定义的钩子的默认实现。 */
export function meshEffectCode(effect: MeshEffect | undefined): string {
  const code = effect?.code ?? '';
  const defaults = Object.entries(HOOKS).filter(([name]) => !new RegExp(`\\bfn\\s+${name}\\b`).test(code)).map(([, hook]) => hook);
  return ['struct MeshEffectParameters { values: array<vec4f, 4> };', code, ...defaults].join('\n');
}
