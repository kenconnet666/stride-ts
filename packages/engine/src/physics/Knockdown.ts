/**
 * 被撞倒再爬起来（Stride 没有）：挂在带 Ragdoll 的角色上。实体自己的物体（一般是运动学的胶囊，跟着角色走；接触不挡东西）被别的东西
 * 以 minSpeed 以上的速度撞到时变成布娃娃，沿被撞的方向加一下冲量；倒地 downTime 秒以后交还给动画（Ragdoll.deactivate：扶正、
 * 从倒地的姿势淡回）。倒地期间同一个实体上的 CrowdAgent、StateTreeRunner 停用（不再走路、不再想事），爬起来再启用。
 * 代码里也能直接 `knock(冲量)`（爆炸、剧情）。
 *
 *   person.add({ script: Knockdown, init: { minSpeed: 3 } });
 *
 * 设接触处理器会顶掉实体上原来的（simulation.setContactHandler 一个物体只有一个）。
 */
import { prop } from '../data/prop';
import { SyncScript, type ScriptComponent } from '../engine/scripts';
import type { GameTime } from '../engine/GameTime';
import { StateTreeRunner } from '../ai/StateTreeRunner';
import { Body, Character } from './components';
import type { StartedContact } from './contacts';
import { CrowdAgent } from './CrowdAgent';
import { Ragdoll } from './Ragdoll';

export class Knockdown extends SyncScript.props('Knockdown', {
  /** 被撞时接近的速度到这么快就倒（米/秒）。 */
  minSpeed: prop.number().min(0).default(3).unit('m/s'),
  /** 冲量：撞的速度乘它（牛·秒每米/秒，约等于"撞过来的有效质量"），方向是被撞的方向，再往上抬一点。 */
  impulse: prop.number().min(0).default(40).unit('kg'),
  /** 倒在地上多少秒以后爬起来。 */
  downTime: prop.number().min(0).default(4).unit('s'),
}) {
  /** 被撞倒的次数。 */
  knockdowns = 0;
  #downFor = 0;
  /** 倒地时停用的脚本（爬起来时启用）。 */
  #paused: ScriptComponent[] = [];

  /** 正倒在地上。 */
  get down(): boolean {
    return this.entity.get(Ragdoll)?.active ?? false;
  }

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Knockdown on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    if (!this.entity.get(Ragdoll)) throw new Error(`Knockdown on '${this.entity.name}': the entity needs a Ragdoll`);
    if (!this.entity.get(Body) && !this.entity.get(Character)) throw new Error(`Knockdown on '${this.entity.name}': the entity needs a Body (a kinematic capsule) or a Character to be hit`);
    simulation.setContactHandler(this.entity, { noContactResponse: true, onStartedTouching: (contact) => this.#hit(contact) });
  }

  /** 变成布娃娃、加 impulse（世界空间，牛·秒）；已经倒着时不变。 */
  knock(impulse: readonly [number, number, number]): void {
    if (this.down) return;
    this.#paused = [this.entity.get(CrowdAgent), this.entity.get(StateTreeRunner)].filter((script): script is CrowdAgent | StateTreeRunner => script?.enabled === true);
    for (const script of this.#paused) script.enabled = false;
    this.entity.require(Ragdoll).activate(impulse);
    this.knockdowns++;
    this.#downFor = 0;
  }

  /** 马上爬起来（倒着时）。 */
  getUp(): void {
    if (!this.down) return;
    this.entity.require(Ragdoll).deactivate();
    for (const script of this.#paused) script.enabled = true;
    this.#paused = [];
  }

  override update(time: GameTime): void {
    if (!this.down) return;
    this.#downFor += time.elapsed;
    if (this.#downFor >= this.downTime) this.getUp();
  }

  #hit({ speed, normal }: StartedContact): void {
    if (speed < this.minSpeed || this.down) return;
    // 法线从自己指向对方：被推往反方向，再往上抬三分之一（撞在腿上、人往前扑）
    const strength = speed * this.impulse;
    this.knock([-normal[0] * strength, Math.abs(normal[1]) * strength + strength / 3, -normal[2] * strength]);
  }
}
