/**
 * 布料（Stride 没有）：一块长方形的布，Jolt 的软体模拟（Simulation.addSoftBody）——窗帘、旗子、晾着的衣服、挂布、帐篷的门帘。
 * 布在实体本地的 XY 平面里：上边在实体原点的高度往下垂 height 米；pin 选哪些点钉住（钉住的点跟着实体走，follow 关掉时钉在
 * 原地）。会被刚体撞开、搭在东西上，受全局的风（game.wind）吹。画的网格是一个动态网格（Mesh.updateVertices），两面都画，
 * 挂在脚本自己建的实体上（位置是布的质心，不跟实体的旋转、缩放）。
 *
 * 衣服、披风这种贴着骨骼的布（蒙皮约束）、按布料资源建的任意形状以后做。
 */
import { prop } from '../data/prop';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import { Mesh, VERTEX_FLOATS } from '../rendering/mesh/Mesh';
import type { SoftBodyHandle } from './Simulation';

export class Cloth extends SyncScript.props('Cloth', {
  width: prop.number().min(0.01).default(1).unit('m'),
  height: prop.number().min(0.01).default(1).unit('m'),
  /** 点的间距：越小越细、越软、越费（一平方米 0.05 米是 441 个点）。 */
  spacing: prop.number().min(0.01).default(0.05).unit('m'),
  /** 钉住哪些点：上边（窗帘）、上边的两个角（晾着的布）、左边（旗子，左边在实体原点）、不钉（掉下去盖在东西上）。 */
  pin: prop.enum(['top', 'topCorners', 'left', 'none']).default('top'),
  /** 钉住的点跟着实体走（窗帘杆拉动、车上的旗子）；关掉时钉在开始的位置。 */
  follow: prop.bool().default(true),
  /** 面密度：薄棉布 0.1，帆布 0.3，厚呢 0.5。 */
  density: prop.number().min(0.001).default(0.2).unit('kg/m2'),
  /** 拉伸的柔度（米/牛，0 是拉不长）。 */
  stretch: prop.number().min(0).default(0).unit('m/N'),
  /** 弯曲的柔度：越大越软塌，0.1 像丝，0.001 像帆布。 */
  bend: prop.number().min(0).default(0.01).unit('m/N'),
  /** 风的阻力（½·空气密度·阻力系数）；0 是不受风。 */
  windDrag: prop.number().min(0).default(0.6),
  /** 每步解约束几遍：越多越不软塌塌地拉长、越费。 */
  iterations: prop.int().min(1).max(64).default(8),
  /** 布的材质；没有时用默认材质（两面都画）。 */
  material: prop.asset('material').optional(),
  /** 碰撞层，0..31。 */
  layer: prop.int().min(0).max(31).default(0),
}) {
  /** 画布的实体（start 以后才有）。 */
  surface: Entity | undefined;
  #body: SoftBodyHandle | undefined;
  #mesh: Mesh | undefined;
  #state = new Float32Array(0);
  /** 钉住的点和它们在实体本地的位置。 */
  #pinned = new Uint32Array(0);
  #pinnedLocal = new Float64Array(0);
  #targets = new Float64Array(0);
  #wind: [number, number, number] = [0, 0, 0];
  /** 睡下以后已经抄过最后的顶点。 */
  #settled = false;

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`Cloth on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    const grid = clothGrid(this.width, this.height, this.spacing, this.pin);
    const world = this.entity.require(Transform).world;
    const count = grid.positions.length / 3;
    // 顶点放进世界：实体的世界矩阵（带缩放）作用到本地的点上，原点是实体的世界位置
    const vertices = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      const [x, y, z] = transformPoint(world, grid.positions[v * 3]!, grid.positions[v * 3 + 1]!, grid.positions[v * 3 + 2]!);
      vertices.set([x - world[12]!, y - world[13]!, z - world[14]!], v * 3);
    }
    const mass = (this.density * this.width * this.height) / count;
    const inverseMasses = new Float32Array(count).fill(1 / mass);
    for (const v of grid.pinned) inverseMasses[v] = 0;
    this.#body = simulation.addSoftBody({
      vertices, inverseMasses, indices: grid.indices, position: [world[12]!, world[13]!, world[14]!],
      layer: this.layer, iterations: this.iterations, compliance: this.stretch, shearCompliance: this.stretch, bendCompliance: this.bend, bendType: 'distance',
      longRange: grid.pinned.length > 0 ? 'geodesic' : 'none', friction: 0.5, vertexRadius: Math.min(0.01, this.spacing * 0.2), doubleSided: true, neverSleep: this.windDrag > 0,
    });
    this.#pinned = Uint32Array.from(grid.pinned);
    this.#pinnedLocal = Float64Array.from(grid.pinned.flatMap((v) => [grid.positions[v * 3]!, grid.positions[v * 3 + 1]!, grid.positions[v * 3 + 2]!]));
    this.#targets = new Float64Array(this.#pinned.length * 3);
    this.#state = new Float32Array(count * VERTEX_FLOATS);

    // 两面：正面的点后面跟一份法线反过来的背面，三角形反着绕；UV 照正面（背面左右镜像）
    const render = new Float32Array(count * 2 * VERTEX_FLOATS);
    for (let v = 0; v < count; v++) {
      render.set([grid.uvs[v * 2]!, grid.uvs[v * 2 + 1]!], v * VERTEX_FLOATS + 6);
      render.set([1 - grid.uvs[v * 2]!, grid.uvs[v * 2 + 1]!], (count + v) * VERTEX_FLOATS + 6);
    }
    const indices = new Uint32Array(grid.indices.length * 2);
    indices.set(grid.indices);
    for (let t = 0; t < grid.indices.length; t += 3) indices.set([count + grid.indices[t]!, count + grid.indices[t + 2]!, count + grid.indices[t + 1]!], grid.indices.length + t);
    this.#mesh = new Mesh(`${this.entity.name} cloth`, { vertices: render, indices, dynamic: true });
    this.#copyState();
    this.surface = this.entity.manager.create({ name: `${this.entity.name} cloth`, scene: this.entity.scene, components: [Transform] });
    this.#placeSurface();
    // 布的模型：不进光追场景（顶点每帧在变，BVH 按静止网格建）
    this.game.content.addModel(this.surface, { meshes: [{ mesh: this.#mesh, material: 0 }], materials: [this.material ?? null] }, { visibleInRayTracing: false });
    this.disposables.use(simulation.onStep((timeStep) => this.#beforeStep(timeStep)));
  }

  override update(): void {
    if (!this.#body || !this.#mesh) return;
    // 睡着（或者离得远被冻结）的布顶点不变：睡下以后抄最后一次，之后不抄、不上传
    const awake = this.#body.awake();
    if (!awake && this.#settled) return;
    this.#settled = !awake;
    this.#copyState();
    this.#placeSurface();
  }

  override cancel(): void {
    this.#body?.remove();
    this.#body = undefined;
    if (this.surface?.alive) this.surface.destroy();
    this.surface = undefined;
    this.#mesh?.dispose();
    this.#mesh = undefined;
  }

  /** 每个物理步之前：钉住的点走到实体现在的位置，风吹。 */
  #beforeStep(timeStep: number): void {
    const body = this.#body!;
    if (this.follow && this.#pinned.length > 0) {
      const world = this.entity.require(Transform).world;
      for (let i = 0; i < this.#pinned.length; i++) {
        const [x, y, z] = transformPoint(world, this.#pinnedLocal[i * 3]!, this.#pinnedLocal[i * 3 + 1]!, this.#pinnedLocal[i * 3 + 2]!);
        this.#targets.set([x, y, z], i * 3);
      }
      body.pin(this.#pinned, this.#targets, timeStep);
    }
    if (this.windDrag > 0) {
      const at = this.surface!.require(Transform).position, origin = this.game.renderOrigin;
      this.game.wind.sample(at.x - origin[0], at.y - origin[1], at.z - origin[2], this.#wind);
      body.wind(this.#wind, this.windDrag, timeStep);
    }
  }

  #origin: [number, number, number] = [0, 0, 0];

  /** 软体的顶点抄进画的网格（正面照抄，背面法线取反）。 */
  #copyState(): void {
    const state = this.#state, render = this.#mesh!.data.vertices as Float32Array;
    this.#origin = this.#body!.vertices(state, VERTEX_FLOATS);
    const count = state.length / VERTEX_FLOATS;
    for (let v = 0; v < count; v++) {
      const from = v * VERTEX_FLOATS, front = from, back = (count + v) * VERTEX_FLOATS;
      for (let k = 0; k < 3; k++) {
        render[front + k] = render[back + k] = state[from + k]!;
        render[front + 3 + k] = state[from + 3 + k]!;
        render[back + 3 + k] = -state[from + 3 + k]!;
      }
    }
    this.#mesh!.updateVertices();
  }

  #placeSurface(): void {
    const position = this.surface!.require(Transform).position;
    position.x = this.#origin[0];
    position.y = this.#origin[1];
    position.z = this.#origin[2];
  }
}

/** 布的格子：点（本地 XY 平面，上边 y = 0 往下）、UV、三角形（正面朝 +Z），按 pin 选的固定点。 */
export function clothGrid(width: number, height: number, spacing: number, pin: Cloth['pin']): { positions: Float32Array; uvs: Float32Array; indices: Uint32Array; pinned: number[] } {
  const columns = Math.max(1, Math.round(width / spacing)) + 1, rows = Math.max(1, Math.round(height / spacing)) + 1;
  const left = pin === 'left' ? 0 : -width / 2;
  const positions = new Float32Array(columns * rows * 3), uvs = new Float32Array(columns * rows * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const v = r * columns + c, u = c / (columns - 1), t = r / (rows - 1);
      positions.set([left + u * width, -t * height, 0], v * 3);
      uvs.set([u, t], v * 2);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < columns; c++) {
      const a = r * columns + c;
      // 正面朝 +Z（从 +Z 看逆时针）；对角线交替，布折起来不偏向一边
      if ((r + c) % 2 === 0) indices.push(a, a + columns, a + columns + 1, a, a + columns + 1, a + 1);
      else indices.push(a, a + columns, a + 1, a + 1, a + columns, a + columns + 1);
    }
  }
  const pinned = pin === 'top' ? Array.from({ length: columns }, (_, c) => c)
    : pin === 'topCorners' ? [0, columns - 1]
    : pin === 'left' ? Array.from({ length: rows }, (_, r) => r * columns)
    : [];
  return { positions, uvs, indices: Uint32Array.from(indices), pinned };
}

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}
