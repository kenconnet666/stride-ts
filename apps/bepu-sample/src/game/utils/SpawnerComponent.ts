// BepuSample 的 SpawnerComponent：按物理时间每秒生成 spawnRate 个预制体（一共 count 个），给一个向上的初速度加随机偏移；
// P、M 调生成速度。Stride 里在 ISimulationUpdate.SimulationUpdate 里计时，这里用 simulation.onStep。
import { prop, Transform, Vector3, type Entity } from '@stride-ts/engine';
import { Spawner } from './Spawner';

export class SpawnerComponent extends Spawner.props({
  spawnPosition: prop.entity().optional(),
  count: prop.int().default(100),
  /** 每秒（物理时间）生成几个。 */
  spawnRate: prop.number().default(1),
  spawnVelocity: prop.vec3().default([0, 20, 0]),
  /** 每个分量再加上 ±range 的随机值。 */
  spawnVelocityRange: prop.vec3().default([2, 0, 2]),
}) {
  #currentCount = 0;
  #currentTime = 0;

  override start(): void {
    const simulation = this.game.simulation;
    if (simulation) this.disposables.use(simulation.onStep((timeStep) => this.#simulationUpdate(timeStep)));
  }

  override update(): void {
    const input = this.game.input;
    if (input.isKeyPressed('P')) this.spawnRate *= 1.1;
    if (input.isKeyPressed('M')) this.spawnRate /= 1.1;
    const right = this.game.graphicsDevice.canvas.width - 500;
    this.game.debugText.print(`Prefab count : ${this.#currentCount}/${this.count}`, [right, 25]);
    this.game.debugText.print(`Spawn by Physic time : ${this.spawnRate} (p & m)`, [right, 50]);
  }

  #simulationUpdate(timeStep: number): void {
    if (this.spawnPosition === undefined) return;
    if (this.spawnRate < 0) this.spawnRate = 0;
    if (this.#currentCount >= this.count) return;
    this.#currentTime += timeStep;
    const toSpawn = Math.floor(this.#currentTime * this.spawnRate);
    if (toSpawn < 1) return;
    this.#currentTime -= toSpawn / this.spawnRate;
    const spawnAt: Entity = this.game.entities.entity(this.spawnPosition);
    const random = () => Math.random() * 2 - 1;
    for (let i = 0; i < toSpawn && this.#currentCount < this.count; i++) {
      const { spawnVelocity: v, spawnVelocityRange: range } = this;
      const velocity = new Vector3(v.x + random() * range.x, v.y + random() * range.y, v.z + random() * range.z);
      this.spawn(spawnAt.require(Transform).position, velocity);
      this.#currentCount++;
    }
  }
}
