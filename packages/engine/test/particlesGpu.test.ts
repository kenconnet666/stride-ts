import { describe, expect, test } from 'vitest';
import { packShape, SHAPE_FLAGS, SHAPE_VEC4S } from '../src/particles/gpu/draw';
import { GpuEmitter, SpawnRing } from '../src/particles/gpu/GpuEmitter';
import { buildKernel, gpuUnsupported, HEADER_VEC4S, WORKGROUP_SIZE } from '../src/particles/gpu/kernel';
import { bitonicStages, sortSize } from '../src/particles/gpu/sort';
import { ParticleSystem } from '../src/particles/ParticleSystem';
import type { ParticleModuleFile } from '../src/content/format';
import { fakeGpu, stubGpuGlobals, type BufferWrite } from './fakeGpu';

/** 一个发射器（种子固定），粒子系统的变换按给的设好、模块的世界变换算好。 */
function emitter(file: ParticleModuleFile, translation: [number, number, number] = [0, 0, 0], scale = 1) {
  const system = new ParticleSystem({ emitters: [{ randomSeedMethod: 'fixed', ...file }] });
  system.translation = translation;
  system.uniformScale = scale;
  // 第一帧 update 算模块的世界变换（不生成：没有生成器）
  system.update(0);
  return system.emitters[0]!;
}

describe('GPU 粒子：哪些发射器能放到 GPU 上', () => {
  test('引擎的形状、支持的模块可以；飘带、碰撞、按生成顺序排、子粒子、关掉的模块不算', () => {
    expect(gpuUnsupported(emitter({ initializers: [{ $type: 'initialSizeSeed' }], updaters: [{ $type: 'updaterGravity' }] }))).toBeUndefined();
    expect(gpuUnsupported(emitter({ shapeBuilder: { $type: 'shapeBuilderRibbon' } }))).toMatch(/ribbons/);
    expect(gpuUnsupported(emitter({ updaters: [{ $type: 'updaterCollider' }] }))).toMatch(/UpdaterCollider/);
    expect(gpuUnsupported(emitter({ updaters: [{ $type: 'updaterCollider', enabled: false }] }))).toBeUndefined();
    expect(gpuUnsupported(emitter({ sortingPolicy: 'byOrder' }))).toMatch(/spawn order/);
    const parent = new ParticleSystem({
      emitters: [{ emitterName: 'Parent' }, { spawners: [{ $type: 'spawnerFromParent', parentName: 'Parent' }] }],
    });
    expect(parent.emitters.map((e) => gpuUnsupported(e) !== undefined)).toEqual([true, true]);
  });
});

