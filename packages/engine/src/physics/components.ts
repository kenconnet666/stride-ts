/**
 * 物理的数据组件，和 Transform 一起用（对应 Stride.BepuPhysics 的 StaticComponent、CharacterComponent），默认值同 Stride。
 * collider 存 Collider.id。物体在实体出现后的第一次仿真更新时建好，位姿取那时的世界位姿。
 *
 *   entities.create({ components: [Transform, Static.with({ collider: new Collider([{ type: 'box', size: [10, 1, 10] }]).id })] });
 *
 * 角色的移动照 Stride：脚本写 moveX、moveY（MoveVector，乘 speed 是目标速度，在角色的基里：x 向右、y 向前）和
 * jump（TryJump，只在站稳时生效），仿真更新后读 grounded（IsGrounded）。
 */
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { ColliderId } from './Collider';

/** 静止的碰撞物体（Stride 的 StaticComponent）。 */
export const Static = component('Static', {
  collider: prop.u32().brand<'ColliderId'>().default(0 as ColliderId),
  /** CollisionLayer，0..31。 */
  layer: prop.int().default(0).min(0).max(31),
  /** FrictionCoefficient。 */
  friction: prop.f32().default(1).min(0),
});

/**
 * 动态刚体（Stride.BepuPhysics 的 BodyComponent）：受力、碰撞、重力。kinematic 时是运动学物体（不受力，按速度走）。
 * 这些列是建物体时的设置；物体建好以后，切换运动学、开关重力、读写速度、加冲量、瞬移、唤醒用 `game.simulation.body(entity)`
 * （直接改列不起作用）。
 */
export const Body = component('Body', {
  collider: prop.u32().brand<'ColliderId'>().default(0 as ColliderId),
  layer: prop.int().default(0).min(0).max(31),
  friction: prop.f32().default(1).min(0),
  kinematic: prop.bool().default(false),
  gravity: prop.bool().default(true),
  /** SleepThreshold：负数一直醒着；其余用 Jolt 的全局睡眠阈值（和 Stride 不同：Bepu 按物体设）。 */
  sleepThreshold: prop.f32().default(0.01),
  interpolated: prop.bool().default(false),
});

/** 角色（Stride 的 CharacterComponent）：不转动的动态刚体，按移动输入和起跳请求走。 */
export const Character = component('Character', {
  collider: prop.u32().brand<'ColliderId'>().default(0 as ColliderId),
  layer: prop.int().default(0).min(0).max(31),
  friction: prop.f32().default(1).min(0),
  speed: prop.f32().default(10).min(0),
  /** 起跳时相对支撑物的竖直速度（Stride 的 JumpForce）。 */
  jumpForce: prop.f32().default(10).min(0),
  maximumHorizontalForce: prop.f32().default(200).min(0),
  maximumVerticalForce: prop.f32().default(1000).min(0),
  /** 能站立的最大坡度。 */
  slopeAngle: prop.f32().default(50).min(0).max(90).unit('deg'),
  airControlForceScale: prop.f32().default(0.2).min(0),
  airControlScale: prop.f32().default(0.2).min(0),
  gravity: prop.bool().default(true),
  /** InterpolationMode.Interpolated：渲染在两步之间插值的位姿，画面更平滑，晚一步。 */
  interpolated: prop.bool().default(false),
  /** MoveVector：乘 speed 是目标水平速度，x 沿角色的右方、y 沿前方。 */
  moveX: prop.f32().default(0).transient(),
  moveY: prop.f32().default(0).transient(),
  /** TryJump：下一次仿真步进时试着起跳，用掉后清零。 */
  jump: prop.bool().default(false).transient(),
  /** IsGrounded：仿真更新后写入，站在能站立的地面上时为真。 */
  grounded: prop.bool().default(false).transient(),
});

/** @internal 已经建好物体的实体：物体编号。 */
export const PhysicsBody = component('PhysicsBody', {
  body: prop.u32().default(0).transient(),
});
