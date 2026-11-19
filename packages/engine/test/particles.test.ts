import { describe, expect, test } from 'vitest';
import { CurveSampler } from '../src/particles/curves';
import { FieldFalloff, FieldShapeTorus } from '../src/particles/fieldShapes';
import type { Vec3 } from '../src/particles/math';
import { compileMaterial, flipbookOf, scrollOf } from '../src/particles/material';
import { circumcenter, expandCatmullRom, expandCircular } from '../src/particles/ribbons';
import { buildShapes, drawOrder, VERTEX_FLOATS } from '../src/particles/shapes';
import type { Texture } from '../src/rendering/Texture';
import { ParticleSystem } from '../src/particles/ParticleSystem';
import { randomSeed, RandomSeedGenerator, seedFloat } from '../src/particles/random';
import type { ParticleModuleFile } from '../src/content/format';

/** 一个发射器的粒子系统，种子固定。 */
function system(emitter: ParticleModuleFile): ParticleSystem {
  return new ParticleSystem({ emitters: [{ randomSeedMethod: 'fixed', ...emitter }] });
}

const STEP = 1 / 60;
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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
    const camera = { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1], viewProjection: IDENTITY } as const;
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
    // Overlay 写成函数，只在用到时带上
    const overlay = compileMaterial({ computeColor: { $type: 'computeBinaryColor', operator: 'overlay', leftChild: { $type: 'computeVertexStreamColor' }, rightChild: { $type: 'computeFloat', value: 0.25 } } }, () => undefined);
    expect(overlay.code).toContain('fn overlay(a: vec4f, b: vec4f)');
    expect(overlay.code).toContain('return overlay(color, vec4f(0.25, 0.25, 0.25, 0.25));');
    expect(fallback.code).not.toContain('fn overlay');
  });

  test('BoundingSphereStatic：世界包围盒是位置周围 半径 · 缩放 的立方体', () => {
    const particles = new ParticleSystem({ boundingShape: { $type: 'boundingSpheretatic', radius: 2 } });
    particles.translation = [1, 0, 0];
    particles.uniformScale = 2;
    expect(particles.worldBounds()).toEqual([[-3, -4, -4], [5, 4, 4]]);
  });
});

