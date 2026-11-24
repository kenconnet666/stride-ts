/**
 * 人群里的一个人（Stride 没有；Recast 的 DetourCrowd，照虚幻的 Detour Crowd、Unity 的 NavMeshAgent）：挂上以后实体由导航系统
 * 的人群移动——沿导航网格走到 `moveTo` 给的点，路上避开别的人群成员（速度障碍法）、和挨得太近的分开。位置写回实体（贴在导航
 * 网格上），faceMovement 时朝走的方向转（绕竖直轴）。导航网格重建以后自动接回去。
 *
 *   entity.require(CrowdAgent).moveTo({ x: 10, y: 0, z: 5 });
 *
 * 实体自己别再挂会动它的物理（角色胶囊）：人群管位置。挂了 SimulationLod 的按档位走：0 档在人群里，1 档沿导航网格的路径、
 * 2、3 档直线走（都不避让，见 ai/SimulationLod.ts）。
 */
import type { AgentId } from '@stride-ts/native';
import { prop } from '../data/prop';
import { Vector3, type Vec3Like } from '../data/vectors';
import { SyncScript } from '../engine/scripts';
import type { GameTime } from '../engine/GameTime';
import { Transform } from '../engine/transform';

export class CrowdAgent extends SyncScript.props('CrowdAgent', {
  radius: prop.number().min(0.05).default(0.4).unit('m'),
  height: prop.number().min(0.1).default(1.8).unit('m'),
  maxSpeed: prop.number().min(0).default(1.4).unit('m/s'),
  maxAcceleration: prop.number().min(0).default(8).unit('m/s2'),
  /** 朝走的方向转（绕竖直轴）；关掉时朝向由别的脚本管。 */
  faceMovement: prop.bool().default(true),
}) {
  /** 现在的速度（世界空间，米/秒）：选走、跑的动画用。 */
  readonly velocity = new Vector3();
  /** 要去的地方；没有时站着。 */
  target: Vector3 | undefined;
  /** @internal 导航系统给的人群槽位；还没进人群时是 -1。 */
  slot: AgentId | -1 = -1;
  /** @internal 目标改了、还没交给人群。 */
  targetDirty = false;
  /** @internal 目标不在导航网格上时，下一次试的游戏时间（秒）。 */
  retryAt = 0;
  /** @internal 降了档（SimulationLod 1 档起）时自己走的拐点（走过的去掉），routeOnPath：是按导航网格的路径（1 档）还是直线。 */
  route: Vector3[] | undefined;
  routeOnPath = false;

  /** 走到 point（世界位置）。目标还不在导航网格上时（分块流式还没建到那）先朝它走，建到了再按真的目标走。 */
  moveTo(point: Vec3Like): void {
    this.target = new Vector3(point.x, point.y, point.z);
    this.targetDirty = true;
    this.retryAt = 0;
  }

  /** 停下（站在原地）。 */
  stop(): void {
    this.target = undefined;
    this.targetDirty = true;
    this.retryAt = 0;
  }

  /** 离目标的水平距离不到 tolerance 米（没有目标时也算到了）。 */
  arrived(tolerance = 0.3): boolean {
    if (!this.target) return true;
    const world = this.entity.require(Transform).world;
    return Math.hypot(world[12]! - this.target.x, world[14]! - this.target.z) <= tolerance;
  }

  override start(): void {
    const navigation = this.game.navigation;
    if (!navigation) throw new Error(`CrowdAgent on '${this.entity.name}': the game runs without navigation (nativeFeatures: [physics, navigation])`);
    navigation.addAgent(this);
  }

  override update(time: GameTime): void {
    this.game.navigation?.updateCrowd(time);
  }

  override cancel(): void {
    this.game.navigation?.removeAgent(this);
  }

  /** 停用时离开人群（站住、不再推挤别人，位置交给别的东西，比如布娃娃），启用时从现在的位置重新加入、接着去原来的目标。 */
  protected override onEnabledChanged(): void {
    const navigation = this.game?.navigation;
    if (!navigation) return;
    if (this.enabled) navigation.addAgent(this);
    else {
      navigation.removeAgent(this);
      this.velocity.set(0, 0, 0);
    }
  }
}
