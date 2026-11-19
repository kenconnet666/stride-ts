/**
 * 粒子系统（Stride 的 ParticleSystem）：一组发射器，加上播放状态（播放、暂停、停止、超时）和预热。位置、旋转、统一缩放由
 * ParticleSystemComponent 每帧按实体的世界变换设。
 */
import type { ParticleModuleFile } from '../content/format';
import { rotate, type Quat, type Vec3 } from './math';
import { NO_CONTEXT, value, type ParticleContext } from './modules';
import { ParticleEmitter, type EmitterParent } from './ParticleEmitter';

/** 预热时的步长（同 Stride）。 */
const WARMUP_STEP = 1 / 30;

export class ParticleSystem implements EmitterParent {
  readonly emitters: readonly ParticleEmitter[];
  /** 开始时先模拟这么多秒（Stride 的 Settings.WarmupTime）。 */
  readonly warmupTime: number;
  /**
   * 本地的包围形状（Stride 的 BoundingBoxStatic、BoundingSphereStatic）：画的时候按它剔除，粒子飞出去也不改；没有时不剔除。
   * 球存成半径。
   */
  readonly boundingBox: { readonly minimum: Vec3; readonly maximum: Vec3 } | undefined;
  readonly boundingRadius: number | undefined;
  translation: Vec3 = [0, 0, 0];
  rotation: Quat = [0, 0, 0, 1];
  uniformScale = 1;
  #paused = false;
  #started = false;
  #timeout = 0;

  /** context 给出贴图和场景里的实体（见 ParticleContext）。 */
  constructor(file: ParticleModuleFile = {}, context: ParticleContext = NO_CONTEXT) {
    const emitters = (file['emitters'] as readonly ParticleModuleFile[] | undefined) ?? [];
    this.emitters = emitters.map((emitter) => new ParticleEmitter(emitter, context));
    for (const emitter of this.emitters) emitter.linkParents(this.emitters);
    this.warmupTime = value(file['settings'] as ParticleModuleFile | undefined, 'warmupTime', 0);
    const shape = file['boundingShape'] as ParticleModuleFile | null | undefined;
    this.boundingBox = shape?.$type === 'boundingBoxStatic'
      ? { minimum: [...value(shape, 'minimum', [-1, -1, -1])] as Vec3, maximum: [...value(shape, 'maximum', [1, 1, 1])] as Vec3 }
      : undefined;
    // Stride 的类名就拼错成这样
    this.boundingRadius = shape?.$type === 'boundingSpheretatic' ? value(shape, 'radius', 1) : undefined;
  }

  /**
   * 世界里的包围盒 [最小角, 最大角]（Stride 的 GetAABB）：包围盒的角按旋转、统一缩放、位置变换后取范围；球是位置周围
   * 半径乘缩放的立方体。
   */
  worldBounds(): [Vec3, Vec3] | undefined {
    if (this.boundingRadius !== undefined) {
      const r = this.boundingRadius * this.uniformScale;
      return [this.translation.map((t) => t - r) as Vec3, this.translation.map((t) => t + r) as Vec3];
    }
    const box = this.boundingBox;
    if (!box) return undefined;
    const min = box.minimum.map((m, k) => (m + box.maximum[k]!) / 2) as Vec3, max = [...min] as Vec3;
    for (let corner = 0; corner < 8; corner++) {
      const p: Vec3 = [0, 1, 2].map((k) => ((corner >> k) & 1 ? box.maximum[k]! : box.minimum[k]!)) as Vec3;
      rotate(this.rotation, p);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, p[k]!);
        max[k] = Math.max(max[k]!, p[k]!);
      }
    }
    const world = (v: Vec3) => v.map((c, k) => c * this.uniformScale + this.translation[k]!) as Vec3;
    return [world(min), world(max)];
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
