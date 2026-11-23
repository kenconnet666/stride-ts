/**
 * 编辑扫描场景（.splatedit.json）的视口工具，挂在画着这个编辑生成的泼溅的实体上：
 * - 框（mode 'boxes'）：画裁剪框（绿）、删掉的框（红）、选中的橙色；左键点一下选中点到的框（同一处再点换成后面的，点空处取消）；
 *   选中的框上放操纵器，拖着移动、旋转、改大小（W、E、R 换）。界面上的按钮加框（addBox）、删框（deleteSelected）。
 * - 刷（mode 'erase'）：左键按着拖，光标下的泼溅表面（点选读回的深度，ScenePicker 画泼溅写深度的那一圈）上一路放球，球里的
 *   泼溅删掉；画一个跟着光标的圈表示笔刷多大（brushRadius，米，泼溅坐标里的）。
 * 拖的中途每帧换文件、给渲染器换遮罩（SplatRenderer.setEditMask：框外、框里、球里的泼溅马上藏掉，不等后端重新生成），松开时
 * commit（编辑器存文件、记一步撤销、后端重新生成泼溅）。删飞点要数邻居，预览不了，存了以后看生成的。
 */
import type { SplatEditFile } from '../../../content/formats/splatEditFormat';
import { splatEditMask } from '../../../content/splatEdit';
import { Matrix } from '../../../data/Matrix';
import { Quaternion } from '../../../data/vectors';
import type { DebugColor } from '../../../debug/DebugDraw';
import { GaussianSplat } from '../../../rendering/components';
import { SplatCloud } from '../../../rendering/splats/SplatCloud';
import { currentWorld } from '../worldBoxes';
import { boxHits } from './brushShapes';
import { addSplatBox, applySplatBoxChange, deleteSplatBox, extendStroke, selectedBox, splatBoxes, splatExtent, type SplatBoxList, type SplatBoxSelection } from './splatBoxes';
import { Clicks, FileEditTool, SELECTED_COLOR, type Point3, type ViewportFrame } from './ViewportTool';

/** 框的线：裁剪框、删掉的框。 */
const BOX_COLORS: Readonly<Record<SplatBoxList, DebugColor>> = { keep: [0.35, 0.95, 0.45, 0.85], remove: [1, 0.35, 0.3, 0.85] };
/** 笔刷的圈。 */
const BRUSH_COLOR: DebugColor = [1, 0.35, 0.3, 0.9];

export type SplatEditMode = 'boxes' | 'erase';

export class SplatEditTool extends FileEditTool<SplatEditFile, SplatBoxSelection | undefined> {
  mode: SplatEditMode = 'boxes';
  /** 刷选的笔刷半径（米，泼溅坐标里的）。 */
  brushRadius = 0.15;
  #drag: { readonly start: SplatEditFile; readonly selection: SplatBoxSelection } | undefined;
  readonly #clicks = new Clicks();
  /** 正在刷的一笔：上一个球心；按着但还没刷到泼溅上时是 null。 */
  #stroke: Point3 | null | undefined;
  /** 光标下的泼溅表面（泼溅坐标），画笔刷的圈；一次只读一个，读回来之前不再读。 */
  #hover: Point3 | undefined;
  #picking = false;
  /** 给渲染器的遮罩对着的文件（换了才重编）、遮罩挂在哪个运行时实体上。 */
  #masked: SplatEditFile | undefined;
  #maskEntity: number | undefined;
  #renderer: { setEditMask(entity: number, data: Float32Array | undefined): void } | undefined;
  /** 实体画着的泼溅的主体的范围（泼溅坐标；加裁剪框时按它）、编辑相机前面看着的地方和那儿多大（加删掉的框时按它）。 */
  #bounds: { readonly min: Point3; readonly max: Point3 } | undefined;
  #boundsOf: SplatCloud | undefined;
  #lookAt: { readonly at: Point3; readonly size: number } | undefined;

  constructor(entity: string, path: string, file: SplatEditFile) {
    super(entity, path, file, undefined);
  }

  update(frame: ViewportFrame): void {
    const entity = frame.agent.live?.entity(this.entity);
    if (!entity?.alive) return;
    this.#updateMask(frame, entity.id);
    const cloud = SplatCloud.byId(entity.get(GaussianSplat)?.splats ?? 0);
    if (cloud && cloud !== this.#boundsOf) {
      this.#bounds = splatExtent(cloud.nodes);
      this.#boundsOf = cloud;
    }
    const world = currentWorld(entity), inverse = new Float64Array(16);
    if (!Matrix.invert(inverse, world)) return;
    const { game: { debugDraw: draw } } = frame;
    // 画面中间往前 3 米（编辑相机看着的地方），换进泼溅坐标：加删掉的框放这儿，边长是画面在那儿高的四分之一
    const canvas = frame.game.graphicsDevice.canvas, ray = frame.ray([canvas.clientWidth / 2, canvas.clientHeight / 2]);
    const ahead = [ray.origin.x + ray.direction.x * 3, ray.origin.y + ray.direction.y * 3, ray.origin.z + ray.direction.z * 3] as const;
    const local = Matrix.transformPoint(inverse, ahead[0], ahead[1], ahead[2]), { scale } = Matrix.decompose(world);
    this.#lookAt = { at: [local[0], local[1], local[2]], size: (frame.viewHeight(ahead) / 4) / (scale[0] || 1) };
    const boxes = splatBoxes(this.file);
    const boxMatrix = (i: number) => {
      const { box } = boxes[i]!;
      return Matrix.multiply(new Float64Array(16), world, Matrix.compose(new Float32Array(16), box.center, box.rotation, [1, 1, 1]));
    };
    const isSelected = (i: number) => this.selection !== undefined && boxes[i]!.selection.list === this.selection.list && boxes[i]!.selection.index === this.selection.index;
    boxes.forEach(({ box, selection }, i) => {
      const chosen = isSelected(i);
      draw.box(boxMatrix(i), box.half, chosen ? SELECTED_COLOR : BOX_COLORS[selection.list], { width: chosen ? 3 : 1.5, depthTest: false });
    });
    if (this.mode === 'erase') this.#erase(frame, world, inverse);
    else this.#boxes(frame, world, inverse, boxes.map(({ box }) => box), boxMatrix, isSelected);
  }

