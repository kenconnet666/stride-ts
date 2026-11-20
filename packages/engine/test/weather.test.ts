import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ContentManager } from '../src/content/ContentManager';
import type { SceneFile } from '../src/content/format';
import { checkEntity } from '../src/editor/fields';
import { Game } from '../src/engine/Game';
import { Precipitation, precipitationEmitter } from '../src/weather/Precipitation';
import { GPU_LOCAL_WINDS, gust, type LocalWind, packWind, WindField, WindZone } from '../src/weather/WindField';
import { buildKernel } from '../src/particles/gpu/kernel';
import { ParticlePool } from '../src/particles/ParticlePool';
import { ParticleSystem } from '../src/particles/ParticleSystem';
import { UpdaterWind } from '../src/particles/updaters';
import { SkyOcclusion, skyOcclusionCenter } from '../src/weather/SkyOcclusion';
import { Matrix } from '../src/data/Matrix';
import { fakeGpu, stubGpuGlobals } from './fakeGpu';

const still = { turbulence: 0, pulseMagnitude: 0, pulseFrequency: 0 };
const local = (center: [number, number, number], radius: number, strength: number): LocalWind => ({ center, radius, strength, ...still });
const round = (v: readonly number[]) => v.map((c) => +c.toFixed(4) + 0);

describe('风场', () => {
  test('全局风到处一样；局部风源从中心往外吹，在半径里线性衰减，半径外没有', () => {
    const wind = new WindField();
    wind.set({ velocity: [2, 0, 0], ...still }, [local([10, 0, 0], 4, 6)]);
    expect(round(wind.sample(-100, 5, 3))).toEqual([2, 0, 0]);
    // 离中心 1 米（半径 4）：往外 6 · 0.75
    expect(round(wind.sample(10, 1, 0))).toEqual([2, 4.5, 0]);
    expect(round(wind.sample(15, 0, 0))).toEqual([2, 0, 0]);
  });

  test('阵风让强度在 1 ± 幅度之间起伏；湍流按位置变；风源没变时版本号不变', () => {
    const wind = new WindField();
    wind.set({ velocity: [0, 0, 4], turbulence: 0, pulseMagnitude: 0.5, pulseFrequency: 1 }, []);
    const speeds = Array.from({ length: 50 }, (_, i) => {
      wind.time = i * 0.137;
      return wind.sample(0, 0, 0)[2];
    });
    expect(Math.min(...speeds)).toBeGreaterThanOrEqual(2 - 1e-6);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(6 + 1e-6);
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThan(1);
    expect(Math.max(...Array.from({ length: 200 }, (_, i) => Math.abs(gust(i / 37))))).toBeLessThanOrEqual(1);
    wind.set({ velocity: [0, 0, 0], turbulence: 1, pulseMagnitude: 0, pulseFrequency: 0 }, []);
    expect(wind.sample(0, 0, 0)).not.toEqual(wind.sample(5, 2, 7));
    const version = wind.version;
    wind.set({ velocity: [0, 0, 0], turbulence: 1, pulseMagnitude: 0, pulseFrequency: 0 }, []);
    expect(wind.version).toBe(version);
  });

  test('局部风源按格子找：远处的风源不用逐个看也取得到；数量不设上限', () => {
    const wind = new WindField();
    const locals = Array.from({ length: 2000 }, (_, i) => local([i * 50, 0, 0], 10, 1));
    wind.set({ velocity: [0, 0, 0], ...still }, locals);
    expect(round(wind.sample(1500 + 5, 0, 0))).toEqual([0.5, 0, 0]);
    // GPU 只带最近的几个：离 (1500, 0, 0) 最近的是它自己和左右两个
    expect(wind.nearest(1500, 0, 0, 3).map((l) => l.center[0]).sort((a, b) => a - b)).toEqual([1450, 1500, 1550]);
  });

  test('打包给着色器：全局风、个数，最近的局部风源各两个 vec4', () => {
    const wind = new WindField();
    wind.set({ velocity: [1, 2, 3], turbulence: 0.5, pulseMagnitude: 0.25, pulseFrequency: 2 }, [local([100, 0, 0], 5, 7), local([1, 0, 0], 3, 4)]);
    const out = new Float32Array((2 + 2 * GPU_LOCAL_WINDS) * 4);
    packWind(wind, [0, 0, 0], out, 0);
    expect([...out.subarray(0, 8)]).toEqual([1, 2, 3, 0.5, 0.25, 2, 2, 0]);
    expect([...out.subarray(8, 16)]).toEqual([1, 0, 0, 3, 4, 0, 0, 0]);
    expect([...out.subarray(16, 20)]).toEqual([100, 0, 0, 5]);
  });

  test('粒子的风：速度往 风 + 终端速度 靠（CPU）；GPU 内核按同样的公式，打包 drag 和终端速度', () => {
    const wind = new WindField();
    wind.set({ velocity: [4, 0, 0], ...still }, []);
    const updater = new UpdaterWind({ $type: 'updaterWind', drag: 2, terminalVelocity: [0, -9, 0] });
    updater.field = wind;
    const pool = new ParticlePool(new Set(['life', 'position', 'velocity']));
    pool.setCapacity(1);
    pool.add();
    updater.update(0.25, pool);
    // k = min(1, 2 · 0.25) = 0.5：从 0 往 (4, -9, 0) 走一半
    expect([...pool.field('velocity')!]).toEqual([2, -4.5, 0]);
    const system = new ParticleSystem({ emitters: [{ updaters: [{ $type: 'updaterWind', drag: 2, terminalVelocity: [0, -9, 0] }] }] });
    system.update(0);
    const kernel = buildKernel(system.emitters[0]!);
    expect(kernel.code).toContain('windAt((*p).position, sim.time, 0u) + sim.data[18].yzw');
    const data = new Float32Array(kernel.slots * 4);
    kernel.pack(data);
    expect([...data.subarray(18 * 4, 19 * 4)]).toEqual([2, 0, -9, 0]);
  });
});

