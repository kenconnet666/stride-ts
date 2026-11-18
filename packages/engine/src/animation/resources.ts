/**
 * 动画的资源：骨架（Stride 的 Skeleton）和动画剪辑（Stride 的 AnimationClip）。数据在 stride-native 里（ozz 的骨架和
 * 动画），这里记着关节名、时长、重复方式和原生对象。内容管理加载 `.skeleton`、`.anim` 时创建它们。
 */
import type { Animation as NativeAnimation, Skeleton as NativeSkeleton, StrideNative } from '@stride-ts/native';
import type { AnimationRepeatMode } from '../content/format';

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

/** 动画剪辑：轨道按骨架的关节顺序。 */
export class AnimationClip {
  /** 内容路径。 */
  readonly name: string;
  /** 秒。 */
  readonly duration: number;
  readonly repeatMode: AnimationRepeatMode;
  readonly skeleton: Skeleton;
  readonly native: NativeAnimation;

  constructor(name: string, repeatMode: AnimationRepeatMode, skeleton: Skeleton, native: NativeAnimation) {
    this.name = name;
    this.duration = native.duration;
    this.repeatMode = repeatMode;
    this.skeleton = skeleton;
    this.native = native;
  }
}
