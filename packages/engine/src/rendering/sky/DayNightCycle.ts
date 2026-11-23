/**
 * 日夜循环（Stride 没有）：按时刻、日期、纬度转太阳、月亮和星空。和 SkyAtmosphere 放在同一个实体上：
 *
 * - 太阳、月亮是 SkyAtmosphere.sun、moon 指的两个带方向光的实体，这里只转它们（颜色、落山以后变黑、月相都是大气算的，见
 *   Atmosphere.ts）；这个实体自己的旋转是星空的朝向（天球坐标到世界），太阳、月亮、星星是同一个旋转带着走的，所以相对位置
 *   对得上：满月整夜都在、和太阳隔着地球相对，新月挨着太阳。
 * - 天文上只取够用的部分：太阳在黄道上匀速走（一年一圈，黄赤交角 23.44°），所以有季节（夏天日长、正午太阳高）；月亮也在
 *   黄道上，比太阳超前 moonPhase 圈（不算白道 5° 的倾角，所以每个新月都是日食的位置——新月本来就看不见）。时刻是真太阳时
 *   （12 点太阳在正南或正北），不算时差和经度。
 * - 世界的方位：Y 朝上；north 是 0 时 -Z 是北、+X 是东（太阳从 +X 升起）。
 * - 运行时时刻、日期跟着世界时钟（`game.clock`，world/WorldClock.ts）：游戏代码、存档没设过时钟时，第一帧按这里的时刻、日期设它，
 *   dayLength 大于 0 时设它的倍速（一整天这么多秒游戏时间）。之后这几个字段每帧写成时钟的值；别处（调试命令、`stride set`、脚本）
 *   改了字段就拨时钟。过了午夜月相往前走一天的量（一个朔望月 29.53 天）。编辑状态下时钟不走，只按写的时刻摆。
 *
 * 太阳、月亮的实体不要挂在转过的父实体下面：这里设的是它们的本地旋转。
 */
import { prop } from '../../data/prop';
import { component } from '../../engine/component';
import type { EntityManager } from '../../engine/EntityManager';
import { system } from '../../engine/system';
import { Transform } from '../../engine/transform';
import { DAYS_PER_YEAR, SECONDS_PER_DAY, type WorldClock } from '../../world/WorldClock';
import { Quaternion } from '../../data/vectors';
import { SkyAtmosphere } from '../components';

export const DayNightCycle = component('DayNightCycle', {
  /** 一天里的时刻（小时，0 到 24；12 是正午）。 */
  timeOfDay: prop.f32().default(12).min(0).max(24).unit('h'),
  /** 一整天是多少秒的游戏时间；0 是时刻不走。 */
  dayLength: prop.f32().default(0).min(0).unit('s'),
  /** 一年里的第几天（1 到 365；80 前后是春分，172 夏至，266 秋分，355 冬至）。 */
  dayOfYear: prop.f32().default(80).min(1).max(365),
  /** 纬度（北纬为正）。 */
  latitude: prop.f32().default(35).min(-90).max(90).unit('deg'),
  /** 北朝哪：绕 Y 转多少度（0 是 -Z 朝北、+X 朝东）。 */
  north: prop.f32().default(0).unit('deg'),
  /** 月相：0 新月，0.25 上弦，0.5 满月，0.75 下弦。 */
  moonPhase: prop.f32().default(0.5).min(0).max(1),
});

const DEGREES = Math.PI / 180;
/** 黄赤交角。 */
const OBLIQUITY = 23.44 * DEGREES;
/** 朔望月（两次满月之间）的天数。 */
const SYNODIC_MONTH = 29.53;
const X_AXIS = { x: 1, y: 0, z: 0 };
const Y_AXIS = { x: 0, y: 1, z: 0 };

export interface CelestialState {
  /** 天球坐标到世界的旋转（星空的朝向）：天球的 +Y 是北天极。 */
  readonly rotation: Quaternion;
  /** 朝太阳、月亮的方向（世界，单位向量）。 */
  readonly sun: [number, number, number];
  readonly moon: [number, number, number];
}

/** 某个时刻的天空：星空的朝向，太阳、月亮在哪。角度是度，timeOfDay 是小时。 */
export function celestialState(timeOfDay: number, dayOfYear: number, latitude: number, north: number, moonPhase: number): CelestialState {
  // 太阳的黄经（春分是 0）；月亮的黄经比它超前 moonPhase 圈
  const sunLongitude = ((dayOfYear - 80) / DAYS_PER_YEAR) * 2 * Math.PI;
  const moonLongitude = sunLongitude + moonPhase * 2 * Math.PI;
  // 地方恒星时 = 太阳的时角 + 太阳的赤经：天球绕天极转过的角度
  const siderealAngle = (timeOfDay - 12) * 15 * DEGREES + equatorial(sunLongitude).rightAscension;
  // 先绕天极（天球的 +Y）往西转，再把天极从正上方朝北压到纬度那么高，最后按 north 转方位
  const rotation = new Quaternion().setAxisAngle(Y_AXIS, north * DEGREES)
    .multiply(new Quaternion().setAxisAngle(X_AXIS, (latitude - 90) * DEGREES))
    .multiply(new Quaternion().setAxisAngle(Y_AXIS, -siderealAngle));
  return { rotation, sun: toWorld(rotation, sunLongitude), moon: toWorld(rotation, moonLongitude) };
}

