// CSharpIntermediate 的 VectorPrintExtension：向量各分量保留一位小数（C# 的 Math.Round(x, 1)，正好一半时取偶数），用 " , " 隔开。
/** C# 的 Math.Round(value, 1) 再转成字符串（整数不带小数，-0 写成 0）。 */
function round1(value: number): string {
  const scaled = value * 10, floor = Math.floor(scaled);
  const rounded = Math.abs(scaled - floor - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled);
  return String(rounded / 10 + 0);
}

export function printVector(vector: { readonly x: number; readonly y: number; readonly z?: number }): string {
  return [vector.x, vector.y, ...(vector.z === undefined ? [] : [vector.z])].map(round1).join(' , ');
}
