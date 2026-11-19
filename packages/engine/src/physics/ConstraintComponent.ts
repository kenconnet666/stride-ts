/**
 * 约束组件（Stride.BepuPhysics 的 BallSocketConstraintComponent 等）：挂在实体上的脚本，启动时用 settings 加约束，脚本移除
 * （实体销毁、场景卸载）时移除约束。每种约束一个类，名字同 Stride，同一个实体上可以挂几种不同的约束。
 * 场景里的约束组件由 ContentManager 挂上；脚本里也可以自己挂：
 *
 *   entity.add(BallSocketConstraintComponent);
 *   entity.require(BallSocketConstraintComponent).settings = { type: 'ballSocket', bodyA: a, bodyB: b, localOffsetB: [0, 2, 0] };
 */
import type { EntityId } from '../data/prop';
import type { Entity } from '../engine/Entity';
import { StartupScript } from '../engine/scripts';
import type { Constraint, ConstraintSettings, ConstraintSettingsOf } from './Simulation';

export abstract class ConstraintComponentBase<S extends ConstraintSettings = ConstraintSettings> extends StartupScript {
  #settings: S | undefined;
  #constraint: Constraint<S> | undefined;
  #started = false;

  /** 约束的设置；启动之后改也行（移除再按新设置加回去）。 */
  get settings(): S | undefined {
    return this.#settings;
  }

  set settings(value: S | undefined) {
    this.#settings = value;
    if (!this.#started) return;
    this.#constraint?.remove();
    this.#constraint = this.#add();
  }

  /** 克隆的实体带着同样的约束；连着的物体在被克隆的子树里时换成它的克隆。 */
  override cloneFrom(source: this, cloneOf: (entity: Entity) => Entity): void {
    const settings = source.#settings;
    if (!settings) return;
    const body = (entity: Entity | EntityId) => cloneOf(typeof entity === 'number' ? this.entity.manager.entity(entity) : entity);
    this.settings = { ...settings, bodyA: body(settings.bodyA), ...('bodyB' in settings ? { bodyB: body(settings.bodyB) } : {}) };
  }

  /** enabled（Stride 的 ConstraintComponentBase.Enabled）关掉时约束不起作用。 */
  protected override onEnabledChanged(): void {
    if (this.#constraint) this.#constraint.enabled = this.enabled;
  }

  /** 改一部分设置，比如马达的目标（Stride 里改约束组件的属性）。 */
  update(changes: Partial<Omit<S, 'type'>>): void {
    if (!this.#settings) return;
    this.#settings = { ...this.#settings, ...changes };
    this.#constraint?.update(changes);
  }

  override start(): void {
    this.#started = true;
    this.#constraint = this.#add();
  }

  override cancel(): void {
    this.#constraint?.remove();
    this.#constraint = undefined;
  }

  #add(): Constraint<S> | undefined {
    const simulation = this.game.simulation;
    if (!this.#settings || !simulation) return undefined;
    const constraint = simulation.addConstraint(this.#settings);
    constraint.enabled = this.enabled;
    return constraint;
  }
}

export class BallSocketConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'ballSocket'>> {}
export class HingeConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'hinge'>> {}
export class AngularAxisGearMotorConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'angularAxisGearMotor'>> {}
export class PointOnLineConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'pointOnLine'>> {}
export class LinearAxisLimitConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'linearAxisLimit'>> {}
export class SwingLimitConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'swingLimit'>> {}
export class TwistLimitConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'twistLimit'>> {}
export class WeldConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'weld'>> {}
export class DistanceLimitConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'distanceLimit'>> {}
export class BallSocketMotorConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'ballSocketMotor'>> {}
export class OneBodyLinearServoConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'oneBodyLinearServo'>> {}
export class OneBodyAngularServoConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'oneBodyAngularServo'>> {}
export class OneBodyAngularMotorConstraintComponent extends ConstraintComponentBase<ConstraintSettingsOf<'oneBodyAngularMotor'>> {}

/** 约束的种类 → 组件类（ContentManager 挂场景里的约束组件用）。 */
export const CONSTRAINT_COMPONENTS: { readonly [T in ConstraintSettings['type']]: new () => ConstraintComponentBase<ConstraintSettingsOf<T>> } = {
  ballSocket: BallSocketConstraintComponent,
  hinge: HingeConstraintComponent,
  angularAxisGearMotor: AngularAxisGearMotorConstraintComponent,
  pointOnLine: PointOnLineConstraintComponent,
  linearAxisLimit: LinearAxisLimitConstraintComponent,
  swingLimit: SwingLimitConstraintComponent,
  twistLimit: TwistLimitConstraintComponent,
  weld: WeldConstraintComponent,
  distanceLimit: DistanceLimitConstraintComponent,
  ballSocketMotor: BallSocketMotorConstraintComponent,
  oneBodyLinearServo: OneBodyLinearServoConstraintComponent,
  oneBodyAngularServo: OneBodyAngularServoConstraintComponent,
  oneBodyAngularMotor: OneBodyAngularMotorConstraintComponent,
};
