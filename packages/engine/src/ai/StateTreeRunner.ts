/**
 * 按状态树（`.statetree.json`）跑一个实体的行为（照虚幻的 StateTreeComponent）：挂上以后每帧跑一次树；游戏代码设参数、发事件：
 *
 *   const brain = entity.require(StateTreeRunner);
 *   brain.set('alarm', true);
 *   brain.send('scared');
 *   brain.activePath;   // ['Calm', 'Stroll']
 *
 * 走路的任务要同一个实体上有 CrowdAgent。挂了 SimulationLod 时按档位的间隔推进（远处的人 0.5、2 秒想一次）。
 */
import { prop } from '../data/prop';
import type { Vec3Like } from '../data/vectors';
import { SyncScript } from '../engine/scripts';
import type { GameTime } from '../engine/GameTime';
import { SimulationLod } from './SimulationLod';
import { StateTreeInstance, type StateTreeStatus } from './StateTree';
import './stateTreeTasks';

export class StateTreeRunner extends SyncScript.props('StateTreeRunner', {
  /** 状态树。 */
  tree: prop.asset('stateTree'),
  /** 树结束（成功、失败）以后从头再来。 */
  loop: prop.bool().default(true),
  /** 时间倍数。 */
  timeFactor: prop.number().min(0).default(1),
}) {
  #instance: StateTreeInstance | undefined;

  /** 树的实例（start 以后才有）。 */
  get instance(): StateTreeInstance {
    if (!this.#instance) throw new Error(`StateTreeRunner on '${this.entity.name}' has not started yet`);
    return this.#instance;
  }

  /** 活的状态的名字，从根到叶子。 */
  get activePath(): readonly string[] {
    return this.instance.activePath;
  }

  get status(): StateTreeStatus {
    return this.instance.status;
  }

  set(name: string, value: number | boolean | Vec3Like): void {
    this.instance.set(name, value);
  }

  get(name: string): number {
    return this.instance.get(name);
  }

  /** 发一个事件（下一帧 on: event 的过渡看得到）。 */
  send(event: string): void {
    this.instance.send(event);
  }

  override start(): void {
    this.#instance = new StateTreeInstance(this.tree, { entity: this.entity, game: this.game });
  }

  override update(time: GameTime): void {
    const instance = this.#instance;
    if (!instance) return;
    // 挂了 SimulationLod 的按档位的间隔推进，跳过的时间攒着一次推进
    const lod = this.entity.get(SimulationLod);
    if (lod && !lod.due) return;
    if (instance.status !== 'running' && this.loop) instance.restart();
    instance.update((lod ? lod.elapsed : time.elapsed) * this.timeFactor);
  }

  override cancel(): void {
    this.#instance?.stop();
  }
}
