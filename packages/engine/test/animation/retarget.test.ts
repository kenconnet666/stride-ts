import { AnimationBatch, createStrideNative, type StrideNative } from '@stride-ts/native';
import { createStrideTools, type JointDescription, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AnimationClip, AnimationSystem, Game, retargetName, Skeleton } from '../../src';

let native: StrideNative;
let tools: StrideTools;

beforeAll(async () => {
  native = await createStrideNative({ workerThreads: 1 });
  tools = await createStrideTools({ workerThreads: 1 });
});

afterAll(() => {
  native?.shutdown();
  tools?.shutdown();
});

const skeleton = (name: string, joints: (JointDescription & { name: string; parent: number })[]) =>
  new Skeleton(name, joints.map(({ name: joint, parent }) => ({ name: joint, parent })), native.loadSkeleton(tools.buildSkeleton(joints)));

describe('动画重定向', () => {
  test('关节名的写法：去掉命名空间前缀、小写、只留字母数字', () => {
    expect(retargetName('mixamorig:LeftUpLeg')).toBe('leftupleg');
    expect(retargetName('Left_Up-Leg')).toBe('leftupleg');
  });

  test('按名字自动对上：目标高一倍、多一个根节点，腿往前抬平、髋按比例挪；同一组参数只建一次；inPlace 时髋不挪', () => {
    const s = Math.SQRT1_2;
    const source = skeleton('Source', [
      { parent: -1, translation: [0, 1, 0], name: 'mixamorig:Hips' },
      { parent: 0, translation: [0.1, 0, 0], name: 'mixamorig:LeftUpLeg' },
      { parent: 1, translation: [0, -0.5, 0], name: 'mixamorig:LeftLeg' },
    ]);
    const target = skeleton('Target', [
      { parent: -1, name: 'Root' },
      { parent: 0, translation: [0, 2, 0], name: 'Hips' },
      { parent: 1, translation: [0.2, 0, 0], name: 'Left_UpLeg' },
      { parent: 2, translation: [0, -1, 0], name: 'LeftLeg' },
    ]);
    const nativeClip = native.loadAnimation(tools.buildAnimation(1, [
      { translations: [[0, 0, 1, 0], [1, 0, 1, 1]], rotations: [[0, 0, 0, 0, 1]], scales: [[0, 1, 1, 1]] },
      { translations: [[0, 0.1, 0, 0]], rotations: [[0, 0, 0, 0, 1], [1, -s, 0, 0, s]], scales: [[0, 1, 1, 1]] },
      { translations: [[0, 0, -0.5, 0]], rotations: [[0, 0, 0, 0, 1]], scales: [[0, 1, 1, 1]] },
    ]));
    const clip = new AnimationClip('Kick', 1, 'playOnce', { skeleton: source, native: nativeClip });
    const animation = new AnimationSystem(native, new Game().entities);
    const retargeted = animation.retarget(clip, target);
    expect(retargeted.bones!.skeleton).toBe(target);
    expect(retargeted.duration).toBe(1);
    expect(animation.retarget(clip, target)).toBe(retargeted);
    const instance = target.native.createInstance();
    using batch = new AnimationBatch(native);
    const positionAt = (c: AnimationClip, joint: number) => {
      batch.clear().instance(instance).push(c.bones!.native, 1);
      batch.evaluate();
      const m = instance.modelMatrices();
      return [12, 13, 14].map((k) => +m[joint * 16 + k]!.toFixed(3));
    };
    expect(positionAt(retargeted, 1)).toEqual([0, 2, 2]);
    expect(positionAt(retargeted, 3)).toEqual([0.2, 2, 3]);
    const inPlace = animation.retarget(clip, target, { inPlace: true });
    expect(positionAt(inPlace, 1)).toEqual([0, 2, 0]);
    expect(() => animation.retarget(clip, target, { map: { LeftLeg: 'Nope' } })).toThrow(/no joint 'Nope'/);
  });
});
