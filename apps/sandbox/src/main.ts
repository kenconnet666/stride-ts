// Smoke test of the whole stack: Vite with cross-origin isolation, the native module with its
// worker threads, WebGPU, and the frame loop. Boxes fall in Jolt; nothing is rendered yet but the
// clear color, so the stats overlay shows what physics does.
import { Game, type GameTime } from '@stride-ts/engine';
import type { PhysicsWorld } from '@stride-ts/native';

const GRID = 10;
const STATS_INTERVAL = 0.25;
// Fixed physics step like Stride's simulation: long steps let fast boxes tunnel through the ground.
const PHYSICS_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

class SandboxGame extends Game {
  private world!: PhysicsWorld;
  private firstBox = 0;
  private physicsTime = 0;
  private stepMilliseconds = 0;
  private statsTime = 0;
  private readonly stats: HTMLElement;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    this.world = this.native.createPhysicsWorld(GRID * GRID + 1);
    this.world.addBox([0, -1, 0], [50, 1, 50], false);
    for (let i = 0; i < GRID * GRID; i++) {
      const index = this.world.addBox([(i % GRID) * 1.5 - 7, 5 + Math.floor(i / GRID) * 1.2, 0], [0.5, 0.5, 0.5], true);
      if (i === 0) this.firstBox = index;
    }
  }

  protected override update(time: GameTime): void {
    this.physicsTime = Math.min(this.physicsTime + time.elapsed, PHYSICS_STEP * MAX_STEPS_PER_FRAME);
    for (; this.physicsTime >= PHYSICS_STEP; this.physicsTime -= PHYSICS_STEP) {
      const start = performance.now();
      this.world.step(PHYSICS_STEP);
      this.stepMilliseconds = performance.now() - start;
    }
    if (time.total - this.statsTime >= STATS_INTERVAL) {
      this.statsTime = time.total;
      this.showStats(time);
    }
  }

  protected override draw(): void {
    const { device, queue } = this.graphicsDevice;
    const encoder = device.createCommandEncoder();
    encoder.beginRenderPass({
      colorAttachments: [{
        view: this.graphicsDevice.currentBackBuffer().createView(),
        clearValue: { r: 0.1, g: 0.12, b: 0.16, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    }).end();
    queue.submit([encoder.finish()]);
  }

  private showStats(time: GameTime): void {
    const positions = this.world.positions();
    let sumY = 0;
    let lowestY = Infinity;
    for (let i = this.firstBox; i < this.world.bodyCount; i++) {
      const y = positions[i * 3 + 1]!;
      sumY += y;
      lowestY = Math.min(lowestY, y);
    }
    const boxes = this.world.bodyCount - this.firstBox;
    const { width, height } = this.graphicsDevice.canvas;
    this.stats.textContent = [
      `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps  ${width}x${height}`,
      `native workers ${this.native.workerThreadCount}  crossOriginIsolated ${crossOriginIsolated}`,
      `physics ${boxes} boxes  step ${this.stepMilliseconds.toFixed(2)} ms  height mean ${(sumY / boxes).toFixed(2)} m, lowest ${lowestY.toFixed(2)} m`,
    ].join('\n');
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
new SandboxGame(stats).run(canvas).catch((error: unknown) => {
  stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
});
