// ParticlesSample 的 ParticleCustomMaterial（着色器是 ParticleCustomShader.sdsl）：颜色和 alpha 各是一棵颜色树，各用一套 UV
// （UVBuilder0、UVBuilder1，第二套给 TexcoordIndex 是 Texcoord1 的贴图用）。颜色 = 组件的颜色 · 颜色树，alpha 换成 alpha 树
// 的值，再预乘 alpha。
import { ParticleMaterial, type MaterialCompiler, type MaterialProgram, type ParticleModuleFile } from '@stride-ts/engine';

export class ParticleCustomMaterial extends ParticleMaterial {
  compile(compiler: MaterialCompiler): MaterialProgram {
    const file = this.file;
    return compiler.program(/* wgsl */ `
  var color = streams.colorScale * ${compiler.color(file['computeColor'])};
  color.a = ${compiler.scalar(file['computeScalar'])};
  return vec4f(color.rgb * color.a, color.a);`, {
      uv0: file['uVBuilder0'] as ParticleModuleFile | null | undefined,
      uv1: file['uVBuilder1'] as ParticleModuleFile | null | undefined,
    });
  }
}
