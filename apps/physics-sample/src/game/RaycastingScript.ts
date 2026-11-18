// PhysicsSample 的 RaycastingScript：按下指针时，从相机穿过那一点打一条射线，打到动态刚体就唤醒它、向上推一下。
import { Body, screenToWorldRaySegment, SyncScript } from '@stride-ts/engine';

export class RaycastingScript extends SyncScript {
  override update(): void {
    for (const event of this.game.input.pointerEvents) {
      if (event.eventType === 'pressed') this.#raycast(event.position[0], event.position[1]);
    }
  }

  #raycast(x: number, y: number): void {
    const simulation = this.game.simulation;
    if (!simulation) return;
    const { start, end } = screenToWorldRaySegment(this.game, this.entity, x, y);
    const direction = end.clone().subtract(start);
    const distance = direction.length();
    const hit = simulation.rayCast([start.x, start.y, start.z], [direction.x / distance, direction.y / distance, direction.z / distance], distance);
    if (!hit || !this.game.entities.hasComponent(hit.entity, Body)) return;
    const body = simulation.body(hit.entity);
    body.awake = true;
    body.applyLinearImpulse({ x: 0, y: 5, z: 0 });
  }
}
