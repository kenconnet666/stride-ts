/**
 * 编辑样条（.spline.json）控制点的视口工具：画路径和控制点（选中的高亮）、道路的车道图；左键点一下点选控制点（Shift、Ctrl
 * 加选、再点去掉，点空处清空），双击路径在那里加一个点，按在操纵器上拖选中的点（移动、旋转、缩放照 W、E、R）。拖的时候每帧
 * 换样条（路径的线跟着动，模型等松开后存文件、后端重新烘），松开、加点时 commit。关了深度测试：埋在地里的路也看得见、点得到。
 * 纯函数在 splinePoints.ts。
 */
import type { SplineFile } from '../../../content/formats/splineFormat';
import type { DebugColor } from '../../../debug/DebugDraw';
import { roadLanes, type RoadLane } from '../../../modeling/roadLanes';
import { splineCurve, splinePaths } from '../../../modeling/spline';
import { currentWorld } from '../worldBoxes';
import { clickSelection, EMPTY_POLY_SELECTION, pickVertex, selectionCenter, worldVertices } from './polyPicking';
import { insertSplinePoint, moveSplinePoints, pickSplineCurve, splinePointList } from './splinePoints';
import { Clicks, drawPointBox, EDGE_COLOR, FileEditTool, SELECTED_COLOR, VERTEX_SCREEN_SIZE, type ViewportFrame } from './ViewportTool';

/** 车道图：路段上的、路口里的连接车道。 */
const LANE_COLOR: DebugColor = [0.2, 0.9, 1, 0.8];
const CONNECTOR_COLOR: DebugColor = [1, 0.85, 0.2, 0.8];

/** 选中的是控制点的扁平下标（splinePointList）。 */
export class SplineEditTool extends FileEditTool<SplineFile, readonly number[]> {
  /** 正在拖的操纵器：按下时的样条和要动的控制点。 */
  #drag: { readonly start: SplineFile; readonly points: readonly number[] } | undefined;
  /** 车道图（道路才有）：按样条对象缓存，改了才重算。 */
  #lanes: { readonly spline: SplineFile; readonly lanes: readonly RoadLane[] } | undefined;
  readonly #clicks = new Clicks();

  constructor(entity: string, path: string, spline: SplineFile) {
    super(entity, path, spline, []);
  }

  update(frame: ViewportFrame): void {
    const entity = frame.agent.live?.entity(this.entity);
    if (!entity?.alive) return;
    const { game: { debugDraw: draw }, agent: { gizmo } } = frame;
    const world = currentWorld(entity), spline = this.file;
    const toWorld = (points: readonly (readonly [number, number, number])[]) => worldVertices({ vertices: points }, world);
    // 每条路径（路网的分支也是）每段一组折线
    const curves = splinePaths(spline).map((path) => splineCurve(path.points, path.closed === true).map(toWorld));
    for (const segment of curves.flat()) draw.polyline(segment, EDGE_COLOR, { width: 2, depthTest: false });
    // 道路的车道图：路段上的青色、路口里的连接车道黄色，细线画在路面上方 5 厘米（深度测试开着，被挡住的看不见）
    if (this.#lanes?.spline !== spline) this.#lanes = { spline, lanes: roadLanes(spline) };
    for (const lane of this.#lanes.lanes) {
      draw.polyline(toWorld(lane.points.map(([x, y, z]) => [x, y + 0.05, z] as const)), lane.junction === undefined ? LANE_COLOR : CONNECTOR_COLOR, { width: 1 });
    }
    const points = toWorld(splinePointList(spline).map((entry) => entry.point.position));
    const chosen = new Set(this.selection);
    points.forEach((point, i) => drawPointBox(frame, point, frame.viewHeight(point) * VERTEX_SCREEN_SIZE * (chosen.has(i) ? 2 : 1.4), chosen.has(i) ? SELECTED_COLOR : EDGE_COLOR));

    const indices = this.#drag?.points ?? this.selection;
    const center = selectionCenter(points, indices);
    if (center) frame.placeGizmo(center, world, this.#drag !== undefined);
    const press = this.#clicks.press(frame);
    if (press) {
      const handle = center ? frame.pickGizmo(press.at) : undefined;
      const projected = points.map((point) => frame.project(point));
      const onPath = press.double && pickVertex(projected, press.at) === undefined
        ? pickSplineCurve(curves.map((segments) => segments.map((segment) => segment.map((point) => frame.project(point)))), press.at)
        : undefined;
      if (handle && gizmo.begin(handle, frame.ray(press.at), press.at)) {
        this.#drag = { start: spline, points: indices };
        this.#clicks.cancel();
      } else if (onPath) {
        const inserted = insertSplinePoint(spline, onPath.path, onPath.segment, onPath.u);
        this.file = inserted.spline;
        this.selection = [inserted.index];
        this.#clicks.cancel();
        this.changed(true);
      }
    }
    const drag = this.#drag;
    if (drag && (frame.down || frame.released)) {
      const change = gizmo.drag(frame.ray(frame.pixel), frame.pixel);
      if (change) {
        this.file = moveSplinePoints(drag.start, drag.points, change, gizmo.dragOrigin ?? gizmo.pivot, gizmo.orientation, world);
        this.changed(false);
      }
    }
    const click = this.#clicks.click(frame);
    if (drag && frame.released) {
      gizmo.end();
      this.#drag = undefined;
      this.changed(true);
    } else if (click) {
      const hit = pickVertex(points.map((point) => frame.project(point)), click);
      this.selection = clickSelection({ ...EMPTY_POLY_SELECTION, vertices: this.selection }, 'vertex', hit, frame.additive).vertices;
      this.changed(false);
    }
    if (center) frame.drawGizmo();
  }
}