describe('GPU 粒子：模拟内核', () => {
  /** 打包一次，按 vec4 读回来。 */
  const packed = (file: ParticleModuleFile, translation?: [number, number, number], scale?: number) => {
    const kernel = buildKernel(emitter(file, translation, scale));
    const data = new Float32Array(Math.max(kernel.slots, 1) * 4);
    kernel.pack(data);
    return { kernel, vec4: (i: number) => [...data.subarray(i * 4, i * 4 + 4)].map((v) => +v.toFixed(4)) };
  };

  test('初始化器按顺序拼进 initialize，更新器分前后；每个模块的数据按顺序占 vec4', () => {
    const { kernel } = packed({
      initializers: [{ $type: 'initialSizeSeed' }, { $type: 'initialPositionSeed' }, { $type: 'initialColorSeed' }],
      updaters: [{ $type: 'updaterGravity' }, { $type: 'updaterSpeedToDirection' }],
    });
    expect(kernel.slots).toBe(1 + 4 + 2 + 1);
    const init = kernel.code.slice(kernel.code.indexOf('fn initialize'), kernel.code.indexOf('fn update('));
    expect(init.indexOf('(*p).size = sim.data[0]')).toBeLessThan(init.indexOf('randomBox(sim.data[1], sim.data[2], sim.data[3], sim.data[4]'));
    expect(init).toContain('mix(sim.data[5], sim.data[6]');
    expect(kernel.code.slice(kernel.code.indexOf('fn update('), kernel.code.indexOf('fn postUpdate'))).toContain('sim.data[7].xyz * dt');
    expect(kernel.code.slice(kernel.code.indexOf('fn postUpdate'))).toContain('((*p).position - old) / dt');
    // 同样的模块组合拼出同样的代码（管线按代码共用）
    expect(buildKernel(emitter({ initializers: [{ $type: 'initialSizeSeed' }], updaters: [] })).code)
      .toBe(buildKernel(emitter({ initializers: [{ $type: 'initialSizeSeed', randomSize: [3, 4] }] })).code);
  });

  test('打包：位置的盒子按粒子系统的位置、缩放变换（同 CPU 的 randomBox），大小乘世界缩放，重力原样', () => {
    const { vec4 } = packed({
      initializers: [{ $type: 'initialPositionSeed', positionMin: [-1, 0, -2], positionMax: [1, 2, 2] }, { $type: 'initialSizeSeed', randomSize: [0.5, 1] }],
      updaters: [{ $type: 'updaterGravity', gravitationalAcceleration: [0, -2, 0] }],
    }, [10, 0, 0], 2);
    // 角是 min · 缩放 + 位置，三条边是 (max - min) · 缩放
    expect([vec4(0), vec4(1), vec4(2), vec4(3)]).toEqual([[8, 0, -4, 0], [4, 0, 0, 0], [0, 4, 0, 0], [0, 0, 8, 0]]);
    expect(vec4(4)).toEqual([1, 1, 0, 0]);
    expect(vec4(5)).toEqual([0, -2, 0, 0]);
  });

  test('按寿命的曲线：标量每个 vec4 放 4 个采样点，有第二条曲线时接在后面并按种子插值；颜色每个采样点一个 vec4', () => {
    const curve = (keys: [number, number][]) => ({ $type: 'computeCurveSamplerFloat', curve: { keyFrames: keys.map(([key, value]) => ({ key, value })) } });
    const { kernel, vec4 } = packed({ updaters: [{ $type: 'updaterSizeOverTime', samplerMain: curve([[0, 0], [1, 31]]), samplerOptional: curve([[0, 1], [1, 1]]) }] });
    // 主曲线 8 个 vec4、第二条 8 个、世界缩放 1 个
    expect(kernel.slots).toBe(17);
    expect([vec4(0), vec4(7), vec4(8), vec4(16)]).toEqual([[0, 1, 2, 3], [28, 29, 30, 31], [1, 1, 1, 1], [1, 0, 0, 0]]);
    expect(kernel.code).toContain('mix(curveScalar(age, 0u), curveScalar(age, 8u), seedFloat');
    const color = packed({ updaters: [{ $type: 'updaterColorOverTime', samplerMain: { $type: 'computeCurveSamplerColor4', curve: { keyFrames: [{ key: 0, value: [1, 0, 0, 1] }, { key: 1, value: [0, 0, 1, 0] }] } } }] });
    expect([color.kernel.slots, color.vec4(0), color.vec4(31)]).toEqual([32, [1, 0, 0, 1], [0, 0, 1, 0]]);
  });
});

describe('GPU 粒子：环形生成的记账', () => {
  test('新粒子接着环的头写，种子逐个加一；最近"最长寿命"秒里生成的个数不超过容量，早于它的不算', () => {
    const ring = new SpawnRing(10, 100);
    expect(ring.advance(0.1, 6, 1)).toEqual({ start: 0, count: 6, seed: 100 });
    // 容量 10，还可能活着 6 个：只能再生成 4 个
    expect(ring.advance(0.1, 6, 1)).toEqual({ start: 6, count: 4, seed: 106 });
    expect([ring.head, ring.aliveBound]).toEqual([0, 10]);
    expect(ring.advance(0.5, 3, 1).count).toBe(0);
    // 第一批生成了 1.1 秒（超过最长寿命 1 秒），一定死了
    expect(ring.advance(0.5, 8, 1)).toEqual({ start: 0, count: 6, seed: 110 });
  });
});

describe('GPU 粒子：排序和形状的参数', () => {
  test('bitonic 排序的步骤：n = 2^m 有 m(m+1)/2 步；大小补到 2 的幂', () => {
    expect(bitonicStages(8)).toEqual([[2, 1], [4, 2], [4, 1], [8, 4], [8, 2], [8, 1]]);
    expect(bitonicStages(262144)).toHaveLength(171);
    expect([sortSize(1), sortSize(5), sortSize(200000)]).toEqual([2, 8, 262144]);
  });

  test('形状：种类、标志（局部模拟、曲线、字段有没有）、排序方式、两套 UV 的参数', () => {
    const shape = (file: ParticleModuleFile) => {
      const buffer = packShape(emitter(file));
      return { u32: new Uint32Array(buffer), f32: new Float32Array(buffer) };
    };
    const quad = shape({
      shapeBuilder: { $type: 'shapeBuilderQuad', samplerSize: { $type: 'computeCurveSamplerFloat', curve: { keyFrames: [{ key: 0, value: 2 }] } } },
      simulationSpace: 'local', sortingPolicy: 'byAge', initializers: [{ $type: 'initialSizeSeed' }],
      material: { $type: 'particleMaterialComputeColor', uvBuilder: { $type: 'uvBuilderFlipbook', xDivisions: 8, yDivisions: 4, animationSpeed: 32 } },
    });
    expect(quad.u32.length).toBe(SHAPE_VEC4S * 4);
    expect([quad.u32[0], quad.u32[1], quad.u32[3]]).toEqual([1, SHAPE_FLAGS.local | SHAPE_FLAGS.sizeCurve | SHAPE_FLAGS.scaleLength | SHAPE_FLAGS.hasSize, 1]);
    expect([quad.u32[4], quad.u32[5], ...quad.f32.subarray(8, 12)]).toEqual([1, 0, 8, 4, 0, 32]);
    expect(quad.f32[(6 + 32) * 4]).toBe(2);
    const billboard = shape({ sortingPolicy: 'byDepth', initializers: [{ $type: 'initial3DRotationSeed' }] });
    expect([billboard.u32[0], billboard.u32[1]! & SHAPE_FLAGS.hasQuaternion, billboard.u32[3]]).toEqual([0, SHAPE_FLAGS.hasQuaternion, 2]);
  });
});

