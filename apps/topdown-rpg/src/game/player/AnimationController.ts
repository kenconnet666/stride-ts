// TopDownRPG 的 AnimationController：按 PlayerController 广播的跑速和出拳，在走（含待机和跑）和出拳两个状态之间切换，自己搭
// 混合栈（BlendTreeBuilder）：走的状态按跑速在待机和走、或走和跑两个剪辑之间插值，时间按插值出的时长归一化；出拳放一遍再回到走。
// 和 Stride 不同（同 TPP 的移植）：没有 AnimationClipEvaluator（混合栈直接压剪辑）；时间用秒；某一帧没收到跑速时保留上一个值。
import { AnimationComponent, prop, SyncScript, type AnimationBlendStack, type AnimationClip, type BlendTreeBuilder, type GameTime } from '@stride-ts/engine';
import { IsAttackingEventKey, RunSpeedEventKey } from './PlayerController';

type AnimationState = 'walking' | 'punching';

export class AnimationController
  extends SyncScript.props({
    animationComponent: prop.component(() => AnimationComponent),
    animationIdle: prop.asset('animation'),
    animationWalk: prop.asset('animation'),
    animationRun: prop.asset('animation'),
    animationPunch: prop.asset('animation'),
    /** 跑速（0..1）低于它时在待机和走之间插值，高于它时在走和跑之间插值。 */
    walkThreshold: prop.number().min(0).max(1).default(0.25),
    timeFactor: prop.number().default(1),
  })
  implements BlendTreeBuilder
{
  /** 当前状态里归一化的时间（0..1）。 */
  #currentTime = 0;
  #state: AnimationState = 'walking';
  #runSpeed = 0;
  #walkLerp1!: AnimationClip;
  #walkLerp2!: AnimationClip;
  #walkLerpFactor = 0;
  readonly #runSpeedEvents = this.receive(RunSpeedEventKey);
  readonly #attackEvents = this.receive(IsAttackingEventKey);

  override start(): void {
    this.animationComponent.blendTreeBuilder = this;
    this.#walkLerp1 = this.animationIdle;
    this.#walkLerp2 = this.animationWalk;
  }

  override cancel(): void {
    if (this.animationComponent.blendTreeBuilder === this) this.animationComponent.blendTreeBuilder = undefined;
  }

  override update(time: GameTime): void {
    this.#runSpeed = this.#runSpeedEvents.drain().at(-1) ?? this.#runSpeed;
    if (this.#attackEvents.drain().includes(true) && this.#state !== 'punching') {
      this.#currentTime = 0;
      this.#state = 'punching';
    }
    const elapsed = time.elapsed * this.timeFactor;
    if (this.#state === 'walking') this.#updateWalking(elapsed);
    else this.#updatePunching(elapsed);
  }

  buildBlendTree(stack: AnimationBlendStack): void {
    const t = this.#currentTime;
    if (this.#state === 'walking') {
      stack.push(this.#walkLerp1, t * this.#walkLerp1.duration).push(this.#walkLerp2, t * this.#walkLerp2.duration).blend(this.#walkLerpFactor);
    } else {
      stack.push(this.animationPunch, t * this.animationPunch.duration);
    }
  }

  #updateWalking(elapsed: number): void {
    if (this.#runSpeed < this.walkThreshold) {
      // 待机和走直接插值不好看，系数往走那边偏
      this.#walkLerpFactor = Math.sqrt(this.#runSpeed / this.walkThreshold);
      this.#walkLerp1 = this.animationIdle;
      this.#walkLerp2 = this.animationWalk;
    } else {
      this.#walkLerpFactor = (this.#runSpeed - this.walkThreshold) / (1 - this.walkThreshold);
      this.#walkLerp1 = this.animationWalk;
      this.#walkLerp2 = this.animationRun;
    }
    const duration = this.#walkLerp1.duration + (this.#walkLerp2.duration - this.#walkLerp1.duration) * this.#walkLerpFactor;
    this.#currentTime = duration === 0 ? 0 : ((this.#currentTime * duration + elapsed) % duration) / duration;
  }

  #updatePunching(elapsed: number): void {
    const duration = this.animationPunch.duration;
    const time = this.#currentTime * duration + elapsed;
    if (time < duration) {
      this.#currentTime = time / duration;
      return;
    }
    this.#state = 'walking';
    this.#currentTime = 0;
    this.#updateWalking(elapsed);
  }
}
