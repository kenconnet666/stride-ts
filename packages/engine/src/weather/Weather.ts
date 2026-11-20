/**
 * 天气状态（Stride 没有，新加的）：一个 Weather 组件写"想要的天气"（云量、云的种类、降水、气温、雾、风），`game.weather`
 * 让当前的天气按 transitionTime 慢慢靠过去，再把当前的值写给场景里的这些东西：
 *
 * - 体积云（VolumetricClouds）：覆盖率、云的种类、密度（下雨的云更厚更暗）、高空的风（地面风的 3 倍，同一个方向）；
 * - 体积雾（VolumetricFog）：密度（雾的量，加上雨里的水汽）；
 * - 雨雪（Precipitation）：强度，种类按气温（低于 1 °C 下雪）；
 * - 风（`game.wind` 的全局风）：风速、方向、阵风和湍流，和场景里 directional 的 WindZone 加在一起。
 *
 * 只驱动场景里有的：没有体积云就只是不画云，想要的东西（以及它们没被天气接管的字段：云底、雾的高度衰减、雨的范围）照常
 * 写在各自的组件上。地面多湿、积了多少雪（wetness、snowCover）跟着降水慢慢变，写给渲染系统（`renderSystem.surfaceWeather`）：
 * 网格着色时淋得到的表面变湿（变暗、变光滑），朝上的积雪。
 *
 * 风向和体积云的 windDirection 一样是吹向的方位（度，0 是 +Z，90 是 +X）。编辑状态下（`game.editing`）不过渡，直接是想要的
 * 天气，地面的湿和雪也直接是下了很久以后的样子。场景里有几个 Weather 时只用第一个。
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import { system } from '../engine/system';
import type { Game } from '../engine/Game';
import { VolumetricClouds, VolumetricFog } from '../rendering/components';
import { Precipitation } from './Precipitation';
import type { GlobalWind } from './WindField';

export const Weather = component('Weather', {
  /** 云量，0 到 1。 */
  cloudCoverage: prop.f32().default(0.3).min(0).max(1),
  /** 云的种类：0 是一层层的层云，1 是一团团的积雨云。 */
  cloudType: prop.f32().default(0.7).min(0).max(1),
  /** 降水，0 到 1（1 是暴雨、暴雪）。 */
  precipitation: prop.f32().default(0).min(0).max(1),
  /** 气温（摄氏度）：低于 1 °C 时降水是雪，高于 0 °C 时积雪化掉。 */
  temperature: prop.f32().default(15).unit('°C'),
  /** 雾，0 到 1（1 是几十米外就看不清）。 */
  fog: prop.f32().default(0).min(0).max(1),
  /** 地面的风速，米每秒。 */
  windSpeed: prop.f32().default(3).min(0).unit('m/s'),
  /** 风吹向的方位（度，0 是 +Z，90 是 +X）。 */
  windDirection: prop.f32().default(0).unit('deg'),
  /** 阵风：0 是平稳，1 是一阵一阵的大风。 */
  gustiness: prop.f32().default(0.3).min(0).max(1),
  /** 当前的天气靠向想要的天气的时间常数（秒）：过这么久走完差距的 63%，三倍的时间基本到位；0 是马上变。 */
  transitionTime: prop.f32().default(30).min(0).unit('s'),
});

/** 当前的天气：Weather 组件的各项，加上地面的湿和雪。 */
export interface WeatherState {
  cloudCoverage: number;
  cloudType: number;
  precipitation: number;
  temperature: number;
  fog: number;
  windSpeed: number;
  windDirection: number;
  gustiness: number;
  /** 地面多湿，0 到 1：下雨时变湿，雨停了慢慢干。 */
  wetness: number;
  /** 地面积了多少雪，0 到 1：下雪时积起来，气温高于 0 °C 时化掉。 */
  snowCover: number;
}

/** Weather 组件里写的那几项（不带过渡时间）。 */
export type WeatherTarget = Omit<WeatherState, 'wetness' | 'snowCover'>;