describe('飘带和拖尾（照 Stride 的 ShapeBuilderRibbon、ShapeBuilderTrail）', () => {
  /** 一帧生成三个粒子：生成顺序 0、1、2，按弧线（不抬高、没有偏移）排在 x = 0、1、2。 */
  function line(shapeBuilder: ParticleModuleFile, extra: ParticleModuleFile[] = []): ParticleSystem {
    const particles = system({
      particleLifetime: [10, 10],
      sortingPolicy: 'byOrder',
      spawners: [{ ...ONE_PARTICLE, spawnCount: 3 }],
      initializers: [
        { $type: 'initialSpawnOrder' },
        { $type: 'initialPositionArc', fallbackTarget: [2, 0, 0], arcHeight: 0, positionMin: [0, 0, 0], positionMax: [0, 0, 0] },
        ...extra,
      ],
      shapeBuilder,
    });
    particles.update(STEP);
    return particles;
  }
  const camera = { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1], viewProjection: IDENTITY } as const;

  test('InitialSpawnOrder 逐个编号，ByOrder 从新到旧；InitialPositionArc 沿发射器到目标排开', () => {
    const emitter = line({ $type: 'shapeBuilderRibbon' }).emitters[0]!;
    expect([...emitter.pool.integers('order')!.subarray(0, 3)]).toEqual([0, 1, 2]);
    expect([...emitter.pool.field('position')!.subarray(0, 9)]).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(drawOrder(emitter, camera)).toEqual([2, 1, 0]);
  });

  test('Ribbon：相邻两个粒子之间一个四边形，宽度是大小、在屏幕里垂直于带子，V 按 Stretched 拉满', () => {
    const emitter = line({ $type: 'shapeBuilderRibbon', textureCoordinatePolicy: 'stretched', texCoordsFactor: 1 }).emitters[0]!;
    const vertices = new Float32Array(3 * 4 * VERTEX_FLOATS);
    const end = buildShapes(emitter, emitter.shape!, camera, drawOrder(emitter, camera), vertices, 0, () => [0, 0, 1, 1]);
    expect(end).toBe(vertices.length);
    // 第二个四边形：从 x = 2 到 x = 1，上下各 0.5（大小 1）
    const quad = (q: number) => [0, 1, 2, 3].map((k) => [...vertices.subarray((q * 4 + k) * VERTEX_FLOATS, (q * 4 + k) * VERTEX_FLOATS + 5)].map((c) => +c.toFixed(4)));
    expect(quad(1)).toEqual([[2, 0.5, 0, 0, 1 / 3].map((c) => +c.toFixed(4)), [2, -0.5, 0, 1, +(1 / 3).toFixed(4)], [1, -0.5, 0, 1, +(2 / 3).toFixed(4)], [1, 0.5, 0, 0, +(2 / 3).toFixed(4)]]);
  });

  test('Trail：宽度是 Direction · 大小，EdgePolicy 是 Edge 时粒子在带子的边上', () => {
    const emitter = line(
      { $type: 'shapeBuilderTrail', edgePolicy: 'edge' },
      [{ $type: 'initialDirectionSeed', directionMin: [0, 0, 2], directionMax: [0, 0, 2] }],
    ).emitters[0]!;
    const vertices = new Float32Array(3 * 4 * VERTEX_FLOATS);
    buildShapes(emitter, emitter.shape!, camera, drawOrder(emitter, camera), vertices, 0, () => [0, 0, 1, 1]);
    const position = (k: number) => [...vertices.subarray((4 + k) * VERTEX_FLOATS, (4 + k) * VERTEX_FLOATS + 3)];
    expect([position(0), position(1), position(2), position(3)]).toEqual([[2, 0, 0], [2, 0, 2], [1, 0, 2], [1, 0, 0]]);
  });

  test('平滑：Catmull-Rom 的插值点经过两头的粒子之间，宽度线性过渡；外接圆的圆心', () => {
    const sections = 4;
    const points = new Float64Array(3 * sections * 3);
    points.set([0, 0, 0], 0);
    points.set([1, 1, 0], sections * 3);
    points.set([2, 0, 0], sections * 6);
    const sizes = new Float64Array(3 * sections);
    sizes[0] = 1; sizes[sections] = 3; sizes[sections * 2] = 1;
    expandCatmullRom(points, sizes, 1, sections, 3 * sections);
    // 第一段的中点在 (0.5, ~0.56)：比直线高（曲线经过顶点 (1, 1)）
    expect(points[2 * 3]).toBeCloseTo(0.5);
    expect(points[2 * 3 + 1]).toBeGreaterThan(0.5);
    expect(sizes[2]).toBeCloseTo(2);
    expect([...circumcenter(new Float64Array(3), [1, 0, 0], [0, 1, 0], [-1, 0, 0])].map((c) => +c.toFixed(6) + 0)).toEqual([0, 0, 0]);
    // Best：圆上的三个点之间，插值的点也在圆上（第二段的两头和前一个点定出外接圆）
    const arc = new Float64Array(3 * sections * 3);
    arc.set([1, 0, 0], 0);
    arc.set([0, 1, 0], sections * 3);
    arc.set([-1, 0, 0], sections * 6);
    expandCircular(arc, new Float64Array(3 * sections), 1, sections, 3 * sections);
    for (let j = 1; j < sections; j++) expect(Math.hypot(...arc.subarray((sections + j) * 3, (sections + j) * 3 + 3))).toBeCloseTo(1, 5);
  });
});

describe('按寿命改颜色、转角和 UV 滚动', () => {
  test('ColorOverTime 存成预乘 alpha，RotationOverTime 的度数换成弧度', () => {
    const color: ParticleModuleFile = {
      $type: 'computeCurveSamplerColor4',
      curve: { keyFrames: [{ key: 0, value: [1, 0, 0, 1] }, { key: 1, value: [1, 0, 0, 0] }] },
    };
    const particles = system({
      particleLifetime: [1, 1],
      spawners: [ONE_PARTICLE],
      updaters: [{ $type: 'updaterColorOverTime', samplerMain: color }, { $type: 'updaterRotationOverTime', samplerMain: floatCurve([[0, 0], [1, 180]]) }],
    });
    for (let i = 0; i < 30; i++) particles.update(STEP);
    const pool = particles.emitters[0]!.pool;
    const age = 1 - pool.field('life')![0]!;
    expect(pool.field('color')![3]).toBeCloseTo(1 - age, 2);
    expect(pool.field('color')![0]).toBeCloseTo(1 - age, 2);
    expect(pool.field('rotation')![0]).toBeCloseTo(age * Math.PI, 2);
  });

  test('UVBuilderScroll：按走过的寿命从 StartFrame 移到 EndFrame', () => {
    const scroll = scrollOf({ startFrame: [0, 0, 1, 1], endFrame: [0, 1, 1, 2] });
    expect(scroll(1)).toEqual([0, 0, 1, 1]);
    expect(scroll(0.5)).toEqual([0, 0.5, 1, 1]);
  });
});

