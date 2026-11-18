/**
 * 可变的数学类型（对应 Stride.Core.Mathematics）。方法修改 `this` 并返回它，链式调用不分配内存；
 * 要新对象就显式 clone()。参数收 *Like 接口，所以列或 wasm 内存上的活视图也能直接传。
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface ColorLike {
  r: number;
  g: number;
  b: number;
  a: number;
}

export class Vector3 implements Vec3Like {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Readonly<Vec3Like>): this {
    return this.set(v.x, v.y, v.z);
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  add(v: Readonly<Vec3Like>): this {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  subtract(v: Readonly<Vec3Like>): this {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): this {
    return this.set(this.x * s, this.y * s, this.z * s);
  }

  /** this += v * s */
  addScaled(v: Readonly<Vec3Like>, s: number): this {
    return this.set(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }

  dot(v: Readonly<Vec3Like>): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Readonly<Vec3Like>): this {
    return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  /** 归一化成单位长度；零向量保持为零。 */
  normalize(): this {
    const length = this.length();
    return length > 0 ? this.scale(1 / length) : this;
  }

  lerp(to: Readonly<Vec3Like>, t: number): this {
    return this.set(this.x + (to.x - this.x) * t, this.y + (to.y - this.y) * t, this.z + (to.z - this.z) * t);
  }

  equals(v: Readonly<Vec3Like>, epsilon = 0): boolean {
    return Math.abs(this.x - v.x) <= epsilon && Math.abs(this.y - v.y) <= epsilon && Math.abs(this.z - v.z) <= epsilon;
  }
}

export class Quaternion implements QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q: Readonly<QuatLike>): this {
    return this.set(q.x, q.y, q.z, q.w);
  }

  clone(): Quaternion {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }

  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  /** 绕单位轴旋转 `radians` 弧度。 */
  setAxisAngle(axis: Readonly<Vec3Like>, radians: number): this {
    const half = radians / 2;
    const s = Math.sin(half);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
  }

  /** this = this * q：先按 q 旋转，再按 this 旋转。 */
  multiply(q: Readonly<QuatLike>): this {
    const { x, y, z, w } = this;
    return this.set(
      w * q.x + x * q.w + y * q.z - z * q.y,
      w * q.y - x * q.z + y * q.w + z * q.x,
      w * q.z + x * q.y - y * q.x + z * q.w,
      w * q.w - x * q.x - y * q.y - z * q.z,
    );
  }

  normalize(): this {
    const length = Math.hypot(this.x, this.y, this.z, this.w);
    return length > 0 ? this.set(this.x / length, this.y / length, this.z / length, this.w / length) : this.identity();
  }

  /** 用这个旋转原地旋转 v。 */
  rotate(v: Vec3Like): Vec3Like {
    const { x, y, z, w } = this;
    // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
    const tx = 2 * (y * v.z - z * v.y);
    const ty = 2 * (z * v.x - x * v.z);
    const tz = 2 * (x * v.y - y * v.x);
    const rx = v.x + w * tx + (y * tz - z * ty);
    const ry = v.y + w * ty + (z * tx - x * tz);
    const rz = v.z + w * tz + (x * ty - y * tx);
    v.x = rx;
    v.y = ry;
    v.z = rz;
    return v;
  }
}

/** 线性空间的 RGBA，分量 0..1（对应 Stride 的 Color4）。 */
export class Color4 implements ColorLike {
  r: number;
  g: number;
  b: number;
  a: number;

  constructor(r = 0, g = 0, b = 0, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }

  set(r: number, g: number, b: number, a: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }

  copy(c: Readonly<ColorLike>): this {
    return this.set(c.r, c.g, c.b, c.a);
  }

  clone(): Color4 {
    return new Color4(this.r, this.g, this.b, this.a);
  }

  /** 把 sRGB 的 r、g、b 转成线性（alpha 不变），同 Stride 的 Color.ToLinear。 */
  toLinear(): this {
    return this.set(srgbToLinear(this.r), srgbToLinear(this.g), srgbToLinear(this.b), this.a);
  }
}

/** sRGB 的一个分量转成线性（IEC 61966-2-1 的分段公式）。 */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