/** 黄道上黄经为 longitude 的点的赤经、赤纬（弧度）。 */
function equatorial(longitude: number): { rightAscension: number; declination: number } {
  return {
    rightAscension: Math.atan2(Math.cos(OBLIQUITY) * Math.sin(longitude), Math.cos(longitude)),
    declination: Math.asin(Math.sin(OBLIQUITY) * Math.sin(longitude)),
  };
}

/** 黄道上的点在世界里的方向：天球坐标里赤经 α、赤纬 δ 的点是 (cos δ · sin α, sin δ, cos δ · cos α)。 */
function toWorld(rotation: Quaternion, longitude: number): [number, number, number] {
  const { rightAscension, declination } = equatorial(longitude);
  const x = Math.cos(declination) * Math.sin(rightAscension), y = Math.sin(declination), z = Math.cos(declination) * Math.cos(rightAscension);
  // 四元数转向量：v + 2w(q × v) + 2 q × (q × v)
  const { x: qx, y: qy, z: qz, w } = rotation;
  const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x;
  return [x + 2 * (w * cx + qy * cz - qz * cy), y + 2 * (w * cy + qz * cx - qx * cz), z + 2 * (w * cz + qx * cy - qy * cx)];
}

/** 方向光照向本地 -Z：让本地 +Z 朝着 direction（朝光源的方向）的旋转，先俯仰再转方位，不带滚转。 */
export function lightRotationTowards(direction: readonly [number, number, number]): Quaternion {
  const yaw = Math.atan2(direction[0], direction[2]);
  const pitch = -Math.asin(Math.min(Math.max(direction[1], -1), 1));
  return new Quaternion().setAxisAngle(Y_AXIS, yaw).multiply(new Quaternion().setAxisAngle(X_AXIS, pitch));
}

/** 上一帧写进字段的值（读回来的单精度）：字段和它不一样就是别处改了，拨时钟。 */
interface Written {
  readonly timeOfDay: number;
  readonly dayOfYear: number;
  readonly dayLength: number;
  /** 时钟的第几天（月相按过了几天走）。 */
  readonly day: number;
}

/** 一整天 dayLength 秒游戏时间对应的时钟倍速；0 是停着。 */
const rateOf = (dayLength: number): number => (dayLength > 0 ? SECONDS_PER_DAY / dayLength : 0);

/** 日夜循环的系统：Game 加进 EntityManager。running 返回世界时钟；编辑状态返回 undefined，只按字段摆。 */
export function dayNightCycleSystem(entities: EntityManager, running: () => WorldClock | undefined) {
  let written = new Map<number, Written>();
  /** 旋转变了才写（变换存储按写入记脏）。 */
  const turn = (id: number, rotation: Quaternion) => {
    if (id < 0 || !entities.isAlive(id as never)) return;
    const transform = entities.entity(id as never).get(Transform);
    if (!transform) return;
    const current = transform.rotation;
    if (Math.abs(current.x - rotation.x) + Math.abs(current.y - rotation.y) + Math.abs(current.z - rotation.z) + Math.abs(current.w - rotation.w) < 1e-7) return;
    transform.rotation = rotation;
  };
  return system('DayNightCycle', {
    with: { cycle: DayNightCycle, atmosphere: SkyAtmosphere, transform: Transform },
    writes: [DayNightCycle],
    update: ({ cycle, atmosphere, entities: ids, count }) => {
      const clock = running();
      const seen = new Map<number, Written>();
      for (let i = 0; i < count; i++) {
        if (clock) {
          const id = ids[i]!, last = written.get(id);
          const timeOfDay = cycle.timeOfDay[i]!, dayOfYear = cycle.dayOfYear[i]!, dayLength = cycle.dayLength[i]!;
          if (!clock.isSet) {
            // 游戏代码没设过时钟：第一个日夜循环按自己的字段设
            clock.set({ dayOfYear: Math.round(dayOfYear), hours: timeOfDay, rate: rateOf(dayLength) });
          } else if (last) {
            if (timeOfDay !== last.timeOfDay || dayOfYear !== last.dayOfYear) clock.set({ dayOfYear: Math.round(dayOfYear), hours: timeOfDay });
            if (dayLength !== last.dayLength) clock.set({ rate: rateOf(dayLength) });
          }
          if (last && clock.day !== last.day) cycle.moonPhase[i] = (((cycle.moonPhase[i]! + (clock.day - last.day) / SYNODIC_MONTH) % 1) + 1) % 1;
          cycle.timeOfDay[i] = clock.timeOfDay;
          cycle.dayOfYear[i] = clock.dayOfYear;
          seen.set(id, { timeOfDay: cycle.timeOfDay[i]!, dayOfYear: cycle.dayOfYear[i]!, dayLength, day: clock.day });
        }
        const state = celestialState(cycle.timeOfDay[i]!, cycle.dayOfYear[i]!, cycle.latitude[i]!, cycle.north[i]!, cycle.moonPhase[i]!);
        turn(ids[i]!, state.rotation);
        turn(atmosphere.sun[i]!, lightRotationTowards(state.sun));
        turn(atmosphere.moon[i]!, lightRotationTowards(state.moon));
      }
      written = seen;
    },
  });
}
