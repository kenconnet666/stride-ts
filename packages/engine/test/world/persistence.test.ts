import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { beforeAll, describe, expect, test } from 'vitest';
import { ContentManager } from '../../src/content/ContentManager';
import type { SceneFile } from '../../src/content/formats/format';
import { Game } from '../../src/engine/Game';
import { Transform } from '../../src/engine/transform';
import { StreamingSource } from '../../src/world/WorldStreaming';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const entity = (id: string, components: SceneFile['entities'][number]['components']) =>
  ({ id, name: id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components }) as const;

/** 一个格子：持久的箱子（记位置）、持久的路灯（只记组件的字段）、持久的金币、不持久的石头。 */
const CELL: SceneFile = {
  name: 'Cell',
  entities: [
    entity('crate', { persistent: {} }),
    entity('beacon', { persistent: { transform: false }, streamingSource: { radiusScale: 1 } }),
    entity('coin', { persistent: {} }),
    entity('rock', {}),
  ],
};

describe('世界状态的持久化', () => {
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 2 });
  });

  const newGame = () => {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(32);
    game.content = new ContentManager({ root: 'https://game.test/content/', read: async () => json(CELL) });
    return game;
  };

  test('场景卸掉再读回来：持久实体的位置、组件的字段、被销毁的都还是那样；不持久的回到文件里的样子', async () => {
    const game = newGame();
    let cell = await game.loadScene('Cells/A', { applySettings: false });
    cell.entities.get('crate')!.require(Transform).position = { x: 3, y: 0, z: -2 };
    cell.entities.get('beacon')!.require(Transform).position = { x: 9, y: 9, z: 9 };
    cell.entities.get('beacon')!.require(StreamingSource).radiusScale = 2.5;
    cell.entities.get('coin')!.destroy();
    cell.entities.get('rock')!.require(Transform).position = { x: 5, y: 5, z: 5 };
    game.unloadScene(cell);
    expect([...game.persistence.records.keys()]).toEqual(['Cells/A#crate', 'Cells/A#beacon', 'Cells/A#coin']);

    cell = await game.loadScene('Cells/A', { applySettings: false });
    expect({ ...cell.entities.get('crate')!.require(Transform).position }).toEqual({ x: 3, y: 0, z: -2 });
    // 路灯不记位置，只记字段
    expect({ ...cell.entities.get('beacon')!.require(Transform).position }).toEqual({ x: 0, y: 0, z: 0 });
    expect(cell.entities.get('beacon')!.require(StreamingSource).radiusScale).toBe(2.5);
    expect(cell.entities.get('coin')!.alive).toBe(false);
    expect({ ...cell.entities.get('rock')!.require(Transform).position }).toEqual({ x: 0, y: 0, z: 0 });
    // 同一个场景路径的另一份（别的格子）不受影响
    const other = await game.loadScene('Cells/B', { applySettings: false });
    expect(other.entities.get('coin')!.alive).toBe(true);
  });

  test('存档读档：存下加载着的持久实体、世界时钟和游戏的段，读到另一局里马上套上；格式不对的不读', async () => {
    const game = newGame();
    const cell = await game.loadScene('Cells/A', { applySettings: false });
    let coins = 7;
    game.persistence.section('wallet', { save: () => ({ coins }), load: (data) => { coins = (data as { coins: number }).coins; } });
    game.clock.set({ dayOfYear: 100, hours: 15 });
    cell.entities.get('crate')!.require(Transform).position = { x: 1, y: 2, z: 3 };
    cell.entities.get('coin')!.destroy();
    const save = JSON.parse(JSON.stringify(game.persistence.save())) as ReturnType<typeof game.persistence.save>;

    const next = newGame();
    const nextCell = await next.loadScene('Cells/A', { applySettings: false });
    next.persistence.section('wallet', { save: () => ({ coins }), load: (data) => { coins = (data as { coins: number }).coins; } });
    coins = 0;
    next.persistence.load(save);
    expect([coins, next.clock.dayOfYear, next.clock.timeOfDay]).toEqual([7, 100, 15]);
    expect({ ...nextCell.entities.get('crate')!.require(Transform).position }).toEqual({ x: 1, y: 2, z: 3 });
    expect(nextCell.entities.get('coin')!.alive).toBe(false);
    expect(() => next.persistence.load({ format: 'other' } as never)).toThrow('not a save');
  });
});
