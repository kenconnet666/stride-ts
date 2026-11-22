/**
 * 编辑器在视口里要的几何：实体现在的世界矩阵、选中框（模型、粒子、放在 3D 里的 UI 的包围盒）、反射探针影响的盒子。
 * 选中框和聚焦（EditAgent.bounds）、视口里画框（EditorViewport）用同一份。
 */
import type { Entity } from '../../engine/Entity';
import { Transform } from '../../engine/transform';
import type { Game } from '../../engine/Game';
import { Matrix } from '../../data/Matrix';
import { GaussianSplat, Light, Model, ModelPart, PlanarReflection, ReflectionProbe } from '../../rendering/components';
import { SplatCloud } from '../../rendering/splats/SplatRenderer';
import { Mesh } from '../../rendering/mesh/Mesh';
import { ParticleSystemComponent } from '../../particles/ParticleSystemComponent';
import { UIComponent } from '../../ui/UIComponent';

/**
 * 实体现在的世界矩阵。世界矩阵平时每帧统一算一次；文档刚改过（或者场景刚打开）的这一帧里它还是旧的，所以编辑器要用
 * 世界位姿的地方都先算一下这个实体和它的祖先。
 */
export function currentWorld(entity: Entity): Float64Array {
  const transform = entity.require(Transform);
  transform.updateWorldMatrix();
  return transform.world;
}

/** 世界里的一个盒子：矩阵（中心在原点，双精度：大世界里远处的框也准）和半边长。 */
export interface WorldBox {
  readonly matrix: Float32Array | Float64Array;
  readonly halfExtents: readonly [number, number, number];
}

/**
 * 实体在视口里的选中框（点选能点到的那些东西）：模型（它自己的和引擎给多出来的网格建的子实体的）的包围盒；粒子系统的包围
 * 形状，没有时是活着的粒子占的范围；放在 3D 里的 UI 的那块板；矩形光的发光面、平面反射的盒子（点选点不到，选中了看得见它在哪、多大）。
 */
export function selectionBoxes(game: Game, entity: Entity): WorldBox[] {
  const boxes = modelBoxes(entity);
  const particles = entity.get(ParticleSystemComponent)?.particleSystem;
  const bounds = particles && (particles.worldBounds() ?? particles.particleBounds());
  if (bounds) {
    const [min, max] = bounds;
    boxes.push({
      matrix: Matrix.scaleTranslation(new Float32Array(16), 1, 1, 1, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2),
      halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
    });
  }
  const ui = entity.get(UIComponent);
  const board = ui && game.ui.worldBox(ui);
  if (board) boxes.push(board);
  const light = entity.get(Light);
  if (light?.type === 'rect') boxes.push({ matrix: currentWorld(entity), halfExtents: [light.width / 2, light.height / 2, 0.005] });
  if (light?.type === 'disc') boxes.push({ matrix: currentWorld(entity), halfExtents: [light.width / 2, light.width / 2, 0.005] });
  if (light?.type === 'tube') boxes.push({ matrix: currentWorld(entity), halfExtents: [light.width / 2, 0.02, 0.02] });
  // 高斯泼溅的包围盒（跟着实体转）
  const splat = entity.get(GaussianSplat);
  const cloud = splat && SplatCloud.byId(splat.splats);
  if (cloud) {
    const center = [0, 1, 2].map((k) => (cloud.min[k]! + cloud.max[k]!) / 2);
    const local = Matrix.scaleTranslation(new Float32Array(16), 1, 1, 1, center[0]!, center[1]!, center[2]!);
    boxes.push({ matrix: Matrix.multiply(new Float64Array(16), currentWorld(entity), local), halfExtents: [0, 1, 2].map((k) => (cloud.max[k]! - cloud.min[k]!) / 2) as [number, number, number] });
  }
  // 平面反射的影响盒子（跟着实体转）
  const planar = entity.get(PlanarReflection);
  if (planar) boxes.push({ matrix: currentWorld(entity), halfExtents: [planar.size.x / 2, planar.size.y / 2, planar.size.z / 2] });
  return boxes;
}

/**
 * 反射探针影响的盒子（同 rendering/lighting/ReflectionProbes 的算法）：以实体为中心、按世界的轴摆，边长是 size 乘实体的缩放；blend 是
 * 过渡距离（离盒子的面这么近以内淡出）。实体上没有探针时是 undefined。
 */
export function probeBoxes(entity: Entity): { matrix: Float32Array | Float64Array; halfExtents: [number, number, number]; blend: number } | undefined {
  const probe = entity.get(ReflectionProbe);
  if (!probe) return undefined;
  const { translation, scale } = Matrix.decompose(currentWorld(entity));
  return {
    matrix: Matrix.scaleTranslation(new Float32Array(16), 1, 1, 1, ...translation),
    halfExtents: [Math.abs(probe.size.x * scale[0]) / 2, Math.abs(probe.size.y * scale[1]) / 2, Math.abs(probe.size.z * scale[2]) / 2],
    blend: probe.blendDistance,
  };
}

/** 实体的模型（它自己的和引擎给多出来的网格建的子实体的）在世界里的包围盒。 */
export function modelBoxes(entity: Entity): WorldBox[] {
  const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
  const boxes: WorldBox[] = [];
  for (const part of parts) {
    const mesh = Mesh.byId(part.get(Model)?.mesh ?? -1);
    if (!mesh) continue;
    const { min, max } = mesh.bounds;
    const center = Matrix.scaleTranslation(new Float32Array(16), 1, 1, 1, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    boxes.push({
      matrix: Matrix.multiply(new Float64Array(16), currentWorld(part), center),
      halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
    });
  }
  return boxes;
}