/** 几种常见的天气（`stride call weather '{"preset":"rain"}'`；编辑器、游戏也可以拿来用）。 */
export const WEATHER_PRESETS = {
  clear: { cloudCoverage: 0.15, cloudType: 0.8, precipitation: 0, temperature: 18, fog: 0, windSpeed: 2, windDirection: 0, gustiness: 0.2 },
  cloudy: { cloudCoverage: 0.55, cloudType: 0.8, precipitation: 0, temperature: 15, fog: 0, windSpeed: 4, windDirection: 0, gustiness: 0.3 },
  overcast: { cloudCoverage: 0.9, cloudType: 0.1, precipitation: 0, temperature: 12, fog: 0.1, windSpeed: 5, windDirection: 0, gustiness: 0.3 },
  rain: { cloudCoverage: 0.95, cloudType: 0.3, precipitation: 0.6, temperature: 10, fog: 0.2, windSpeed: 6, windDirection: 0, gustiness: 0.4 },
  storm: { cloudCoverage: 1, cloudType: 1, precipitation: 1, temperature: 14, fog: 0.3, windSpeed: 14, windDirection: 0, gustiness: 0.8 },
  fog: { cloudCoverage: 0.6, cloudType: 0, precipitation: 0, temperature: 8, fog: 0.8, windSpeed: 0.5, windDirection: 0, gustiness: 0.1 },
  snow: { cloudCoverage: 0.9, cloudType: 0.2, precipitation: 0.6, temperature: -5, fog: 0.3, windSpeed: 3, windDirection: 0, gustiness: 0.3 },
} as const satisfies Record<string, WeatherTarget>;

export type WeatherPreset = keyof typeof WEATHER_PRESETS;

/** 大雨下多久地面全湿、雨停了多久干透、大雪下多久积满（秒；降水小时按比例慢）。 */
const WETTING_TIME = 60;
const DRYING_TIME = 300;
const SNOWING_TIME = 600;
/** 气温每高 1 °C，积雪多快化掉（每秒化掉的比例）。 */
const MELT_PER_DEGREE = 1 / 600;
/** 低于这个气温降水是雪。 */
const SNOW_BELOW = 1;
/** 高空的风是地面的几倍（云飘的速度）。 */
const HIGH_ALTITUDE_WIND = 3;

/** 天气到雾的密度（每米的消光）：一点点霭，加上雾（平方：小的值只是霭），加上雨雪里的水汽。 */
export function fogDensity(state: Pick<WeatherState, 'fog' | 'precipitation'>): number {
  return 0.0015 + 0.08 * state.fog * state.fog + 0.015 * state.precipitation;
}

/** 天气到全局风：方向 · 风速，湍流和阵风跟着风速和阵风的大小。 */
export function weatherWind(state: Pick<WeatherState, 'windSpeed' | 'windDirection' | 'gustiness'>): GlobalWind {
  const angle = (state.windDirection * Math.PI) / 180;
  return {
    velocity: [Math.sin(angle) * state.windSpeed, 0, Math.cos(angle) * state.windSpeed],
    turbulence: state.windSpeed * (0.1 + 0.3 * state.gustiness),
    pulseMagnitude: state.gustiness,
    pulseFrequency: 0.1 + 0.3 * state.gustiness,
  };
}

/** 所有天气（`game.weather`）：每帧在风场、雨雪之前，让当前的天气靠向 Weather 组件写的，再写给云、雾、雨雪和风。 */
export class WeatherSystem {
  /** 当前的天气；场景里没有 Weather 时是 undefined（这时什么都不接管）。 */
  current: WeatherState | undefined;
  #target: (WeatherTarget & { transitionTime: number }) | undefined;

