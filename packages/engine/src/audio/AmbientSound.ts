/**
 * 环境声区（Stride 没有；同虚幻的 Ambient Zone、Wwise 的 Ambience 区域）：一片区域（球、长方体）里放一个循环的声音事件——街道的
 * 车流人声、公园的鸟和风、室内的空调嗡嗡声。听者在区域里是满音量，出了区域在 fade 米里淡出，几片区域挨着时交叉淡化；声音不
 * 空间化（四面八方都是）。听者离开淡出的范围就停下，回来再放。
 *
 *   entity.add({ script: AmbientSound, init: { event: park, shape: 'box', size: [80, 20, 60], fade: 15 } });
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { SoundEventInstance } from './SoundEvents';

export class AmbientSound extends SyncScript.props('AmbientSound', {
  /** 循环的声音事件（事件自己最好是 loop 的）。 */
  event: prop.asset('soundEvent'),
  /** 区域的形状：sphere 用 size 的 x 当半径；box 是实体本地的长方体（size 是整个的长宽高，跟着实体转）。 */
  shape: prop.enum(['sphere', 'box']).default('box'),
  size: prop.vec3().default([20, 10, 20]),
  /** 出了区域多远淡到 0（米）。 */
  fade: prop.number().min(0).default(10).unit('m'),
  volume: prop.number().min(0).default(1),
}) {
  #instance: SoundEventInstance | undefined;

  /** 听者在区域里的程度：区域里 1，出了区域按离区域多远淡到 fade 米外的 0。 */
  weightAt(point: readonly number[]): number {
    const world = this.entity.require(Transform).world;
    let outside: number;
    if (this.shape === 'sphere') {
      outside = Math.max(0, Math.hypot(point[0]! - world[12]!, point[1]! - world[13]!, point[2]! - world[14]!) - this.size.x);
    } else {
      // 换到实体本地：减去位置，投到三个轴上（轴带着缩放，按长度归一）
      const d = [point[0]! - world[12]!, point[1]! - world[13]!, point[2]! - world[14]!];
      const half = [this.size.x / 2, this.size.y / 2, this.size.z / 2];
      let squared = 0;
      for (let axis = 0; axis < 3; axis++) {
        const ax = world[axis * 4]!, ay = world[axis * 4 + 1]!, az = world[axis * 4 + 2]!;
        const length = Math.hypot(ax, ay, az) || 1;
        const along = (d[0]! * ax + d[1]! * ay + d[2]! * az) / length;
        const scaled = half[axis]! * length;
        const beyond = Math.max(0, Math.abs(along) - scaled);
        squared += beyond * beyond;
      }
      outside = Math.sqrt(squared);
    }
    if (outside <= 0) return 1;
    return this.fade > 0 ? Math.max(0, 1 - outside / this.fade) : 0;
  }

  override update(): void {
    const events = this.game.audio.events;
    const weight = this.weightAt(this.game.audio.listenerPosition) * this.volume;
    if (weight <= 0) {
      this.#instance?.stop();
      this.#instance = undefined;
      return;
    }
    if (!this.#instance?.playing) this.#instance = events.play(this.event, { volume: weight });
    else this.#instance.volume = weight;
  }

  override cancel(): void {
    this.#instance?.stop();
    this.#instance = undefined;
  }
}
