// ParticlesSample 的 CustomParticleSpawner：每秒生成 SpawnCount 个（小数部分累积到下一帧），另外每秒一次多生成 BurstCount 个。
import { particleModuleValue, ParticleSpawner, type ParticleModuleFile, type SpawnTarget } from '@stride-ts/engine';

export class CustomParticleSpawner extends ParticleSpawner {
  readonly spawnCount: number;
  readonly burstCount: number;
  #carryOver = 0;
  #burstTimer = 0;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.spawnCount = particleModuleValue(file, 'spawnCount', 100);
    this.burstCount = particleModuleValue(file, 'burstCount', 50);
  }

  maxParticlesPerSecond(): number {
    return Math.ceil(this.spawnCount) + Math.ceil(this.burstCount);
  }

  spawn(dt: number, target: SpawnTarget): void {
    // 状态（休息、活跃）由基类管，一般只在活跃时生成
    if (this.updatedState(dt, target) !== 'active') return;
    const toSpawn = this.spawnCount * dt + this.#carryOver;
    let count = Math.floor(toSpawn);
    this.#carryOver = toSpawn - count;
    this.#burstTimer -= dt;
    if (this.#burstTimer < 0) {
      this.#burstTimer += 1;
      count += Math.floor(this.burstCount);
    }
    target.emit(count);
  }
}
