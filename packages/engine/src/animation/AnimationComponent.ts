/**
 * 动画组件（Stride 的 AnimationComponent）：按名字登记剪辑，播放、淡入淡出、叠加。和带骨架的模型放在同一个实体上；
 * 动画系统（AnimationSystem，对应 Stride 的 AnimationProcessor）每帧推进正在播放的动画、把它们合成一个姿势。
 * 设了 blendTreeBuilder 时改由它每帧给出混合栈（Stride 的 IBlendTreeBuilder），正在播放的列表就不再推进。
 *
 *   const animation = entity.require(AnimationComponent);
 *   animation.play('Idle');
 *   animation.crossfade('Run', 0.2);
 *   await animation.ended(animation.add(punch, { repeatMode: 'playOnce' }));
 *
 * 和 Stride 不同：时间用秒（Stride 是 TimeSpan）；没有 AnimationClipEvaluator，混合栈直接压剪辑（ozz 的轨道已经按骨架的
 * 关节排好，不需要每个剪辑一份通道映射）；正在播放的列表只读，增删走 play、add、stop 这些方法（Stride 的
 * TrackingCollection 在移除时完成 Ended 的任务，这里由方法做）。
 */
import type { AnimationRepeatMode } from '../content/format';
import { ScriptComponent } from '../engine/scripts';
import type { AnimationClip } from './resources';

/** 和下面的动画怎么合成（Stride 的 AnimationBlendOperation）。 */
export type AnimationBlendOperation = 'linearBlend' | 'add';

/** 混合栈（Stride 的 List<AnimationOperation>）：后缀表达式，push 压入剪辑在某个时刻的姿势，其余的合并栈顶两个。 */
export interface AnimationBlendStack {
  /** 压入 clip 在 time 秒处的姿势（截到 [0, 时长]）。 */
  push(clip: AnimationClip, time: number): this;
  /** 弹出 a、b，压入 lerp(a, b, factor)（Stride 的 CoreAnimationOperation.Blend）。 */
  blend(factor: number): this;
  /** 弹出 a、b，压入从 a 往 a + b 插值 factor 的结果（b 是叠加动画）。 */
  add(factor: number): this;
  /** 弹出 a、b，压入从 a 往 a − b 插值 factor 的结果。 */
  subtract(factor: number): this;
}

/** 自己搭混合栈（Stride 的 IBlendTreeBuilder），动画系统每帧调用。 */
export interface BlendTreeBuilder {
  buildBlendTree(stack: AnimationBlendStack): void;
}

/** 正在播放的一个动画（Stride 的 PlayingAnimation）。 */
export class PlayingAnimation {
  /** 停用的不推进时间，但仍按权重参与合成（同 Stride）。 */
  enabled = true;
  readonly name: string;
  readonly clip: AnimationClip;
  repeatMode: AnimationRepeatMode;
  blendOperation: AnimationBlendOperation = 'linearBlend';
  /** 秒。 */
  currentTime = 0;
  timeFactor = 1;
  weight = 1;
  weightTarget = 0;
  /** 淡入淡出还剩的秒数；大于 0 时权重每帧向 weightTarget 靠。 */
  crossfadeRemainingTime = 0;
  /** @internal ended() 等待的结果；动画从列表移除时完成。 */
  endedResolve: (() => void) | undefined;
  /** @internal */
  endedPromise: Promise<void> | undefined;

  constructor(name: string, clip: AnimationClip) {
    this.name = name;
    this.clip = clip;
    this.repeatMode = clip.repeatMode;
  }
}

/** add() 的选项（Stride 的 Add 的可选参数）。 */
export interface AddAnimationOptions {
  /** 起始时刻，秒。 */
  readonly startTime?: number;
  readonly blend?: AnimationBlendOperation;
  readonly timeScale?: number;
  readonly weight?: number;
  /** 默认是剪辑自己的。 */
  readonly repeatMode?: AnimationRepeatMode;
}

export class AnimationComponent extends ScriptComponent {
  /** 按名字的剪辑；场景里的 AnimationComponent.Animations 导入到这里。 */
  readonly animations = new Map<string, AnimationClip>();
  /** 设了以后由它搭混合栈，见 BlendTreeBuilder。 */
  blendTreeBuilder: BlendTreeBuilder | undefined;
  readonly #playing: PlayingAnimation[] = [];

  /** 正在播放的动画，按合成的顺序（后面的叠在前面的上面）。 */
  get playingAnimations(): readonly PlayingAnimation[] {
    return this.#playing;
  }

