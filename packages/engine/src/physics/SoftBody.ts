/**
 * 软的东西（Stride 没有）：按一个模型建 Jolt 的软体——气球、沙包、果冻、软垫、轮胎这类撞了会变形又弹回来的。模型的顶点按位置
 * 焊在一起（接缝上的重复顶点算一个质点），边、剪切、弯曲约束按三角形自动建；封闭的模型给 pressure 时像充了气（越大越鼓、越硬）。
 * 摆在实体现在的世界位姿上（带缩放），之后自己动：画的是脚本建的实体上的动态网格（位置是软体的质心，不跟原实体走）。
 *
 * 和 Cloth 一样受 game.wind 吹（windDrag 不为 0 时）、被远处物理的降级冻结；实体上别挂别的模型和碰撞体。
 */
import { prop } from '../data/prop';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { LoadedModel } from '../content/ContentManager';
import { meshFloatVertices } from '../content/modelFile';
import { Mesh, VERTEX_FLOATS } from '../rendering/mesh/Mesh';
import type { SoftBodyHandle } from './Simulation';

export class SoftBody extends SyncScript.props('SoftBody', {
  /** 软体的形状（也是画它的模型）。 */
  model: prop.asset('model'),
  /** 总质量（千克），平均分给每个质点。 */
  mass: prop.number().min(0.001).default(1).unit('kg'),
  /** 封闭的模型里气体的压力（n·R·T）：0 是不充气（软塌塌的），几百到几千像充了气的球。 */
  pressure: prop.number().min(0).default(0),
  /** 拉伸的柔度（米/牛，0 是拉不长）。 */
  stretch: prop.number().min(0).default(0.0001).unit('m/N'),
  /** 弯曲的柔度：越大越软塌。 */
  bend: prop.number().min(0).default(0.001).unit('m/N'),
  /** 每步解约束几遍。 */
  iterations: prop.int().min(1).max(64).default(8),
  friction: prop.number().min(0).default(0.5),
  /** 风的阻力（½·空气密度·阻力系数）；0 是不受风。 */
  windDrag: prop.number().min(0).default(0),
  /** 碰撞层，0..31。 */
  layer: prop.int().min(0).max(31).default(0),
}) {
  /** 画软体的实体（start 以后才有）。 */
  surface: Entity | undefined;
  #body: SoftBodyHandle | undefined;
  #meshes: { readonly mesh: Mesh; readonly welded: Uint32Array }[] = [];
  #state = new Float32Array(0);
  #origin: [number, number, number] = [0, 0, 0];
  #wind: [number, number, number] = [0, 0, 0];
  #settled = false;

  override start(): void {
    const simulation = this.game.simulation;
    if (!simulation) throw new Error(`SoftBody on '${this.entity.name}': the game runs without physics (nativeFeatures: [physics])`);
    const shape = weldModel(this.model);
    if (shape.indices.length < 3) throw new Error(`SoftBody on '${this.entity.name}': the model has no triangles`);
    const world = this.entity.require(Transform).world;
    const count = shape.positions.length / 3;
    const vertices = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      const x = shape.positions[v * 3]!, y = shape.positions[v * 3 + 1]!, z = shape.positions[v * 3 + 2]!;
      vertices[v * 3] = world[0]! * x + world[4]! * y + world[8]! * z;
      vertices[v * 3 + 1] = world[1]! * x + world[5]! * y + world[9]! * z;
      vertices[v * 3 + 2] = world[2]! * x + world[6]! * y + world[10]! * z;
    }
    this.#body = simulation.addSoftBody({
      vertices, inverseMasses: new Float32Array(count).fill(count / this.mass), indices: shape.indices, position: [world[12]!, world[13]!, world[14]!],
      layer: this.layer, iterations: this.iterations, compliance: this.stretch, shearCompliance: this.stretch, bendCompliance: this.bend,
      pressure: this.pressure, friction: this.friction, vertexRadius: 0.005, neverSleep: this.windDrag > 0,
    });
    this.#state = new Float32Array(count * VERTEX_FLOATS);
    // 每个网格一份动态网格：画用的顶点（带 UV）按 welded 取焊过的质点的位置和法线
    const meshes = this.model.meshes.map(({ mesh, material }, i) => {
      const source = meshFloatVertices({ vertices: mesh.data.vertices, layout: mesh.layout, dequantize: mesh.dequantize });
      const dynamic = new Mesh(`${this.entity.name} soft ${i}`, { vertices: source, indices: Uint32Array.from(mesh.data.indices), dynamic: true });
      this.#meshes.push({ mesh: dynamic, welded: shape.welded[i]! });
      return { mesh: dynamic, material };
    });
    this.#copyState();
    this.surface = this.entity.manager.create({ name: `${this.entity.name} soft`, scene: this.entity.scene, components: [Transform] });
    this.#placeSurface();
    this.game.content.addModel(this.surface, { meshes, materials: this.model.materials }, { visibleInRayTracing: false });
    if (this.windDrag > 0) {
      this.disposables.use(simulation.onStep((timeStep) => {
        const at = this.surface!.require(Transform).position, origin = this.game.renderOrigin;
        this.game.wind.sample(at.x - origin[0], at.y - origin[1], at.z - origin[2], this.#wind);
        this.#body!.wind(this.#wind, this.windDrag, timeStep);
      }));
    }
  }

  override update(): void {
    if (!this.#body) return;
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
    for (const { mesh } of this.#meshes) mesh.dispose();
    this.#meshes = [];
  }

  #copyState(): void {
    const state = this.#state;
    this.#origin = this.#body!.vertices(state, VERTEX_FLOATS);
    for (const { mesh, welded } of this.#meshes) {
      const render = mesh.data.vertices as Float32Array;
      for (let v = 0; v < welded.length; v++) {
        const from = welded[v]! * VERTEX_FLOATS, to = v * VERTEX_FLOATS;
        for (let k = 0; k < 6; k++) render[to + k] = state[from + k]!;
      }
      mesh.updateVertices();
    }
  }

  #placeSurface(): void {
    const position = this.surface!.require(Transform).position;
    position.x = this.#origin[0];
    position.y = this.#origin[1];
    position.z = this.#origin[2];
  }
}

/**
 * 模型的所有网格合成一个软体的形状：位置相同（差不到 0.1 毫米）的顶点焊成一个质点。welded[网格][顶点] 是这个顶点对应的质点。
 */
export function weldModel(model: Pick<LoadedModel, 'meshes'>): { positions: Float32Array; indices: Uint32Array; welded: Uint32Array[] } {
  const lookup = new Map<string, number>();
  const positions: number[] = [];
  const indices: number[] = [];
  const welded = model.meshes.map(({ mesh }) => {
    const p = mesh.positions();
    const map = new Uint32Array(p.length / 3);
    for (let v = 0; v < map.length; v++) {
      const key = `${Math.round(p[v * 3]! * 1e4)},${Math.round(p[v * 3 + 1]! * 1e4)},${Math.round(p[v * 3 + 2]! * 1e4)}`;
      let index = lookup.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        lookup.set(key, index);
        positions.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
      }
      map[v] = index;
    }
    const source = mesh.data.indices;
    for (let t = 0; t + 2 < source.length; t += 3) {
      const a = map[source[t]!]!, b = map[source[t + 1]!]!, c = map[source[t + 2]!]!;
      // 焊完退化的（两个角焊成了一个点）不进软体
      if (a !== b && b !== c && a !== c) indices.push(a, b, c);
    }
    return map;
  });
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), welded };
}