  readonly #collect = system('Weather.collect', {
    with: { weather: Weather },
    update: ({ weather, count }) => {
      if (count === 0 || this.#target) return;
      this.#target = {
        cloudCoverage: weather.cloudCoverage[0]!, cloudType: weather.cloudType[0]!, precipitation: weather.precipitation[0]!,
        temperature: weather.temperature[0]!, fog: weather.fog[0]!, windSpeed: weather.windSpeed[0]!,
        windDirection: weather.windDirection[0]!, gustiness: weather.gustiness[0]!, transitionTime: weather.transitionTime[0]!,
      };
    },
  });

  readonly #clouds = system('Weather.clouds', {
    with: { clouds: VolumetricClouds },
    writes: [VolumetricClouds],
    update: ({ clouds, count }) => {
      const state = this.current!;
      for (let i = 0; i < count; i++) {
        clouds.coverage[i] = state.cloudCoverage;
        clouds.cloudType[i] = state.cloudType;
        clouds.density[i] = 1 + state.precipitation;
        clouds.windSpeed[i] = state.windSpeed * HIGH_ALTITUDE_WIND;
        clouds.windDirection[i] = state.windDirection;
      }
    },
  });

  readonly #fog = system('Weather.fog', {
    with: { fog: VolumetricFog },
    writes: [VolumetricFog],
    update: ({ fog, count }) => {
      const density = fogDensity(this.current!);
      for (let i = 0; i < count; i++) fog.density[i] = density;
    },
  });

  readonly #precipitation = system('Weather.precipitation', {
    with: { precipitation: Precipitation },
    writes: [Precipitation],
    update: ({ precipitation, count }) => {
      const state = this.current!;
      const kind = state.temperature < SNOW_BELOW ? 'snow' : 'rain';
      for (let i = 0; i < count; i++) {
        precipitation.kind[i] = kind;
        precipitation.intensity[i] = state.precipitation;
      }
    },
  });

  /** @internal Game 每帧在变换更新之后、风场和雨雪之前调用。 */
  update(game: Game): void {
    this.#target = undefined;
    game.entities.run(this.#collect, game.updateTime);
    const target = this.#target as (WeatherTarget & { transitionTime: number }) | undefined;
    const surface = (game.renderSystem as Game['renderSystem'] | undefined)?.surfaceWeather;
    if (!target) {
      this.current = undefined;
      game.wind.weather = undefined;
      if (surface) Object.assign(surface, { wetness: 0, snowCover: 0 });
      return;
    }
    this.advance(target, game.editing ? undefined : game.updateTime.elapsed);
    for (const run of [this.#clouds, this.#fog, this.#precipitation]) game.entities.run(run, game.updateTime);
    game.wind.weather = weatherWind(this.current!);
    // 材质的湿和雪：淋不淋得到看天空遮挡
    if (surface) {
      const { wetness, snowCover } = this.current!;
      Object.assign(surface, { wetness, snowCover });
      if (wetness > 0 || snowCover > 0) game.renderSystem.skyOcclusion.use();
    }
  }

  /**
   * 当前的天气往 target 走 elapsed 秒（单测、不用组件的游戏也能直接调）；elapsed 没给时直接到 target，地面的湿和雪是下了
   * 很久以后的样子（编辑状态、第一帧）。
   */
  advance(target: WeatherTarget & { transitionTime: number }, elapsed: number | undefined): WeatherState {
    const current = this.current;
    if (!current || elapsed === undefined) {
      const snowing = target.temperature < SNOW_BELOW && target.precipitation > 0;
      return (this.current = {
        ...stripTransition(target),
        wetness: target.precipitation > 0 && !snowing ? 1 : 0,
        snowCover: snowing ? 1 : 0,
      });
    }
    // 指数地靠过去：帧率不同走的一样
    const k = target.transitionTime > 0 ? 1 - Math.exp(-elapsed / target.transitionTime) : 1;
    for (const key of ['cloudCoverage', 'cloudType', 'precipitation', 'temperature', 'fog', 'windSpeed', 'gustiness'] as const) {
      current[key] += (target[key] - current[key]) * k;
    }
    // 风向走近的那一边
    const turn = ((((target.windDirection - current.windDirection) % 360) + 540) % 360) - 180;
    current.windDirection = (current.windDirection + turn * k + 360) % 360;
    const amount = current.precipitation;
    const snowing = current.temperature < SNOW_BELOW;
    const wetting = snowing ? 0 : amount / WETTING_TIME;
    current.wetness = clamp01(current.wetness + (wetting > 0 ? wetting : -1 / DRYING_TIME) * elapsed);
    const melting = Math.max(0, current.temperature) * MELT_PER_DEGREE;
    current.snowCover = clamp01(current.snowCover + ((snowing ? amount / SNOWING_TIME : 0) - melting) * elapsed);
    return current;
  }
}

function stripTransition({ transitionTime: _, ...target }: WeatherTarget & { transitionTime: number }): WeatherTarget {
  return target;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
