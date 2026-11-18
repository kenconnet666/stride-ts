/**
 * 天空盒镜面光照的预滤波，在 GPU 上做（同 Stride 的 RadiancePrefilteringGGXNoCompute，资源管线不再导出结果）：
 * 输出 size 的 RGBA16F 立方体贴图，第 i 级 mip 的粗糙度是 i / (级数 - 1)。最高一级不滤波，按方向重采样源贴图；
 * 其余每个纹素用 1024 个 GGX 重要性采样，按采样的立体角从源贴图合适的 mip 里取（包括 Stride 按 N·L 算 pdf 的写法，
 * 保持结果一致）。源贴图的 mip 由导入器从第 0 级重建（同 Stride 贴图编译的 GenerateMipmaps）。每个（级别，面）一次全屏绘制。
 */
import { BRDF } from './brdf';
import { FULLSCREEN_VERTEX } from './fullscreen';

/** 每个纹素的 GGX 采样数，同 Stride 的 RadiancePrefilteringGGX 默认值。 */
const SAMPLES = 1024;

const SHADER = /* wgsl */ `
${BRDF}
${FULLSCREEN_VERTEX}

struct Params { face: u32, roughness: f32, resample: u32, samples: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_cube<f32>;
@group(0) @binding(2) var linearClamp: sampler;

/** 面上的坐标（-1..1，v 向下）到方向，同 Stride 的 CubemapUtils.ConvertTexcoordsNoFlip。 */
fn faceDirection(face: u32, p: vec2f) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -p.y, -p.x); }
    case 1u: { return vec3f(-1.0, -p.y, p.x); }
    case 2u: { return vec3f(p.x, 1.0, p.y); }
    case 3u: { return vec3f(p.x, -1.0, -p.y); }
    case 4u: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}

/** GGX 重要性采样的半角向量，同 Stride 的 ImportanceSamplingGGX.GetSample（a = 粗糙度²）。 */
fn sampleGGX(xi: vec2f, roughness: f32, n: vec3f) -> vec3f {
  let a = roughness * roughness;
  let phi = 2.0 * PI * xi.x;
  let cosTheta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sinTheta = sqrt(1.0 - cosTheta * cosTheta);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tangentX = normalize(cross(up, n));
  let tangentY = cross(n, tangentX);
  return tangentX * sinTheta * cos(phi) + tangentY * sinTheta * sin(phi) + n * cosTheta;
}

@fragment fn fs(in: FullscreenVaryings) -> @location(0) vec4f {
  let r = normalize(faceDirection(params.face, in.uv * 2.0 - 1.0));
  if (params.resample == 1u) {
    return vec4f(textureSampleLevel(source, linearClamp, r, 0.0).rgb, 1.0);
  }
  let size = f32(textureDimensions(source).x);
  let maxLevel = f32(textureNumLevels(source) - 1u);
  let omegaP = 4.0 * PI / (6.0 * size * size);
  var sum = vec4f(0.0);
  for (var i = 0u; i < params.samples; i++) {
    let xi = vec2f(f32(reverseBits(i)) * 2.3283064365386963e-10, (f32(i) + 0.5) / f32(params.samples));
    let h = sampleGGX(xi, params.roughness, r);
    let l = 2.0 * dot(r, h) * h - r;
    let nDotL = saturate(dot(r, l));
    if (nDotL > 0.0) {
      let pdf = normalDistributionGGX(params.roughness * params.roughness, nDotL) / 4.0;
      let omegaS = 1.0 / (f32(params.samples) * pdf);
      let level = clamp(0.5 * log2(omegaS / omegaP), 0.0, maxLevel);
      sum += vec4f(textureSampleLevel(source, linearClamp, l, level).rgb * nDotL, nDotL);
    }
  }
  return vec4f(sum.rgb / max(sum.w, 1e-6), 1.0);
}`;

/** 每次绘制的参数各占一块 uniform：动态偏移要按 256 字节对齐。 */
const PARAMS_STRIDE = 256;

/** 从 radiance（立方体贴图，带 mip）生成 size 的预滤波镜面立方体贴图，命令提交到设备队列上。 */
export function prefilterSkybox(device: GPUDevice, radiance: GPUTexture, size: number, sampler: GPUSampler, label = 'skybox specular'): GPUTexture {
  const levels = Math.log2(size) + 1;
  if (!Number.isInteger(levels)) throw new RangeError(`skybox specular size ${size} must be a power of two`);
  const output = device.createTexture({ label, size: [size, size, 6], format: 'rgba16float', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const module = device.createShaderModule({ label: 'SkyboxPrefilter', code: SHADER });
  const layout = device.createBindGroupLayout({
    label: 'SkyboxPrefilter',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const pipeline = device.createRenderPipeline({
    label: 'SkyboxPrefilter',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'fullscreenVertex' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
  });

  const draws = levels * 6;
  const params = new ArrayBuffer(draws * PARAMS_STRIDE);
  for (let level = 0; level < levels; level++) {
    for (let face = 0; face < 6; face++) {
      const offset = (level * 6 + face) * PARAMS_STRIDE;
      new Uint32Array(params, offset, 4).set([face, 0, level === 0 ? 1 : 0, SAMPLES]);
      new Float32Array(params, offset + 4, 1)[0] = levels > 1 ? level / (levels - 1) : 0;
    }
  }
  const buffer = device.createBuffer({ label: 'SkyboxPrefilter params', size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, params);
  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer, size: 16 } },
      { binding: 1, resource: radiance.createView({ dimension: 'cube' }) },
      { binding: 2, resource: sampler },
    ],
  });

  const encoder = device.createCommandEncoder({ label: 'SkyboxPrefilter' });
  for (let level = 0; level < levels; level++) {
    for (let face = 0; face < 6; face++) {
      const view = output.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: face, arrayLayerCount: 1 });
      const pass = encoder.beginRenderPass({ label: `SkyboxPrefilter level ${level} face ${face}`, colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup, [(level * 6 + face) * PARAMS_STRIDE]);
      pass.draw(3);
      pass.end();
    }
  }
  device.queue.submit([encoder.finish()]);
  buffer.destroy();
  return output;
}
