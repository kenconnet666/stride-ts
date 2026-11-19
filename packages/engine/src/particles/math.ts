/**
 * 粒子模块用的小向量、四元数运算，照 Stride.Core.Mathematics：四元数是 [x, y, z, w]，`combine(a, b)` 是 Stride 的 `a * b`
 * （先转 a 再转 b）。
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

const ZERO_TOLERANCE = 1e-6;

/** Stride 的 a * b：先转 a，再转 b（哈密顿积 b ⊗ a）。 */
export function combine(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const [lx, ly, lz, lw] = a, [rx, ry, rz, rw] = b;
  return [
    rx * lw + lx * rw + ry * lz - rz * ly,
    ry * lw + ly * rw + rz * lx - rx * lz,
    rz * lw + lz * rw + rx * ly - ry * lx,
    rw * lw - (rx * lx + ry * ly + rz * lz),
  ];
}

/** 用 q 转向量 v，写回 v（Stride 的 Quaternion.Rotate）。 */
export function rotate(q: Readonly<Quat>, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 · (q.xyz × v)，v' = v + w·t + q.xyz × t
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  v[0] = vx + w * tx + (y * tz - z * ty);
  v[1] = vy + w * ty + (z * tx - x * tz);
  v[2] = vz + w * tz + (x * ty - y * tx);
  return v;
}

export function isIdentity(q: Readonly<Quat>): boolean {
  return q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1;
}

/** 球面插值（Stride 的 Quaternion.Slerp，不归一化）。 */
export function slerp(start: Readonly<Quat>, end: Readonly<Quat>, amount: number): Quat {
  const dot = start[0] * end[0] + start[1] * end[1] + start[2] * end[2] + start[3] * end[3];
  let inverse: number, opposite: number;
  if (Math.abs(dot) > 1 - ZERO_TOLERANCE) {
    inverse = 1 - amount;
    opposite = amount * Math.sign(dot);
  } else {
    const angle = Math.acos(Math.abs(dot));
    const invSin = 1 / Math.sin(angle);
    inverse = Math.sin((1 - amount) * angle) * invSin;
    opposite = Math.sin(amount * angle) * invSin * Math.sign(dot);
  }
  return [0, 1, 2, 3].map((i) => inverse * start[i]! + opposite * end[i]!) as Quat;
}

/** 长度大于容差时归一化（Stride 的 Normalize，向量、四元数通用）。 */
export function normalize<T extends number[]>(v: T): T {
  const length = Math.hypot(...v);
  if (length > ZERO_TOLERANCE) for (let i = 0; i < v.length; i++) v[i]! /= length;
  return v;
}
