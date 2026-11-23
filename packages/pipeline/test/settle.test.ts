import { describe, expect, test } from 'vitest';
import type { ProductFile } from '@stride-ts/engine/content-format';
import { settleFood } from '../src/bakers/settle.ts';

/** 口径 16 厘米、高 7 厘米的碗，盛到六成。 */
const bowl = (pieces: 'chunks' | 'strands' | 'beans', dropped: number): ProductFile => ({
  name: 'Bowl', shape: 'bowl', size: [0.16, 0.07, 0], food: { color: '#8a3b1c', pieces, dropped, level: 0.6, mound: 0.1 }, seed: 3,
});

describe('碗里落下去的菜（settleFood）', () => {
  test('块、粒落在碗里：几乎都留下，停在菜面上、口沿以内；同一个文件落出来一样', async () => {
    for (const [pieces, dropped] of [['chunks', 30], ['beans', 80]] as const) {
      const products = new Map([['Bowl', bowl(pieces, dropped)]]);
      const poses = (await settleFood(products)).get('Bowl')!;
      expect(poses.length).toBeGreaterThanOrEqual(dropped * 0.9);
      for (const { position } of poses) {
        expect(Math.hypot(position[0], position[2])).toBeLessThanOrEqual(0.08);
        expect(position[1]).toBeGreaterThan(0.03);
        expect(position[1]).toBeLessThan(0.15);
      }
      const again = (await settleFood(products)).get('Bowl')!;
      expect(again.map((pose) => pose.position)).toEqual(poses.map((pose) => pose.position));
    }
  }, 60_000);

  test('没有要落的菜的商品不在结果里', async () => {
    const result = await settleFood(new Map<string, ProductFile>([['Empty', { name: 'Empty', shape: 'bowl', size: [0.16, 0.07, 0] }], ['Smooth', { ...bowl('chunks', 10), food: { color: '#eeeeee', pieces: 'smooth', dropped: 10 } }]]));
    expect(result.size).toBe(0);
  });
});
