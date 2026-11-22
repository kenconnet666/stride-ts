/**
 * 列车（W3，Stride 没有）：沿着轨道（`.spline.json` 的一条路径）按时刻表开和停，车门和站台的屏蔽门跟着开关。
 *
 * - 时刻表是时间的纯函数（trainSchedule、trainStateAt）：从第一个车站开始，停站（开门、等、关门），按梯形的速度曲线开到下一站
 *   （加速度、限速、减速度，正好停在站上），往返（pingpong）或者在首尾相连的轨道上绕圈（loop），一圈一圈重复。同一个时刻
 *   总是同一个位置：时间轴拖到哪、离线出片的哪一帧都对得上，几列车错开用 timeOffset；
 * - 车厢是 Train 实体的子实体（按子实体的顺序，第一节在轨道的正方向那头），每节按前后两个转向架落在轨道上的点摆：位置是两点
 *   的中点，+Z 朝轨道的正方向（往返时车不掉头），上方跟着轨道的截面（侧倾）。Train 实体要和轨道的模型实体放在同一处（轨道的
 *   坐标是它的本地坐标）；
 * - 车门（TrainDoor）开的时候从原来的位置挪 offset：在车厢下面的门跟着这列车，写了 station 的门（站台的屏蔽门）在任何一列车
 *   停在那个站、开着门的时候开。
 */
import type { SplineFile } from '../content/formats/splineFormat';
import { prop } from '../data/prop';
import { Quaternion, Vector3 } from '../data/vectors';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import type { GameTime } from '../engine/GameTime';
import { Transform } from '../engine/transform';
import { frameAt, sampleSpline, splinePaths, type SplineFrame } from '../modeling/spline';

/** 一个车站：列车中点停在轨道上哪（离路径起点的弧长，米）、停多久（秒，含开关门）、站名（屏蔽门按它认）。 */
export interface TrainStop {
  readonly at: number;
  readonly dwell: number;
  readonly name: string;
}

/** 算时刻表要的：轨道这条路径多长、是不是首尾相连，列车多长，车站，速度曲线，开关门各几秒，往返还是绕圈。 */
export interface TrainScheduleOptions {
  readonly length: number;
  readonly closed: boolean;
  readonly trainLength: number;
  readonly stops: readonly TrainStop[];
  readonly maxSpeed: number;
  readonly acceleration: number;
  readonly deceleration: number;
  readonly doorTime: number;
  readonly mode: 'pingpong' | 'loop';
}

/**
 * 某一时刻的列车：中点离路径起点的弧长（首尾相连时取模）、速度（米每秒，带方向：正的是往路径的后面）、停在第几站（按位置排的
 * 下标，开着时 -1）和站名、门开了多少（0..1）。
 */
export interface TrainState {
  readonly distance: number;
  readonly speed: number;
  readonly stop: number;
  readonly station: string;
  readonly doors: number;
}

/** 时刻表的一段：停站，或者从一个弧长开到另一个（to 可以超过路径长，绕圈时取模）。 */
type Leg =
  | { readonly kind: 'dwell'; readonly stop: number; readonly station: string; readonly at: number; readonly duration: number; readonly doors: boolean }
  | { readonly kind: 'run'; readonly from: number; readonly to: number; readonly duration: number; readonly peak: number; readonly accelTime: number; readonly cruiseTime: number };

/** 算好的时刻表：一圈的各段和一圈多长（秒）。 */
export interface TrainSchedule {
  readonly legs: readonly Leg[];
  readonly cycle: number;
  readonly options: TrainScheduleOptions;
}

/**
 * 算时刻表。没有车站时在两头之间往返（绕圈时一直开），不开门；只有往返的轨道不能绕圈（loop 在开放的路径上按往返算）。
 */
export function trainSchedule(options: TrainScheduleOptions): TrainSchedule {
  const { length, trainLength } = options;
  const loop = options.mode === 'loop' && options.closed;
  const real = [...options.stops].sort((a, b) => a.at - b.at);
  const stops: (TrainStop & { doors: boolean })[] = real.length > 0
    ? real.map((stop) => ({ ...stop, doors: true }))
    : (loop ? [0] : [trainLength / 2, length - trainLength / 2]).map((at) => ({ at, dwell: 0, name: '', doors: false }));
  // 停站的顺序：往返是 0, 1, …, n-1, n-2, …, 1；绕圈是 0, 1, …, n-1
  const order = loop || stops.length < 2 ? stops.map((_, i) => i) : [...stops.keys(), ...[...stops.keys()].reverse().slice(1, -1)];
  const legs: Leg[] = [];
  order.forEach((index, k) => {
    const stop = stops[index]!;
    legs.push({ kind: 'dwell', stop: stop.doors ? index : -1, station: stop.name, at: stop.at, duration: Math.max(0, stop.dwell), doors: stop.doors });
    if (order.length < 2 && !loop) return;
    const next = stops[order[(k + 1) % order.length]!]!;
    // 绕圈时总往前开（下一站在后面就多绕一圈）；往返时朝下一站开
    const to = loop ? (next.at > stop.at ? next.at : next.at + length) : next.at;
    legs.push(runLeg(stop.at, to, options));
  });
  return { legs, cycle: legs.reduce((sum, leg) => sum + leg.duration, 0), options };
}

