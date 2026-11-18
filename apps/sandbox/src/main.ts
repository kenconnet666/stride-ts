/// <reference types="vite/client" />
// Smoke test of the whole stack: Vite with cross-origin isolation, the native module with its worker
// threads, WebGPU, the frame loop, and the entity core (an AsyncScript spawning particles that systems
// move and expire). Boxes fall in Jolt; nothing is rendered yet but the clear color, so the stats
// overlay shows what happens.
import { Game, system, type GameTime } from '@stride-ts/engine';
import type { PhysicsWorld } from '@stride-ts/native';
import { Fountain } from './game/fountain';
import { expire, integrate, Position } from './game/particles';

const GRID = 10;
const STATS_INTERVAL = 0.25;
// Fixed physics step like Stride's simulation: long steps let fast boxes tunnel through the ground.
const PHYSICS_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

/** Particle count and mean height, gathered after the particles moved. */
const particles = { count: 0, sumY: 0 };
const measure = system({
  with: { position: Position },
  phase: 'afterPhysics',
  update({ position, count }) {
    particles.count += count;
    for (let i = 0; i < count; i++) particles.sumY += position.y[i]!;
  },
});

class SandboxGame extends Game {
  private world!: PhysicsWorld;
  private fountain!: Fountain;
  private firstBox = 0;
  private physicsTime = 0;
  private stepMilliseconds = 0;
  private entitiesMilliseconds = 0;
  private statsTime = 0;
  private readonly stats: HTMLElement;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    this.world = this.native.createPhysicsWorld(GRID * GRID + 1);
    this.world.addBox({ position: [0, -1, 0], halfExtent: [50, 1, 50], motion: 'static' });
    this.firstBox = this.world.addBoxes(
      Array.from({ length: GRID * GRID }, (_, i) => ({
        position: [(i % GRID) * 1.5 - 7, 5 + Math.floor(i / GRID) * 1.2, 0],
        halfExtent: [0.5, 0.5, 0.5],
      })),
    );
    this.entities.addSystems(integrate, expire, measure);
    this.fountain = this.entities.create({ name: 'fountain', components: [Fountain.with({ burst: 2_000, interval: 0.5 })] }).require(Fountain);
  }

  protected override update(time: GameTime): void {
    particles.count = 0;
    particles.sumY = 0;
    const start = performance.now();
    super.update(time);
    this.entitiesMilliseconds = performance.now() - start;

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
      `entities ${this.entities.count}  scripts + systems ${this.entitiesMilliseconds.toFixed(2)} ms  particles ${particles.count}, mean height ${(particles.sumY / Math.max(1, particles.count)).toFixed(2)} m, spawned ${this.fountain.spawned}`,
      `registered: ${Fountain.scriptName}, ${integrate.name}, ${expire.name}`,
    ].join('\n');
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const stats = document.querySelector<HTMLElement>('#stats')!;
new SandboxGame(stats).run(canvas, { modules: import.meta.glob('./game/**/*.ts', { eager: true }) }).catch((error: unknown) => {
  stats.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
});
