// ParticlesSample 的 CustomParticleInitializer（"Custom Cone Initializer"）：粒子生在模块周围一个朝上的锥面里（张角 Angle 度，
// 半径是模块的缩放），速度沿着离开中心的方向，乘 Strength。
// 照抄样例的写法：y 用的是 sqrt(1 - u²)（u 是角度，不是 cos），所以不是严格的锥面，归一化后差别不大。
import {
  forEachSpawned, particleModuleValue, ParticleInitializer, RandomOffset, seedFloat, Vector3,
  type ParticleModuleFile, type ParticlePool, type SpawnedRange,
} from '@stride-ts/engine';

export class CustomParticleInitializer extends ParticleInitializer {
  readonly requiredFields = ['position', 'velocity', 'randomSeed'] as const;
  readonly angle: number;
  readonly strength: number;
  readonly seedOffset: number;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.angle = particleModuleValue(file, 'angle', 20);
    this.strength = particleModuleValue(file, 'strength', 1);
    this.seedOffset = particleModuleValue(file, 'seedOffset', 0);
  }

  initialize(pool: ParticlePool, range: SpawnedRange): void {
    const position = pool.field('position'), velocity = pool.field('velocity');
    if (!position || !velocity) return;
    const seeds = pool.seeds;
    const arc = (this.angle * Math.PI) / 180;
    const magnitude = this.worldScale[0];
    const [qx, qy, qz, qw] = this.worldRotation;
    const rotation = { x: qx, y: qy, z: qz, w: qw };
    const p = new Vector3();
    forEachSpawned(range, (i) => {
      const u = (seedFloat(seeds[i]!, RandomOffset.offset2A + this.seedOffset) - 0.5) * arc;
      const v = (seedFloat(seeds[i]!, RandomOffset.offset2B + this.seedOffset) - 0.5) * Math.PI;
      const xz = Math.sin(u);
      p.set(Math.cos(v) * xz, Math.sqrt(1 - u * u), Math.sin(v) * xz).normalize().scale(magnitude).rotate(rotation);
      position.set([p.x + this.worldPosition[0], p.y + this.worldPosition[1], p.z + this.worldPosition[2]], i * 3);
      velocity.set([p.x * this.strength, p.y * this.strength, p.z * this.strength], i * 3);
    });
  }
}
