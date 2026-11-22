import { describe, expect, test } from 'vitest';
import { encodeSplats, SPLAT_WORDS, type SplatNode } from '../../src/content/splatFile';
import { SplatCloud, type SplatRangeReader } from '../../src/rendering/splats/SplatCloud';

/** 700 个泼溅、三个节点：根（前 100 个）和两个叶子（各 300 个），带 1 阶球谐。 */
function file(): ArrayBuffer {
  const count = 700;
  const node = (first: number, n: number, firstChild: number, childCount: number): SplatNode => ({ min: [0, 0, 0], max: [1, 1, 1], first, count: n, firstChild, childCount, detail: childCount ? 0.5 : 0 });
  const positions = new Float32Array(count * 3).map((_, k) => k / 3);
  const bytes = encodeSplats({
    count, positions, scales: new Float32Array(count * 3).fill(0.01), rotations: new Float32Array(count * 4).map((_, k) => (k % 4 === 3 ? 1 : 0)),
    colors: new Float32Array(count * 4).fill(0.5), shBands: 1, sh: new Float32Array(count * 9).map((_, k) => (k % 7) / 10),
    nodes: [node(0, 100, 1, 2), node(100, 300, 0, 0), node(400, 300, 0, 0)],
  });
  return bytes.buffer as ArrayBuffer;
}

/** 按范围读的假服务器：记下每次读的范围；range 为 false 时像不认 Range 的服务器一样回整个文件。 */
function server(buffer: ArrayBuffer, range = true): { read: SplatRangeReader; calls: [number, number][] } {
  const calls: [number, number][] = [];
  return {
    calls,
    read: async (_url, start, end) => {
      calls.push([start, end]);
      return range ? { bytes: buffer.slice(start, Math.min(end, buffer.byteLength)), whole: false } : { bytes: buffer, whole: true };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('高斯泼溅按需加载', () => {
  test('先读头和节点表、马上要根；相邻的节点合成一次请求；读到的字和整个文件的一样', async () => {
    const buffer = file();
    const { read, calls } = server(buffer);
    const cloud = await SplatCloud.stream('test', new URL('file:///test.splat'), read);
    expect(cloud.count).toBe(700);
    expect(cloud.nodes).toHaveLength(3);
    await settle();
    // 头一次，根节点的字和球谐各一次
    expect(calls).toHaveLength(3);
    expect(cloud.arrived.map((chunk) => chunk.nodes)).toEqual([[0]]);
    cloud.arrived.length = 0;
    cloud.request([1, 2]);
    await settle();
    expect(calls).toHaveLength(5);
    const [chunk] = cloud.arrived;
    expect(chunk!.nodes).toEqual([1, 2]);
    expect(chunk!.first).toBe(100);
    expect(chunk!.count).toBe(600);
    const whole = SplatCloud.fromBytes('whole', buffer).arrived[0]!;
    expect([...chunk!.words]).toEqual([...whole.words.subarray(100 * SPLAT_WORDS, 700 * SPLAT_WORDS)]);
    // 1 阶球谐每个泼溅 9 个系数、3 个字
    expect(chunk!.sh.length).toBe(600 * 3);
    // 要过的不再要
    cloud.request([1, 2]);
    await settle();
    expect(calls).toHaveLength(5);
  });

  test('读失败的放回去下一次再要，同一个节点失败三次就不再要', async () => {
    const buffer = file();
    let fail = 0;
    const calls: number[] = [];
    const read: SplatRangeReader = async (_url, start, end) => {
      calls.push(start);
      if (start >= 1000 && fail-- > 0) throw new Error('Failed to fetch');
      return { bytes: buffer.slice(start, end), whole: false };
    };
    const cloud = await SplatCloud.stream('test', new URL('file:///test.splat'), read);
    await settle();
    cloud.arrived.length = 0;
    fail = 1;
    cloud.request([1]);
    await settle();
    expect(cloud.arrived).toHaveLength(0);
    cloud.request([1]);
    await settle();
    expect(cloud.arrived.map((chunk) => chunk.nodes)).toEqual([[1]]);
    fail = 3;
    for (let k = 0; k < 4; k++) {
      cloud.request([2]);
      await settle();
    }
    expect(cloud.arrived).toHaveLength(1);
    const before = calls.length;
    cloud.request([2]);
    await settle();
    expect(calls.length).toBe(before);
  });

  test('服务器不认 Range（回整个文件）时一次全到', async () => {
    const { read, calls } = server(file(), false);
    const cloud = await SplatCloud.stream('test', new URL('file:///test.splat'), read);
    expect(calls).toHaveLength(1);
    expect(cloud.arrived).toHaveLength(1);
    expect(cloud.arrived[0]!.nodes).toEqual([0, 1, 2]);
    expect(cloud.arrived[0]!.count).toBe(700);
  });
});
