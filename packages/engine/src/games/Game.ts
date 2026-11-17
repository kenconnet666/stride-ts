import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { GraphicsDevice } from '../graphics/GraphicsDevice';
import { GameTime } from './GameTime';

export type GameStatus = 'starting' | 'running' | 'failed' | 'exited';

export interface GameOptions {
  /** Job-system threads of the native module; defaults to hardwareConcurrency - 1. */
  workerThreads?: number;
}

// A longer gap (a background tab, a breakpoint) is not simulated in one step.
const MAX_ELAPSED = 0.25;

/**
 * Owns the native module, the graphics device and the frame loop (Stride's Game).
 * Subclass it and override loadContent, update and draw; `native` and `graphicsDevice` exist once
 * run() has initialized them. An exception in any of them stops the game with status 'failed'.
 *
 * While running, the game is also `globalThis.strideGame`, which the scripts in tools/ read
 * (`status`, `frames`, `sceneFrame`, `error`).
 */
export class Game {
  native!: StrideNative;
  graphicsDevice!: GraphicsDevice;
  readonly updateTime = new GameTime();

  status: GameStatus = 'starting';
  error: string | undefined;
  /** The frame on which the content finished loading. */
  sceneFrame: number | undefined;

  private lastFrameTime: number | undefined;

  get frames(): number {
    return this.updateTime.frameCount;
  }

  async run(canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<void> {
    (globalThis as { strideGame?: Game }).strideGame = this;
    try {
      this.native = await createStrideNative(options);
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
    this.graphicsDevice.destroy();
    this.native.shutdown();
  }

  protected async loadContent(): Promise<void> {}

  protected update(_time: GameTime): void {}

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
  }
}
