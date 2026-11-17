import { afterAll, beforeAll, expect, test } from 'vitest';
import { createStrideNative, type StrideNative } from '@stride-ts/native';

// Checks the package wiring: the copied module loads in Node with its worker threads and steps physics.
let native: StrideNative;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 2 });
});

afterAll(() => native?.shutdown());

test('a dynamic box falls onto the ground', () => {
  const world = native.createPhysicsWorld(16);
  try {
    world.addBox([0, -1, 0], [10, 1, 10], false);
    const box = world.addBox([0, 5, 0], [0.5, 0.5, 0.5], true);

    for (let i = 0; i < 180; i++) world.step(1 / 60);

    const y = world.positions()[box * 3 + 1]!;
    expect(native.workerThreadCount).toBe(2);
    expect(y).toBeCloseTo(0.5, 1);
  } finally {
    world.destroy();
  }
});
