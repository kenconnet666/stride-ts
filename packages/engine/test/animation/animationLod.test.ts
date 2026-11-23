import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { createStrideTools, type JointDescription, type StrideTools } from '@stride-ts/native/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AnimationSystem, Game, Skeleton, Transform } from '../../src';

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

describe('动画按距离降频', () => {
  test('近的每帧求，远的隔帧、每 4 帧、每 8 帧；按实体编号错开；没有关注点时每帧都求', () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(64);
    const animation = new AnimationSystem(native, game.entities);
    game.entities.addSystems(animation.system);
    const joints: (JointDescription & { name: string; parent: number })[] = [{ parent: -1, name: 'root' }, { parent: 0, translation: [0, 1, 0], name: 'head' }];
    const skeleton = new Skeleton('Test', joints.map(({ name, parent }) => ({ name, parent })), native.loadSkeleton(tools.buildSkeleton(joints)));
    const at = (x: number) => {
      const entity = game.entities.create({ name: `At${x}`, components: [Transform.with({ position: [x, 0, 0] })] });
      animation.attach(entity, skeleton, []);
    };
    for (const x of [10, 40, 80, 200]) at(x);
    game.transforms.update();
    const run = (frames: number) => {
      let total = 0;
      for (let i = 0; i < frames; i++) {
        game.updateTime.advance(1 / 60);
        game.entities.update(game.updateTime);
        total += animation.lodStats.evaluated;
      }
      return total;
    };
    run(1);
    animation.focus = [0, 0, 0];
    // 16 帧：1 + 1/2 + 1/4 + 1/8 → 16 + 8 + 4 + 2
    expect(run(16)).toBe(30);
    animation.focus = undefined;
    expect(run(16)).toBe(64);
    animation.lod.distances = [];
    animation.focus = [0, 0, 0];
    expect(run(4)).toBe(16);
  });
});
