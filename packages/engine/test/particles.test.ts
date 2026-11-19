import { describe, expect, test } from 'vitest';
import { FieldFalloff } from '../src/particles/modules';
import { ParticleSystem } from '../src/particles/ParticleSystem';
import { randomSeed, RandomSeedGenerator, seedFloat } from '../src/particles/random';
import type { ParticleModuleFile } from '../src/content/format';

/** 一个发射器的粒子系统，种子固定。 */
function system(emitter: ParticleModuleFile): ParticleSystem {
  return new ParticleSystem({ emitters: [{ randomSeedMethod: 'fixed', ...emitter }] });
}

const STEP = 1 / 60;

describe('粒子的随机数（照 Stride 的 RandomSeed）', () => {
  test('和 .NET 算出来的一样（dotnet fsi 算的参考值），种子只留低 16 位', () => {
    const cases: [number, number, number][] = [[0, 0, 0.174333289], [1, 0, 0.225040227], [7, 1112, 0.607673585], [65535, 6667, 0.689377367], [70000, 4445, 0.669068515], [123, 3334, 0.600783169]];
    for (const [seed, offset, expected] of cases) expect(seedFloat(randomSeed(seed), offset)).toBeCloseTo(expected, 6);
  });

  test('种子序列从给的数开始逐个加一', () => {
    const generator = new RandomSeedGenerator(0xfffe);
    expect([generator.nextSeed(), generator.nextSeed(), generator.nextSeed()]).toEqual([0xfffe, 0xffff, 0]);
  });
});

describe('粒子的模拟（照 Stride 的 ParticleEmitter）', () => {
  test('PerSecond：每秒生成 SpawnCount 个，粒子池按 寿命 · 每秒个数 定大小，寿命到了删掉', () => {
    const particles = system({ particleLifetime: [1, 1], spawners: [{ $type: 'spawnerPerSecond', spawnCount: 30 }] });
    const emitter = particles.emitters[0]!;
    for (let i = 0; i < 30; i++) particles.update(STEP);
    expect(emitter.pool.capacity).toBe(30);
    expect(emitter.pool.living).toBe(15);
    for (let i = 0; i < 120; i++) particles.update(STEP);
    // 稳定后活着的不超过池的大小
    expect(emitter.pool.living).toBeGreaterThan(25);
    expect(emitter.pool.living).toBeLessThanOrEqual(30);
  });

  test('OneShot 活跃一次后不再生成；MaxParticlesOverride 定池的大小', () => {
    const particles = system({
      particleLifetime: [5, 5], maxParticlesOverride: 4,
      spawners: [{ $type: 'spawnerPerFrame', loopCondition: 'oneShot', duration: [0.05, 0.05], spawnCount: 1 }],
    });
    for (let i = 0; i < 60; i++) particles.update(STEP);
    // 活跃 0.05 秒：第一帧进入活跃，共 3 帧生成，池最多 4 个
    expect(particles.emitters[0]!.pool.capacity).toBe(4);
    expect(particles.emitters[0]!.pool.living).toBe(3);
  });

  test('初始化器：大小、速度在范围里，位置在盒子里并跟着实体的位置；有速度时按速度移动', () => {
    const particles = system({
      particleLifetime: [10, 10],
      spawners: [{ $type: 'spawnerPerFrame', spawnCount: 5 }],
      initializers: [
        { $type: 'initialSizeSeed', randomSize: [0.2, 0.4] },
        { $type: 'initialPositionSeed', positionMin: [-1, 0, 0], positionMax: [1, 0, 0] },
        { $type: 'initialVelocitySeed', velocityMin: [0, 1, 0], velocityMax: [0, 2, 0] },
        { $type: 'initialColorSeed', colorMin: [1, 0, 0, 0.5], colorMax: [1, 0, 0, 0.5] },
      ],
    });
    particles.translation = [10, 0, 0];
    particles.update(STEP);
    const pool = particles.emitters[0]!.pool;
    expect(pool.living).toBe(5);
    const size = pool.field('size')!, position = pool.field('position')!, velocity = pool.field('velocity')!, color = pool.field('color')!;
    for (let i = 0; i < pool.living; i++) {
      expect(size[i]).toBeGreaterThanOrEqual(0.2);
      expect(size[i]).toBeLessThanOrEqual(0.4);
      expect(position[i * 3]).toBeGreaterThanOrEqual(9);
      expect(position[i * 3]).toBeLessThanOrEqual(11);
      expect(velocity[i * 3 + 1]).toBeGreaterThanOrEqual(1);
      expect(velocity[i * 3 + 1]).toBeLessThanOrEqual(2);
      // 存成预乘 alpha 的
      expect([...color.subarray(i * 4, i * 4 + 4)]).toEqual([0.5, 0, 0, 0.5]);
    }
    const y = position[1]!, vy = velocity[1]!;
    particles.update(STEP);
    expect(position[1]).toBeCloseTo(y + vy * STEP, 5);
  });

  test('固定种子时两次模拟结果一样；停止清空、暂停不动', () => {
    const file: ParticleModuleFile = { particleLifetime: [0.5, 1.5], spawners: [{ $type: 'spawnerPerSecond', spawnCount: 50 }], initializers: [{ $type: 'initialPositionSeed' }] };
    const a = system(file), b = system(file);
    for (let i = 0; i < 90; i++) {
      a.update(STEP);
      b.update(STEP);
    }
    const pa = a.emitters[0]!.pool, pb = b.emitters[0]!.pool;
    expect(pa.living).toBe(pb.living);
    expect([...pa.field('position')!.subarray(0, pa.living * 3)]).toEqual([...pb.field('position')!.subarray(0, pb.living * 3)]);
    a.pause();
    const living = pa.living;
    a.update(STEP);
    expect(pa.living).toBe(living);
    a.stop();
    expect(pa.living).toBe(0);
    a.play();
    // 每秒 50 个：第一帧不到一个（小数部分累积到下一帧）
    for (let i = 0; i < 3; i++) a.update(STEP);
    expect(pa.living).toBeGreaterThan(0);
  });

  test('力场：球形场里离开中心的力把粒子推远；衰减在 FalloffStart 到 FalloffEnd 之间线性过渡', () => {
    const particles = system({
      particleLifetime: [10, 10],
      // 活跃的时间要比一帧长：短于一帧时进入活跃的同一帧就结束了，不生成（同 Stride）
      spawners: [{ $type: 'spawnerPerFrame', spawnCount: 1, loopCondition: 'oneShot', duration: [0.02, 0.02] }],
      initializers: [{ $type: 'initialPositionSeed', positionMin: [1, 0, 0], positionMax: [1, 0, 0] }],
      updaters: [{
        $type: 'updaterForceField', fieldShape: { $type: 'fieldShapeSphere', radius: 3 },
        fieldFalloff: { strengthInside: 1, falloffStart: 0.1, strengthOutside: 0, falloffEnd: 0.9 },
        energyConservation: 0, forceDirected: 0, forceVortex: 0, forceRepulsive: 1,
      }],
    });
    particles.update(STEP);
    const position = particles.emitters[0]!.pool.field('position')!;
    const x = position[0]!;
    particles.update(STEP);
    expect(position[0]).toBeGreaterThan(x);
    const falloff = new FieldFalloff({ strengthInside: 1, falloffStart: 0.1, strengthOutside: 0, falloffEnd: 0.9 });
    expect(falloff.strength(0.5)).toBeCloseTo(0.5);
    expect(falloff.strength(0.95)).toBe(0);
  });
});
