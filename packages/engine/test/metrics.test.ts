import { describe, expect, test } from 'vitest';
import { Metrics } from '../src/debug/Metrics';
import { GpuMemory, PipelineCounts, textureBytes } from '../src/graphics/GpuMemory';

describe('统计和预算（Metrics）', () => {
  test('量是现读现算的；设了上限的超了就报，没设的不报；可以先设预算后登记', () => {
    const metrics = new Metrics();
    let enemies = 3;
    metrics.budget('enemies', 5);
    metrics.gauge('enemies', 'count', () => enemies);
    metrics.gauge('audio.bytes', 'bytes', () => 1024);
    expect(metrics.snapshot()).toEqual([
      { name: 'audio.bytes', unit: 'bytes', value: 1024, over: false },
      { name: 'enemies', unit: 'count', value: 3, budget: 5, over: false },
    ]);
    enemies = 6;
    expect(metrics.over()).toEqual([{ name: 'enemies', unit: 'count', value: 6, budget: 5, over: true }]);
    metrics.budget('enemies', undefined);
    expect(metrics.over()).toEqual([]);
    // 同名的换掉
    metrics.gauge('enemies', 'count', () => 0);
    expect(metrics.snapshot().find((metric) => metric.name === 'enemies')!.value).toBe(0);
  });
});

describe('显存的账（GpuMemory）', () => {
  test('贴图的字节数：格式、各级 mip、层数、多重采样、压缩格式的块', () => {
    expect(textureBytes({ size: [256, 256], format: 'rgba8unorm', usage: 0 })).toBe(256 * 256 * 4);
    expect(textureBytes({ size: { width: 256, height: 128 }, format: 'rgba16float', usage: 0 })).toBe(256 * 128 * 8);
    // 整条 mip 链：4x4 + 2x2 + 1x1
    expect(textureBytes({ size: [4, 4], format: 'r8unorm', mipLevelCount: 3, usage: 0 })).toBe(16 + 4 + 1);
    // 立方体贴图六层；3D 贴图的深度也逐级减半
    expect(textureBytes({ size: [64, 64, 6], format: 'rgba8unorm', usage: 0 })).toBe(64 * 64 * 4 * 6);
    expect(textureBytes({ size: [8, 8, 8], format: 'r8unorm', dimension: '3d', mipLevelCount: 2, usage: 0 })).toBe(512 + 64);
    expect(textureBytes({ size: [100, 100], format: 'depth24plus', sampleCount: 4, usage: 0 })).toBe(100 * 100 * 4 * 4);
    // 压缩格式按块：BC7 每 4x4 一块 16 字节，不满一块的算一块；ASTC 的块大小在名字里
    expect(textureBytes({ size: [10, 10], format: 'bc7-rgba-unorm', usage: 0 })).toBe(3 * 3 * 16);
    expect(textureBytes({ size: [16, 16], format: 'bc1-rgba-unorm', usage: 0 })).toBe(4 * 4 * 8);
    expect(textureBytes({ size: [16, 16], format: 'astc-8x8-unorm', usage: 0 })).toBe(2 * 2 * 16);
  });

  test('建的时候加上、销毁的时候减掉（销毁两次只减一次），按标签的第一个词分组', () => {
    const destroyed: string[] = [];
    const resource = (label: string | undefined) => ({ label, destroy: () => void destroyed.push(label ?? '') });
    const device = {
      createBuffer: (descriptor: GPUBufferDescriptor) => resource(descriptor.label),
      createTexture: (descriptor: GPUTextureDescriptor) => resource(descriptor.label),
    } as unknown as GPUDevice;
    const memory = new GpuMemory(device);
    const vertices = device.createBuffer({ label: 'Wall vertices', size: 1000, usage: 0 });
    device.createBuffer({ label: 'Wall indices', size: 24, usage: 0 });
    device.createBuffer({ size: 16, usage: 0 });
    const color = device.createTexture({ label: 'ForwardRenderer HDR color', size: [100, 50], format: 'rgba16float', usage: 0 });
    expect([memory.buffers, memory.textures]).toEqual([{ count: 3, bytes: 1040 }, { count: 1, bytes: 40000 }]);
    expect(memory.groups()).toEqual({ ForwardRenderer: 40000, Wall: 1024, '(unlabeled)': 16 });
    vertices.destroy();
    vertices.destroy();
    color.destroy();
    expect([memory.buffers, memory.textures, memory.groups()]).toEqual([{ count: 2, bytes: 40 }, { count: 0, bytes: 0 }, { Wall: 24, '(unlabeled)': 16 }]);
    // 原来的 destroy 照常调到
    expect(destroyed).toEqual(['Wall vertices', 'Wall vertices', 'ForwardRenderer HDR color']);
  });

  test('管线：当场建的和后台编的分开数，记着最近当场建的是哪些', async () => {
    const made: string[] = [];
    const device = {
      createRenderPipeline: (descriptor: GPURenderPipelineDescriptor) => (made.push(`sync ${descriptor.label}`), {}),
      createComputePipeline: (descriptor: GPUComputePipelineDescriptor) => (made.push(`sync ${descriptor.label}`), {}),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => (made.push(`async ${descriptor.label}`), {}),
      createComputePipelineAsync: async (descriptor: GPUComputePipelineDescriptor) => (made.push(`async ${descriptor.label}`), {}),
    } as unknown as GPUDevice;
    const pipelines = new PipelineCounts(device);
    const descriptor = (label?: string) => ({ ...(label ? { label } : {}), layout: 'auto' }) as unknown as GPURenderPipelineDescriptor & GPUComputePipelineDescriptor;
    device.createRenderPipeline(descriptor('ToneMap'));
    device.createComputePipeline(descriptor());
    await device.createRenderPipelineAsync(descriptor('Mesh Opaque'));
    await device.createComputePipelineAsync(descriptor('Prefilter'));
    expect([pipelines.sync, pipelines.warmed, pipelines.recentSync]).toEqual([2, 2, ['ToneMap', '(unlabeled)']]);
    expect(made).toEqual(['sync ToneMap', 'sync undefined', 'async Mesh Opaque', 'async Prefilter']);
  });
});
