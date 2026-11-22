/**
 * 粒子面板的预览（S2；参考 Niagara 编辑器的预览工具条）：编辑状态的视口里单独放一个粒子系统——播放、暂停、从头放、慢放，只看
 * 正在编辑的那个发射器。只改视口里正在跑的那一份（速度、暂停、发射器开关），不写场景文件；关掉预览时改回去。播放时视口一直出帧
 * （编辑状态平时按需出帧，见 Game.renderOnDemand）。
 *
 *   agent.particles.set({ entity: id, playing: true, speed: 0.25, solo: 1 });   // 四分之一速度、只看第二个发射器
 *   agent.particles.restart();
 *   agent.particles.set(undefined);                                          // 关掉，改回去
 *
 * 场景改了以后视口里的粒子系统会重建（LiveScene）：每帧按 entity 找现在的那一份，换了就重新记原来的值、再套上预览。
 */
import type { Game } from '../engine/Game';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import type { LiveScene } from './LiveScene';

/** 预览的设置。 */
export interface ParticlePreviewState {
  /** 粒子系统所在的实体（场景文件里的 id）。 */
  readonly entity: string;
  readonly playing: boolean;
  /** 播放速度（1 是正常，0.25 是四分之一）。 */
  readonly speed: number;
  /** 只看第几个发射器（别的先关掉）；undefined 是都看。 */
  readonly solo?: number | undefined;
}

/** 预览前组件自己的值：关掉预览、换实体时改回去。 */
interface Original {
  readonly component: ParticleSystemComponent;
  readonly speed: number;
  readonly enabled: readonly boolean[];
  readonly paused: boolean;
}

export class ParticlePreview {
  readonly #game: Game;
  readonly #live: () => LiveScene | undefined;
  #state: ParticlePreviewState | undefined;
  #original: Original | undefined;
  #release: (() => void) | undefined;

  constructor(game: Game, live: () => LiveScene | undefined) {
    this.#game = game;
    this.#live = live;
  }

  get state(): ParticlePreviewState | undefined {
    return this.#state;
  }

  /** 换预览的设置（undefined 关掉预览、改回去）。 */
  set(state: ParticlePreviewState | undefined): void {
    if (state && (!(state.speed > 0) || !Number.isFinite(state.speed))) throw new Error(`particle preview: speed must be > 0, got ${state.speed}`);
    if (!state || state.entity !== this.#state?.entity) this.#restore();
    this.#state = state;
    // 播放时一直出帧，停下时只出几帧把这一下画出来
    if (state?.playing) this.#release ??= this.#game.holdFrames();
    else {
      this.#release?.();
      this.#release = undefined;
    }
    this.apply();
    this.#game.requestFrames();
  }

  /** 从头放（清掉现在的粒子，发射器从第 0 秒开始）。 */
  restart(): void {
    this.#component()?.particleSystem.resetSimulation();
    this.#game.requestFrames();
  }

  /** @internal 编辑视口每帧调：把预览的设置套到视口里现在的那一份上。 */
  apply(): void {
    const state = this.#state;
    if (!state) return;
    const component = this.#component();
    if (!component) return;
    if (this.#original?.component !== component) {
      const system = component.particleSystem;
      this.#original = { component, speed: component.speed, enabled: system.emitters.map((emitter) => emitter.enabled), paused: system.isPaused };
    }
    const { enabled } = this.#original;
    component.speed = state.speed;
    const system = component.particleSystem;
    system.emitters.forEach((emitter, i) => (emitter.enabled = enabled[i]! && (state.solo === undefined || state.solo === i)));
    if (state.playing && system.isPaused) system.play();
    if (!state.playing && !system.isPaused) system.pause();
  }

  /** 不再预览：放开出帧，组件改回预览前的值（还在的话）。 */
  dispose(): void {
    this.set(undefined);
  }

  #component(): ParticleSystemComponent | undefined {
    const entity = this.#state && this.#live()?.entity(this.#state.entity);
    return entity?.alive ? entity.get(ParticleSystemComponent) : undefined;
  }

  #restore(): void {
    const original = this.#original;
    this.#original = undefined;
    if (!original?.component.entity.alive) return;
    const { component, speed, enabled, paused } = original;
    component.speed = speed;
    component.particleSystem.emitters.forEach((emitter, i) => (emitter.enabled = enabled[i] ?? emitter.enabled));
    if (paused) component.particleSystem.pause();
    else component.particleSystem.play();
  }
}
