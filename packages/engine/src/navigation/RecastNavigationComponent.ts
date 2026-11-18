/**
 * Stride.BepuPhysics.Navigation 的 RecastNavigationComponent：实体的寻路。`tryFindPath(target)` 从实体的世界位置找到 target
 * 的路径，路径点放在 `path`（第一个是起点附近），状态在 `state`。路径怎么走由脚本自己决定（TopDownRPG 的 PlayerController
 * 按路径点给角色设 MoveVector）。
 *
 * 还没做（场景里用到时再做）：Stride 的 RecastNavigationProcessor 每帧处理 setTarget 排队的寻路、按 speed 直接移动实体
 * （StartFollowingPath）。
 */
import { prop } from '../data/prop';
import { StartupScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { Vector3, type Vec3Like } from '../mathematics/vectors';

/** Stride 的 NavigationState。 */
export type NavigationState = 'queuePathPlanning' | 'planningPath' | 'pathIsReady' | 'pathIsInvalid';

export class RecastNavigationComponent extends StartupScript.props({
  /** 直接移动实体时的速度（Stride 的 Speed）；跟随路径还没做，先只记下。 */
  speed: prop.number().default(5),
}) {
  static override scriptName = 'RecastNavigationComponent';

  state: NavigationState = 'queuePathPlanning';
  readonly target = new Vector3();
  /** 上一次 tryFindPath 找到的路径点；没找到时是空的。 */
  path: Vector3[] = [];

  /** 从实体的世界位置找到 target 的路径（Stride 的 TryFindPath）：找到时写进 path，返回 true。还没建好导航网格时是 false。 */
  tryFindPath(target: Vec3Like): boolean {
    this.target.set(target.x, target.y, target.z);
    const navigation = this.game.navigation;
    if (!navigation) throw new Error('RecastNavigationComponent needs navigation; run the game with nativeFeatures: [physics, navigation]');
    const world = this.entity.require(Transform).world;
    const path = navigation.findPath({ x: world[12]!, y: world[13]!, z: world[14]! }, target);
    this.path = path ?? [];
    this.state = path ? 'pathIsReady' : 'pathIsInvalid';
    return path !== undefined;
  }
}
