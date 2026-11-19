import { describe, expect, test } from 'vitest';
import { CurveSampler } from '../src/particles/curves';
import { FieldFalloff } from '../src/particles/fieldShapes';
import { compileMaterial, flipbookOf } from '../src/particles/material';
import { buildShapes, VERTEX_FLOATS } from '../src/particles/shapes';
import type { Texture } from '../src/rendering/Texture';
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

describe('粒子的翻页动画（照 Stride 的 UVBuilderFlipbook）', () => {
  test('按走过的寿命取帧：起始帧加上 走过的比例 · AnimationSpeed，按行排', () => {
    const frame = flipbookOf({ $type: 'uvBuilderFlipbook', xDivisions: 4, yDivisions: 2, startingFrame: 1, animationSpeed: 8 });
    expect(frame(1)).toEqual([0.25, 0, 0.25, 0.5]);
    // 走过一半：1 + 4 = 第 5 帧，第二行第二个
    expect(frame(0.5)).toEqual([0.25, 0.5, 0.25, 0.5]);
  });
});

/** 第一帧生成一个粒子（OneShot，活跃略长于一帧）。 */
const ONE_PARTICLE: ParticleModuleFile = { $type: 'spawnerPerFrame', spawnCount: 1, loopCondition: 'oneShot', duration: [0.02, 0.02] };

/** 线性的标量曲线采样器。 */
function floatCurve(frames: [number, number][]): ParticleModuleFile {
  return { $type: 'computeCurveSamplerFloat', curve: { $type: 'computeAnimationCurveFloat', keyFrames: frames.map(([key, value]) => ({ key, value, tangentType: 'linear' })) } };
}

describe('粒子的曲线（照 Stride 的 ComputeCurveSampler）', () => {
  test('关键帧之间线性插值，两头停在端点；Constant 切线停在左边的值', () => {
    const linear = new CurveSampler(floatCurve([[0, 0], [1, 2]]));
    expect(linear.evaluateFloat(0)).toBeCloseTo(0);
    expect(linear.evaluateFloat(0.5)).toBeCloseTo(1);
    expect(linear.evaluateFloat(1)).toBeCloseTo(2);
    const step = new CurveSampler({ $type: 'computeCurveSamplerFloat', curve: { keyFrames: [{ key: 0, value: 1, tangentType: 'constant' }, { key: 1, value: 3 }] } });
    expect(step.evaluateFloat(0.5)).toBeCloseTo(1);
  });

  test('四元数按短的那边插值并归一化', () => {
    const half = Math.SQRT1_2;
    const curve = new CurveSampler({ $type: 'computeCurveSamplerQuaternion', curve: { keyFrames: [{ key: 0, value: [0, 0, 0, 1] }, { key: 1, value: [0, half, 0, half] }] } });
    const q = curve.evaluate(0.5);
    const angle = Math.PI / 8;
    expect(q[1]).toBeCloseTo(Math.sin(angle), 5);
    expect(q[3]).toBeCloseTo(Math.cos(angle), 5);
  });
});

describe('粒子的更新器（照 Stride 的 Updaters）', () => {
  test('重力：速度加 g · dt，位置多走 g · dt² / 2', () => {
    const particles = system({ particleLifetime: [10, 10], spawners: [ONE_PARTICLE], updaters: [{ $type: 'updaterGravity', gravitationalAcceleration: [0, -10, 0] }] });
    particles.update(STEP);
    particles.update(STEP);
    const pool = particles.emitters[0]!.pool;
    expect(pool.field('velocity')![1]).toBeCloseTo(-10 * STEP, 6);
    expect(pool.field('position')![1]).toBeCloseTo(-5 * STEP * STEP, 6);
  });

  test('按寿命改大小：大小是曲线在走过的寿命处的值', () => {
    const particles = system({ particleLifetime: [1, 1], spawners: [ONE_PARTICLE], updaters: [{ $type: 'updaterSizeOverTime', samplerMain: floatCurve([[0, 1], [1, 3]]) }] });
    for (let i = 0; i < 20; i++) particles.update(STEP);
    const pool = particles.emitters[0]!.pool;
    expect(pool.field('size')![0]).toBeCloseTo(1 + 2 * (1 - pool.field('life')![0]!), 2);
  });

  test('碰撞：进到球里的粒子放回表面，垂直的速度按 Restitution 反弹，记下这一帧碰过', () => {
    const particles = system({
      particleLifetime: [10, 10],
      spawners: [ONE_PARTICLE],
      initializers: [
        { $type: 'initialPositionSeed', positionMin: [0, 0.5, 0], positionMax: [0, 0.5, 0] },
        { $type: 'initialVelocitySeed', velocityMin: [0, -1, 0], velocityMax: [0, -1, 0] },
      ],
      updaters: [{ $type: 'updaterCollider', fieldShape: { $type: 'fieldShapeSphere', radius: 1 }, restitution: 0.5, friction: 0.1 }],
    });
    particles.update(STEP);
    const pool = particles.emitters[0]!.pool;
    expect([...pool.field('position')!.subarray(0, 3)].map((c) => +c.toFixed(5))).toEqual([0, 1, 0]);
    expect(pool.field('velocity')![1]).toBeCloseTo(0.5);
    expect(pool.field('collision')![0]).toBe(1);
  });
});

