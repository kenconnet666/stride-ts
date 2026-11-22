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