  /** 停掉其他动画，从头播放 name。 */
  play(name: string): PlayingAnimation {
    this.stopAll();
    const playing = new PlayingAnimation(name, this.#clip(name));
    this.#playing.push(playing);
    return playing;
  }

  isPlaying(name: string): boolean {
    return this.#playing.some((playing) => playing.name === name);
  }

  /** 叠加播放一个剪辑（可以不在 animations 里）。 */
  add(clip: AnimationClip, { startTime = 0, blend = 'linearBlend', timeScale = 1, weight = 1, repeatMode }: AddAnimationOptions = {}): PlayingAnimation {
    const playing = new PlayingAnimation('', clip);
    playing.currentTime = startTime;
    playing.blendOperation = blend;
    playing.timeFactor = timeScale;
    playing.weight = weight;
    if (repeatMode) playing.repeatMode = repeatMode;
    this.#playing.push(playing);
    return playing;
  }

  /** 其他动画在 fadeSeconds 内淡出（淡完移除），name 同时淡入。 */
  crossfade(name: string, fadeSeconds: number): PlayingAnimation {
    this.#clip(name);
    for (const playing of this.#playing) {
      playing.weightTarget = 0;
      playing.crossfadeRemainingTime = fadeSeconds;
    }
    return this.blend(name, 1, fadeSeconds);
  }

  /** 从头加一个 name，权重在 fadeSeconds 内从 0 升到 weight（fadeSeconds 是 0 时直接是 weight）。 */
  blend(name: string, weight: number, fadeSeconds: number): PlayingAnimation {
    const playing = new PlayingAnimation(name, this.#clip(name));
    playing.weight = 0;
    if (fadeSeconds > 0) {
      playing.weightTarget = weight;
      playing.crossfadeRemainingTime = fadeSeconds;
    } else {
      playing.weight = weight;
    }
    this.#playing.push(playing);
    return playing;
  }

  stop(animation: PlayingAnimation): void {
    const index = this.#playing.indexOf(animation);
    if (index >= 0) this.#removeAt(index);
  }

  stopAll(): void {
    while (this.#playing.length > 0) this.#removeAt(this.#playing.length - 1);
  }

  /** 动画从列表里移除时（播完、淡出完或被停掉）完成。 */
  ended(animation: PlayingAnimation): Promise<void> {
    if (!this.#playing.includes(animation)) throw new Error(`animation '${animation.name || animation.clip.name}' is not playing`);
    if (!animation.endedPromise) animation.endedPromise = new Promise((resolve) => (animation.endedResolve = resolve));
    return animation.endedPromise;
  }

  override cancel(): void {
    this.stopAll();
  }

  /**
   * @internal 没有 blendTreeBuilder 时动画系统每帧调用（Stride 的 AnimationProcessor）：推进时间，
   * 把权重不是 0 的动画压进混合栈，返回压了几个。
   */
  advanceAndBuild(elapsed: number, stack: AnimationBlendStack): number {
    for (const playing of this.#playing) {
      if (playing.enabled) playing.currentTime = advanceTime(playing, elapsed);
    }
    let pushed = 0;
    let totalWeight = 0;
    for (const playing of this.#playing) {
      const weight = playing.weight;
      if (weight === 0) continue;
      // 线性混合按累计权重分配（多个动画按权重平均）；叠加直接用自己的权重，并把累计权重重置成它
      totalWeight += weight;
      let factor = weight / totalWeight;
      if (playing.blendOperation === 'add') factor = totalWeight = weight;
      stack.push(playing.clip, playing.currentTime);
      if (++pushed >= 2) {
        if (playing.blendOperation === 'add') stack.add(factor);
        else stack.blend(factor);
      }
    }
    return pushed;
  }

  /** @internal 合成之后：淡入淡出的权重往目标靠，淡出完的和播完的（playOnce）移除。 */
  updateWeights(elapsed: number): void {
    for (let i = 0; i < this.#playing.length; i++) {
      const playing = this.#playing[i]!;
      let remove = false;
      if (playing.crossfadeRemainingTime > 0) {
        playing.weight += (playing.weightTarget - playing.weight) * Math.min(1, elapsed / playing.crossfadeRemainingTime);
        playing.crossfadeRemainingTime -= elapsed;
        if (playing.crossfadeRemainingTime <= 0) {
          playing.weight = playing.weightTarget;
          remove = playing.weight <= 0;
        }
      }
      if (playing.repeatMode === 'playOnce') {
        const duration = playing.clip.duration;
        if ((playing.timeFactor > 0 && playing.currentTime === duration) || (playing.timeFactor < 0 && playing.currentTime === 0)) remove = true;
      }
      if (remove) this.#removeAt(i--);
    }
  }

  #clip(name: string): AnimationClip {
    const clip = this.animations.get(name);
    if (!clip) throw new Error(`AnimationComponent has no animation named '${name}' (it has: ${[...this.animations.keys()].join(', ') || 'none'})`);
    return clip;
  }

  #removeAt(index: number): void {
    const [removed] = this.#playing.splice(index, 1);
    removed?.endedResolve?.();
  }
}

/** 按重复方式推进一个动画的时间（Stride 的 AnimationProcessor 里那段 switch）。 */
function advanceTime(playing: PlayingAnimation, elapsed: number): number {
  const duration = playing.clip.duration;
  const time = playing.currentTime + elapsed * playing.timeFactor;
  if (playing.repeatMode !== 'loopInfinite') return Math.min(Math.max(time, 0), duration);
  if (duration === 0) return 0;
  return ((time % duration) + duration) % duration;
}
