import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Transform } from '../src/engine/transform';
import { Game } from '../src/engine/Game';
import { ContentManager } from '../src/content/ContentManager';
import type { SceneFile } from '../src/content/formats/format';
import { SkyAtmosphere, VolumetricClouds } from '../src/rendering/components';
import { celestialState, DayNightCycle, dayNightCycleSystem, lightRotationTowards } from '../src/rendering/sky/DayNightCycle';
import { Vector3 } from '../src/data/vectors';

const DEGREES = Math.PI / 180;
const elevation = (direction: readonly number[]) => Math.asin(direction[1]!) / DEGREES;
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1 });
});

afterAll(() => native?.shutdown());

describe('场景文件里的天空', () => {
  test('skyAtmosphere 的太阳、月亮引用排在它后面的实体；dayNightCycle、volumetricClouds 照写的值建，没写的是默认值', async () => {
    const scene: SceneFile = {
      name: 'Sky',
      entities: [
        { id: 'sky', name: 'Sky', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {
          skyAtmosphere: { sun: 'sun', moon: 'moon', starsIntensity: 2 },
          dayNightCycle: { timeOfDay: 6, dayLength: 600 },
          volumetricClouds: { coverage: 0.3, bottom: 2000 },
        } },
        { id: 'sun', name: 'Sun', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'directional', color: [1, 1, 1], intensity: 5 } } },
        { id: 'moon', name: 'Moon', parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { light: { type: 'directional', color: [0.6, 0.7, 1], intensity: 0.2 } } },
      ],
    };
    const content = new ContentManager({ root: 'https://game.test/content/', read: async () => new TextEncoder().encode(JSON.stringify(scene)).buffer as ArrayBuffer });
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const loaded = await content.loadScene('scenes/Sky', game.entities);
    const byName = (name: string) => loaded.entities.get(name.toLowerCase())!;
    const sky = byName('Sky').require(SkyAtmosphere);
    expect([sky.sun, sky.moon]).toEqual([byName('Sun').id, byName('Moon').id]);
    expect([sky.starsIntensity, sky.moonDiskIntensity, sky.planetRadius]).toEqual([2, 1, 6360]);
    const cycle = byName('Sky').require(DayNightCycle);
    expect([cycle.timeOfDay, cycle.dayLength, cycle.latitude, cycle.moonPhase]).toEqual([6, 600, 35, 0.5]);
    const clouds = byName('Sky').require(VolumetricClouds);
    expect([clouds.coverage, clouds.bottom, clouds.thickness]).toEqual([expect.closeTo(0.3, 6), 2000, 2500]);
  });
});

