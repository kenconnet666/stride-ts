/**
 * 按动画状态机（`.animgraph.json`）放动画的脚本（照 Unity 的 Animator）：挂在有 AnimationComponent 的实体上，接管它的混合树
 * （blendTreeBuilder）；游戏代码只设参数：
 *
 *   const animator = entity.require(Animator);
 *   animator.set('speed', run);
 *   animator.set('grounded', onGround);
 *   animator.trigger('jump');
 *
 * 写了 speedParameter 时它每帧自己设成实体在水平面上的速度（米每秒，按世界位置的变化算）：人群里的行人、沿路走的东西不用写代码，
 * 状态机按速度在站、走、跑之间混。
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import type { GameTime } from '../engine/GameTime';
import { AnimationComponent } from './AnimationComponent';
import { AnimationGraphInstance } from './AnimationGraph';
import { Transform } from '../engine/transform';

export class Animator extends SyncScript.props('Animator', {
  /** 状态机。 */
  graph: prop.asset('animationGraph'),
  /** 放动画的组件；没有时用同一个实体上的。 */
  animation: prop.component(() => AnimationComponent).optional(),
  /** 时间倍数。 */
  timeFactor: prop.number().min(0).default(1),
  /** 每帧设成实体水平速度（米每秒）的数值参数；空的不设。 */
  speedParameter: prop.string().default(''),
}) {
  #instance: AnimationGraphInstance | undefined;
  /** 上一帧的世界位置（x、z），量速度用；第一帧没有。 */
  #last: [number, number] | undefined;

  /** 状态机的实例（start 以后才有）：参数、现在的状态。 */
  get instance(): AnimationGraphInstance {
    if (!this.#instance) throw new Error(`Animator on '${this.entity.name}' has not started yet`);
    return this.#instance;
  }

  /** 现在的状态名。 */
  get state(): string {
    return this.instance.state;
  }

  set(name: string, value: number | boolean): void {
    this.instance.set(name, value);
  }

  trigger(name: string): void {
    this.instance.trigger(name);
  }

  override start(): void {
    this.#instance = new AnimationGraphInstance(this.graph);
    this.#component().blendTreeBuilder = this.#instance;
  }

  override update(time: GameTime): void {
    if (!this.#instance) return;
    if (this.speedParameter) this.#instance.set(this.speedParameter, this.#horizontalSpeed(time.elapsed));
    this.#instance.update(time.elapsed * this.timeFactor);
  }

  #horizontalSpeed(elapsed: number): number {
    const world = this.entity.get(Transform)?.world;
    if (!world || elapsed <= 0) return 0;
    const x = world[12]!, z = world[14]!;
    const last = this.#last;
    this.#last = [x, z];
    return last ? Math.hypot(x - last[0], z - last[1]) / elapsed : 0;
  }

  override cancel(): void {
    const component = this.animation ?? this.entity.get(AnimationComponent);
    if (component && component.blendTreeBuilder === this.#instance) component.blendTreeBuilder = undefined;
  }

  #component(): AnimationComponent {
    const component = this.animation ?? this.entity.get(AnimationComponent);
    if (!component) throw new Error(`Animator on '${this.entity.name}': the entity has no AnimationComponent (or set animation)`);
    return component;
  }
}
