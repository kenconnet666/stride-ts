// BepuSample 的 ThrowerComponent：按 T 从 spawnPosition 沿相机的朝向扔出一个预制体。
import { Matrix, prop, Transform, Vector3 } from '@stride-ts/engine';
import { Spawner } from './Spawner';

export class ThrowerComponent extends Spawner.props({
  cameraEntity: prop.entity().optional(),
  spawnPosition: prop.entity().optional(),
  speed: prop.number().default(20),
}) {
  override update(): void {
    this.game.debugText.print('Throw a prefab (T)', [this.game.graphicsDevice.canvas.width - 500, 125]);
    if (this.spawnPosition === undefined || this.cameraEntity === undefined || !this.game.input.isKeyPressed('T')) return;
    const camera = Matrix.decompose(this.game.entities.entity(this.cameraEntity).require(Transform).world).rotation;
    const forward = new Vector3(0, 0, -1).rotate({ x: camera[0], y: camera[1], z: camera[2], w: camera[3] }).scale(this.speed);
    const at = this.game.entities.entity(this.spawnPosition).require(Transform).world;
    this.spawn({ x: at[12]!, y: at[13]!, z: at[14]! }, forward);
  }
}
