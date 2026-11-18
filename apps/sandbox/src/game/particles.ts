// Particles as data components and a system: the shape of per-frame logic over many entities.
import { component, prop, system } from '@stride-ts/engine';

const GRAVITY = -9.81;
const RESTITUTION = 0.7;

export const Position = component({ x: 0, y: 0, z: 0 });
export const Velocity = component({ x: 0, y: 0, z: 0 });
export const Lifetime = component({ seconds: prop.f32().min(0).default(3) });

export const integrate = system({
  with: { position: Position, velocity: Velocity },
  writes: [Position, Velocity],
  update({ position, velocity, count }, time) {
    const dt = time.elapsed;
    const { x, y, z } = position;
    const { x: vx, y: vy, z: vz } = velocity;
    for (let i = 0; i < count; i++) {
      vy[i]! += GRAVITY * dt;
      x[i]! += vx[i]! * dt;
      y[i]! += vy[i]! * dt;
      z[i]! += vz[i]! * dt;
      if (y[i]! < 0) {
        y[i] = -y[i]!;
        vy[i] = -vy[i]! * RESTITUTION;
      }
    }
  },
});

/** Counts lifetimes down and destroys expired particles through the system's commands. */
export const expire = system({
  with: { lifetime: Lifetime },
  writes: [Lifetime],
  update({ lifetime, entities, count }, time, commands) {
    const seconds = lifetime.seconds;
    for (let i = 0; i < count; i++) {
      seconds[i]! -= time.elapsed;
      if (seconds[i]! <= 0) commands.destroy(entities[i]!);
    }
  },
});
