import type { Case, Run } from './harness';

// CPU cost of encoding and submitting one frame of n cubes, the part of rendering a JS engine pays for.
// The GPU work is tiny (small cubes into a 1280x720 target), so the numbers are submission overhead.

const CUBE = /* wgsl */ `
const corners = array<vec3f, 8>(
  vec3f(-1, -1, -1), vec3f(1, -1, -1), vec3f(1, 1, -1), vec3f(-1, 1, -1),
  vec3f(-1, -1, 1), vec3f(1, -1, 1), vec3f(1, 1, 1), vec3f(-1, 1, 1));
const indices = array<u32, 36>(
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2);
fn corner(vertex: u32) -> vec4f {
  var c = corners;
  var i = indices;
  return vec4f(c[i[vertex]], 1);
}`;

const PER_DRAW = /* wgsl */ `${CUBE}
struct Object { transform: mat4x4f, color: vec4f };
@group(0) @binding(0) var<uniform> object: Object;
@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return object.transform * corner(v); }
@fragment fn fs() -> @location(0) vec4f { return object.color; }`;

const INSTANCED = /* wgsl */ `${CUBE}
@group(0) @binding(0) var<storage, read> transforms: array<mat4x4f>;
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> @builtin(position) vec4f {
  return transforms[i] * corner(v);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.8, 0.6, 0.2, 1); }`;

/** Uniform blocks must start at multiples of minUniformBufferOffsetAlignment (256 on every adapter we target). */
const UNIFORM_STRIDE = 256;
const FORMAT: GPUTextureFormat = 'rgba8unorm';
const SIZES = [100, 1_000, 5_000, 10_000];
const GROUP = 'render: CPU time to encode and submit one frame of n cubes';

/** A small cube somewhere on screen: scale 0.01, translated in clip space. */
function writeTransform(target: Float32Array, offset: number, i: number): void {
  target.fill(0, offset, offset + 16);
  target[offset] = target[offset + 5] = target[offset + 10] = 0.01;
  target[offset + 12] = ((i * 0.618) % 1) * 1.8 - 0.9;
  target[offset + 13] = ((i * 0.381) % 1) * 1.8 - 0.9;
  target[offset + 14] = 0.5;
  target[offset + 15] = 1;
}

export function createRenderCases(device: GPUDevice): Case[] {
  const target = device.createTexture({ size: [1280, 720], format: FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const targetView = target.createView();
  const flushGpu = () => device.queue.onSubmittedWorkDone();
  const pass = (encoder: GPUCommandEncoder) =>
    encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });

  const perDrawLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 } }],
  });
  const perDrawModule = device.createShaderModule({ code: PER_DRAW });
  const perDrawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [perDrawLayout] }),
    vertex: { module: perDrawModule, entryPoint: 'vs' },
    fragment: { module: perDrawModule, entryPoint: 'fs', targets: [{ format: FORMAT }] },
  });

  /** n objects, each with its own 256-byte uniform block in one buffer, bound by dynamic offset. */
  const perDrawScene = (n: number) => {
    const data = new Float32Array((n * UNIFORM_STRIDE) / 4);
    for (let i = 0; i < n; i++) {
      const o = (i * UNIFORM_STRIDE) / 4;
      writeTransform(data, o, i);
      data.set([0.2 + (i % 5) * 0.15, 0.5, 0.8, 1], o + 16);
    }
    const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    const bindGroup = device.createBindGroup({ layout: perDrawLayout, entries: [{ binding: 0, resource: { buffer, size: 80 } }] });
    return { data, buffer, bindGroup };
  };

  const perDrawCase = (name: string, encode: (p: GPURenderPassEncoder, bindGroup: GPUBindGroup, n: number) => void): Case => ({
    group: GROUP,
    name,
    sizes: SIZES,
    setup(n): Run {
      const scene = perDrawScene(n);
      return {
        iterate() {
          device.queue.writeBuffer(scene.buffer, 0, scene.data);
          const encoder = device.createCommandEncoder();
          const p = pass(encoder);
          encode(p, scene.bindGroup, n);
          p.end();
          device.queue.submit([encoder.finish()]);
        },
        between: flushGpu,
        dispose: () => scene.buffer.destroy(),
      };
    },
  });

  const instancedLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
  });
  const instancedModule = device.createShaderModule({ code: INSTANCED });
  const instancedPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [instancedLayout] }),
    vertex: { module: instancedModule, entryPoint: 'vs' },
    fragment: { module: instancedModule, entryPoint: 'fs', targets: [{ format: FORMAT }] },
  });

  return [
    perDrawCase('n draws: pipeline once, dynamic-offset bind group per draw', (p, bindGroup, n) => {
      p.setPipeline(perDrawPipeline);
      for (let i = 0; i < n; i++) {
        p.setBindGroup(0, bindGroup, [i * UNIFORM_STRIDE]);
        p.draw(36);
      }
    }),
    perDrawCase('n draws: pipeline and bind group set again on every draw', (p, bindGroup, n) => {
      for (let i = 0; i < n; i++) {
        p.setPipeline(perDrawPipeline);
        p.setBindGroup(0, bindGroup, [i * UNIFORM_STRIDE]);
        p.draw(36);
      }
    }),
    {
      group: GROUP,
      name: 'n draws recorded once into a render bundle, replayed per frame',
      sizes: SIZES,
      setup(n): Run {
        const scene = perDrawScene(n);
        const recorder = device.createRenderBundleEncoder({ colorFormats: [FORMAT] });
        recorder.setPipeline(perDrawPipeline);
        for (let i = 0; i < n; i++) {
          recorder.setBindGroup(0, scene.bindGroup, [i * UNIFORM_STRIDE]);
          recorder.draw(36);
        }
        const bundle = recorder.finish();
        return {
          iterate() {
            device.queue.writeBuffer(scene.buffer, 0, scene.data);
            const encoder = device.createCommandEncoder();
            const p = pass(encoder);
            p.executeBundles([bundle]);
            p.end();
            device.queue.submit([encoder.finish()]);
          },
          between: flushGpu,
          dispose: () => scene.buffer.destroy(),
        };
      },
    },
    {
      group: GROUP,
      name: 'one instanced draw of n cubes (matrices in a storage buffer)',
      sizes: SIZES,
      setup(n): Run {
        const data = new Float32Array(n * 16);
        for (let i = 0; i < n; i++) writeTransform(data, i * 16, i);
        const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        const bindGroup = device.createBindGroup({ layout: instancedLayout, entries: [{ binding: 0, resource: { buffer } }] });
        return {
          iterate() {
            device.queue.writeBuffer(buffer, 0, data);
            const encoder = device.createCommandEncoder();
            const p = pass(encoder);
            p.setPipeline(instancedPipeline);
            p.setBindGroup(0, bindGroup);
            p.draw(36, n);
            p.end();
            device.queue.submit([encoder.finish()]);
          },
          between: flushGpu,
          dispose: () => buffer.destroy(),
        };
      },
    },
  ];
}
