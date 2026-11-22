/**
 * 风场（Stride 没有，新加的；组件参考 Unity 的 WindZone）：`game.wind.sample(x, y, z)` 取某一点的风速（米每秒，世界空间）。
 *
 * 风源是带 WindZone 组件的实体：
 * - directional：全局的风，方向是实体的 -Z（Stride 的前方），所有地方都吹；
 * - spherical：局部的风，从实体的位置往外吹，强度在半径里线性衰减到 0。
 * 场景里有天气状态（world/Weather.ts）时，它给的风也算进全局风。
 * 都有阵风（pulse：强度按时间起伏）和湍流（turbulence：按位置、时间变的扰动，单位同风速）。全局风的阵风、湍流、局部风源
 * 都是时间和位置的确定函数，CPU（这里）和 GPU（windWgsl）用同一个公式，粒子在哪边模拟都一样。
 *
 * 局部风源按格子（cellSize 米）放进哈希表，取风时只看点所在那一格里的风源，风源的个数不设上限；每帧收集一次，内容没变时
 * version 不变（GPU 那边据此不重传）。
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';

/** 风源（Stride 没有）。 */
export const WindZone = component('WindZone', {
  mode: prop.enum(['directional', 'spherical']).default('directional'),
  /** 风速，米每秒。 */
  strength: prop.f32().default(3),
  /** 湍流的幅度，米每秒。 */
  turbulence: prop.f32().default(0.5).min(0),
  /** 阵风：强度在 1 ± pulseMagnitude 之间起伏。 */
  pulseMagnitude: prop.f32().default(0.5).min(0),
  /** 阵风每秒起伏几次。 */
  pulseFrequency: prop.f32().default(0.2).min(0),
  /** spherical 的半径，米。 */
  radius: prop.f32().default(10).min(0),
});

/** 全局风（所有 directional 的合起来）。 */
export interface GlobalWind {
  /** 风速向量（方向 · 强度），米每秒。 */
  readonly velocity: readonly [number, number, number];
  readonly turbulence: number;
  readonly pulseMagnitude: number;
  readonly pulseFrequency: number;
}

/** 一个局部风源。 */
export interface LocalWind {
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly strength: number;
  readonly turbulence: number;
  readonly pulseMagnitude: number;
  readonly pulseFrequency: number;
}

/** 阵风的起伏，-1 到 1（几个不成整数倍的正弦叠起来，看不出周期）。 */
export function gust(phase: number): number {
  const t = phase * 2 * Math.PI;
  return (Math.sin(t) + 0.5 * Math.sin(t * 2.31 + 1.7) + 0.25 * Math.sin(t * 4.17 + 0.3)) / 1.75;
}

/** 湍流的方向（每个分量 -1 到 1）：便宜的正弦扰动，按位置和时间变。 */
export function turbulenceAt(x: number, y: number, z: number, time: number, out: [number, number, number]): [number, number, number] {
  out[0] = Math.sin(y * 0.73 + time * 1.1 + Math.sin(z * 0.41));
  out[1] = 0.5 * Math.sin(z * 0.67 + time * 0.9 + Math.sin(x * 0.37));
  out[2] = Math.sin(x * 0.59 + time * 1.3 + Math.sin(y * 0.53));
  return out;
}

const NO_WIND: GlobalWind = { velocity: [0, 0, 0], turbulence: 0, pulseMagnitude: 0, pulseFrequency: 0 };

/**
 * 风场：各个 WindZone 合起来。坐标是渲染空间的（相对 game.renderOrigin，D18；局部风源的中心取自 Transform.renderWorld），
 * 和粒子的模拟同一个空间：sample、nearest 的点也按渲染空间给，世界坐标要先减渲染原点。
 */
