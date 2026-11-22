/**
 * 光追的调试视图（调试命令 `raytrace`）：从主相机按像素发射线（rtTrace），打到的按材质的颜色乘朝太阳的程度上色、打不到的是天的
 * 颜色，读回成 RGBA 像素。和光栅化的截图并排看，验证光追场景（RayTracingScene）里的东西都在、位置和朝向对。
 */
import type { RenderView } from '../RenderSystem';
import { rayTracingWgsl, type RayTracingScene } from './RayTracingScene';

const SHADER = /* wgsl */ `
struct Params {
  inverseViewProjection: mat4x4f,
  // 朝太阳的方向、宽
  sun: vec4f,
  // 高、0、0、0
  size: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
${rayTracingWgsl(1)}

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(u32(params.sun.w), u32(params.size.x));
  if (id.x >= size.x || id.y >= size.y) { return; }
  let ndc = vec2f((f32(id.x) + 0.5) / f32(size.x) * 2.0 - 1.0, 1.0 - (f32(id.y) + 0.5) / f32(size.y) * 2.0);
  // 反向 Z：近平面深度 1
  let nearPoint = params.inverseViewProjection * vec4f(ndc, 1.0, 1.0);
  let farPoint = params.inverseViewProjection * vec4f(ndc, 0.5, 1.0);
  let origin = nearPoint.xyz / nearPoint.w;
  let dir = normalize(farPoint.xyz / farPoint.w - origin);
  let hit = rtTrace(origin, dir, 1e6);
  var color = vec3f(0.45, 0.62, 0.85);
  if (hit.instance != 0xffffffffu) {
    let n = rtNormal(hit, dir);
    color = rtAlbedo(hit) * (0.25 + 0.75 * max(dot(n, params.sun.xyz), 0.0)) + rtEmissive(hit) * 0.1;
    color = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
  }
  textureStore(output, id.xy, vec4f(color, 1.0));
}
`;

/** 画一张光追的调试图并读回：RGBA8，按行。 */
export async function rayTraceView(device: GPUDevice, scene: RayTracingScene, view: RenderView, sun: readonly [number, number, number], width: number, height: number): Promise<Uint8Array> {
  const group = scene.bindGroup;
  if (!group) throw new Error('raytrace: the ray tracing scene is not built yet (no meshes, or still building the BVHs)');
  const module = device.createShaderModule({ label: 'RayTracingDebug', code: SHADER });
  const ownLayout = device.createBindGroupLayout({
    label: 'RayTracingDebug',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: 'rgba8unorm', access: 'write-only' } },
    ],
  });
  const pipeline = await device.createComputePipelineAsync({ label: 'RayTracingDebug', layout: device.createPipelineLayout({ bindGroupLayouts: [ownLayout, scene.bindGroupLayout] }), compute: { module, entryPoint: 'main' } });
  const params = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const data = new Float32Array(24);
  data.set(view.inverseViewProjection, 0);
  data.set([sun[0], sun[1], sun[2], width, height, 0, 0, 0], 16);
  device.queue.writeBuffer(params, 0, data);
  const texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: 'RayTracingDebug' });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: ownLayout, entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: texture.createView() }] }));
  pass.setBindGroup(1, group);
  pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
  pass.end();
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const rows = new Uint8Array(readback.getMappedRange());
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) pixels.set(rows.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  readback.unmap();
  for (const resource of [params, readback, texture]) resource.destroy();
  return pixels;
}
