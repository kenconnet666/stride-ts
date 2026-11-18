// An AsyncScript that spawns a burst of particles every `interval` seconds; expire() removes them again.
import { AsyncScript, prop } from '@stride-ts/engine';
import { Lifetime, Position, Velocity } from './particles';

export class Fountain extends AsyncScript.props({
  burst: prop.int().min(1).default(2_000),
  interval: prop.number().min(0.05).default(0.5),
  lifetime: prop.f32().min(0).default(3),
}) {
  spawned = 0;

  override async execute(): Promise<void> {
    for (;;) {
      const batch = this.game.entities.spawn(this.burst, [Position, Velocity, Lifetime.with({ seconds: this.lifetime })]);
      // Per-particle values go straight into the columns: no entity objects, nothing for the GC to keep
      const { x, y, z } = batch.columns(Velocity);
      for (let row = batch.firstRow; row < batch.firstRow + batch.count; row++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 3;
        x[row] = Math.cos(angle) * speed;
        z[row] = Math.sin(angle) * speed;
        y[row] = 6 + Math.random() * 4;
      }
      this.spawned += batch.count;
      await this.delay(this.interval);
    }
  }
}