describe('日夜循环（DayNightCycle）', () => {
  test('春分、北纬 35°：正午太阳在正南 55° 高，早上六点在正东的地平线上，傍晚六点在正西', () => {
    const noon = celestialState(12, 80, 35, 0, 0.5).sun;
    expect(elevation(noon)).toBeCloseTo(55, 4);
    // 北是 -Z，所以正南是 +Z
    expect(noon[0]).toBeCloseTo(0, 6);
    expect(noon[2]).toBeGreaterThan(0);
    const sunrise = celestialState(6, 80, 35, 0, 0.5).sun;
    expect(sunrise[0]).toBeCloseTo(1, 5);
    expect(elevation(sunrise)).toBeCloseTo(0, 4);
    expect(celestialState(18, 80, 35, 0, 0.5).sun[0]).toBeCloseTo(-1, 5);
    expect(elevation(celestialState(0, 80, 35, 0, 0.5).sun)).toBeCloseTo(-55, 4);
  });

  test('季节：夏至正午的太阳比冬至高两个黄赤交角，夏天六点太阳已经升起来了', () => {
    const summer = elevation(celestialState(12, 172, 35, 0, 0.5).sun);
    const winter = elevation(celestialState(12, 355, 35, 0, 0.5).sun);
    expect(summer).toBeCloseTo(55 + 23.44, 1);
    expect(winter).toBeCloseTo(55 - 23.44, 1);
    expect(elevation(celestialState(6, 172, 35, 0, 0.5).sun)).toBeGreaterThan(5);
    expect(elevation(celestialState(6, 355, 35, 0, 0.5).sun)).toBeLessThan(-5);
  });

  test('月相：满月在太阳对面（半夜在南边的天上），新月和太阳在一起，上弦月和太阳差 90°', () => {
    const full = celestialState(0, 80, 35, 0, 0.5);
    expect(dot(full.sun, full.moon)).toBeCloseTo(-1, 6);
    expect(elevation(full.moon)).toBeCloseTo(55, 4);
    const fresh = celestialState(9, 200, 35, 0, 0);
    expect(dot(fresh.sun, fresh.moon)).toBeCloseTo(1, 6);
    const quarter = celestialState(18, 80, 35, 0, 0.25);
    // 春分的上弦月在黄经 90°（夏至点）：和太阳差 90°，日落时在南边的高处
    expect(dot(quarter.sun, quarter.moon)).toBeCloseTo(0, 6);
    expect(elevation(quarter.moon)).toBeGreaterThan(70);
  });

  test('星空的旋转带着太阳一起转：天极在正北、纬度那么高；north 把整个天空绕 Y 转', () => {
    const { rotation } = celestialState(3, 80, 35, 0, 0.5);
    const pole = new Vector3(0, 1, 0).rotate(rotation);
    expect(pole.x).toBeCloseTo(0, 6);
    expect(pole.y).toBeCloseTo(Math.sin(35 * DEGREES), 6);
    expect(pole.z).toBeCloseTo(-Math.cos(35 * DEGREES), 6);
    // 换一个时刻，天极不动
    const later = new Vector3(0, 1, 0).rotate(celestialState(15, 80, 35, 0, 0.5).rotation);
    expect(later.z).toBeCloseTo(pole.z, 6);
    // 北转到 -X（绕 Y 转 90°）：早上六点的太阳从 -Z 升起
    const turned = celestialState(6, 80, 35, 90, 0.5).sun;
    expect(turned[2]).toBeCloseTo(-1, 5);
  });

  test('方向光的旋转：本地 -Z 背着光源', () => {
    const direction: [number, number, number] = [0.36, 0.48, -0.8];
    const forward = new Vector3(0, 0, -1).rotate(lightRotationTowards(direction));
    expect(forward.x).toBeCloseTo(-direction[0], 6);
    expect(forward.y).toBeCloseTo(-direction[1], 6);
    expect(forward.z).toBeCloseTo(-direction[2], 6);
  });

  test('系统：转太阳、月亮和自己；dayLength 大于 0 时时刻往前走，过了午夜日期加一、月相往前走', () => {
    // 带原生变换存储、但不跑帧循环的游戏
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const { entities, updateTime: time } = game;
    let advancing = true;
    entities.addSystems(dayNightCycleSystem(entities, () => advancing));
    const sun = entities.create({ components: [Transform] });
    const moon = entities.create({ components: [Transform] });
    const sky = entities.create({
      components: [Transform, SkyAtmosphere.with({ sun: sun.id, moon: moon.id }), DayNightCycle.with({ timeOfDay: 23, dayLength: 240, dayOfYear: 365, moonPhase: 0.5 })],
    });
    const step = (seconds: number) => {
      time.advance(seconds);
      entities.update(time);
    };
    step(0);
    const forward = () => new Vector3(0, 0, -1).rotate(sun.require(Transform).rotation);
    const expected = celestialState(23, 365, 35, 0, 0.5);
    expect(forward().x).toBeCloseTo(-expected.sun[0], 5);
    expect(forward().y).toBeCloseTo(-expected.sun[1], 5);
    expect(sky.require(Transform).rotation.w).toBeCloseTo(expected.rotation.w, 5);
    expect(new Vector3(0, 0, 1).rotate(moon.require(Transform).rotation).y).toBeCloseTo(expected.moon[1], 5);
    // 一天 240 秒：10 秒是一小时。走两小时，过了午夜
    step(20);
    const cycle = sky.require(DayNightCycle);
    expect(cycle.timeOfDay).toBeCloseTo(1, 4);
    expect(cycle.dayOfYear).toBe(1);
    expect(cycle.moonPhase).toBeCloseTo(0.5 + 1 / 29.53, 5);
    // 编辑状态：时刻不走，改了时刻照样摆
    advancing = false;
    step(20);
    expect(cycle.timeOfDay).toBeCloseTo(1, 4);
    cycle.timeOfDay = 12;
    step(0);
    expect(-forward().y).toBeCloseTo(celestialState(12, 1, 35, 0, cycle.moonPhase).sun[1], 5);
  });
});