export class WindField {
  /** 局部风源的格子边长，米。改了下一帧生效。 */
  cellSize = 32;
  /** 全局风；没有 directional 的风源时是 0。 */
  global: GlobalWind = NO_WIND;
  /** 所有局部风源（收集的顺序）。 */
  locals: readonly LocalWind[] = [];
  /** 风源变了就加一（GPU 那边按它决定重不重传）。 */
  version = 0;
  /** 取风用的时间（秒，game.updateTime.total）；阵风、湍流按它变。 */
  time = 0;
  /** 天气状态给的全局风（world/Weather.ts 每帧写；没有天气时是 undefined），和 directional 的风源加在一起。 */
  weather: GlobalWind | undefined;
  #grid = new Map<string, number[]>();
  #key = '';
  #collected: { global: { velocity: [number, number, number]; turbulence: number; pulseMagnitude: number; pulseFrequency: number }; locals: LocalWind[] } | undefined;
  readonly #turbulence: [number, number, number] = [0, 0, 0];

  readonly #collect = system('WindField.collect', {
    with: { zone: WindZone, transform: Transform },
    update: ({ zone, transform, count }) => {
      const collected = this.#collected!;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16, world = transform.renderWorld;
        const settings = { turbulence: zone.turbulence[i]!, pulseMagnitude: zone.pulseMagnitude[i]!, pulseFrequency: zone.pulseFrequency[i]! };
        if (zone.mode[i] === 'spherical') {
          collected.locals.push({ center: [world[w + 12]!, world[w + 13]!, world[w + 14]!], radius: zone.radius[i]!, strength: zone.strength[i]!, ...settings });
          continue;
        }
        // 方向是实体的 -Z
        const z = [world[w + 8]!, world[w + 9]!, world[w + 10]!];
        const length = Math.hypot(...z) || 1;
        const strength = zone.strength[i]!;
        const global = collected.global;
        for (let k = 0; k < 3; k++) global.velocity[k]! -= (z[k]! / length) * strength;
        // 几个全局风源：湍流、阵风取最大的
        global.turbulence = Math.max(global.turbulence, settings.turbulence);
        global.pulseMagnitude = Math.max(global.pulseMagnitude, settings.pulseMagnitude);
        global.pulseFrequency = Math.max(global.pulseFrequency, settings.pulseFrequency);
      }
    },
  });

  /** @internal Game 每帧在变换更新之后、粒子模拟之前调用：收集风源，变了才重建格子。 */
  update(game: Game): void {
    this.time = game.updateTime.total;
    const weather = this.weather;
    this.#collected = {
      global: weather ? { ...weather, velocity: [...weather.velocity] } : { velocity: [0, 0, 0], turbulence: 0, pulseMagnitude: 0, pulseFrequency: 0 },
      locals: [],
    };
    game.entities.run(this.#collect, game.updateTime);
    this.set(this.#collected.global, this.#collected.locals);
  }

  /** 直接给风源（单测、不用组件的游戏）：和上一次一样时什么都不做。 */
  set(global: GlobalWind, locals: readonly LocalWind[]): void {
    const key = JSON.stringify([global, locals, this.cellSize]);
    if (key === this.#key) return;
    this.#key = key;
    this.global = global;
    this.locals = locals;
    this.version++;
    const grid = new Map<string, number[]>();
    locals.forEach((local, index) => {
      const [x0, y0, z0] = local.center.map((c) => Math.floor((c - local.radius) / this.cellSize));
      const [x1, y1, z1] = local.center.map((c) => Math.floor((c + local.radius) / this.cellSize));
      for (let x = x0!; x <= x1!; x++) for (let y = y0!; y <= y1!; y++) for (let z = z0!; z <= z1!; z++) {
        const cell = `${x},${y},${z}`;
        let list = grid.get(cell);
        if (!list) grid.set(cell, (list = []));
        list.push(index);
      }
    });
    this.#grid = grid;
  }

  /** 渲染空间的 (x, y, z) 处这一刻的风速，米每秒，写进 out。 */
  sample(x: number, y: number, z: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    const time = this.time, global = this.global;
    const pulse = 1 + global.pulseMagnitude * gust(time * global.pulseFrequency);
    const noise = turbulenceAt(x, y, z, time, this.#turbulence);
    for (let k = 0; k < 3; k++) out[k] = global.velocity[k]! * pulse + noise[k]! * global.turbulence;
    const cell = `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)},${Math.floor(z / this.cellSize)}`;
    for (const index of this.#grid.get(cell) ?? []) addLocal(this.locals[index]!, x, y, z, time, noise, out);
    return out;
  }

  /** 离 (x, y, z) 最近的 count 个局部风源（GPU 粒子只带这几个进着色器）。 */
  nearest(x: number, y: number, z: number, count: number): LocalWind[] {
    const distance = (local: LocalWind) => Math.max(0, Math.hypot(local.center[0] - x, local.center[1] - y, local.center[2] - z) - local.radius);
    return [...this.locals].sort((a, b) => distance(a) - distance(b)).slice(0, count);
  }
}

/** 一个局部风源在 (x, y, z) 的贡献加进 out（noise 是这一点的湍流方向）。 */
function addLocal(local: LocalWind, x: number, y: number, z: number, time: number, noise: readonly number[], out: [number, number, number]): void {
  const dx = x - local.center[0], dy = y - local.center[1], dz = z - local.center[2];
  const distance = Math.hypot(dx, dy, dz);
  if (distance >= local.radius || local.radius <= 0) return;
  const falloff = 1 - distance / local.radius;
  const pulse = 1 + local.pulseMagnitude * gust(time * local.pulseFrequency);
  const scale = distance > 1e-6 ? (local.strength * falloff * pulse) / distance : 0;
  out[0] += dx * scale + noise[0]! * local.turbulence * falloff;
  out[1] += dy * scale + noise[1]! * local.turbulence * falloff;
  out[2] += dz * scale + noise[2]! * local.turbulence * falloff;
}

/** GPU 粒子带进着色器的局部风源个数。 */
export const GPU_LOCAL_WINDS = 8;

/**
 * 风打包给着色器：全局风 2 个 vec4（速度和湍流、阵风的幅度频率和个数），每个局部风源 2 个 vec4（中心和半径、
 * 强度湍流阵风），共 2 + 2 · GPU_LOCAL_WINDS 个 vec4。局部风源取离 near 最近的几个。
 */
export function packWind(wind: WindField, near: readonly number[], out: Float32Array, base: number): void {
  const at = base * 4;
  const global = wind.global;
  const locals = wind.nearest(near[0]!, near[1]!, near[2]!, GPU_LOCAL_WINDS);
  out.set([...global.velocity, global.turbulence, global.pulseMagnitude, global.pulseFrequency, locals.length, 0], at);
  locals.forEach((local, i) => out.set([...local.center, local.radius, local.strength, local.turbulence, local.pulseMagnitude, local.pulseFrequency], at + 8 + i * 8));
}

/** 着色器里的 windAt(p, time, first)：first 是 packWind 写的第一个 vec4 在 sim.data 里的下标（和 WindField.sample 同一个公式）。 */
export const WIND_WGSL = /* wgsl */ `
fn windGust(phase: f32) -> f32 {
  let t = phase * 6.28318530718;
  return (sin(t) + 0.5 * sin(t * 2.31 + 1.7) + 0.25 * sin(t * 4.17 + 0.3)) / 1.75;
}

fn windTurbulence(p: vec3f, time: f32) -> vec3f {
  return vec3f(sin(p.y * 0.73 + time * 1.1 + sin(p.z * 0.41)), 0.5 * sin(p.z * 0.67 + time * 0.9 + sin(p.x * 0.37)), sin(p.x * 0.59 + time * 1.3 + sin(p.y * 0.53)));
}

fn windAt(p: vec3f, time: f32, first: u32) -> vec3f {
  let global = sim.data[first];
  let settings = sim.data[first + 1u];
  let noise = windTurbulence(p, time);
  var wind = global.xyz * (1.0 + settings.x * windGust(time * settings.y)) + noise * global.w;
  let count = u32(settings.z);
  for (var i = 0u; i < count; i++) {
    let a = sim.data[first + 2u + i * 2u];
    let b = sim.data[first + 3u + i * 2u];
    let d = p - a.xyz;
    let distance = length(d);
    if (distance >= a.w || a.w <= 0.0) {
      continue;
    }
    let falloff = 1.0 - distance / a.w;
    let pulse = 1.0 + b.z * windGust(time * b.w);
    wind += select(vec3f(0.0), d * (b.x * falloff * pulse / distance), distance > 1e-6) + noise * b.y * falloff;
  }
  return wind;
}
`;
