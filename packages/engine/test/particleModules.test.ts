import { describe, expect, test } from 'vitest';
import { curve, isCurve, newEmitter, PARTICLE_MODULES } from '../src/editor/particleModules';
import { createInitializer, createSpawner, NO_CONTEXT } from '../src/particles/modules';
import { createUpdater } from '../src/particles/updaters';
import { createBuiltinShape } from '../src/particles/shapes';
import { ParticleEmitter } from '../src/particles/ParticleEmitter';
import { CurveSampler } from '../src/particles/curves';

describe('粒子模块库（编辑器的粒子面板）', () => {
  test('面板能加的每个模块运行时都认识', () => {
    for (const spec of PARTICLE_MODULES) {
      const known = {
        spawners: () => createSpawner(spec.initial),
        initializers: () => createInitializer(spec.initial, NO_CONTEXT),
        updaters: () => createUpdater(spec.initial),
        shapeBuilder: () => createBuiltinShape(spec.initial),
        material: () => (spec.initial.$type === 'particleMaterialComputeColor' ? spec.initial : undefined),
      }[spec.stack]();
      expect(known, spec.type).toBeDefined();
    }
  });

  test('新的发射器能建起来', () => {
    const emitter = new ParticleEmitter(newEmitter('Sparks'));
    expect(emitter.spawners).toHaveLength(1);
    expect(emitter.updaters.length).toBeGreaterThan(0);
  });

  test('curve 建的曲线运行时能采样', () => {
    const file = curve('Float', [[0, 0], [1, 2]]);
    expect(isCurve(file)).toBe(true);
    expect(isCurve({ $type: 'initialSizeSeed' })).toBe(false);
    expect(new CurveSampler(file).evaluate(0.5)[0]).toBeCloseTo(1);
  });
});
