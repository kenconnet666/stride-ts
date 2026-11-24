/**
 * 海量实体的模拟细节层次（照虚幻 Mass 的 LOD 和可变步长：MassLODCollector、MassSimulationLOD、MassRepresentation）：挂
 * SimulationLod 的实体（行人、车、动物这类成百上千的东西）每帧按离观察者（主相机）的距离分四档，各档按不同的间隔推进：
 *
 * | 档 | 距离（默认） | 推进 | 移动（CrowdAgent） | 表现 |
 * |---|---|---|---|---|
 * | 0 高 | 40 米内，最多 maxHigh 个 | 每帧 | 人群里，局部避让 | 完整：模型、动画 |
 * | 1 中 | 120 米内 | 0.1 秒一次 | 沿导航网格的路径走，不避让 | 模型、动画（按距离降频） |
 * | 2 低 | 400 米内 | 0.5 秒一次 | 直线走向目标 | 模型，动画停住 |
 * | 3 关 | 更远 | 2 秒一次 | 直线走向目标 | 不画（只推进状态） |
 *
 * 读档位的有 CrowdAgent（导航系统按档位换走法，只有 0、1 档当分块导航网格的引子）、StateTreeRunner（按档位的间隔推进，跳过的时间
 * 攒着一次推进）、动画系统（2 档起不求姿势）；3 档把模型藏起来（不画、不投影），回来时还原。档位之间有滞回（hysteresis），在边上
 * 走动不来回跳；推进的时刻按实体编号错开，同一档的一大群不挤在同一帧。
 *
 *   entity.add(SimulationLod);                            // 默认
 *   entity.add(SimulationLod.with({ distanceScale: 2 }));  // 重要的：按一半的距离算，远一倍才降档
 *   game.simulationLod.settings.distances = [30, 100, 300];
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import type { GameTime } from '../engine/GameTime';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { Model } from '../rendering/components';

/** 档位：0 高（完整）、1 中、2 低、3 关（只推进状态）。 */
export type SimulationLodLevel = 0 | 1 | 2 | 3;
export const SIMULATION_LOD_OFF = 3;

/**
 * 模拟细节层次：distanceScale 是距离的倍数（大于 1 远一些才降档，重要的角色用）；level、due、elapsed 是系统每帧写的结果——这一帧
 * 的档位、这一帧该不该推进、该推进的话推进多少秒（上次推进以来攒的时间）。
 */
export const SimulationLod = component('SimulationLod', {
  distanceScale: prop.f32().default(1).min(0.01),
  level: prop.u8().max(3).default(0).transient(),
  due: prop.bool().default(true).transient(),
  elapsed: prop.f32().default(0).transient(),
  /** @internal 离上次推进攒了多少秒。 */
  pending: prop.f32().default(-1).transient(),
  /** @internal 3 档藏模型之前模型的两个开关（第 1 位画进相机、第 2 位投阴影），1 加上它们；0 是没藏。 */
  hidden: prop.u8().default(0).transient(),
});

export interface SimulationLodSettings {
  /** 0 档到 1 档、1 到 2、2 到 3 的距离（米，乘实体的 distanceScale 的倒数）。 */
  distances: [number, number, number];
  /** 滞回：往高档回来要比边界近这么多（比例）。 */
  hysteresis: number;
  /** 0 档最多几个（多了按距离把远的降到 1 档：近处的人再多，完整模拟的个数也有上限）。 */
  maxHigh: number;
  /** 各档推进的间隔（秒）；0 是每帧。 */
  intervals: [number, number, number, number];
}

/** `game.simulationLod`：每帧（脚本之前）按主相机给挂 SimulationLod 的实体分档、定这一帧推不推进。 */
export class SimulationLodSystem {
  readonly settings: SimulationLodSettings = { distances: [40, 120, 400], hysteresis: 0.1, maxHigh: 200, intervals: [0, 0.1, 0.5, 2] };
  /** 观察者（世界坐标）：Game 每帧设成主相机的位置；没有时都按 0 档。 */
  focus: readonly [number, number, number] | undefined;
  /** 各档的个数、这一帧推进的个数（调试命令 simlod）。 */
  stats = { levels: [0, 0, 0, 0] as [number, number, number, number], due: 0 };
  /** 画出各档（调试）：每个实体头上一个点，0 档绿、1 档黄、2 档橙、3 档红。 */
  show = false;
  #entities: EntityManager | undefined;
  /** 这一帧 0 档的候选（实体在列里的位置、距离），超过 maxHigh 时降远的。 */
  readonly #high: { index: number; distance: number }[] = [];