describe('GPU 粒子：发射器', () => {
  test('管线在后台编，编好之前不模拟；之后每帧把头、生成的范围、种子、寿命、默认值、要处理的那段环和模块的数据写进 uniform，按 64 一组派发那一段', async () => {
    stubGpuGlobals();
    const { device, calls, writes } = fakeGpu();
    const source = emitter({ maxParticlesOverride: 1000, particleLifetime: [1, 2], initializers: [{ $type: 'initialSizeSeed' }] }, [3, 4, 5], 2);
    expect(source.targetCapacity).toBe(1000);
    const gpu = new GpuEmitter(device, source, source.targetCapacity, 7);
    const pass = { setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: (n: number) => calls.push({ method: 'dispatch', args: [n] }) } as unknown as GPUComputePassEncoder;
    gpu.simulate(pass, 0.5, 30);
    expect([calls.some((call) => call.method === 'dispatch'), gpu.ring.head, calls.some((call) => call.method === 'createComputePipeline')]).toEqual([false, 0, false]);
    await Promise.resolve();
    gpu.simulate(pass, 0.5, 30);
    const header = writes.filter((write: BufferWrite) => (write.buffer as GPUBuffer).label?.endsWith('simulate')).at(-1)!;
    const f32 = new Float32Array(header.bytes.buffer, header.bytes.byteOffset, header.bytes.byteLength / 4);
    const u32 = new Uint32Array(header.bytes.buffer, header.bytes.byteOffset, header.bytes.byteLength / 4);
    expect([f32[0], u32[1], u32[2], u32[3], u32[4], f32[5], f32[6]]).toEqual([0.5, 1000, 0, 30, 7, 1, 2]);
    // 默认位置是粒子系统的位置、默认大小是它的缩放
    expect([...f32.subarray(8, 12)]).toEqual([3, 4, 5, 2]);
    expect(f32.length).toBe((HEADER_VEC4S + 1) * 4);
    // 只派发可能活着的那一段环：这一帧生成的 30 个，从槽 0 起
    expect([u32[16], u32[17]]).toEqual([0, 30]);
    expect(calls.filter((call) => call.method === 'dispatch').map((call) => call.args[0])).toEqual([Math.ceil(30 / WORKGROUP_SIZE)]);
    expect(gpu.ring.head).toBe(30);
  });
});

describe('GPU 粒子：间接绘制', () => {
  test('模拟时活着的粒子数从 0 数起；不排序、按深度排序的间接绘制，按新旧画的只画最近生成的那段环', async () => {
    stubGpuGlobals();
    const { device, calls, writes } = fakeGpu();
    const make = (sortingPolicy: string) => new GpuEmitter(device, emitter({ maxParticlesOverride: 1000, sortingPolicy, initializers: [{ $type: 'initialSizeSeed' }] }), 1000, 0);
    const none = make('none'), byAge = make('byAge');
    await Promise.resolve();
    const pass = { setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: () => {} } as unknown as GPUComputePassEncoder;
    byAge.simulate(pass, 0.1, 40);
    const args = writes.filter((write) => (write.buffer as GPUBuffer).label?.endsWith(' draw')).at(-1)!;
    expect([...new Uint32Array(args.bytes.buffer, args.bytes.byteOffset, 4)]).toEqual([6, 0, 0, 0]);
    expect(buildKernel(none.emitter).code).toContain('markAlive(i);');
    const render = { draw: (...args: number[]) => calls.push({ method: 'draw', args }), drawIndirect: (...args: unknown[]) => calls.push({ method: 'drawIndirect', args }) } as unknown as GPURenderPassEncoder;
    none.draw(render);
    byAge.draw(render);
    expect(calls.filter((call) => call.method === 'drawIndirect')).toHaveLength(1);
    expect(calls.find((call) => call.method === 'draw')!.args).toEqual([6, 40]);
  });
});
