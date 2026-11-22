/** 调试命令：点选、射线和粒子。 */
import { Transform } from '../../engine/transform';
import { PARTICLE_BYTES } from '../../particles/gpuKernel';
import type { Game } from '../../engine/Game';
import { describe, type Debug } from '../Debug';
import type { Args } from './shared.ts';

function raycast(game: Game, args: Args): unknown {
  if (!game.simulation) throw new Error('the game has no physics (nativeFeatures has no physics)');
  const origin = vector(args['origin'], 'origin');
  const direction = vector(args['direction'], 'direction');
  const hit = game.simulation.rayCast(origin, direction, Number(args['maxDistance'] ?? 1000), typeof args['mask'] === 'number' ? { mask: args['mask'] } : {});
  if (!hit) return { hit: null };
  return { hit: { distance: hit.distance, point: Array.from(hit.point), normal: Array.from(hit.normal), entity: describe(game.entities.entity(hit.entity)) } };
}
function vector(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number')) throw new Error(`${name} must be [x, y, z]`);
  return value as [number, number, number];
}
/**
 * 所有粒子发射器（`stride particles`）：在哪模拟、粒子池多大、活着几个、活着的粒子在世界里的范围（GPU 上的读回来数）。
 * 粒子看不见时先看这个：没生成、全死了，还是跑到了别处。
 */
async function particles(game: Game, { name }: Args): Promise<unknown> {
  const rows = [];
  for (const component of game.particles.components) {
    const owner = component.entity;
    if (typeof name === 'string' && !(owner.name ?? '').includes(name)) continue;
    for (const emitter of component.particleSystem.emitters) {
      const gpu = emitter.onGpu ? game.particles.gpuEmitter(emitter) : undefined;
      let positions: ArrayLike<number> = [], stride = 3, lifeAt = -1, count = 0;
      if (gpu) {
        positions = await gpu.read();
        stride = PARTICLE_BYTES / 4;
        lifeAt = 3;
        count = gpu.capacity;
      } else {
        positions = emitter.pool.field('position') ?? [];
        count = emitter.pool.living;
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      let alive = 0;
      for (let i = 0; i < count; i++) {
        if (lifeAt >= 0 && !(positions[i * stride + lifeAt]! > 0)) continue;
        alive++;
        for (let c = 0; c < 3; c++) {
          const v = positions[i * stride + c]!;
          min[c] = Math.min(min[c]!, v);
          max[c] = Math.max(max[c]!, v);
        }
      }
      const round = (v: number[]) => v.map((x) => Math.round(x * 100) / 100);
      const at = owner.get(Transform)?.position;
      rows.push({
        entity: describe(owner), emitter: emitter.name, enabled: emitter.enabled, simulation: emitter.onGpu ? 'gpu' : 'cpu', space: emitter.simulationSpace,
        ...(at ? { position: round([at.x, at.y, at.z]) } : {}),
        capacity: gpu ? gpu.capacity : emitter.pool.capacity, alive,
        ...(alive > 0 ? { min: round(min), max: round(max) } : {}),
      });
    }
  }
  return rows;
}

export function registerSceneCommands(debug: Debug, game: Game): void {
  debug.command('pick', 'Entity under a canvas pixel (GPU id buffer). args: x, y in CSS pixels from the top-left of the canvas.', async (args) => {
    const entity = await game.pick(Number(args['x']), Number(args['y']));
    return { entity: entity ? describe(entity) : null };
  });
  debug.command('raycast', 'Physics ray cast. args: origin [x,y,z], direction [x,y,z], maxDistance (default 1000), mask.', (args) => raycast(game, args));
  debug.command('particles', 'Particle emitters: where they simulate, pool size, living particles and their world bounds (GPU ones are read back). args: name (part of the entity name).', (args) => particles(game, args));
}
