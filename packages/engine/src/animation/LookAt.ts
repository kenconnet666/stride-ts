/**
 * 看向（Stride 没有；照虚幻的 Look At 节点、Unity 的 LookAt IK）：挂在带骨架的模型实体上，头（或别的关节）转向一个实体或世界里
 * 的一点（ozz 的 IKAimJob）。目标偏到身后超过 maxAngle 时权重淡到 0（不扭断脖子）。头骨的前方、上方按开始时的姿势从模型的前方、
 * 上方换到关节本地（不同骨架的头骨轴向不一样）。
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { toJointLocal, worldToModel } from './ikRig';

export class LookAt extends SyncScript.props('LookAt', {
  /** 看这个实体；没有时看 point。 */
  target: prop.entity().optional(),
  /** 世界里的一点（target 没有时用）。 */
  point: prop.vec3(),
  /** 转的关节；空的时候找名字里带 head 的。 */
  joint: prop.string().default(''),
  /** 模型的前方、上方（模型空间）。 */
  modelForward: prop.vec3(),
  modelUp: prop.vec3(),
  weight: prop.number().min(0).max(1).default(1),
  /** 目标偏离模型前方超过这个角（度）时权重淡到 0。 */
  maxAngle: prop.number().min(0).max(180).default(100).unit('deg'),
}) {
  #joint = -1;
  #forward: [number, number, number] = [0, 0, 1];
  #up: [number, number, number] = [0, 1, 0];

  override start(): void {
    if (this.modelForward.x === 0 && this.modelForward.y === 0 && this.modelForward.z === 0) this.modelForward.z = 1;
    if (this.modelUp.x === 0 && this.modelUp.y === 0 && this.modelUp.z === 0) this.modelUp.y = 1;
  }

  override update(): void {
    const animation = this.game.animation;
    const instance = animation.instanceOf(this.entity), skeleton = animation.skeletonOf(this.entity);
    if (!instance || !skeleton) return;
    const matrices = instance.modelMatrices();
    const forward = [this.modelForward.x, this.modelForward.y, this.modelForward.z], up = [this.modelUp.x, this.modelUp.y, this.modelUp.z];
    if (this.#joint < 0) {
      this.#joint = this.joint ? skeleton.jointIndex(this.joint) : skeleton.joints.findIndex((joint) => /head/i.test(joint.name));
      if (this.#joint < 0) throw new Error(`LookAt on '${this.entity.name}': no joint ${this.joint ? `'${this.joint}'` : 'with head in its name'} (set joint)`);
      this.#forward = toJointLocal(matrices, this.#joint, forward);
      this.#up = toJointLocal(matrices, this.#joint, up);
    }
    const world = this.entity.require(Transform).world;
    const targetEntity = this.target !== undefined && this.entity.manager.isAlive(this.target) ? this.entity.manager.entity(this.target) : undefined;
    const point = targetEntity ? Array.from(targetEntity.require(Transform).world.subarray(12, 15)) : [this.point.x, this.point.y, this.point.z];
    const target = worldToModel(world, point);
    // 偏离前方的角度：超过 maxAngle 的一半开始淡，到 maxAngle 为 0
    const head = matrices.subarray(this.#joint * 16 + 12, this.#joint * 16 + 15);
    const to = [target[0] - head[0]!, target[1] - head[1]!, target[2] - head[2]!];
    const angle = Math.acos(Math.max(-1, Math.min(1, (to[0]! * forward[0]! + to[1]! * forward[1]! + to[2]! * forward[2]!) / (Math.hypot(...to) * Math.hypot(...forward) || 1)))) * (180 / Math.PI);
    const fade = Math.max(0, Math.min(1, (this.maxAngle - angle) / Math.max(1e-6, this.maxAngle / 2)));
    const weight = this.weight * fade;
    animation.setIk(this.entity, this, weight <= 0 ? [] : [{ type: 'aim', joint: this.#joint, target, forward: this.#forward, up: this.#up, pole: up as [number, number, number], weight }]);
  }

  override cancel(): void {
    if (this.game.animation.instanceOf(this.entity)) this.game.animation.setIk(this.entity, this, []);
  }
}
