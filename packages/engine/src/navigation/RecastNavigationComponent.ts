/**
 * Stride.BepuPhysics.Navigation 的 RecastNavigationComponent：实体的寻路和沿路径走。
 * - `tryFindPath(target)` 马上从实体的世界位置找到 target 的路径，路径点放在 `path`（第一个是起点附近），状态在 `state`；
 *   路径怎么走可以由脚本自己决定（TopDownRPG 的 PlayerController 按路径点给角色设 MoveVector）。
 * - `setTarget(target)` 排队寻路：导航系统每帧最多算 10 条（Stride 的 RecastNavigationProcessor），算好后 `state` 变成
 *   pathIsReady。
 * - `startFollowingPath()` 以后每帧按 `speed` 把实体沿 `path` 挪过去、转向前进的方向，走到一个路径点就把它从 `path` 里去掉。
 *
 * 和 Stride 不同：
 * - 一开始的状态是 pathIsInvalid（还没有路径）。Stride 的枚举默认值是 QueuePathPlanning，每个组件一出生就排队找一条去原点的路。
 * - 排队的寻路没找到时状态是 pathIsInvalid（Stride 停在 PlanningPath 不动）。
 * - 已经站在下一个路径点上时不转向（Stride 这时对零向量求朝向，得到 NaN）。
 */
import { prop } from '../data/prop';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { GameTime } from '../games/GameTime';
import { Matrix } from '../mathematics/Matrix';
import { Quaternion, Vector3, type Vec3Like } from '../mathematics/vectors';

/** Stride 的 NavigationState。 */
export type NavigationState = 'queuePathPlanning' | 'planningPath' | 'pathIsReady' | 'pathIsInvalid';

const UP = new Vector3(0, 1, 0);
const PARENT_INVERSE = Matrix.identity();

export class RecastNavigationComponent extends SyncScript.props({
  /** 沿路径走的速度（每秒，Stride 的 Speed）。 */
  speed: prop.number().default(5),
}) {
  static override scriptName = 'RecastNavigationComponent';

  state: NavigationState = 'pathIsInvalid';
  readonly target = new Vector3();
  /** 找到的路径点；没找到时是空的。沿路径走的时候走到一个去掉一个。 */
  path: Vector3[] = [];
  #moving = false;

  /** 正在沿路径走（startFollowingPath 之后）。 */
  get isMoving(): boolean {
    return this.#moving;
  }

  /** 排队找一条到 target 的路（Stride 的 SetTarget）：导航系统在之后的帧里算，看 state。 */
  setTarget(target: Vec3Like): void {
    this.target.set(target.x, target.y, target.z);
    this.state = 'queuePathPlanning';
  }

  /** 从实体的世界位置找到 target 的路径（Stride 的 TryFindPath）：找到时写进 path，返回 true。还没建好导航网格时是 false。 */
  tryFindPath(target: Vec3Like): boolean {
    this.target.set(target.x, target.y, target.z);
    const world = this.entity.require(Transform).world;
    const path = this.#navigation().findPath({ x: world[12]!, y: world[13]!, z: world[14]! }, target);
    this.path = path ?? [];
    this.state = path ? 'pathIsReady' : 'pathIsInvalid';
    return path !== undefined;
  }

  startFollowingPath(): void {
    this.#moving = true;
  }

  stopFollowingPath(): void {
    this.#moving = false;
  }

  override update(time: GameTime): void {
    const navigation = this.game.navigation;
    if (!navigation) return;
    navigation.processQueue(time.frameCount);
    if (this.state === 'queuePathPlanning') {
      this.state = 'planningPath';
      navigation.queuePath(() => {
        // 排着队的时候可能已经换了目标、马上找过，或者实体没了
        if (this.attached && this.state === 'planningPath') this.tryFindPath(this.target);
      });
    }
    if (this.#moving) this.#moveAndRotate(time.elapsed);
  }

  /** 往下一个路径点挪 speed · elapsed，朝着它；到了就把它从路径里去掉（Stride 的 MoveAndRotate）。 */
  #moveAndRotate(elapsed: number): void {
    const next = this.path[0];
    if (!next) {
      this.state = 'pathIsInvalid';
      return;
    }
    const transform = this.entity.require(Transform), world = transform.world;
    const position = new Vector3(world[12]!, world[13]!, world[14]!);
    const offset = new Vector3(next.x - position.x, next.y - position.y, next.z - position.z);
    const distance = Math.hypot(offset.x, offset.y, offset.z), step = this.speed * elapsed;
    const rotation = distance > 1e-6 ? Quaternion.lookRotation(offset.clone().scale(1 / distance), UP) : undefined;
    if (distance <= step) {
      position.copy(next);
      this.path.shift();
    } else {
      position.add(offset.scale(step / distance));
    }
    // 世界空间的位置、朝向换到父实体的本地空间
    const parent = transform.parent?.require(Transform);
    if (parent && Matrix.invert(PARENT_INVERSE, parent.world)) {
      const [x, y, z] = Matrix.transformPoint(PARENT_INVERSE, position.x, position.y, position.z);
      position.set(x, y, z);
      if (rotation) {
        const [px, py, pz, pw] = Matrix.decompose(parent.world).rotation;
        rotation.copy(new Quaternion(-px, -py, -pz, pw).multiply(rotation));
      }
    }
    Object.assign(transform.position, { x: position.x, y: position.y, z: position.z });
    if (rotation) Object.assign(transform.rotation, { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  }

  #navigation() {
    const navigation = this.game.navigation;
    if (!navigation) throw new Error('RecastNavigationComponent needs navigation; run the game with nativeFeatures: [physics, navigation]');
    return navigation;
  }
}
