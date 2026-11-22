/**
 * 白平衡矩阵（线性 sRGB → 线性 sRGB，列主序 3×3）：相机设成 temperature（K）、tint 时，把这个色温的光源的白当成白（von Kries：
 * 在 CAT02 的 LMS 里按 D65 和那个白点的比缩放）。色温的色度按普朗克轨迹的近似（Kang 2002），tint 沿轨迹的法线往品红、绿挪。
 */
export function whiteBalanceMatrix(temperature: number, tint: number): number[] {
  if (Math.abs(temperature - 6500) < 1e-3 && Math.abs(tint) < 1e-6) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const t = Math.min(Math.max(temperature, 1667), 25000);
  const x = t <= 4000
    ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y0 = t <= 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
    : t <= 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  const y = y0 + tint * 0.02;
  const xyz = (cx: number, cy: number) => [cx / cy, 1, (1 - cx - cy) / cy];
  // CAT02 的 XYZ → LMS
  const cat = [[0.7328, 0.4296, -0.1624], [-0.7036, 1.6975, 0.0061], [0.003, 0.0136, 0.9834]];
  const lms = (v: number[]) => cat.map((row) => row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!);
  const source = lms(xyz(x, y)), target = lms(xyz(0.31271, 0.32902));
  const scale = source.map((value, i) => target[i]! / value);
  // 线性 sRGB ↔ XYZ（D65）
  const toXyz = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
  const fromXyz = [[3.2404542, -1.5371385, -0.4985314], [-0.969266, 1.8760108, 0.041556], [0.0556434, -0.2040259, 1.0572252]];
  const catInverse = invert3(cat);
  const multiply = (a: number[][], b: number[][]) => a.map((row) => [0, 1, 2].map((j) => row[0]! * b[0]![j]! + row[1]! * b[1]![j]! + row[2]! * b[2]![j]!));
  const diagonal = [[scale[0]!, 0, 0], [0, scale[1]!, 0], [0, 0, scale[2]!]];
  const m = multiply(fromXyz, multiply(catInverse, multiply(diagonal, multiply(cat, toXyz))));
  // 列主序
  return [m[0]![0]!, m[1]![0]!, m[2]![0]!, m[0]![1]!, m[1]![1]!, m[2]![1]!, m[0]![2]!, m[1]![2]!, m[2]![2]!];
}

function invert3(m: number[][]): number[][] {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!, B = -(d! * i! - f! * g!), C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ];
}