  readonly #assign = system('SimulationLod.assign', {
    with: { lod: SimulationLod, transform: Transform },
    update: ({ lod, transform, entities: ids, count }, time) => {
      const { distances, hysteresis, maxHigh, intervals } = this.settings;
      const focus = this.focus;
      const world = transform.world;
      const stats = (this.stats = { levels: [0, 0, 0, 0], due: 0 });
      const high = this.#high;
      high.length = 0;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16;
        const distance = focus ? Math.hypot(world[w + 12]! - focus[0], world[w + 13]! - focus[1], world[w + 14]! - focus[2]) / lod.distanceScale[i]! : 0;
        const level = levelFor(distance, lod.level[i]! as SimulationLodLevel, distances, hysteresis);
        lod.level[i] = level;
        if (level === 0) high.push({ index: i, distance });
      }
      // 0 档的个数封顶：按距离排，远的降到 1 档
      if (high.length > maxHigh) {
        high.sort((a, b) => a.distance - b.distance);
        for (let k = maxHigh; k < high.length; k++) lod.level[high[k]!.index] = 1;
      }
      for (let i = 0; i < count; i++) {
        const level = lod.level[i]! as SimulationLodLevel;
        stats.levels[level]++;
        const interval = intervals[level];
        // 第一次：按编号错开一个相位（同一档的一大群不在同一帧一起推进）
        let pending = lod.pending[i]!;
        if (pending < 0) pending = interval * ((ids[i]! * 0.618034) % 1);
        pending += time.elapsed;
        const due = pending >= interval;
        lod.due[i] = due ? 1 : 0;
        lod.elapsed[i] = due ? pending : 0;
        lod.pending[i] = due ? 0 : pending;
        if (due) stats.due++;
        this.#represent(ids[i]!, lod, i, level);
      }
    },
  });

  /** 3 档藏模型（不画、不投影），回来时还原成藏之前的样子；模型多出来的网格在子实体上，一起藏。 */
  #represent(id: number, lod: { hidden: Uint8Array }, i: number, level: SimulationLodLevel): void {
    const off = level === SIMULATION_LOD_OFF;
    if (off === lod.hidden[i]! > 0) return;
    const entity = this.#entities!.entity(id as never);
    if (off) {
      const model = entity.get(Model);
      lod.hidden[i] = 1 + (model ? (model.visibleInCamera ? 1 : 0) | (model.isShadowCaster ? 2 : 0) : 3);
      forModels(entity, (part) => {
        part.visibleInCamera = false;
        part.isShadowCaster = false;
      });
    } else {
      const saved = lod.hidden[i]! - 1;
      lod.hidden[i] = 0;
      forModels(entity, (part) => {
        part.visibleInCamera = (saved & 1) !== 0;
        part.isShadowCaster = (saved & 2) !== 0;
      });
    }
  }

  /** 每帧一次（Game 在脚本之前调）。 */
  update(entities: EntityManager, time: GameTime): void {
    this.#entities = entities;
    entities.run(this.#assign, time);
    if (this.show) this.#draw(entities);
  }

  #draw(entities: EntityManager): void {
    const colors: readonly [number, number, number, number][] = [[0.2, 1, 0.3, 1], [1, 0.9, 0.2, 1], [1, 0.55, 0.1, 1], [1, 0.15, 0.1, 1]];
    const draw = entities.game.debugDraw;
    for (const id of entities.ids()) {
      const entity = entities.entity(id);
      const lod = entity.get(SimulationLod);
      if (!lod) continue;
      const world = entity.require(Transform).world;
      draw.sphere([world[12]!, world[13]! + 2.2, world[14]!], 0.25, colors[lod.level]!);
    }
  }
}

/** 按距离定档，往高档回来时边界缩 hysteresis（比例）。 */
export function levelFor(distance: number, current: SimulationLodLevel, distances: readonly number[], hysteresis: number): SimulationLodLevel {
  let level = 0;
  while (level < 3 && distance >= distances[level]!) level++;
  // 比现在的档高（近了）：要越过缩过的边界才升
  while (level < current && distance >= distances[level]! * (1 - hysteresis)) level++;
  return level as SimulationLodLevel;
}

function forModels(entity: Entity, apply: (model: { visibleInCamera: boolean; isShadowCaster: boolean }) => void): void {
  const model = entity.get(Model);
  if (model) apply(model);
  for (const child of entity.require(Transform).children) {
    const part = child.get(Model);
    if (part) apply(part);
  }
}

/** 实体的档位；没挂 SimulationLod 时是 0 档（完整）。 */
export function simulationLevel(entity: Entity): SimulationLodLevel {
  return (entity.get(SimulationLod)?.level ?? 0) as SimulationLodLevel;
}
