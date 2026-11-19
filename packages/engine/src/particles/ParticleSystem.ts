/**
 * 粒子系统（Stride 的 ParticleSystem）：一组发射器，加上播放状态（播放、暂停、停止、超时）和预热。位置、旋转、统一缩放由
 * ParticleSystemComponent 每帧按实体的世界变换设。
 */
import type { ParticleModuleFile } from '../content/format';
import type { Texture } from '../rendering/Texture';
import type { Quat, Vec3 } from './math';
import { value } from './modules';
import { ParticleEmitter, type EmitterParent } from './ParticleEmitter';

/** 预热时的步长（同 Stride）。 */
const WARMUP_STEP = 1 / 30;

export class ParticleSystem implements EmitterParent {
  readonly emitters: readonly ParticleEmitter[];
  /** 开始时先模拟这么多秒（Stride 的 Settings.WarmupTime）。 */
  readonly warmupTime: number;
  translation: Vec3 = [0, 0, 0];
  rotation: Quat = [0, 0, 0, 1];
  uniformScale = 1;
  #paused = false;
  #started = false;
  #timeout = 0;

  /** textures 按内容路径给加载好的贴图（材质用）。 */
  constructor(file: ParticleModuleFile = {}, textures?: (path: string) => Texture | undefined) {
    const emitters = (file['emitters'] as readonly ParticleModuleFile[] | undefined) ?? [];
    this.emitters = emitters.map((emitter) => new ParticleEmitter(emitter, textures));
    this.warmupTime = value(file['settings'] as ParticleModuleFile | undefined, 'warmupTime', 0);
  }

  get isPaused(): boolean {
    return this.#paused;
  }

  /** 活着的粒子总数。 */
  get livingParticles(): number {
    return this.emitters.reduce((sum, emitter) => sum + emitter.pool.living, 0);
  }

  update(dt: number): void {
    if (this.#timeout > 0) {
      this.#timeout -= dt;
      if (this.#timeout <= 0) this.stop();
    }
    if (this.#paused) {
      for (const emitter of this.emitters) if (emitter.enabled) emitter.updatePaused(this);
      return;
    }
    if (!this.#started) {
      this.#started = true;
      for (let remaining = this.warmupTime; remaining > 0; remaining -= WARMUP_STEP) {
        const step = Math.min(remaining, WARMUP_STEP);
        for (const emitter of this.emitters) if (emitter.enabled) emitter.update(step, this);
      }
    }
    for (const emitter of this.emitters) if (emitter.enabled) emitter.update(dt, this);
  }

  /** 清空所有粒子，下一帧从头开始（预热也重新做）。 */
  resetSimulation(): void {
    for (const emitter of this.emitters) emitter.resetSimulation();
    this.#started = false;
  }

  pause(): void {
    this.#paused = true;
  }

  /** 继续（或开始）播放，发射器重新可以生成粒子。 */
  play(): void {
    this.#paused = false;
    for (const emitter of this.emitters) emitter.canEmitParticles = true;
  }

  /** 清空并暂停。 */
  stop(): void {
    this.resetSimulation();
    this.#paused = true;
  }

  /** 不再生成新粒子，seconds 秒后停止（已有的粒子接着走完）。 */
  timeout(seconds: number): void {
    if (seconds < 0) return;
    this.stopEmitters();
    this.#timeout = seconds;
  }

  /** 不再生成新粒子。 */
  stopEmitters(): void {
    for (const emitter of this.emitters) emitter.canEmitParticles = false;
  }

  /** 按名字找发射器（Stride 的 GetEmitterByName）。 */
  emitter(name: string): ParticleEmitter | undefined {
    return name ? this.emitters.find((emitter) => emitter.name === name) : undefined;
  }
}
