// Third Person Platformer 的 AnimationController：按 PlayerController 广播的跑速和是否着地，在走（含待机和跑）、起跳、空中、
// 落地四个状态之间切换，并且自己搭混合栈（BlendTreeBuilder）：走的状态按跑速在待机和走、或走和跑两个剪辑之间插值，
// 时间按两个剪辑插值出的时长归一化，所以步子不会错开。
// 和 Stride 不同：没有 AnimationClipEvaluator（混合栈直接压剪辑）；时间用秒；某一帧没收到事件时保留上一个值
// （Stride 的 TryReceive 失败时读到默认值；PlayerController 每帧都广播，结果一样）。
import { AnimationComponent, prop, SyncScript, type AnimationBlendStack, type AnimationClip, type BlendTreeBuilder, type GameTime } from '@stride-ts/engine';
import { IsGroundedEventKey, RunSpeedEventKey } from './PlayerController';

type AnimationState = 'walking' | 'jumping' | 'airborne' | 'landing';

export class AnimationController
  extends SyncScript.props({
    animationComponent: prop.component(() => AnimationComponent),
    animationIdle: prop.asset('animation'),
    animationWalk: prop.asset('animation'),
    animationRun: prop.asset('animation'),
    /** 起跳。 */
    animationJumpStart: prop.asset('animation'),
    /** 空中（循环）。 */
    animationJumpMid: prop.asset('animation'),
    /** 落地。 */
    animationJumpEnd: prop.asset('animation'),
    /** 跑速（0..1）低于它时在待机和走之间插值，高于它时在走和跑之间插值。 */
    walkThreshold: prop.number().min(0).max(1).default(0.25),
    timeFactor: prop.number().default(1),
  })
  implements BlendTreeBuilder
{
  /** 当前状态里归一化的时间（0..1）。 */
  #currentTime = 0;
  #state: AnimationState = 'airborne';
  #isGrounded = false;
  #runSpeed = 0;
  // 走的状态：在这两个剪辑之间按 #walkLerpFactor 插值
  #walkLerp1!: AnimationClip;
  #walkLerp2!: AnimationClip;
  #walkLerpFactor = 0;
  readonly #runSpeedEvents = this.receive(RunSpeedEventKey);
  readonly #isGroundedEvents = this.receive(IsGroundedEventKey);

  override start(): void {
    // 设了自己的混合树，动画系统每帧改为调用 buildBlendTree
    this.animationComponent.blendTreeBuilder = this;
    this.#walkLerp1 = this.animationIdle;
    this.#walkLerp2 = this.animationWalk;
  }

  override cancel(): void {
    if (this.animationComponent.blendTreeBuilder === this) this.animationComponent.blendTreeBuilder = undefined;
  }

  override update(time: GameTime): void {
    this.#runSpeed = this.#runSpeedEvents.drain().at(-1) ?? this.#runSpeed;
    const grounded = this.#isGroundedEvents.drain().at(-1) ?? this.#isGrounded;
    if (grounded !== this.#isGrounded) {
      this.#currentTime = 0;
      this.#isGrounded = grounded;
      this.#state = grounded ? 'landing' : 'jumping';
    }
    const elapsed = time.elapsed * this.timeFactor;
    switch (this.#state) {
      case 'walking':
        this.#updateWalking(elapsed);
        break;
      case 'jumping':
        this.#updateJumping(elapsed);
        break;
      case 'airborne':
        this.#updateAirborne(elapsed);
        break;
      case 'landing':
        this.#updateLanding(elapsed);
        break;
    }
  }

  buildBlendTree(stack: AnimationBlendStack): void {
    const t = this.#currentTime;
    switch (this.#state) {
      case 'walking':
        stack.push(this.#walkLerp1, t * this.#walkLerp1.duration).push(this.#walkLerp2, t * this.#walkLerp2.duration).blend(this.#walkLerpFactor);
        break;
      case 'jumping':
        stack.push(this.animationJumpStart, t * this.animationJumpStart.duration);
        break;
      case 'airborne':
        stack.push(this.animationJumpMid, t * this.animationJumpMid.duration);
        break;
      case 'landing':
        stack.push(this.animationJumpEnd, t * this.animationJumpEnd.duration);
        break;
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
    // 两个剪辑时长不同：按插值出的时长推进，保持归一化的时间
    const duration = this.#walkLerp1.duration + (this.#walkLerp2.duration - this.#walkLerp1.duration) * this.#walkLerpFactor;
    this.#currentTime = duration === 0 ? 0 : ((this.#currentTime * duration + elapsed) % duration) / duration;
  }

  #updateJumping(elapsed: number): void {
    const duration = this.animationJumpStart.duration;
    const time = this.#currentTime * duration + elapsed;
    if (time < duration) {
      this.#currentTime = time / duration;
      return;
    }
    this.#state = 'airborne';
    this.#currentTime = 0;
    this.#updateAirborne(elapsed);
  }

  #updateAirborne(elapsed: number): void {
    const duration = this.animationJumpMid.duration;
    this.#currentTime = ((this.#currentTime * duration + elapsed) % duration) / duration;
  }

  #updateLanding(elapsed: number): void {
    const duration = this.animationJumpEnd.duration;
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
