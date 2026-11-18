// FirstPersonShooter 的 EffectController：每次开枪在枪口生成火焰，打中时在命中点生成弹孔（+Y 朝命中面的法线），打中刚体时在
// 刚体上随机一点生成受击拖尾。三个特效都是粒子（P2），现在生成的预制体里只有变换。
import { Body, Matrix, Quaternion } from '@stride-ts/engine';
import { WeaponFired } from './player/WeaponScript';
import { TriggerScript } from './trigger/TriggerScript';

export class EffectController extends TriggerScript {
  readonly #weaponFiredEvents = this.receive(WeaponFired);

  override async execute(): Promise<void> {
    for (;;) {
      const target = await this.#weaponFiredEvents.receive(this.signal);
      if (target.didFire) this.spawnEvent('MuzzleFlash', this.entity, Matrix.identity());
      const hit = target.hitResult;
      if (!target.didHit || !hit) continue;
      const { x, y, z, w } = Quaternion.betweenDirections({ x: 0, y: 1, z: 0 }, { x: hit.normal[0]!, y: hit.normal[1]!, z: hit.normal[2]! });
      this.spawnEvent('BulletImpact', undefined, Matrix.compose(Matrix.identity(), [hit.point[0]!, hit.point[1]!, hit.point[2]!], [x, y, z, w], [1, 1, 1]));
      const entity = this.game.entities.entity(hit.entity);
      if (entity.get(Body)) {
        this.spawnEvent('DamagedTrail', entity, Matrix.compose(Matrix.identity(), [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], [0, 0, 0, 1], [1, 1, 1]));
      }
    }
  }
}
