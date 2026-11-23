/**
 * IK 脚本（FootIk、LookAt）共用的骨架几何：按结构找腿、模型空间的方向换到关节的本地空间、世界坐标换到模型空间。
 * 矩阵都是列主序 4x4（AnimationInstance.modelMatrices）。
 */
import type { Skeleton } from './resources';

type Vec3 = [number, number, number];

/** 第 joint 个关节在模型空间的位置。 */
export function jointPosition(matrices: ArrayLike<number>, joint: number): Vec3 {
  return [matrices[joint * 16 + 12]!, matrices[joint * 16 + 13]!, matrices[joint * 16 + 14]!];
}

/** 模型空间的方向换到关节的本地空间（关节矩阵的旋转部分的转置；有缩放时归一）。 */
export function toJointLocal(matrices: ArrayLike<number>, joint: number, direction: readonly number[]): Vec3 {
  const o = joint * 16;
  const local: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const x = matrices[o + axis * 4]!, y = matrices[o + axis * 4 + 1]!, z = matrices[o + axis * 4 + 2]!;
    const length = Math.hypot(x, y, z) || 1;
    local[axis] = (x * direction[0]! + y * direction[1]! + z * direction[2]!) / length;
  }
  return normalize(local);
}

/** 世界位置换到模型空间：模型到世界的矩阵（双精度，列主序）求逆作用到点上（只处理旋转、平移、缩放）。 */
export function worldToModel(modelToWorld: ArrayLike<number>, point: readonly number[]): Vec3 {
  const d = [point[0]! - modelToWorld[12]!, point[1]! - modelToWorld[13]!, point[2]! - modelToWorld[14]!];
  const out: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const x = modelToWorld[axis * 4]!, y = modelToWorld[axis * 4 + 1]!, z = modelToWorld[axis * 4 + 2]!;
    const length2 = x * x + y * y + z * z || 1;
    out[axis] = (x * d[0]! + y * d[1]! + z * d[2]!) / length2;
  }
  return out;
}

/** 一条腿：大腿根、膝、脚踝的关节下标，膝的转轴（膝本地，正方向是把腿伸直，同 ozz 的 mid_axis）。 */
export interface Leg {
  readonly thigh: number;
  readonly knee: number;
  readonly foot: number;
  readonly midAxis: Vec3;
}

/**
 * 按骨架的结构找两条腿：模型空间里左右（x 正负）各取最低的关节（名字带 platform、ik、target 的辅助骨不算），往上找到第一个和
 * 父关节离得远（超过 longBone 米）的关节当脚踝，它的父、祖父是膝和大腿根；两条大腿根最近的共同祖先是髋。膝的转轴按现在的
 * 姿势算（腿弯着时是两段骨叉乘的反方向；伸直时用模型的 x 轴）。找不到时是 undefined。
 */
export function findLegs(skeleton: Skeleton, matrices: ArrayLike<number>, longBone = 0.25): { legs: [Leg, Leg]; hips: number } | undefined {
  const helper = /platform|ik|target/i;
  const sides = [-1, 1].map((side) => {
    let lowest = -1;
    skeleton.joints.forEach((joint, j) => {
      if (helper.test(joint.name) || Math.sign(matrices[j * 16 + 12]!) !== side) return;
      if (lowest < 0 || matrices[j * 16 + 13]! < matrices[lowest * 16 + 13]!) lowest = j;
    });
    if (lowest < 0) return undefined;
    let foot = lowest;
    while (foot >= 0) {
      const parent = skeleton.joints[foot]!.parent;
      if (parent < 0) return undefined;
      if (distance(jointPosition(matrices, foot), jointPosition(matrices, parent)) > longBone) break;
      foot = parent;
    }
    const knee = skeleton.joints[foot]!.parent, thigh = knee >= 0 ? skeleton.joints[knee]!.parent : -1;
    if (knee < 0 || thigh < 0) return undefined;
    return { thigh, knee, foot, midAxis: kneeAxis(matrices, thigh, knee, foot) };
  });
  if (!sides[0] || !sides[1]) return undefined;
  const ancestors = (joint: number) => {
    const chain: number[] = [];
    for (let j = joint; j >= 0; j = skeleton.joints[j]!.parent) chain.push(j);
    return chain;
  };
  const right = new Set(ancestors(sides[1].thigh));
  const hips = ancestors(sides[0].thigh).find((j) => right.has(j) && j !== sides[0]!.thigh) ?? 0;
  return { legs: [sides[0], sides[1]], hips };
}

/** 膝往哪边弯（模型空间）：膝离大腿根到脚踝那条线的方向；腿伸直时用模型的 +z。 */
export function kneePole(matrices: ArrayLike<number>, leg: Leg): Vec3 {
  const a = jointPosition(matrices, leg.thigh), b = jointPosition(matrices, leg.knee), c = jointPosition(matrices, leg.foot);
  const line = sub(c, a), toKnee = sub(b, a);
  const length2 = line[0] * line[0] + line[1] * line[1] + line[2] * line[2] || 1;
  const t = (toKnee[0] * line[0] + toKnee[1] * line[1] + toKnee[2] * line[2]) / length2;
  const away: Vec3 = [toKnee[0] - line[0] * t, toKnee[1] - line[1] * t, toKnee[2] - line[2] * t];
  return Math.hypot(...away) > 0.01 ? normalize(away) : [0, 0, 1];
}

function kneeAxis(matrices: ArrayLike<number>, thigh: number, knee: number, foot: number): Vec3 {
  const a = jointPosition(matrices, thigh), b = jointPosition(matrices, knee), c = jointPosition(matrices, foot);
  const upper = sub(b, a), lower = sub(c, b);
  const cross: Vec3 = [upper[1] * lower[2] - upper[2] * lower[1], upper[2] * lower[0] - upper[0] * lower[2], upper[0] * lower[1] - upper[1] * lower[0]];
  // 弯着时：绕两段骨叉乘的方向转是再弯，伸直是反方向
  const model: Vec3 = Math.hypot(...cross) > 0.02 * Math.hypot(...upper) * Math.hypot(...lower) ? [-cross[0], -cross[1], -cross[2]] : [-1, 0, 0];
  return toJointLocal(matrices, knee, model);
}

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(...v) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}