/** 从 from 开到 to：梯形的速度曲线（加速到限速、匀速、减速到停；距离不够时加速到一半就减速）。 */
function runLeg(from: number, to: number, { maxSpeed, acceleration: a, deceleration: d }: TrainScheduleOptions): Leg {
  const distance = Math.abs(to - from);
  const peak = Math.min(maxSpeed, Math.sqrt((2 * distance * a * d) / (a + d)));
  if (!(peak > 0)) return { kind: 'run', from, to, duration: 0, peak: 0, accelTime: 0, cruiseTime: 0 };
  const accelTime = peak / a, decelTime = peak / d;
  const cruiseTime = Math.max(0, (distance - (peak * peak) / (2 * a) - (peak * peak) / (2 * d)) / peak);
  return { kind: 'run', from, to, duration: accelTime + cruiseTime + decelTime, peak, accelTime, cruiseTime };
}

/** 时刻 t（秒，一圈一圈重复）的列车。 */
export function trainStateAt(schedule: TrainSchedule, t: number): TrainState {
  const { legs, cycle, options } = schedule;
  if (legs.length === 0 || !(cycle > 0)) {
    const first = legs[0];
    const dwell = first?.kind === 'dwell' ? first : undefined;
    return { distance: dwell?.at ?? 0, speed: 0, stop: dwell?.stop ?? -1, station: dwell?.station ?? '', doors: dwell?.doors ? 1 : 0 };
  }
  let local = ((t % cycle) + cycle) % cycle;
  for (const leg of legs) {
    if (local >= leg.duration && leg !== legs.at(-1)) {
      local -= leg.duration;
      continue;
    }
    if (leg.kind === 'dwell') {
      const open = leg.doors && options.doorTime > 0 ? Math.min(1, Math.max(0, Math.min(local, leg.duration - local) / options.doorTime)) : leg.doors ? 1 : 0;
      return { distance: leg.at, speed: 0, stop: leg.stop, station: leg.station, doors: open };
    }
    const { travelled, speed } = runAt(leg, Math.min(local, leg.duration), options.deceleration);
    const sign = leg.to >= leg.from ? 1 : -1;
    const distance = leg.from + sign * travelled;
    return { distance: options.closed ? ((distance % options.length) + options.length) % options.length : distance, speed: sign * speed, stop: -1, station: '', doors: 0 };
  }
  throw new Error('unreachable');
}

function runAt(leg: Extract<Leg, { kind: 'run' }>, tau: number, deceleration: number): { travelled: number; speed: number } {
  const { peak, accelTime, cruiseTime } = leg;
  const a = accelTime > 0 ? peak / accelTime : 0;
  if (tau <= accelTime) return { travelled: 0.5 * a * tau * tau, speed: a * tau };
  const accelDistance = 0.5 * peak * accelTime;
  if (tau <= accelTime + cruiseTime) return { travelled: accelDistance + peak * (tau - accelTime), speed: peak };
  const u = tau - accelTime - cruiseTime;
  return { travelled: accelDistance + peak * cruiseTime + peak * u - 0.5 * deceleration * u * u, speed: Math.max(0, peak - deceleration * u) };
}

/** 转向架离车厢中心多远（车厢长的比例）。 */
const BOGIE = 0.35;