describe('粒子的形状和材质', () => {
  test('OrientedQuad：一条边沿速度方向拉长（长度乘大小），另一条在屏幕里垂直于它', () => {
    const particles = system({
      particleLifetime: [10, 10],
      spawners: [ONE_PARTICLE],
      initializers: [{ $type: 'initialVelocitySeed', velocityMin: [0, 2, 0], velocityMax: [0, 2, 0] }],
      updaters: [{ $type: 'updaterSpeedToDirection' }],
      shapeBuilder: { $type: 'shapeBuilderOrientedQuad' },
    });
    particles.update(STEP);
    particles.update(STEP);
    const emitter = particles.emitters[0]!;
    const vertices = new Float32Array(4 * VERTEX_FLOATS);
    const camera = { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1] } as const;
    buildShapes(emitter, emitter.shape!, camera, [0], vertices, 0, () => [0, 0, 1, 1]);
    const y = emitter.pool.field('position')![1]!;
    // 方向是速度 (0, 2, 0)，大小 1：上下各伸出 方向 · 大小 / 2，左右各 0.5
    expect([vertices[0], vertices[1]! - y, vertices[2]].map((c) => +c!.toFixed(5))).toEqual([-0.5, 1, 0]);
    expect([vertices[2 * VERTEX_FLOATS], vertices[2 * VERTEX_FLOATS + 1]! - y].map((c) => +c!.toFixed(5))).toEqual([0.5, -1]);
  });

  test('材质的颜色树编译成 WGSL：二元运算、贴图（预乘、缩放偏移）、粒子颜色，AlphaAdditive 换成 alpha 系数', () => {
    const texture = {} as Texture;
    const program = compileMaterial({
      $type: 'particleMaterialComputeColor',
      alphaAdditive: 0.25,
      computeColor: {
        $type: 'computeBinaryColor', operator: 'multiply',
        leftChild: { $type: 'computeTextureColor', texture: { texture: 'fire.ktx2' }, scale: [2, 2], offset: [0.5, 0] },
        rightChild: { $type: 'computeVertexStreamColor' },
      },
    }, (path) => (path === 'fire.ktx2' ? texture : undefined));
    expect(program.textures).toHaveLength(1);
    expect(program.textures[0]!.texture).toBe(texture);
    expect(program.alphaFactor).toBe(0.75);
    expect(program.code).toContain('@group(1) @binding(0) var t0: texture_2d<f32>;');
    expect(program.code).toContain('(premultiply(textureSample(t0, s0, uv * vec2f(2, 2) + vec2f(0.5, 0))) * color)');
    // 没有贴图时用 FallbackValue
    const fallback = compileMaterial({ computeColor: { $type: 'computeTextureColor', fallbackValue: { value: [1, 0.5, 0, 1] } } }, () => undefined);
    expect(fallback.textures).toHaveLength(0);
    expect(fallback.code).toContain('return vec4f(1.0, 0.5, 0.0, 1.0);');
  });

  test('BoundingSphereStatic：世界包围盒是位置周围 半径 · 缩放 的立方体', () => {
    const particles = new ParticleSystem({ boundingShape: { $type: 'boundingSpheretatic', radius: 2 } });
    particles.translation = [1, 0, 0];
    particles.uniformScale = 2;
    expect(particles.worldBounds()).toEqual([[-3, -4, -4], [5, 4, 4]]);
  });
});
