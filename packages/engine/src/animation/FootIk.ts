/**
 * 脚贴地（Stride 没有；照虚幻的 Leg IK、Unity 的 Foot IK）：挂在带骨架的模型实体上，每帧从两只脚（动画里的位置）往下打射线
 * 找地面，按地面比模型原点高多少把脚抬上去（两段骨的 IK，膝朝前弯），低的那边让髋往下沉，站在台阶、斜坡上两只脚都踩实。
 * 腿按骨架的结构自动找（ikRig.ts 的 findLegs）；射线不算自己和祖先实体（角色的胶囊）。
 *
 * 动画里两只脚着地时在模型的 y = 0 上（平地上走跑的动画都是这样）；离地的时候（跳）脚的偏移跟着离地的高度淡掉。
 */
import { prop } from '../data/prop';
import type { EntityId } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { findLegs, jointPosition, kneePole, type Leg } from './ikRig';

export class FootIk extends SyncScript.props('FootIk', {
  /** 0 不做，1 完全贴地。 */
  weight: prop.number().min(0).max(1).default(1),
  /** 脚最多抬高、髋最多下沉多少（米）。 */
  maxStep: prop.number().min(0).default(0.45).unit('m'),
  /** 射线从脚上方多高开始打（米）。 */
  rayHeight: prop.number().min(0).default(0.6).unit('m'),
  /** 地面的碰撞层（位掩码）。 */
  mask: prop.u32().default(0xffffffff),
  /** 偏移变化的快慢（每秒趋近的比例，越大越跟得紧）。 */
  smoothing: prop.number().min(0).default(15),
}) {
  #rig: { legs: [Leg, Leg]; hips: number } | undefined;
  #offsets = [0, 0];
  #hips = 0;
  #self = new Set<EntityId>();

  /** 两只脚现在的偏移（米，往上为正）和髋的下沉（负的）。 */
  get offsets(): { left: number; right: number; hips: number } {
    return { left: this.#offsets[0]!, right: this.#offsets[1]!, hips: this.#hips };
  }

  override update(): void {
    const animation = this.game.animation, simulation = this.game.simulation;
    const instance = animation.instanceOf(this.entity), skeleton = animation.skeletonOf(this.entity);
    if (!instance || !skeleton || !simulation) return;
    const matrices = instance.modelMatrices();
    if (!this.#rig) {
      this.#rig = findLegs(skeleton, matrices);
      if (!this.#rig) throw new Error(`FootIk on '${this.entity.name}': could not find two legs in the skeleton`);
      for (let entity = this.entity as typeof this.entity | undefined; entity; entity = entity.get(Transform)?.parent ?? undefined) this.#self.add(entity.id);
    }
    const world = this.entity.require(Transform).world;
    const up: [number, number, number] = [world[4]!, world[5]!, world[6]!];
    const scale = Math.hypot(...up) || 1;
    const blend = 1 - Math.exp(-this.smoothing * this.game.updateTime.elapsed);
    // 每只脚：动画里脚的位置（上一帧 IK 之前的位置减去上一帧的偏移）往下打射线，地面比模型原点高多少就抬多少
    const wanted = this.#rig.legs.map((leg, i) => {
      const local = jointPosition(matrices, leg.foot);
      local[1] -= this.#offsets[i]! + this.#hips;
      const x = world[0]! * local[0] + world[4]! * local[1] + world[8]! * local[2] + world[12]!;
      const z = world[2]! * local[0] + world[6]! * local[1] + world[10]! * local[2] + world[14]!;
      const top = world[13]! + this.rayHeight * scale;
      const hit = simulation.rayCastPenetrating([x, top, z], [0, -1, 0], (this.rayHeight + this.maxStep) * scale, { mask: this.mask }).find((h) => !this.#self.has(h.entity));
      if (!hit) return 0;
      return Math.max(-this.maxStep, Math.min(this.maxStep, (hit.point[1] - world[13]!) / scale));
    });
    const hips = Math.min(0, ...wanted);
    this.#hips += (hips - this.#hips) * blend;
    wanted.forEach((value, i) => (this.#offsets[i]! += (value - this.#offsets[i]!) * blend));
    const weight = this.weight;
    animation.setIk(this.entity, this, weight <= 0 ? [] : [
      { type: 'offset', joint: this.#rig.hips, offset: [0, this.#hips, 0], weight },
      ...this.#rig.legs.map((leg, i) => ({
        type: 'twoBone' as const, joints: [leg.thigh, leg.knee, leg.foot] as const, target: [0, this.#offsets[i]! - this.#hips, 0] as const,
        relative: true, midAxis: leg.midAxis, pole: kneePole(matrices, leg), weight, soften: 0.97,
      })),
    ]);
  }

  override cancel(): void {
    if (this.game.animation.instanceOf(this.entity)) this.game.animation.setIk(this.entity, this, []);
  }
}