describe('雨雪', () => {
  test('发射器：在 GPU 上，体积按半径和高度，寿命是落下两倍高度的时间，容量够装下；雨沿速度拉长，雪是点', () => {
    const rain = precipitationEmitter('rain', 10, 9);
    const emitter = (rain.file['particleSystem'] as { emitters: Record<string, unknown>[] }).emitters[0]!;
    expect(rain.rate).toBe(20 * 20 * 20);
    expect([emitter['simulation'], emitter['particleLifetime'], (emitter['shapeBuilder'] as { $type: string }).$type]).toEqual(['gpu', [2, 2.2], 'shapeBuilderOrientedQuad']);
    expect(emitter['maxParticlesOverride']).toBeGreaterThanOrEqual(rain.rate * 2.2);
    const system = new ParticleSystem(rain.file['particleSystem'] as never);
    const snow = precipitationEmitter('snow', 10, 9);
    expect(((snow.file['particleSystem'] as { emitters: Record<string, { $type: string }>[] }).emitters[0]!['shapeBuilder'])!.$type).toBe('shapeBuilderBillboard');
    expect(system.emitters[0]!.updaters.some((updater) => updater instanceof UpdaterWind)).toBe(true);
  });
});

describe('天空遮挡（从上往下的深度图）', () => {
  test('没人用就不画、不建贴图；中心按纹素吸附；走远了或者到了刷新间隔才重画；画完下一帧开头才换成对外那张、版本号加一', () => {
    stubGpuGlobals();
    const { device, calls, writes } = fakeGpu();
    const sky = new SkyOcclusion(device);
    Object.assign(sky, { size: 64, resolution: 512, redrawDistance: 8, refreshInterval: 1 });
    expect(skyOcclusionCenter({ x: 5.06, y: 1.2, z: -2.1 }, 0.125)).toEqual([5.0, 1.25, -2.125]);
    expect(sky.begin({ x: 0, y: 0, z: 0 }, 0)).toBeUndefined();
    expect(calls.some((call) => call.method === 'createTexture')).toBe(false);
    sky.use();
    const view = sky.begin({ x: 0.3, y: 0, z: 0 }, 0)!;
    // 正交、从上往下：中心正下方的点在画面中间
    const c = Matrix.transformPoint(view.viewProjection, 0.25, 0, 0);
    expect([+c[0].toFixed(4) + 0, +c[1].toFixed(4) + 0]).toEqual([0, 0]);
    sky.use();
    expect(sky.begin({ x: 5, y: 0, z: 0 }, 0.5)).toBeUndefined();
    sky.use();
    expect(sky.begin({ x: 9, y: 0, z: 0 }, 0.6)).toBe(view);
    sky.use();
    expect(sky.begin({ x: 9, y: 0, z: 0 }, 1.7)).toBe(view);
    // 画完：这一帧还是旧的，下一帧 begin 时换上
    const pass = { end: () => {} } as unknown as GPURenderPassEncoder;
    const encoder = { beginRenderPass: () => pass } as unknown as GPUCommandEncoder;
    sky.draw({} as never, encoder, { draw: () => {}, graphicsDevice: { profiler: { passTimestamps: () => undefined } } } as never, {} as never);
    expect(sky.version).toBe(0);
    sky.begin({ x: 9, y: 0, z: 0 }, 1.8);
    expect(sky.version).toBe(1);
    const [write] = writes.filter((w) => (w.buffer as GPUBuffer).label === 'SkyOcclusion');
    expect(new Uint32Array(write!.bytes.buffer, write!.bytes.byteOffset + 64, 1)[0]).toBe(1);
    sky.use();
    sky.enabled = false;
    expect(sky.begin({ x: 100, y: 0, z: 0 }, 5)).toBeUndefined();
  });

  test('发射器挂了遮挡时，内核多两个绑定，活着的粒子到了表面以下就死', () => {
    stubGpuGlobals();
    const { device } = fakeGpu();
    const system = new ParticleSystem({ emitters: [{ initializers: [{ $type: 'initialSizeSeed' }] }] });
    const emitter = system.emitters[0]!;
    expect(buildKernel(emitter).occluded).toBe(false);
    emitter.gpuOccluder = new SkyOcclusion(device);
    const kernel = buildKernel(emitter);
    expect(kernel.occluded).toBe(true);
    expect(kernel.code).toContain('@group(0) @binding(2) var occlusionDepth: texture_depth_2d;');
    expect(kernel.code).toContain('if (occluded(p.position)) {\n    p.life = 0.0;');
  });
});

describe('风场和雨雪写在场景文件里', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  test('windZone、precipitation 加出组件，没写的字段用默认值；编辑器的字段描述照它们检查', async () => {
    const scene: SceneFile = {
      name: 'Weather',
      entities: [
        { id: 'wind', name: 'Wind', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { windZone: { mode: 'spherical', strength: 5, radius: 3 } } },
        { id: 'rain', name: 'Rain', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { precipitation: { kind: 'snow' } } },
      ],
    };
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => new TextEncoder().encode(JSON.stringify(scene)).buffer as ArrayBuffer });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const loaded = await content.loadScene('scenes/Weather', game.entities);
    const zone = loaded.entities.get('wind')!.require(WindZone);
    expect([zone.mode, zone.strength, zone.radius, zone.turbulence]).toEqual(['spherical', 5, 3, 0.5]);
    const precipitation = loaded.entities.get('rain')!.require(Precipitation);
    expect([precipitation.kind, precipitation.intensity, precipitation.radius]).toEqual(['snow', 1, 20]);
    expect(checkEntity(scene.entities[0]!)).toEqual([]);
    expect(checkEntity({ ...scene.entities[1]!, components: { precipitation: { intensity: 3 } } }).length).toBeGreaterThan(0);
  });
});
