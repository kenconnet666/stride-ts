// FirstPersonShooter 的 AnimationController：手臂的四个状态——待机、走（按跑速）、开枪、换弹，开枪和换弹放完一遍回到待机或走；
// 混合栈里只压当前状态的一个剪辑（BlendTreeBuilder）。
// 和 Stride 不同（同 TPP 的移植）：没有 AnimationClipEvaluator（混合栈直接压剪辑）；时间用秒。
import { AnimationComponent, prop, SyncScript, type AnimationBlendStack, type AnimationClip, type BlendTreeBuilder, type GameTime } from '@stride-ts/engine';
import { RunSpeedEventKey } from './PlayerController';
import { IsReloading, WeaponFired } from './WeaponScript';

type AnimationState = 'idle' | 'walking' | 'shooting' | 'reloading';

export class AnimationController
  extends SyncScript.props({
    animationComponent: prop.component(() => AnimationComponent),
    animationIdle: prop.asset('animation'),
    animationWalk: prop.asset('animation'),
    animationShoot: prop.asset('animation'),
    animationReload: prop.asset('animation'),
    timeFactor: prop.number().default(1),
  })
  implements BlendTreeBuilder
{
  /** 当前剪辑里归一化的时间（0..1）。 */
  #currentTime = 0;
  #state: AnimationState = 'idle';
  #defaultState: AnimationState = 'idle';
  #currentClip!: AnimationClip;
  readonly #runSpeedEvents = this.receive(RunSpeedEventKey);
  readonly #weaponFiredEvents = this.receive(WeaponFired);
  readonly #reloadingEvents = this.receive(IsReloading);

  override start(): void {
    this.animationComponent.blendTreeBuilder = this;
    this.#currentClip = this.animationIdle;
  }

  override cancel(): void {
    if (this.animationComponent.blendTreeBuilder === this) this.animationComponent.blendTreeBuilder = undefined;
  }

  override update(time: GameTime): void {
    const runSpeed = this.#runSpeedEvents.drain().at(-1) ?? 0;
    this.#defaultState = runSpeed > 0.15 ? 'walking' : 'idle';
    const didFire = this.#weaponFiredEvents.drain().length > 0;
    const isReloading = this.#reloadingEvents.drain().length > 0;

    const duration = this.#currentClip.duration;
    const updated = this.#currentTime * duration + time.elapsed * this.timeFactor;
    const clipFinished = updated >= duration;
    this.#currentTime = duration === 0 ? 0 : (updated % duration) / duration;

    if (isReloading) this.#enter('reloading', this.animationReload);
    else if (didFire) this.#enter('shooting', this.animationShoot);
    else if (clipFinished || ((this.#state === 'idle' || this.#state === 'walking') && this.#state !== this.#defaultState)) this.#switchToDefaultState();
  }

  buildBlendTree(stack: AnimationBlendStack): void {
    stack.push(this.#currentClip, this.#currentTime * this.#currentClip.duration);
  }

  #enter(state: AnimationState, clip: AnimationClip): void {
    if (this.#state === state) return;
    this.#currentTime = 0;
    this.#state = state;
    this.#currentClip = clip;
  }

  #switchToDefaultState(): void {
    if (this.#state !== this.#defaultState) this.#currentTime = 0;
    this.#state = this.#defaultState;
    this.#currentClip = this.#state === 'idle' ? this.animationIdle : this.animationWalk;
  }
}
