/**
 * 动画的资源：骨架（Stride 的 Skeleton）和动画剪辑（Stride 的 AnimationClip）。数据在 stride-native 里（ozz 的骨架和
 * 动画），这里记着关节名、时长、重复方式和原生对象。内容管理加载 `.skeleton`、`.anim` 时创建它们。
 */
import type { Animation as NativeAnimation, Skeleton as NativeSkeleton, StrideNative } from '@stride-ts/native';
import type { AnimationRepeatMode, MorphWeightCurve } from '../content/format';

/** 内容管理加载骨架、动画和蒙皮要用的原生功能（Game 启动时交给 ContentManager，测试里可以换成假的）。 */
export type AnimationNative = Pick<StrideNative, 'loadSkeleton' | 'loadAnimation' | 'createSkin'>;

export class Skeleton {
  /** 内容路径。 */
  readonly name: string;
  /** 关节（深度优先，父关节在前；根的 parent 是 -1）。 */
  readonly joints: readonly { readonly name: string; readonly parent: number }[];
  readonly native: NativeSkeleton;
  readonly #indexOf: ReadonlyMap<string, number>;

  constructor(name: string, joints: readonly { readonly name: string; readonly parent: number }[], native: NativeSkeleton) {
    if (native.jointCount !== joints.length) throw new Error(`skeleton '${name}': ${joints.length} joints listed, the archive has ${native.jointCount}`);
    this.name = name;
    this.joints = joints;
    this.native = native;
    this.#indexOf = new Map(joints.map((joint, i) => [joint.name, i]));
  }

  /** 关节的下标；没有这个名字时是 -1。 */
  jointIndex(name: string): number {
    return this.#indexOf.get(name) ?? -1;
  }
}

/** 动画剪辑：骨架的轨道（按关节顺序，在原生侧）和形变权重的曲线；只动形变权重的剪辑没有骨架。 */
export class AnimationClip {
  /** 内容路径。 */
  readonly name: string;
  /** 秒。 */
  readonly duration: number;
  readonly repeatMode: AnimationRepeatMode;
  /** 骨架和它的轨道；只动形变权重的剪辑没有。 */
  readonly bones: { readonly skeleton: Skeleton; readonly native: NativeAnimation } | undefined;
  readonly morphWeights: readonly MorphWeightCurve[];

  constructor(name: string, duration: number, repeatMode: AnimationRepeatMode, bones: AnimationClip['bones'], morphWeights: readonly MorphWeightCurve[] = []) {
    this.name = name;
    this.duration = duration;
    this.repeatMode = repeatMode;
    this.bones = bones;
    this.morphWeights = morphWeights;
  }
}
