/**
 * 编辑关卡白盒（.brush.json）的视口工具：画每个笔刷的有向包围盒（加的白、减的红、交的蓝，选中的橙色），选中的笔刷六个面的
 * 中心各有一个手柄；左键点一下选中点到的笔刷（同一处再点换成后面的那个，点空处取消），双击一个面在它外侧贴着加一个同样大小的
 * 方块，按在手柄上拖改尺寸（对面不动；吸附开着时按移动的步长，Ctrl 反过来）。拖的时候每帧换白盒（线框跟着动，模型等松开后
 * 存文件、后端重新烘），松开、加方块时 commit。关了深度测试：被挡住、挖掉的笔刷也看得见、点得到。纯函数在 brushShapes.ts。
 */
import type { BrushFile, BrushShapeFile } from '../../../content/formats/assetFormat';
import { Matrix } from '../../../data/Matrix';
import type { DebugColor } from '../../../debug/DebugDraw';
import { currentWorld } from '../worldBoxes';
import { addBoxOnFace, brushBox, clickBrush, faceCenter, pickBrushFace, resizeBrushFace } from './brushShapes';
import { pickVertex } from './polyPicking';
import { ACTIVE_COLOR, Clicks, drawPointBox, FileEditTool, SELECTED_COLOR, VERTEX_SCREEN_SIZE, type Pixel, type ViewportFrame } from './ViewportTool';

/** 笔刷的线框：加的、减的、交的。 */
const OPERATION_COLORS: Readonly<Record<BrushShapeFile['operation'], DebugColor>> = {
  add: [0.85, 0.88, 0.95, 0.75], subtract: [1, 0.35, 0.3, 0.85], intersect: [0.35, 0.6, 1, 0.85],
};
/** 光标离手柄在屏幕上多少像素以内算按到；手柄的方块按轴着色，指着的、拖着的黄色。 */
const HANDLE_PIXELS = 12;
const HANDLE_COLORS: readonly DebugColor[] = [[1, 0.15, 0.15, 1], [0.25, 0.9, 0.2, 1], [0.2, 0.4, 1, 1]];

type Vec3 = readonly [number, number, number];

/**
 * 射线上离直线（过 point、单位方向 axis）最近的那一点在直线上的位置（从 point 量的长度）：拖手柄用。射线和直线差不多平行
 * （顺着轴看）时是 undefined。
 */
export function lineParameter(ray: { readonly origin: readonly number[]; readonly direction: readonly number[] }, point: readonly number[], axis: readonly number[]): number | undefined {
  const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const d = ray.direction, w = [ray.origin[0]! - point[0]!, ray.origin[1]! - point[1]!, ray.origin[2]! - point[2]!];
  const a = dot(d, d), b = dot(d, axis), denominator = a - b * b;
  if (denominator < 1e-9 * a) return undefined;
  return (a * dot(axis, w) - b * dot(d, w)) / denominator;
}

/** 选中的是笔刷的下标。 */
export class BrushEditTool extends FileEditTool<BrushFile, number | undefined> {
  /**
   * 正在拖的手柄：按下时的白盒、哪个笔刷的哪个面、面的中心和法线（模型本地）、按下时光标在法线那条线上的位置、上一次交出去的
   * 推出量（没变就不再交）。
   */
  #drag: { readonly start: BrushFile; readonly index: number; readonly face: number; readonly center: Vec3; readonly normal: Vec3; readonly anchor: number; delta: number } | undefined;
  readonly #clicks = new Clicks();

  constructor(entity: string, path: string, brush: BrushFile) {
    super(entity, path, brush, undefined);
  }

  update(frame: ViewportFrame): void {
    const entity = frame.agent.live?.entity(this.entity);
    if (!entity?.alive) return;
    const draw = frame.game.debugDraw, snap = frame.agent.snap;
    const world = currentWorld(entity), inverse = new Float32Array(16);
    if (!Matrix.invert(inverse, world)) return;
    const toWorld = ([x, y, z]: readonly number[]) => Matrix.transformPoint(world, x!, y!, z!);
    // 射线换进模型的本地坐标（方向不归一：只比远近、求线上的位置）
    const localRay = (at: Pixel) => {
      const { origin: o, direction: d } = frame.ray(at);
      const origin = Matrix.transformPoint(inverse, o.x, o.y, o.z), end = Matrix.transformPoint(inverse, o.x + d.x, o.y + d.y, o.z + d.z);
      return { origin, direction: [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]] as [number, number, number] };
    };
    const boxes = this.file.brushes.map(brushBox);
    boxes.forEach((box, i) => {
      const chosen = i === this.selection;
      const matrix = Matrix.multiply(new Float32Array(16), world, Matrix.compose(new Float32Array(16), box.center, box.rotation, [1, 1, 1]));
      draw.box(matrix, box.half, chosen ? SELECTED_COLOR : OPERATION_COLORS[this.file.brushes[i]!.operation], { width: chosen ? 3 : 1.5, depthTest: false });
    });

    const selected = this.selection === undefined ? undefined : boxes[this.selection];
    const handles = selected ? [0, 1, 2, 3, 4, 5].map((face) => toWorld(faceCenter(selected, face).center)) : [];
    const handleAt = (at: Pixel) => pickVertex(handles.map((point) => frame.project(point)), at, HANDLE_PIXELS);
    const active = this.#drag?.face ?? (frame.navigating ? undefined : handleAt(frame.pixel));
    handles.forEach((point, face) => drawPointBox(frame, point, frame.viewHeight(point) * VERTEX_SCREEN_SIZE * (face === active ? 2.6 : 2), face === active ? ACTIVE_COLOR : HANDLE_COLORS[face >> 1]!));

    const press = this.#clicks.press(frame);
    if (press) {
      const face = selected ? handleAt(press.at) : undefined;
      if (face !== undefined) {
        const { center, normal } = faceCenter(selected!, face);
        const anchor = lineParameter(localRay(press.at), center, normal);
        if (anchor !== undefined) this.#drag = { start: this.file, index: this.selection!, face, center, normal, anchor, delta: 0 };
        this.#clicks.cancel();
      } else if (press.double) {
        this.#clicks.cancel();
        const ray = localRay(press.at), hit = pickBrushFace(this.file, ray.origin, ray.direction);
        if (hit) {
          const added = addBoxOnFace(this.file, hit.index, hit.face);
          this.file = added.brush;
          this.selection = added.index;
          this.changed(true);
        }
      }
    }
    const drag = this.#drag;
    if (drag && (frame.down || frame.released)) {
      const along = lineParameter(localRay(frame.pixel), drag.center, drag.normal);
      if (along !== undefined) {
        let delta = along - drag.anchor;
        // 吸附的步长按模型本地的长度（白盒的实体一般不缩放）
        if (snap.enabled !== frame.ctrl && snap.translate > 0) delta = Math.round(delta / snap.translate) * snap.translate;
        if (delta !== drag.delta) {
          drag.delta = delta;
          this.file = resizeBrushFace(drag.start, drag.index, drag.face, delta);
          this.changed(false);
        }
      }
    }
    const click = this.#clicks.click(frame);
    if (drag && frame.released) {
      this.#drag = undefined;
      this.changed(true);
    } else if (click) {
      const ray = localRay(click);
      this.selection = clickBrush(this.file, ray.origin, ray.direction, this.selection);
      this.changed(false);
    }
  }
}