/** 列车：挂在一个实体上，子实体是车厢（见文件开头）。 */
export class Train extends SyncScript.props('Train', {
  /** 轨道（样条）。 */
  track: prop.asset('spline'),
  /** 走轨道的第几条路径（0 是样条的 points，1 起是分支）。 */
  path: prop.int().default(0).min(0),
  /** 车站：列车中点停的位置（离路径起点的弧长，米）、停几秒（含开关门）、站名。没有车站时在两头之间往返。 */
  stops: prop.list(prop.object({ at: prop.f32().unit('m'), dwell: prop.f32().default(20).min(0).unit('s'), name: prop.string().default('') })).default([]),
  maxSpeed: prop.f32().default(22).min(0.1).unit('m/s'),
  acceleration: prop.f32().default(1).min(0.01).unit('m/s²'),
  deceleration: prop.f32().default(1.1).min(0.01).unit('m/s²'),
  /** 开门、关门各用几秒。 */
  doorTime: prop.f32().default(2.5).min(0).unit('s'),
  /** 每节车厢多长、车厢之间的空隙（米）。 */
  carLength: prop.f32().default(20).min(0.1).unit('m'),
  carGap: prop.f32().default(1).min(0).unit('m'),
  /** 往返，或者在首尾相连的轨道上绕圈。 */
  mode: prop.enum(['pingpong', 'loop']).default('pingpong'),
  /** 时刻表往后挪几秒（同一条线上几列车错开）。 */
  timeOffset: prop.f32().default(0).unit('s'),
}) {
  /** 活着的列车（屏蔽门按站名找停在那的车）。 */
  static readonly all = new Set<Train>();
  #frames: readonly SplineFrame[] = [];
  #schedule: TrainSchedule | undefined;
  #key = '';

  override start(): void {
    Train.all.add(this);
  }

  override cancel(): void {
    Train.all.delete(this);
  }

  /** 车厢：子实体（有变换的），按顺序。 */
  get cars(): readonly Entity[] {
    return this.entity.get(Transform)?.children ?? [];
  }

  /** 这列车在游戏时刻 t 的状态（纯的：时间轴、出片按时刻要）。 */
  stateAt(t: number): TrainState {
    return trainStateAt(this.#scheduleNow(), t + this.timeOffset);
  }

  override update(time: GameTime): void {
    const schedule = this.#scheduleNow();
    const state = trainStateAt(schedule, time.total + this.timeOffset);
    const { length, closed, trainLength } = schedule.options;
    const carLength = this.carLength, pitch = carLength + this.carGap;
    const at = (d: number) => frameAt(this.#frames, closed ? ((d % length) + length) % length : Math.min(length, Math.max(0, d))).position;
    const front = state.distance + trainLength / 2;
    this.cars.forEach((car, i) => {
      const center = front - i * pitch - carLength / 2;
      const ahead = at(center + BOGIE * carLength), behind = at(center - BOGIE * carLength);
      const transform = car.require(Transform);
      transform.position = { x: (ahead[0] + behind[0]) / 2, y: (ahead[1] + behind[1]) / 2, z: (ahead[2] + behind[2]) / 2 };
      const up = frameAt(this.#frames, closed ? ((center % length) + length) % length : Math.min(length, Math.max(0, center))).up;
      transform.rotation = Quaternion.lookRotation(new Vector3(ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]), new Vector3(...up));
    });
  }

  /** 时刻表；轨道、车站、速度这些改了（属性面板、时间轴）重算。 */
  #scheduleNow(): TrainSchedule {
    const track = this.track as SplineFile | undefined;
    if (!track) throw new Error(`train '${this.entity.name}' has no track`);
    const cars = Math.max(1, this.cars.length);
    const key = [this.path, cars, this.carLength, this.carGap, this.maxSpeed, this.acceleration, this.deceleration, this.doorTime, this.mode, JSON.stringify(this.stops)].join('|');
    if (this.#schedule && key === this.#key && this.#schedule.options.length > 0) return this.#schedule;
    const path = splinePaths(track)[this.path];
    if (!path) throw new Error(`train '${this.entity.name}': its track has no path ${this.path}`);
    this.#frames = sampleSpline(path.points, path.closed ?? false, 1);
    this.#key = key;
    this.#schedule = trainSchedule({
      length: this.#frames.at(-1)!.distance, closed: path.closed ?? false, trainLength: cars * this.carLength + (cars - 1) * this.carGap,
      stops: this.stops.map((stop) => ({ at: stop.at, dwell: stop.dwell, name: stop.name })),
      maxSpeed: this.maxSpeed, acceleration: this.acceleration, deceleration: this.deceleration, doorTime: this.doorTime, mode: this.mode,
    });
    return this.#schedule;
  }
}

/** 车门、屏蔽门：开的时候从原来的位置挪 offset（父实体的本地坐标）；见文件开头。 */
export class TrainDoor extends SyncScript.props('TrainDoor', {
  /** 开到头时挪多远（父实体的本地坐标，米）。 */
  offset: prop.vec3().default([1, 0, 0]),
  /** 站台的屏蔽门写站名：任何一列车停在这个站、开着门时开；空着的是车门，跟着它所在的那列车。 */
  station: prop.string().default(''),
}) {
  #rest: Vector3 | undefined;

  override update(time: GameTime): void {
    const transform = this.entity.require(Transform);
    this.#rest ??= new Vector3().copy(transform.position);
    const open = this.station !== '' ? stationDoors(this.station, time.total) : (this.#train()?.stateAt(time.total).doors ?? 0);
    transform.position = { x: this.#rest.x + this.offset.x * open, y: this.#rest.y + this.offset.y * open, z: this.#rest.z + this.offset.z * open };
  }

  /** 最近的挂着 Train 的祖先。 */
  #train(): Train | undefined {
    for (let entity = this.entity.get(Transform)?.parent; entity; entity = entity.get(Transform)?.parent) {
      const train = entity.get(Train);
      if (train) return train;
    }
    return undefined;
  }
}

/** 停在这个站的列车里门开得最大的（没有停着的是 0）。 */
function stationDoors(station: string, t: number): number {
  let open = 0;
  for (const train of Train.all) {
    const state = train.stateAt(t);
    if (state.station === station) open = Math.max(open, state.doors);
  }
  return open;
}
