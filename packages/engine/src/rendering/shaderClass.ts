/**
 * 着色器类（Stride 材质颜色树里 ComputeShaderClassColor 引用的 .sdsl 着色器类）写成 WGSL：游戏导出 `shaderClass(...)` 的结果，
 * 按导出名登记（名字同 Stride 的 MixinReference，见 Registry.shaderClass）。代码里定义一个同名的函数，参数是着色器类的泛型参数
 * （按 generics 的顺序，ComputeColorParameterFloat4 是 vec4f、Float 是 f32……），返回 vec4f；Stride 里的 `streams.X` 写成
 * `streams.x`（MaterialStreams），可以改（比如改 UV，之后采样的贴图跟着变，WGSL 的操作数从左到右求值，同 HLSL 的写法）。
 *
 *   export const ComputeColorRed = shaderClass([], `fn ComputeColorRed() -> vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }`);
 */

/** 着色器类：WGSL 函数和它的泛型参数的名字。 */
export interface ShaderClass {
  readonly isShaderClass: true;
  readonly generics: readonly string[];
  readonly code: string;
}

/** 定义着色器类：generics 是泛型参数的名字（场景里按名字给值），code 里定义同名的 WGSL 函数。 */
export function shaderClass(generics: readonly string[], code: string): ShaderClass {
  return { isShaderClass: true, generics, code };
}

export function isShaderClass(value: unknown): value is ShaderClass {
  return typeof value === 'object' && value !== null && (value as Partial<ShaderClass>).isShaderClass === true;
}

/**
 * 材质着色器里共用的流（Stride 的 streams）：uv、uv1 是两套 UV（TEXCOORD0、1），color 是顶点颜色（粒子的颜色），colorScale 是
 * 组件的颜色（粒子），position 是本地坐标（网格），time 是游戏开始以来的秒数（Stride 的 Global.Time）。片元着色器开头填好。
 * world、normal 是世界坐标的位置和法线（网格，材质节点图的坡度、高度遮罩和世界 UV 用；法线是几何的，不带法线贴图；
 * 粒子、顶点着色器里是 0 和朝上）。和 Stride 不同：Stride 的颜色树拿不到世界坐标，地形的按坡度、高度混材质要另写着色器。
 */
export const MATERIAL_STREAMS = /* wgsl */ `
struct MaterialStreams {
  uv: vec2f,
  uv1: vec2f,
  color: vec4f,
  colorScale: vec4f,
  position: vec3f,
  time: f32,
  world: vec3f,
  normal: vec3f,
  // 片元在画面上的像素坐标（材质节点图的屏幕空间遮蔽用）；顶点阶段、粒子里没有，是 -1
  pixel: vec2f,
};
var<private> streams: MaterialStreams;

/** 贴图按预乘 alpha 用（同 Stride 编译贴图时预乘）。 */
fn premultiply(texel: vec4f) -> vec4f {
  return vec4f(texel.rgb * texel.a, texel.a);
}
`;
