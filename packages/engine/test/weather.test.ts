import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ContentManager } from '../src/content/ContentManager';
import type { SceneFile } from '../src/content/format';
import { checkEntity } from '../src/editor/fields';
import { Game } from '../src/engine/Game';
import { Precipitation, precipitationEmitter } from '../src/weather/Precipitation';
import { fogDensity, Weather, WEATHER_PRESETS, WeatherSystem } from '../src/weather/Weather';
import { VolumetricClouds, VolumetricFog } from '../src/rendering/components';
import { GPU_LOCAL_WINDS, gust, type LocalWind, packWind, WindField, WindZone } from '../src/weather/WindField';
import { buildKernel } from '../src/particles/gpuKernel';
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
    // 深度拷进还没换上的那个缓冲（网格着色器读缓冲），下一帧开头和矩阵一起换上
    const pass = { end: () => {} } as unknown as GPURenderPassEncoder;
    const copies: GPUBuffer[] = [];
    const encoder = { beginRenderPass: () => pass, copyTextureToBuffer: (_: unknown, { buffer }: { buffer: GPUBuffer }) => copies.push(buffer) } as unknown as GPUCommandEncoder;
    const before = sky.depthBuffer;
    sky.draw({} as never, encoder, { draw: () => {}, graphicsDevice: { profiler: { passTimestamps: () => undefined } } } as never, {} as never);
    expect(sky.version).toBe(0);
    expect(copies).toHaveLength(1);
    expect(copies[0]).not.toBe(before);
    expect(sky.depthBuffer).toBe(before);
    sky.begin({ x: 9, y: 0, z: 0 }, 1.8);
    expect(sky.version).toBe(1);
    expect(sky.depthBuffer).toBe(copies[0]);
    const [write] = writes.filter((w) => (w.buffer as GPUBuffer).label === 'SkyOcclusion');
    // 有效位、深度图的边长
    expect(Array.from(new Uint32Array(write!.bytes.buffer, write!.bytes.byteOffset + 64, 2))).toEqual([1, 512]);
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

describe('天气状态', () => {
  const rain = { ...WEATHER_PRESETS.rain, transitionTime: 30 };
  const clear = { ...WEATHER_PRESETS.clear, transitionTime: 30 };

  test('第一次直接到想要的天气（下了很久的样子）；之后按时间常数指数地靠过去，帧率不同走的一样', () => {
    const weather = new WeatherSystem();
    expect(weather.advance(rain, 0.016)).toMatchObject({ cloudCoverage: 0.95, precipitation: 0.6, wetness: 1, snowCover: 0 });
    // 一个时间常数走完 63%
    weather.advance(clear, 30);
    expect(weather.current!.cloudCoverage).toBeCloseTo(0.95 + (0.15 - 0.95) * (1 - Math.exp(-1)), 5);
    const coarse = new WeatherSystem(), fine = new WeatherSystem();
    coarse.advance(rain, undefined);
    fine.advance(rain, undefined);
    coarse.advance(clear, 1);
    for (let i = 0; i < 100; i++) fine.advance(clear, 0.01);
    expect(fine.current!.cloudCoverage).toBeCloseTo(coarse.current!.cloudCoverage, 5);
    // 过渡时间 0：马上变
    expect(weather.advance({ ...rain, transitionTime: 0 }, 0.016).cloudCoverage).toBe(0.95);
  });

  test('风向走近的那一边；雨停了地面慢慢干，下雪积雪，气温高了雪化', () => {
    const weather = new WeatherSystem();
    weather.advance({ ...clear, windDirection: 350 }, undefined);
    weather.advance({ ...clear, windDirection: 10, transitionTime: 1 }, 100);
    expect(weather.current!.windDirection).toBeCloseTo(10, 3);
    weather.advance({ ...clear, windDirection: 350 }, undefined);
    weather.advance({ ...clear, windDirection: 10 }, 30);
    // 从 350 往上走过 0 到 10，不是往回走 340 度
    expect(weather.current!.windDirection < 10 || weather.current!.windDirection > 350).toBe(true);
    weather.advance(rain, undefined);
    weather.advance({ ...clear, transitionTime: 0 }, 150);
    expect(weather.current!.wetness).toBeCloseTo(0.5, 5);
    const snow = { ...WEATHER_PRESETS.snow, transitionTime: 0 };
    weather.advance({ ...clear, transitionTime: 0 }, undefined);
    weather.advance(snow, 100);
    expect(weather.current!.snowCover).toBeCloseTo((0.6 / 600) * 100, 5);
    expect(weather.current!.wetness).toBe(0);
    weather.advance({ ...snow, temperature: 10, precipitation: 0 }, 10);
    expect(weather.current!.snowCover).toBeLessThan((0.6 / 600) * 100);
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

  test('weather 加出 Weather；天气把当前的值写给云、雾、雨雪和全局风，没有天气时不接管', async () => {
    const scene: SceneFile = {
      name: 'Weather',
      entities: [
        { id: 'sky', name: 'Sky', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { weather: { ...WEATHER_PRESETS.snow }, volumetricClouds: {}, volumetricFog: {}, precipitation: {} } },
      ],
    };
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => new TextEncoder().encode(JSON.stringify(scene)).buffer as ArrayBuffer });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const loaded = await content.loadScene('scenes/Weather', game.entities);
    const sky = loaded.entities.get('sky')!;
    expect(sky.require(Weather).temperature).toBe(-5);
    game.weather.update(game);
    expect(sky.require(VolumetricClouds).coverage).toBeCloseTo(0.9, 5);
    expect(sky.require(VolumetricClouds).windSpeed).toBeCloseTo(9, 5);
    expect(sky.require(VolumetricFog).density).toBeCloseTo(fogDensity(WEATHER_PRESETS.snow), 5);
    expect([sky.require(Precipitation).kind, sky.require(Precipitation).intensity]).toEqual(['snow', expect.closeTo(0.6, 5)]);
    // 风吹向 0 度（+Z），3 米每秒
    game.wind.update(game);
    expect(game.wind.global.velocity.map((v) => +v.toFixed(4) + 0)).toEqual([0, 0, 3]);
    expect(checkEntity({ ...scene.entities[0]!, components: { weather: WEATHER_PRESETS.storm } })).toEqual([]);
    // 地面的湿和雪写给渲染系统，有湿或雪时要天空遮挡（屋檐下的不湿）
    let used = 0;
    const surfaceWeather = { wetness: 0, snowCover: 0 };
    game.renderSystem = { surfaceWeather, skyOcclusion: { use: () => used++ } } as never;
    game.weather.update(game);
    expect(surfaceWeather).toEqual({ wetness: 0, snowCover: 1 });
    expect(used).toBe(1);
    sky.remove(Weather);
    game.weather.update(game);
    expect(surfaceWeather).toEqual({ wetness: 0, snowCover: 0 });
    game.wind.update(game);
    expect(game.weather.current).toBeUndefined();
    expect(game.wind.global.velocity).toEqual([0, 0, 0]);
  });
});
