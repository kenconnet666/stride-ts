/**
 * 在模型上画贴图的视口工具（S2，绘制层的遮罩）：光标下最近的网格面上画出笔刷的球；左键按着时每挪过笔刷半径的四分之一落一笔
 * （拖得快时中间补上），画完拷回贴图（视口马上看到）；松开时读回像素交给 onStroke 存盘。也给调试命令 paint 用（沿点列画）。
 */
import type { Entity } from '../../../engine/Entity';
import { Transform } from '../../../engine/transform';
import type { DebugColor } from '../../../debug/DebugDraw';
import { Model, ModelPart } from '../../../rendering/components';
import type { Material } from '../../../rendering/mesh/Material';
import { Mesh } from '../../../rendering/mesh/Mesh';
import { raycastMesh, type MeshPainter, type PaintTarget } from '../../../rendering/paint/MeshPainter';
import { currentWorld } from '../worldBoxes';
import type { Point3, ViewportFrame, ViewportTool } from './ViewportTool';

/** 绘制的笔刷（半径米，硬度、强度 0..1；erase 是画 0）。 */
export interface PaintBrush {
  readonly radius: number;
  readonly hardness: number;
  readonly strength: number;
  readonly erase: boolean;
}

export const DEFAULT_PAINT_BRUSH: PaintBrush = { radius: 0.25, hardness: 0.5, strength: 0.8, erase: false };

/** 读回的遮罩像素。 */
export interface PaintImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array<ArrayBuffer>;
}

/** 笔刷的球：画是白的，擦是红的。 */
const BRUSH_COLOR: DebugColor = [1, 1, 1, 0.9];
const ERASE_COLOR: DebugColor = [1, 0.3, 0.3, 0.9];

export class PaintTool implements ViewportTool {
  /** 画的实体（场景文件的 id）：画它（和它的 ModelPart 子实体）上用 material 的网格。 */
  readonly entity: string;
  readonly material: Material;
  /** 遮罩贴图的内容路径（线性的 png）。 */
  readonly mask: string;
  readonly painter: MeshPainter;
  brush: PaintBrush;
  /** 一笔画完（松开左键）以后调：遮罩的内容路径和读回的像素（编辑器存成 png）。 */
  onStroke: ((mask: string, image: PaintImage) => void) | undefined;
  /** 正在画的一笔：上一笔落在哪（世界坐标），画没画上。 */
  #stroke: { last: Point3 | undefined; painted: boolean } | undefined;

  constructor(entity: string, material: Material, mask: string, painter: MeshPainter, brush: PaintBrush = DEFAULT_PAINT_BRUSH) {
    this.entity = entity;
    this.material = material;
    this.mask = mask;
    this.painter = painter;
    this.brush = brush;
  }

  dispose(): void {
    this.painter.destroy();
  }

  /** 实体上用这个材质的网格和它们现在的世界矩阵（模型多出来的网格在子实体 ModelPart 上）。 */
  targets(entity: Entity | undefined): PaintTarget[] {
    if (!entity?.alive) return [];
    const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
    return parts.flatMap((part) => {
      const model = part.get(Model);
      const mesh = model && model.material === this.material.id ? Mesh.byId(model.mesh) : undefined;
      return mesh ? [{ mesh, world: new Float32Array(currentWorld(part)) }] : [];
    });
  }

  /** 落一笔（center 是世界坐标）。 */
  dab(targets: readonly PaintTarget[], center: Point3, brush: PaintBrush = this.brush): void {
    const { radius, hardness, strength, erase } = brush;
    this.painter.dab(targets, { center, radius, hardness, strength, value: erase ? [0, 0, 0, 1] : [1, 1, 1, 1] });
  }

  update(frame: ViewportFrame): void {
    const ray = frame.ray(frame.pixel);
    const origin = [ray.origin.x, ray.origin.y, ray.origin.z], direction = [ray.direction.x, ray.direction.y, ray.direction.z];
    const targets = this.targets(frame.agent.live?.entity(this.entity));
    let hit: ReturnType<typeof raycastMesh>;
    for (const { mesh, world } of targets) {
      const found = raycastMesh(mesh, world, origin, direction);
      if (found && (!hit || found.distance < hit.distance)) hit = found;
    }
    const { brush } = this;
    if (hit) frame.game.debugDraw.sphere(hit.point, brush.radius, brush.erase ? ERASE_COLOR : BRUSH_COLOR, { width: 1, segments: 24 });
    if (frame.pressed) this.#stroke = { last: undefined, painted: false };
    const stroke = this.#stroke;
    if (stroke && frame.down && hit) {
      const spacing = brush.radius * 0.25;
      const from = stroke.last ?? hit.point;
      const gap = Math.hypot(hit.point[0] - from[0], hit.point[1] - from[1], hit.point[2] - from[2]);
      // 第一笔落在按下的地方；之后按间距补上中间的点
      const steps = stroke.last ? Math.floor(gap / spacing) : 1;
      for (let i = 1; i <= steps; i++) {
        const t = stroke.last ? (i * spacing) / gap : 1;
        const center: Point3 = [from[0] + (hit.point[0] - from[0]) * t, from[1] + (hit.point[1] - from[1]) * t, from[2] + (hit.point[2] - from[2]) * t];
        this.dab(targets, center);
        stroke.last = center;
        stroke.painted = true;
      }
      this.painter.commit();
    }
    if (frame.released && stroke) {
      this.#stroke = undefined;
      if (stroke.painted) void this.painter.read().then((image) => this.onStroke?.(this.mask, image));
    }
  }
}
