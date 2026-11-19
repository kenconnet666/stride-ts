// SpaceEscape 的网格效果 SpaceEscapeEffectMain（Effects/SpaceEscapeEffectMain.sdfx：StrideForwardShadingEffect 加上下面三个
// 着色器，开关是 GameParameters），参数的值照 BendFogRenderFeature 每次绘制写进常量缓冲的值。合成器里 MeshRenderFeature 的
// EffectName 是这个名字，所以场景里的网格都用它画。
//
// 每个网格的参数（Mesh.setEffectParameters，Stride 的 Mesh.Parameters）：
//   values[0] = (EnableBend, EnableFog, EnableOnflyTextureUVChange, 0)，1 是开
//   values[1] = (DeformFactorX, DeformFactorY, 0, 0)
//   values[2] = TextureRegion（xy 是起点，zw 是大小；TransformationTextureUV）
import { meshEffect } from '@stride-ts/engine';

/** EnableBend 的参数下标（BackgroundScript 给天空板关掉弯曲、打开 UV 变换时用）。 */
export const ENABLE_BEND = 0;
export const ENABLE_TEXTURE_UV = 2;
export const TEXTURE_REGION = 8;

export const SpaceEscapeEffectMain = meshEffect(/* wgsl */ `
// TransformationBendWorld：投影前把世界位置的 x、y 各加 系数 × z²，走廊往远处弯下去、弯向一边
fn effectWorldPosition(world: vec3f, p: MeshEffectParameters) -> vec3f {
  if (p.values[0].x < 0.5) {
    return world;
  }
  let z2 = world.z * world.z;
  return vec3f(world.x + p.values[1].x * z2, world.y + p.values[1].y * z2, world.z);
}

// TransformationTextureUV：UV 换到贴图的一块区域里（天空板滚动）
fn effectUv(uv: vec2f, p: MeshEffectParameters) -> vec2f {
  if (p.values[0].z < 0.5) {
    return uv;
  }
  return p.values[2].xy + p.values[2].zw * uv;
}

// CustomFogEffect 的 PostTransformPosition：雾因子按深度（裁剪空间的 w）和高度（照 Stride 用的是裁剪空间的 y）算，
// 1 是没有雾；y 分量带上 EnableFog 给片元着色器
const FOG_NEAR_Z = 80.0;
const FOG_FAR_Z = 250.0;
const FOG_NEAR_Y = 0.0;
const FOG_FAR_Y = 120.0;
fn effectVarying(clip: vec4f, world: vec3f, p: MeshEffectParameters) -> vec4f {
  let depthFactor = max((FOG_FAR_Z - clip.w) / (FOG_FAR_Z - FOG_NEAR_Z), 0.0);
  let heightFactor = max((clip.y - FOG_FAR_Y) / (FOG_FAR_Y - FOG_NEAR_Y), 0.0);
  return vec4f(saturate(depthFactor + heightFactor), p.values[0].y, 0.0, 0.0);
}

// CustomFogEffect 的 Shading：往雾色插值。雾色是 Color.FromAbgr(0xFF7D02FF) 转成 Color4（只除以 255，不换到线性空间）
const FOG_COLOR = vec4f(1.0, 125.0 / 255.0, 2.0 / 255.0, 1.0);
fn effectShading(color: vec4f, fromVertex: vec4f) -> vec4f {
  if (fromVertex.y < 0.5 || color.w <= 0.005) {
    return color;
  }
  return mix(FOG_COLOR, color, fromVertex.x);
}
`, [
  1, 1, 0, 0,
  // DeformFactorX 的默认值是 -0.001、DeformFactorY 是 -0.0006，但 BendFogRenderFeature 把 X 的值写进了两个位置
  // （*perDraw++ = X; *perDraw = X），实际 y 也是 -0.001；照 Stride 画出来的样子取
  -0.001, -0.001, 0, 0,
  0, 0, 1, 1,
]);