  /** 框的模式：操纵器拖选中的框，点一下换选中。 */
  #boxes(frame: ViewportFrame, world: Float64Array, inverse: Float64Array, boxes: ReturnType<typeof splatBoxes>[number]['box'][], boxMatrix: (i: number) => Float64Array, isSelected: (i: number) => boolean): void {
    const { agent: { gizmo } } = frame;
    const index = boxes.findIndex((_, i) => isSelected(i));
    const placed = index >= 0 ? boxMatrix(index) : undefined;
    if (placed) frame.placeGizmo([placed[12]!, placed[13]!, placed[14]!], placed, this.#drag !== undefined);
    const press = this.#clicks.press(frame);
    if (press && placed && this.selection) {
      const handle = frame.pickGizmo(press.at);
      if (handle && gizmo.begin(handle, frame.ray(press.at), press.at)) {
        this.#drag = { start: this.file, selection: this.selection };
        this.#clicks.cancel();
      }
    }
    const drag = this.#drag;
    if (drag && (frame.down || frame.released)) {
      const change = gizmo.drag(frame.ray(frame.pixel), frame.pixel);
      if (change) {
        const { rotation, scale } = Matrix.decompose(world);
        const toLocal = new Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]).invert();
        this.file = applySplatBoxChange(drag.start, drag.selection, change, [toLocal.x, toLocal.y, toLocal.z, toLocal.w], scale[0] || 1);
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
      const all = splatBoxes(this.file);
      const at = hits.findIndex((hit) => isSelected(hit.index));
      const next = at < 0 ? hits[0] : hits[(at + 1) % hits.length];
      this.selection = next ? all[next.index]!.selection : undefined;
      this.changed(false);
    }
    if (placed) frame.drawGizmo();
  }

  /** 刷的模式：光标下读泼溅表面，按着时一路放球。 */
  #erase(frame: ViewportFrame, world: Float64Array, inverse: Float64Array): void {
    if (frame.pressed) this.#stroke = null;
    if (!this.#picking && !frame.navigating) {
      this.#picking = true;
      void frame.game.pickSurface(frame.pixel[0], frame.pixel[1]).then((hit) => {
        this.#picking = false;
        if (!hit) {
          this.#hover = undefined;
          return;
        }
        const local = Matrix.transformPoint(inverse, hit.point[0], hit.point[1], hit.point[2]);
        this.#hover = [local[0], local[1], local[2]];
        if (this.#stroke !== undefined) {
          const step = extendStroke(this.file, this.#stroke ?? undefined, this.#hover, this.brushRadius);
          if (step.file !== this.file) {
            this.file = step.file;
            this.#stroke = step.last;
            this.changed(false);
          }
        }
        frame.game.requestFrames();
      });
    }
    if (frame.released && this.#stroke !== undefined) {
      const painted = this.#stroke !== null;
      this.#stroke = undefined;
      if (painted) this.changed(true);
    }
    if (this.#hover) {
      const center = Matrix.transformPoint(world, this.#hover[0], this.#hover[1], this.#hover[2]);
      const { scale } = Matrix.decompose(world);
      frame.game.debugDraw.sphere(center, this.brushRadius * (scale[0] || 1), BRUSH_COLOR, { depthTest: false, segments: 24 });
    }
  }

  /** 加一个裁剪框（默认盖住整个扫描）或删掉的框，选中它。 */
  addBox(list: SplatBoxList): void {
    const added = addSplatBox(this.file, list, this.#bounds ?? { min: [-1, -1, -1], max: [1, 1, 1] }, this.#lookAt?.at ?? [0, 0, 0], this.#lookAt?.size ?? 1);
    this.file = added.file;
    this.selection = added.selection;
    this.mode = 'boxes';
    this.changed(true);
  }

  /** 删掉选中的框。 */
  deleteSelected(): void {
    if (!this.selection || !selectedBox(this.file, this.selection)) return;
    this.file = deleteSplatBox(this.file, this.selection);
    this.selection = undefined;
    this.changed(true);
  }

  dispose(): void {
    if (this.#maskEntity !== undefined) this.#renderer?.setEditMask(this.#maskEntity, undefined);
  }

  /** 文件换了（或者实体换了）就把遮罩重新交给渲染器。 */
  #updateMask(frame: ViewportFrame, entity: number): void {
    if (this.#masked === this.file && this.#maskEntity === entity) return;
    const renderer = frame.game.renderSystem.splats;
    if (this.#maskEntity !== undefined && this.#maskEntity !== entity) renderer.setEditMask(this.#maskEntity, undefined);
    renderer.setEditMask(entity, splatEditMask(this.file));
    this.#renderer = renderer;
    this.#masked = this.file;
    this.#maskEntity = entity;
    frame.game.requestFrames();
  }
}
