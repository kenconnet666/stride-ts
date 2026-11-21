/**
 * 4x4 矩阵的运算，直接作用在 Float32Array 上（对应 Stride.Core.Mathematics.Matrix 的静态方法）。
 * 布局和 Stride 的 Matrix 在内存里一样：16 个 float，平移在 12..14。按列主序、列向量理解就是 WGSL 的
 * mat4x4f，所以变换存储的世界矩阵可以原样上传。out 可以和参数是同一个数组。
 */
export type Matrix4 = Float32Array;
/** 只读的输入矩阵：单精度的，或者双精度的（变换存储的世界矩阵，D18）。 */
export type MatrixSource = Readonly<Float32Array | Float64Array>;

// 双精度：multiply 也给双精度的矩阵用（D18，编辑器里远处的框），单精度的结果照样精确到 float
const temp = new Float64Array(16);

export const Matrix = {
  /** 新的单位矩阵。 */
  identity(): Matrix4 {
    return Matrix.setIdentity(new Float32Array(16));
  },

  setIdentity(out: Matrix4): Matrix4 {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
  },

  /** out = a * b：先做 b 的变换，再做 a 的（列向量）。和 Stride 的 Matrix.Multiply(b, a) 同一个结果。 */
  multiply<Out extends Float32Array | Float64Array = Matrix4>(out: Out, a: MatrixSource, b: MatrixSource): Out {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4]!, b1 = b[c * 4 + 1]!, b2 = b[c * 4 + 2]!, b3 = b[c * 4 + 3]!;
      for (let r = 0; r < 4; r++) temp[c * 4 + r] = a[r]! * b0 + a[4 + r]! * b1 + a[8 + r]! * b2 + a[12 + r]! * b3;
    }
    out.set(temp);
    return out;
  },

  /** 矩阵（source 里从 offset 开始的 16 个数）的旋转部分：前三列各自归一化去掉缩放，平移置 0。 */
  rotationOf(out: Matrix4, source: MatrixSource, offset = 0): Matrix4 {
    out.fill(0);
    for (let c = 0; c < 3; c++) {
      const o = offset + c * 4;
      const length = Math.hypot(source[o]!, source[o + 1]!, source[o + 2]!) || 1;
      for (let r = 0; r < 3; r++) out[c * 4 + r] = source[o + r]! / length;
    }
    out[15] = 1;
    return out;
  },

  /** 逆矩阵；奇异时返回 false，out 不变。 */
  invert(out: Float32Array | Float64Array, m: MatrixSource): boolean {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m as unknown as number[] as [
      number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number,
    ];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (det === 0 || !Number.isFinite(det)) return false;
    const d = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
    return true;
  },

  /**
   * 右手坐标系的透视投影（Stride 的 Matrix.PerspectiveFovRH）：相机看向 -Z，深度 0（近）到 1（远），
   * 和 WebGPU 的裁剪空间一致。fieldOfView 是竖直视角，弧度。
   */
  perspectiveFovRH(out: Matrix4, fieldOfView: number, aspectRatio: number, near: number, far: number, reversed = false): Matrix4 {
    const yScale = 1 / Math.tan(fieldOfView / 2);
    out.fill(0);
    out[0] = yScale / aspectRatio;
    out[5] = yScale;
    // 反向 Z（reversed）：近 1 远 0，浮点深度的精度均匀地落在远处（大世界不闪）；正向同 Stride：近 0 远 1
    out[10] = reversed ? near / (far - near) : far / (near - far);
    out[11] = -1;
    out[14] = reversed ? (near * far) / (far - near) : (near * far) / (near - far);
    return out;
  },

  /** 右手坐标系的观察矩阵（Stride 的 Matrix.LookAtRH）：从 eye 看向 target，up 定上方。 */
  lookAtRH(out: Matrix4, eye: ArrayLike<number>, target: ArrayLike<number>, up: ArrayLike<number>): Matrix4 {
    const z = normalize([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!]);
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    out.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
    return out;
  },

  /** 右手坐标系的正交投影（Stride 的 Matrix.OrthoOffCenterRH），深度 0（近）到 1（远）；reversed 时反过来（近 1 远 0）。 */
  orthoOffCenterRH(out: Matrix4, left: number, right: number, bottom: number, top: number, near: number, far: number, reversed = false): Matrix4 {
    out.fill(0);
    out[0] = 2 / (right - left);
    out[5] = 2 / (top - bottom);
    out[10] = reversed ? 1 / (far - near) : 1 / (near - far);
    out[12] = (left + right) / (left - right);
    out[13] = (top + bottom) / (bottom - top);
    out[14] = reversed ? far / (far - near) : near / (near - far);
    out[15] = 1;
    return out;
  },

  /** 右手坐标系、以视线为中心的正交投影（Stride 的 Matrix.OrthoRH）。 */
  orthoRH(out: Matrix4, width: number, height: number, near: number, far: number, reversed = false): Matrix4 {
    return Matrix.orthoOffCenterRH(out, -width / 2, width / 2, -height / 2, height / 2, near, far, reversed);
  },

  /** 先缩放再平移（Stride 的 Matrix.Scaling(s) * Matrix.Translation(t)）。 */
  scaleTranslation(out: Matrix4, sx: number, sy: number, sz: number, tx: number, ty: number, tz: number): Matrix4 {
    out.fill(0);
    out[0] = sx;
    out[5] = sy;
    out[10] = sz;
    out[12] = tx;
    out[13] = ty;
    out[14] = tz;
    out[15] = 1;
    return out;
  },

  /**
   * 视图投影矩阵的 6 个视锥平面，朝内（dot(n, p) + w > 0 在内侧），法线归一化，顺序：左、右、下、上、近、远
   * （近、远在最后，剔除时可以只用前 4 个）。深度范围 0..1，同 WebGPU。
   */
  frustumPlanes(out: Float32Array, viewProjection: Readonly<Matrix4>, reversed = false): Float32Array {
    const m = viewProjection;
    // 裁剪坐标 = M * p，第 i 行是 (m[i], m[4 + i], m[8 + i], m[12 + i])
    const row = (i: number, sign: number, base: number | undefined, o: number): void => {
      for (let c = 0; c < 4; c++) out[o + c] = (base === undefined ? 0 : m[c * 4 + base]!) + sign * m[c * 4 + i]!;
    };
    row(0, 1, 3, 0);
    row(0, -1, 3, 4);
    row(1, 1, 3, 8);
    row(1, -1, 3, 12);
    // 近平面 z ≥ 0、远平面 z ≤ w；反向 Z 时两个对调（近平面 z ≤ w、远平面 z ≥ 0）
    if (reversed) {
      row(2, -1, 3, 16);
      row(2, 1, undefined, 20);
    } else {
      row(2, 1, undefined, 16);
      row(2, -1, 3, 20);
    }
    for (let o = 0; o < 24; o += 4) {
      const length = Math.hypot(out[o]!, out[o + 1]!, out[o + 2]!) || 1;
      for (let c = 0; c < 4; c++) out[o + c]! /= length;
    }
    return out;
  },

  /**
   * 拆成平移、旋转（四元数 xyzw）、缩放（Stride 的 Matrix.Decompose）。只对没有切变的矩阵精确；镜像（行列式为负）
   * 记在 x 的缩放上。
   */
  decompose(m: MatrixSource): { translation: Vec3Tuple; rotation: [number, number, number, number]; scale: Vec3Tuple } {
    const scale: Vec3Tuple = [0, 1, 2].map((c) => Math.hypot(m[c * 4]!, m[c * 4 + 1]!, m[c * 4 + 2]!)) as Vec3Tuple;
    const determinant = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
    if (determinant < 0) scale[0] = -scale[0];
    // 旋转矩阵 r[列][行]，按最大的对角项分情况转四元数（Shepperd）
    const r = [0, 1, 2].map((c) => [0, 1, 2].map((k) => (scale[c] === 0 ? 0 : m[c * 4 + k]! / scale[c]!)));
    const [m00, m11, m22] = [r[0]![0]!, r[1]![1]!, r[2]![2]!];
    const trace = m00 + m11 + m22;
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      [w, x, y, z] = [0.25 * s, (r[1]![2]! - r[2]![1]!) / s, (r[2]![0]! - r[0]![2]!) / s, (r[0]![1]! - r[1]![0]!) / s];
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      [w, x, y, z] = [(r[1]![2]! - r[2]![1]!) / s, 0.25 * s, (r[1]![0]! + r[0]![1]!) / s, (r[2]![0]! + r[0]![2]!) / s];
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      [w, x, y, z] = [(r[2]![0]! - r[0]![2]!) / s, (r[1]![0]! + r[0]![1]!) / s, 0.25 * s, (r[2]![1]! + r[1]![2]!) / s];
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      [w, x, y, z] = [(r[0]![1]! - r[1]![0]!) / s, (r[2]![0]! + r[0]![2]!) / s, (r[2]![1]! + r[1]![2]!) / s, 0.25 * s];
    }
    return { translation: [m[12]!, m[13]!, m[14]!], rotation: [x, y, z, w], scale };
  },

  /** 平移、旋转（四元数 xyzw）、缩放拼成矩阵：先缩放，再旋转，再平移（Stride 的 Matrix.Transformation 的常用形式）。 */
  compose(out: Matrix4, translation: ArrayLike<number>, rotation: ArrayLike<number>, scale: ArrayLike<number>): Matrix4 {
    const [x, y, z, w] = [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!];
    const [sx, sy, sz] = [scale[0]!, scale[1]!, scale[2]!];
    out[0] = (1 - 2 * (y * y + z * z)) * sx;
    out[1] = 2 * (x * y + z * w) * sx;
    out[2] = 2 * (x * z - y * w) * sx;
    out[3] = 0;
    out[4] = 2 * (x * y - z * w) * sy;
    out[5] = (1 - 2 * (x * x + z * z)) * sy;
    out[6] = 2 * (y * z + x * w) * sy;
    out[7] = 0;
    out[8] = 2 * (x * z + y * w) * sz;
    out[9] = 2 * (y * z - x * w) * sz;
    out[10] = (1 - 2 * (x * x + y * y)) * sz;
    out[11] = 0;
    out[12] = translation[0]!;
    out[13] = translation[1]!;
    out[14] = translation[2]!;
    out[15] = 1;
    return out;
  },

  /** 用矩阵变换一个点（带平移，做透视除法）。 */
  transformPoint(m: MatrixSource, x: number, y: number, z: number): [number, number, number] {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    return [
      (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
      (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
      (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
    ];
  },
} as const;

type Vec3Tuple = [number, number, number];

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross(a: ArrayLike<number>, b: ArrayLike<number>): Vec3Tuple {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function normalize(v: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
