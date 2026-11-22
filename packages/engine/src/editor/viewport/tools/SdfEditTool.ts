/**
 * 编辑 SDF 模型（.sdf.json）的视口工具：画每个形状的有向包围盒（加的白、减的红、交的蓝，选中的橙色）；左键点一下选中点到的形状
 * （同一处再点换成后面的那个，点空处取消）；选中的形状上放操纵器（按形状自己的朝向），拖着移动、旋转、改大小（W、E、R 换，
 * 改大小按形状的参数：方块的边长、圆柱的高和半径……，见 sdfShapes.ts）。拖的时候每帧换文件（线框跟着动，模型等松开后存文件、
 * 后端重新烘），松开时 commit。关了深度测试：被挡住、减掉的形状也看得见、点得到。
 */
import type { SdfFile, SdfShapeFile } from '../../../content/formats/assetFormat';
import { Matrix } from '../../../data/Matrix';
import { Quaternion } from '../../../data/vectors';
import type { DebugColor } from '../../../debug/DebugDraw';
import { currentWorld } from '../worldBoxes';
import { boxHits } from './brushShapes';
import { applySdfChange, sdfShapeBox } from './sdfShapes';
import { Clicks, FileEditTool, SELECTED_COLOR, type ViewportFrame } from './ViewportTool';

/** 形状的线框：加的、减的、交的。 */
const OPERATION_COLORS: Readonly<Record<SdfShapeFile['operation'], DebugColor>> = {
  add: [0.85, 0.88, 0.95, 0.75], subtract: [1, 0.35, 0.3, 0.85], intersect: [0.35, 0.6, 1, 0.85],
};

/** 选中的是形状的下标。 */
export class SdfEditTool extends FileEditTool<SdfFile, number | undefined> {
  /** 正在拖操纵器：按下时的文件、哪个形状。 */
  #drag: { readonly start: SdfFile; readonly index: number } | undefined;
  readonly #clicks = new Clicks();

  constructor(entity: string, path: string, sdf: SdfFile) {
    super(entity, path, sdf, undefined);
  }

  update(frame: ViewportFrame): void {
    const entity = frame.agent.live?.entity(this.entity);
    if (!entity?.alive) return;
    const { game: { debugDraw: draw }, agent: { gizmo } } = frame;
    const world = currentWorld(entity), inverse = new Float64Array(16);
    if (!Matrix.invert(inverse, world)) return;
    const boxes = this.file.shapes.map(sdfShapeBox);
    const shapeMatrix = (i: number) => {
      const box = boxes[i]!;
      return Matrix.multiply(new Float64Array(16), world, Matrix.compose(new Float32Array(16), box.center, box.rotation, [1, 1, 1]));
    };
    boxes.forEach((box, i) => {
      const chosen = i === this.selection;
      draw.box(shapeMatrix(i), box.half, chosen ? SELECTED_COLOR : OPERATION_COLORS[this.file.shapes[i]!.operation], { width: chosen ? 3 : 1.5, depthTest: false });
    });

    // 操纵器放在选中的形状的中心，朝向是形状的朝向（缩放按它自己的轴）
    const index = this.#drag?.index ?? this.selection;
    const placed = index !== undefined && boxes[index] ? shapeMatrix(index) : undefined;
    if (placed) frame.placeGizmo([placed[12]!, placed[13]!, placed[14]!], placed, this.#drag !== undefined);
    const press = this.#clicks.press(frame);
    if (press && placed && index !== undefined) {
      const handle = frame.pickGizmo(press.at);
      if (handle && gizmo.begin(handle, frame.ray(press.at), press.at)) {
        this.#drag = { start: this.file, index };
        this.#clicks.cancel();
      }
    }
    const drag = this.#drag;
    if (drag && (frame.down || frame.released)) {
      const change = gizmo.drag(frame.ray(frame.pixel), frame.pixel);
      if (change) {
        // 世界到模型本地：实体的旋转的逆、统一缩放
        const { rotation, scale } = Matrix.decompose(world);
        const toLocal = new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]).invert();
        this.file = applySdfChange(drag.start, drag.index, change, [toLocal.x, toLocal.y, toLocal.z, toLocal.w], scale[0] || 1);
        this.changed(false);
      }
    }
    const click = this.#clicks.click(frame);
    if (drag && frame.released) {
      gizmo.end();
      this.#drag = undefined;
      this.changed(true);
    } else if (click) {
      const { origin: o, direction: d } = frame.ray(click);
      const origin = Matrix.transformPoint(inverse, o.x, o.y, o.z), end = Matrix.transformPoint(inverse, o.x + d.x, o.y + d.y, o.z + d.z);
      const hits = boxHits(boxes, origin, [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]]);
      const at = hits.findIndex((hit) => hit.index === this.selection);
      this.selection = at < 0 ? hits[0]?.index : hits[(at + 1) % hits.length]!.index;
      this.changed(false);
    }
    if (placed) frame.drawGizmo();
  }
}
