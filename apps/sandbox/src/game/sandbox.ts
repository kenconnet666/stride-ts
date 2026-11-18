// 沙盒游戏本身：箱子是带 Transform 的实体，Jolt 步进后把位姿直接写回原生的变换存储，渲染器从那里上传
// 世界矩阵、实例化绘制；AsyncScript 生成粒子，系统移动并回收它们（粒子只是数据，不画，看左上角的统计）。
// 系统和标签都导出：按名字登记之后，热重载才能把它们换成新版本（docs/architecture.md 的“热重载”）。
import { Camera, Game, Material, Mesh, MeshRenderFeature, Model, system, tag, Transform, transformSlot, type GameTime } from '@stride-ts/engine';
import type { PhysicsWorld } from '@stride-ts/native';
import { Fountain } from './fountain';
import { expire, integrate, Position } from './particles';

const GRID = 10;
const STATS_INTERVAL = 0.25;
// 和 Stride 的物理一样用固定步长：步长太长时快速下落的箱子会穿过地面。
const PHYSICS_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;

/** 粒子数和平均高度，在粒子移动之后统计。 */
const particles = { count: 0, sumY: 0 };
export const measure = system({
  with: { position: Position },
  phase: 'afterPhysics',
  update({ position, count }) {
    particles.count += count;
    for (let i = 0; i < count; i++) particles.sumY += position.y[i]!;
  },
});

export const Crate = tag('Crate');

/** 箱子的高度，从世界矩阵读（上一帧末尾算的，物理已经把位姿写回了槽位）。 */
const crates = { count: 0, sumY: 0, lowestY: Infinity };
export const measureCrates = system({
  with: { transform: Transform, crate: Crate },
  phase: 'afterPhysics',
  update({ transform, count }) {
    crates.count += count;
    for (let i = 0; i < count; i++) {
      const y = transform.world[transform.slot[i]! * 16 + 13]!;
      crates.sumY += y;
      crates.lowestY = Math.min(crates.lowestY, y);
    }
  },
});

export class SandboxGame extends Game {
  private world!: PhysicsWorld;
  private fountain!: Fountain;
  private physicsTime = 0;
  private stepMilliseconds = 0;
  private entitiesMilliseconds = 0;
  private drawMilliseconds = 0;
  private statsTime = 0;
  private readonly stats: HTMLElement;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    this.world = this.native.createPhysicsWorld(GRID * GRID + 1, { transforms: this.transforms });
    this.world.addBox({ position: [0, -1, 0], halfExtent: [50, 1, 50], motion: 'static' });
    // 箱子先作为实体放好，刚体从它们的 Transform 出发
    const boxes = Array.from({ length: GRID * GRID }, (_, i) =>
      this.entities.create({
        name: `crate ${i}`,
        components: [Transform.with({ position: [(i % GRID) * 1.5 - 7, 5 + Math.floor(i / GRID) * 1.2, 0] }), Crate],
      }),
    );
    this.world.addBoxes(boxes.map((box) => ({ halfExtent: [0.5, 0.5, 0.5], transform: transformSlot(box) })));

    // 看得见的部分：每排箱子一种颜色（同网格同材质的合成一次实例化绘制），地面和相机
    const cube = Mesh.cube();
    const palette = [[0.8, 0.25, 0.1], [0.9, 0.6, 0.1], [0.2, 0.6, 0.3], [0.15, 0.35, 0.8], [0.6, 0.2, 0.7]] as const;
    const materials = palette.map((color, i) => new Material(`crate ${i}`, { baseColor: color }));
    boxes.forEach((box, i) => box.add(Model.with({ mesh: cube.id, material: materials[Math.floor(i / GRID) % materials.length]!.id })));
    const ground = new Material('ground', { baseColor: [0.35, 0.35, 0.33] });
    this.entities.create({ name: 'ground', components: [Transform, Model.with({ mesh: Mesh.plane(100, 100).id, material: ground.id })] });
    // 绕 X 轴低头 12°
    const pitch = (-12 * Math.PI) / 180;
    this.entities.create({
      name: 'camera',
      components: [Transform.with({ position: [0, 7, 24], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] }), Camera],
    });
    this.entities.addSystems(integrate, expire, measure, measureCrates);
    this.fountain = this.entities.create({ name: 'fountain', components: [Fountain.with({ burst: 2_000, interval: 0.5 })] }).require(Fountain);
  }

  protected override update(time: GameTime): void {
    particles.count = 0;
    particles.sumY = 0;
    crates.count = 0;
    crates.sumY = 0;
    crates.lowestY = Infinity;
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

  protected override draw(time: GameTime): void {
    const start = performance.now();
    super.draw(time);
    this.drawMilliseconds = performance.now() - start;
  }

  private showStats(time: GameTime): void {
    const { width, height } = this.graphicsDevice.canvas;
    this.stats.textContent = [
      `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps  ${width}x${height}`,
      `native workers ${this.native.workerThreadCount}  crossOriginIsolated ${crossOriginIsolated}`,
      `render: ${this.renderSystem.features.filter((f) => f instanceof MeshRenderFeature).map((f) => `${f.instanceCount} instances in ${f.batches.filter((b) => b.count > 0).length} draws`).join(', ')}  draw ${this.drawMilliseconds.toFixed(2)} ms`,
      `physics ${crates.count} crates  step ${this.stepMilliseconds.toFixed(2)} ms  height from world matrices: mean ${(crates.sumY / Math.max(1, crates.count)).toFixed(2)} m, lowest ${crates.lowestY.toFixed(2)} m`,
      `entities ${this.entities.count}  scripts + systems ${this.entitiesMilliseconds.toFixed(2)} ms  particles ${particles.count}, mean height ${(particles.sumY / Math.max(1, particles.count)).toFixed(2)} m, spawned ${this.fountain.spawned}`,
      `registered: ${Fountain.scriptName}, ${integrate.name}, ${expire.name}`,
    ].join('\n');
  }
}
