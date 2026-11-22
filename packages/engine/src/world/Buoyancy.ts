/**
 * 浮力（W6，Stride 没有）：挂了 Buoyancy 的刚体（Body）在水里按形状浮起来、受水的阻力，河里顺着水流走。每个物理步之前，按物体所在
 * 的位置找水面（湖、海是水位，河是中心线上那一点的水面和流速，见 waterSurfaceAt），调原生的 Jolt `ApplyBuoyancyImpulse`
 * （按形状算水下的体积和浮心）。水面按平面算，不跟着浪起伏。
 *
 *   entity.add(Buoyancy.with({ buoyancy: 1.3 }));   // 比水轻一点：浮着、露出一部分
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { Game } from '../engine/Game';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import { PhysicsBody } from '../physics/components';
import type { BodyControl, Simulation } from '../physics/Simulation';
import { waterAreas, type WaterArea } from './Water';

/** 浮力：buoyancy 是浮力系数（1 是和水一样重：悬着；大于 1 浮起来），linearDrag、angularDrag 是水的阻力。 */
export const Buoyancy = component('Buoyancy', {
  buoyancy: prop.f32().default(1.2).min(0),
  linearDrag: prop.f32().default(0.5).min(0),
  angularDrag: prop.f32().default(0.05).min(0),
});

/** 一点（世界的 x、z）上的水面：高度和水流的速度（世界的，米每秒）；不在水上时是 undefined。 */
export function waterSurfaceAt(areas: readonly WaterArea[], x: number, z: number): { readonly height: number; readonly flow: readonly [number, number, number] } | undefined {
  for (const area of areas) {
    if (area.river) {
      const { line, halfWidth, speed, offset } = area.river;
      let best: { distance: number; height: number; flow: [number, number, number] } | undefined;
      for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay, az] = line[i]!, [bx, by, bz] = line[i + 1]!;
        const ex = bx - ax, ez = bz - az, length = Math.hypot(ex, ez);
        if (length < 1e-6) continue;
        const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (length * length)));
        const distance = Math.hypot(x - ax - ex * t, z - az - ez * t);
        if (distance > halfWidth || (best && distance >= best.distance)) continue;
        best = { distance, height: ay + (by - ay) * t + offset, flow: [(ex / length) * speed, 0, (ez / length) * speed] };
      }
      if (best) return best;
      continue;
    }
    if (!area.outline || insidePolygon(area.outline, x, z)) return { height: area.level, flow: [0, 0, 0] };
  }
  return undefined;
}

function insidePolygon(points: readonly (readonly [number, number])[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 浮力的系统：Game 建好物理仿真以后 attach，每个物理步之前给水里的物体加浮力。 */
export class BuoyancySystem {
  readonly #game: Game;
  #simulation: Simulation | undefined;
  #areas: WaterArea[] = [];
  #areasFrame = -1;
  /** 这一步在水里的物体数（调试命令 water 报）。 */
  submerged = 0;

  readonly #collect = system('BuoyancySystem.collect', {
    with: { buoyancy: Buoyancy, transform: Transform, physicsBody: PhysicsBody },
    update: ({ buoyancy, transform, count, entities }) => {
      const simulation = this.#simulation!;
      for (let i = 0; i < count; i++) {
        const w = transform.slot[i]! * 16, m = transform.world;
        const x = m[w + 12]!, y = m[w + 13]!, z = m[w + 14]!;
        const surface = waterSurfaceAt(this.#areas, x, z);
        // 离水面远的不算（省得每步都调原生）：形状再大也不会大过 50 米
        if (!surface || y - surface.height > 50) continue;
        let control: BodyControl;
        try {
          control = simulation.body(entities[i]!);
        } catch {
          continue;
        }
        if (control.applyBuoyancy([x, surface.height, z], [0, 1, 0], buoyancy.buoyancy[i]!, buoyancy.linearDrag[i]!, buoyancy.angularDrag[i]!, surface.flow, this.#step)) this.submerged++;
      }
    },
  });
  #step = 0;

  constructor(game: Game) {
    this.#game = game;
  }

  /** @internal Game 建好物理仿真以后调。 */
  attach(simulation: Simulation): void {
    this.#simulation = simulation;
    simulation.onStep((step) => this.#update(step));
  }

  #update(step: number): void {
    const game = this.#game;
    // 水体一帧取一次（一帧可能走好几步）
    if (this.#areasFrame !== game.frames) {
      this.#areasFrame = game.frames;
      this.#areas = waterAreas(game.entities, game.updateTime, game.weather.current?.flood ?? 0);
    }
    this.submerged = 0;
    if (this.#areas.length === 0) return;
    this.#step = step;
    game.entities.run(this.#collect, game.updateTime);
  }
}