describe('子粒子（照 Stride 的 SpawnerFromParent 和 ParticleChildInitializer）', () => {
  const PARENT_SPAWNER: ParticleModuleFile = { $type: 'spawnerPerFrame', spawnCount: 2, loopCondition: 'oneShot', duration: [0.02, 0.02] };
  const fromParent = (trigger: ParticleModuleFile, count: number): ParticleModuleFile =>
    ({ $type: 'spawnerFromParent', parentName: 'Parent', particleSpawnTrigger: trigger, spawnCount: [count, count] });

  test('死亡触发：父粒子寿命到了多留一帧，子粒子生在它最后的位置', () => {
    const particles = new ParticleSystem({
      emitters: [
        {
          emitterName: 'Parent', randomSeedMethod: 'fixed', particleLifetime: [0.1, 0.1], spawners: [ONE_PARTICLE],
          initializers: [{ $type: 'initialPositionSeed', positionMin: [1, 2, 3], positionMax: [1, 2, 3] }],
        },
        {
          emitterName: 'Child', randomSeedMethod: 'fixed', particleLifetime: [10, 10],
          spawners: [fromParent({ $type: 'particleSpawnTriggerDeath' }, 3)],
          initializers: [{ $type: 'initialPositionParent', parentName: 'Parent', positionMin: [0, 0, 0], positionMax: [0, 0, 0] }],
        },
      ],
    });
    const [parent, child] = particles.emitters;
    expect(parent!.delayParticleDeath).toBe(1);
    for (let i = 0; i < 12; i++) particles.update(STEP);
    expect(parent!.pool.living).toBe(0);
    expect(child!.pool.living).toBe(3);
    expect([...child!.pool.field('position')!.subarray(0, 9)]).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
  });

  test('寿命触发：按顺序对应父粒子，继承颜色（相乘再预乘）、速度（乘系数）和生成顺序（父粒子的序号在高 16 位）', () => {
    const particles = new ParticleSystem({
      emitters: [
        {
          emitterName: 'Parent', randomSeedMethod: 'fixed', particleLifetime: [10, 10], spawners: [PARENT_SPAWNER],
          initializers: [
            { $type: 'initialSpawnOrder' },
            { $type: 'initialColorSeed', colorMin: [1, 0.5, 0, 0.5], colorMax: [1, 0.5, 0, 0.5] },
            { $type: 'initialVelocitySeed', velocityMin: [0, 2, 0], velocityMax: [0, 2, 0] },
          ],
        },
        {
          emitterName: 'Child', randomSeedMethod: 'fixed', particleLifetime: [10, 10],
          spawners: [fromParent({ $type: 'particleSpawnTriggerLifetime', lifetimeLowerLimit: 0, lifetimeUpperLimit: 1 }, 1)],
          initializers: [
            { $type: 'initialColorParent', parentName: 'Parent' },
            { $type: 'initialVelocityParent', parentName: 'Parent', velocityMin: [0, 0, 0], velocityMax: [0, 0, 0], parentVelocityFactor: 0.5 },
            { $type: 'initialOrderParent', parentName: 'Parent' },
          ],
        },
      ],
    });
    particles.update(STEP);
    const child = particles.emitters[1]!.pool;
    expect(child.living).toBe(2);
    expect([...child.field('color')!.subarray(0, 4)]).toEqual([0.25, 0.125, 0, 0.5]);
    expect([...child.field('velocity')!.subarray(0, 3)]).toEqual([0, 1, 0]);
    expect([...child.integers('order')!.subarray(0, 2)]).toEqual([0, 1 << 16]);
    // 父粒子记下每个子粒子取到的序号
    expect([...particles.emitters[0]!.pool.integers('childOrder')!.subarray(0, 2)]).toEqual([1, 1]);
  });

  test('圆环：管子中心线上相对距离 0，管子外面 1；碰撞放回管子表面', () => {
    const torus = new FieldShapeTorus({ bigRadius: 2, smallRadius: 0.25 });
    torus.prepare([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    const along: Vec3 = [0, 0, 0], around: Vec3 = [0, 0, 0], away: Vec3 = [0, 0, 0];
    expect(torus.distance([2, 0, 0], along, around, away)).toBeCloseTo(0);
    expect(torus.distance([0, 0, 0], along, around, away)).toBe(1);
    // 管子里：中心线外 0.25 · 2 · 0.5 = 0.25（一半的管子半径）
    expect(torus.distance([2.25, 0, 0], along, around, away)).toBeCloseTo(0.5);
    expect(away.map((c) => +c.toFixed(5) + 0)).toEqual([1, 0, 0]);
    const point: Vec3 = [0, 0, 0], normal: Vec3 = [0, 0, 0];
    expect(torus.isPointInside([2, 0.1, 0], point, normal)).toBe(true);
    expect(point.map((c) => +c.toFixed(5) + 0)).toEqual([2, 0.5, 0]);
    expect(normal.map((c) => +c.toFixed(5) + 0)).toEqual([0, 1, 0]);
  });
});
