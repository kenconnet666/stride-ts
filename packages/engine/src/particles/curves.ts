/**
 * 粒子用的曲线（Stride 的 ComputeCurveSampler 加 ComputeAnimationCurve）：关键帧按 Key 排序，相邻两帧之间按左边那帧的切线
 * 类型插值（Linear 线性，其余停在左边的值），再烘焙成 32 个均匀的采样点，求值时在采样点之间线性插值（同 Stride，所以关键帧
 * 之间的拐角会被削平一点）。值是 Float、Vector2/3/4、Color4（都按分量线性）或 Quaternion（归一化的线性插值）。
 */
import type { ParticleModuleFile } from '../content/format';

const BAKED = 32;

type Kind = 'float' | 'vector' | 'quaternion';

interface KeyFrame {
  readonly key: number;
  readonly value: readonly number[];
  readonly linear: boolean;
}

/** 曲线采样器：t 一般是走过的寿命（0 到 1）。 */
export class CurveSampler {
  readonly #baked: number[][];
  readonly #kind: Kind;

  constructor(file: ParticleModuleFile) {
    const type = String(file.$type ?? '');
    this.#kind = type.endsWith('Float') ? 'float' : type.endsWith('Quaternion') ? 'quaternion' : 'vector';
    const curve = file['curve'] as ParticleModuleFile | null | undefined;
    const frames = ((curve?.['keyFrames'] as readonly ParticleModuleFile[] | undefined) ?? [])
      .map((frame): KeyFrame => {
        const value = frame['value'];
        return {
          key: Number(frame['key'] ?? 0),
          value: typeof value === 'number' ? [value] : [...((value as readonly number[] | undefined) ?? [0])],
          linear: (frame['tangentType'] ?? 'linear') === 'linear',
        };
      })
      .sort((a, b) => a.key - b.key);
    // 分量数按类型（没有关键帧的曲线也要对，VFXPackage 的受击拖尾的 ColorOverTime 主曲线是空的，Stride 求出来是 0）
    const size = this.#kind === 'float' ? 1 : this.#kind === 'quaternion' || /(Color4|Vector4)$/.test(type) ? 4 : type.endsWith('Vector3') ? 3 : type.endsWith('Vector2') ? 2 : (frames[0]?.value.length ?? 4);
    this.#baked = Array.from({ length: BAKED }, (_, i) => sampleRaw(frames, i / (BAKED - 1), size, this.#kind));
  }

  /** 求值（Stride 的 Evaluate）：在烘焙的采样点之间线性插值。 */
  evaluate(t: number): number[] {
    const location = t * (BAKED - 1);
    const index = Math.trunc(location);
    const lerp = location - index;
    const a = this.#baked[Math.max(index, 0)] ?? this.#baked[0]!;
    const b = this.#baked[Math.min(index + 1, BAKED - 1)] ?? this.#baked[BAKED - 1]!;
    return interpolate(a, b, lerp, this.#kind);
  }

  /** 烘焙好的 32 个均匀采样点（t = i / 31），每个是一组分量（GPU 的粒子打包给着色器）。 */
  get samples(): readonly (readonly number[])[] {
    return this.#baked;
  }

  /** 是不是四元数曲线（按归一化的线性插值求值）。 */
  get isQuaternion(): boolean {
    return this.#kind === 'quaternion';
  }

  /** 标量曲线的值。 */
  evaluateFloat(t: number): number {
    return this.evaluate(t)[0]!;
  }
}

/** 文件里的采样器（可能没有）。 */
export function curveSampler(file: ParticleModuleFile | null | undefined): CurveSampler | undefined {
  return file && typeof file.$type === 'string' && file.$type.startsWith('computeCurveSampler') ? new CurveSampler(file) : undefined;
}

/** Stride 的 ComputeAnimationCurve.SampleRaw：找 t 左边的关键帧，Linear 时和右边的插值。 */
function sampleRaw(frames: readonly KeyFrame[], t: number, size: number, kind: Kind): number[] {
  if (frames.length === 0) return kind === 'quaternion' ? [0, 0, 0, 1] : new Array<number>(size).fill(0);
  let left = 0;
  while (left < frames.length - 1 && frames[left + 1]!.key <= t) left++;
  const leftFrame = frames[left]!;
  if (left >= frames.length - 1 || leftFrame.key >= t) return [...leftFrame.value];
  const rightFrame = frames[left + 1]!;
  if (leftFrame.key >= rightFrame.key || !leftFrame.linear) return [...leftFrame.value];
  return interpolate(leftFrame.value, rightFrame.value, (t - leftFrame.key) / (rightFrame.key - leftFrame.key), kind);
}

function interpolate(a: readonly number[], b: readonly number[], t: number, kind: Kind): number[] {
  if (kind !== 'quaternion') return a.map((value, i) => value + ((b[i] ?? value) - value) * t);
  // Stride 的 Quaternion.Lerp：走短的那边，再归一化
  const sign = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]! < 0 ? -1 : 1;
  const q = a.map((value, i) => value * (1 - t) + b[i]! * t * sign);
  const length = Math.hypot(...q) || 1;
  return q.map((value) => value / length);
}
