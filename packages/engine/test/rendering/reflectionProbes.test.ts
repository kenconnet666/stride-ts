import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Game, Transform } from '../../src';
import { GpuResources } from '../../src/graphics/GpuResources';
import { ReflectionProbe } from '../../src/rendering/components';
import { PROBE_FLOATS, ReflectionProbes } from '../../src/rendering/lighting/ReflectionProbes';
import type { EntityId } from '../../src/data/prop';
import { Color4, Vector3 } from '../../src/data/vectors';
import type { Lighting, RenderContext } from '../../src/rendering/RenderSystem';
import { fakeGpu, stubGpuGlobals } from '../fakeGpu';

describe('反射探针（ReflectionProbes）', () => {
  let native: StrideNative;
  beforeAll(async () => {
    stubGpuGlobals();
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  function setup() {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    const { device } = fakeGpu();
    const probes = new ReflectionProbes(device, new GpuResources(device));
    const context = { game, time: game.updateTime } as unknown as RenderContext;
    const frame = () => {
      game.updateTime.advance(1 / 60);
      game.entities.update(game.updateTime);
      game.transforms.update();
      const view = probes.begin(context);
      if (view) {
        probes.captureTarget();
        probes.finish({ beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }) } as unknown as GPUCommandEncoder);
      }
      return view;
    };
    return { game, probes, frame };
  }

  test('每帧拍一个面，六个面拍完才进着色用的表；面朝 WebGPU 立方体贴图的 +X、-X、+Y、-Y、+Z、-Z', () => {
    const { game, probes, frame } = setup();
    game.entities.create({ components: [Transform.with({ position: [1, 2, 3] }), ReflectionProbe.with({ size: [4, 6, 8] })] });
    const forwards: number[][] = [];
    for (let face = 0; face < 6; face++) {
      expect(probes.count).toBe(0);
      const view = frame()!;
      expect([view.eye.x, view.eye.y, view.eye.z]).toEqual([1, 2, 3]);
      // 相机看向本地 -Z：视图矩阵第三行取反就是朝向
      forwards.push([-view.view[2]!, -view.view[6]!, -view.view[10]!].map((v) => Math.round(v) + 0));
    }
    expect(forwards).toEqual([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
    // once 的拍完一轮就不拍了，表里有它：中心和立方体、盒子的两个角和过渡距离、强度、视差校正
    expect(frame()).toBeUndefined();
    expect(probes.count).toBe(1);
    expect(Array.from(probes.data.subarray(0, 13))).toEqual([1, 2, 3, 0, -1, -1, -1, 1, 3, 5, 7, 1, 1]);
  });

  test('盒子小的排在前面；挪了的重拍，拍好之前着色时不用', () => {
    const { game, probes, frame } = setup();
    const big = game.entities.create({ components: [Transform.with({ position: [0, 0, 0] }), ReflectionProbe.with({ size: [20, 20, 20] })] });
    game.entities.create({ components: [Transform.with({ position: [5, 0, 0] }), ReflectionProbe.with({ size: [2, 2, 2] })] });
    // 表在每帧开头排：拍完的下一帧才用
    for (let i = 0; i < 13; i++) frame();
    expect(probes.count).toBe(2);
    expect([probes.data[0], probes.data[PROBE_FLOATS]]).toEqual([5, 0]);

    big.require(Transform).position = { x: 0, y: 1, z: 0 };
    frame();
    expect(probes.count).toBe(1);
    for (let i = 0; i < 6; i++) frame();
    expect(probes.count).toBe(2);
    expect(probes.data[PROBE_FLOATS + 1]).toBe(1);
  });

  test('everyFrame 的拍完接着拍；关掉时不拍、表是空的', () => {
    const { game, probes, frame } = setup();
    game.entities.create({ components: [Transform, ReflectionProbe.with({ refresh: 'everyFrame' })] });
    for (let i = 0; i < 6; i++) frame();
    expect(frame()).toBeDefined();
    probes.enabled = false;
    expect(frame()).toBeUndefined();
    expect(probes.count).toBe(0);
  });

  test('光照变了就重拍只拍一次的探针：太阳转一点点不拍，转得多、落山了才拍；重拍的时候接着用旧的', () => {
    const { game, probes, frame } = setup();
    game.entities.create({ components: [Transform, ReflectionProbe.with({ size: [4, 4, 4] })] });
    const sun = { direction: new Vector3(0, -1, 0), color: new Color4(5, 5, 5, 1), entity: -1 as EntityId, angle: 0.53, shadow: undefined };
    const lighting = { directionals: [sun], directionalCount: 1, ambient: new Color4(0, 0, 0, 1), skybox: undefined } as unknown as Lighting;
    const framesToSettle = () => {
      let frames = 0;
      for (;;) {
        const view = frame();
        probes.watchLighting(lighting);
        if (!view) return frames;
        frames++;
      }
    };
    expect(framesToSettle()).toBe(6);
    expect(probes.count).toBe(1);
    // 转了不到 1°：不重拍
    sun.direction.set(0.01, -1, 0);
    expect(framesToSettle()).toBe(0);
    // 转了十几度：重拍六个面，这期间探针照用
    sun.direction.set(0.3, -1, 0);
    probes.watchLighting(lighting);
    expect(frame()).toBeDefined();
    expect(probes.count).toBe(1);
    expect(framesToSettle()).toBe(5);
    // 太阳落山（从光照里拿掉了）：再拍一轮
    lighting.directionalCount = 0;
    probes.watchLighting(lighting);
    expect(framesToSettle()).toBe(6);
  });
});
