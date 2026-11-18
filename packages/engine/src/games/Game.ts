import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { EntityManager } from '../engine/EntityManager';
import { Registry } from '../engine/registry';
import { GraphicsDevice } from '../graphics/GraphicsDevice';
import { GameTime } from './GameTime';

export type GameStatus = 'starting' | 'running' | 'failed' | 'exited';

export interface GameOptions {
  /** Job-system threads of the native module; defaults to hardwareConcurrency - 1. */
  workerThreads?: number;
  /**
   * The game's modules, `import.meta.glob('./**\/*.ts', { eager: true })`: their components, scripts and
   * systems are named after path and export (see engine/registry.ts) before loadContent runs.
   */
  modules?: Readonly<Record<string, unknown>>;
}

// A longer gap (a background tab, a breakpoint) is not simulated in one step.
const MAX_ELAPSED = 0.25;

declare global {
  /** The running game, read by the scripts in tools/ (`status`, `frames`, `sceneFrame`, `error`). */
  var strideGame: Game | undefined;
}

/**
 * Owns the native module, the graphics device, the entities and the frame loop (Stride's Game).
 * Subclass it and override loadContent, update (calling super.update, which runs scripts and systems)
 * and draw; `native` and `graphicsDevice` exist once run() has initialized them. An exception in any of
 * them, or a rejected AsyncScript, stops the game with status 'failed'.
 */
export class Game {
  native!: StrideNative;
  graphicsDevice!: GraphicsDevice;
  readonly updateTime = new GameTime();
  readonly registry = new Registry();
  readonly entities: EntityManager = new EntityManager(this);

  status: GameStatus = 'starting';
  error: string | undefined;
  /** The frame on which the content finished loading. */
  sceneFrame: number | undefined;

  private lastFrameTime: number | undefined;

  get frames(): number {
    return this.updateTime.frameCount;
  }

  async run(canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<void> {
    globalThis.strideGame = this;
    this.entities.onError = (error) => this.fail(error);
    try {
      if (options.modules) this.registry.registerModules(options.modules);
      this.native = await createStrideNative(options.workerThreads === undefined ? {} : { workerThreads: options.workerThreads });
      this.graphicsDevice = await GraphicsDevice.create(canvas);
      await this.loadContent();
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.sceneFrame = this.frames;
    this.status = 'running';
    requestAnimationFrame(this.frame);
  }

  exit(): void {
    if (this.status !== 'running') return;
    this.status = 'exited';
    this.entities.clear();
    this.graphicsDevice.destroy();
    this.native.shutdown();
  }

  protected async loadContent(): Promise<void> {}

  /** Runs scripts and systems; overrides call super.update(time). */
  protected update(time: GameTime): void {
    this.entities.update(time);
  }

  protected draw(_time: GameTime): void {}

  private readonly frame = (now: number): void => {
    if (this.status !== 'running') return;
    const elapsed = this.lastFrameTime === undefined ? 0 : Math.min((now - this.lastFrameTime) / 1000, MAX_ELAPSED);
    this.lastFrameTime = now;
    try {
      this.updateTime.advance(elapsed);
      this.update(this.updateTime);
      this.graphicsDevice.resizeToDisplaySize();
      this.draw(this.updateTime);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    requestAnimationFrame(this.frame);
  };

  private fail(error: unknown): void {
    this.status = 'failed';
    this.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
  }
}
