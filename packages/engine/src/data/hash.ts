/**
 * 两个 32 位整数混成一个（lowbias32，Chris Wellons）：程序化生成按种子和坐标、编号取确定的随机数用（摆放的格子、树的每根枝、
 * 城里的每块地）。同样的输入在哪都得到同样的输出；除以 2³² 就是 [0, 1) 的随机数。
 */
export function hash32(a: number, b: number): number {
  let h = (Math.imul(a, 0x7feb352d) ^ (b + 0x846ca68b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 种子起的 [0, 1) 伪随机数（mulberry32）：音效合成、包装的配色这些按种子出一串随机数的地方用。（树的生长用自己的一份，
 * 写法差一点：换成这个会让已有的树长得不一样。）
 */
export function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
