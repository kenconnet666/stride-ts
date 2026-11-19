// CSharpIntermediate 的 NavigateCharacter（挂在相机实体上）：点左键，把鼠标的位置反投影成射线打到地面，让角色的
// RecastNavigationComponent 找一条到那里的路；路径的每个拐点放一个小球，角色沿着拐点一个个走过去。
import { prop, screenToWorldRaySegment, SyncScript, Transform, RecastNavigationComponent, Vector3, type Entity } from '@stride-ts/engine';

export class NavigateCharacter extends SyncScript.props({
  regularCharacter: prop.entity().optional(),
  pathSphere: prop.entity().optional(),
  movementSpeed: prop.f32().default(0),
}) {
  #waypoints: Vector3[] = [];
  #spheres: Entity[] = [];
  #waypointIndex = 0;

  override start(): void {
    // Stride 的 RecastMeshSystem.RebuildNavMesh()；建好之前找不到路
    void this.game.navigation?.rebuild();
  }

  override update(): void {
    this.game.debugText.print('Left click to set Regular character target', [200, 20]);
    if (this.game.input.isMouseButtonPressed('left')) {
      this.#cleanupExistingPath();
      this.#setTarget();
    }
    this.#updateMovement();
  }

  #updateMovement(): void {
    const next = this.#waypoints[this.#waypointIndex];
    if (!next || this.regularCharacter === undefined) {
      this.game.debugText.print('No target', [200, 60]);
      return;
    }
    const transform = this.game.entities.entity(this.regularCharacter).require(Transform);
    const [x, y, z] = transform.world.subarray(12, 15);
    const direction = new Vector3(next.x - x!, next.y - y!, next.z - z!);
    const distance = direction.length();
    this.game.debugText.print(`Distance to waypoint ${distance.toFixed(1)} `, [200, 60]);
    if (distance > 0.1) {
      const step = (this.movementSpeed * this.game.updateTime.elapsed) / distance;
      const { position } = transform;
      transform.position = { x: position.x + direction.x * step, y: position.y + direction.y * step, z: position.z + direction.z * step };
    } else if (this.#waypointIndex + 1 < this.#waypoints.length) {
      this.#waypointIndex++;
    } else {
      this.#cleanupExistingPath();
    }
  }

  #setTarget(): void {
    if (this.regularCharacter === undefined) return;
    const input = this.game.input;
    const { start, end } = screenToWorldRaySegment(this.game, this.entity, input.mousePosition[0], input.mousePosition[1]);
    const direction = end.clone().subtract(start);
    const distance = direction.length();
    const hit = this.game.simulation!.rayCast([start.x, start.y, start.z], [direction.x / distance, direction.y / distance, direction.z / distance], distance);
    const navigation = this.game.entities.entity(this.regularCharacter).require(RecastNavigationComponent);
    if (!hit || !navigation.tryFindPath({ x: hit.point[0], y: hit.point[1], z: hit.point[2] })) return;
    this.#waypoints = navigation.path.map((point) => point.clone());
    this.#waypointIndex = 0;
    if (this.pathSphere === undefined) return;
    const sphere = this.game.entities.entity(this.pathSphere);
    for (const waypoint of this.#waypoints) {
      const clone = sphere.clone();
      clone.require(Transform).position = waypoint;
      // Stride 的 Entity.Scene.Entities.Add：换教程时跟着销毁
      clone.scene = this.entity.scene;
      this.#spheres.push(clone);
    }
  }

  #cleanupExistingPath(): void {
    for (const sphere of this.#spheres) if (sphere.alive) sphere.destroy();
    this.#spheres = [];
    this.#waypoints = [];
  }
}
