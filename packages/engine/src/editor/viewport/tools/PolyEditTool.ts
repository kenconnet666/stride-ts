/**
 * 编辑多边形网格（.poly.json）的视口工具（照 Blender 的编辑模式、ProBuilder）：画线框（选中的点、边、面高亮），1、2、3 换
 * 选择模式；左键点一下按模式点选（Shift、Ctrl 加选、再点去掉，点空处清空），按在操纵器上拖选中的顶点（移动、旋转、缩放照
 * W、E、R）。拖的时候每帧换网格（onChanged(false)），松开时 commit。线框关了深度测试：背面的边也看得见、点得到。
 * 点选、选择、变换的纯函数在 polyPicking.ts，编辑操作（挤出、倒角……）在 modeling/polyEdit.ts。
 */
import type { PolyMeshFile } from '../../../content/formats/assetFormat';
import { selectionVertices } from '../../../modeling/polyEdit';
import { currentWorld } from '../worldBoxes';
import { clickSelection, EMPTY_POLY_SELECTION, meshEdges, pickEdge, pickFace, pickVertex, selectionCenter, transformPoints, worldVertices, type PolySelection, type PolySelectMode } from './polyPicking';
import { Clicks, drawPointBox, EDGE_COLOR, FileEditTool, SELECTED_COLOR, VERTEX_SCREEN_SIZE, type ViewportFrame } from './ViewportTool';

const MODE_KEYS: readonly (readonly [string, PolySelectMode])[] = [['Digit1', 'vertex'], ['Digit2', 'edge'], ['Digit3', 'face']];

export class PolyEditTool extends FileEditTool<PolyMeshFile, PolySelection> {
  /** 选择模式：点、边、面。 */
  mode: PolySelectMode;
  /** 正在拖的操纵器：按下时的网格和要动的顶点（结果每帧从它算）。 */
  #drag: { readonly start: PolyMeshFile; readonly vertices: readonly number[] } | undefined;
  readonly #clicks = new Clicks();

  constructor(entity: string, path: string, mesh: PolyMeshFile, mode: PolySelectMode = 'face') {
    super(entity, path, mesh, EMPTY_POLY_SELECTION);
    this.mode = mode;
  }

  /** 换选择模式；选中的清空。 */
  setMode(mode: PolySelectMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.selection = EMPTY_POLY_SELECTION;
    this.changed(false);
  }

  update(frame: ViewportFrame): void {
    const entity = frame.agent.live?.entity(this.entity);
    if (!entity?.alive) return;
    const { input, game: { debugDraw: draw }, agent: { gizmo } } = frame;
    if (!frame.navigating && !this.#drag) {
      const mode = MODE_KEYS.find(([key]) => input.isKeyPressed(key))?.[1];
      if (mode) this.setMode(mode);
    }
    const mesh = this.file, world = currentWorld(entity);
    const points = worldVertices(mesh, world);
    const edges = meshEdges(mesh);
    const { selection } = this;
    const selectedEdges = new Set(selection.edges.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
    for (const [a, b] of edges) {
      const chosen = selectedEdges.has(`${a},${b}`);
      draw.line(points[a]!, points[b]!, chosen ? SELECTED_COLOR : EDGE_COLOR, { width: chosen ? 3 : 1, depthTest: false });
    }
    for (const face of selection.faces) {
      const outline = mesh.faces[face]?.vertices.map((v) => points[v]!);
      if (outline) draw.polyline(outline, SELECTED_COLOR, { width: 3, depthTest: false, closed: true });
    }
    if (this.mode === 'vertex') {
      const chosen = new Set(selection.vertices);
      points.forEach((point, v) => drawPointBox(frame, point, frame.viewHeight(point) * VERTEX_SCREEN_SIZE * (chosen.has(v) ? 1.6 : 1), chosen.has(v) ? SELECTED_COLOR : EDGE_COLOR));
    }

    const vertices = this.#drag?.vertices ?? selectionVertices(mesh, selection);
    const center = selectionCenter(points, vertices);
    if (center) frame.placeGizmo(center, world, this.#drag !== undefined);
    const press = this.#clicks.press(frame);
    if (press && center) {
      const handle = frame.pickGizmo(press.at);
      if (handle && gizmo.begin(handle, frame.ray(press.at), press.at)) {
        this.#drag = { start: mesh, vertices };
        this.#clicks.cancel();
      }
    }
    const drag = this.#drag;
    if (drag && (frame.down || frame.released)) {
      const change = gizmo.drag(frame.ray(frame.pixel), frame.pixel);
      if (change) {
        this.file = { ...drag.start, vertices: transformPoints(drag.start.vertices, drag.vertices, change, gizmo.dragOrigin ?? gizmo.pivot, gizmo.orientation, world) };
        this.changed(false);
      }
    }
    const click = this.#clicks.click(frame);
    if (drag && frame.released) {
      gizmo.end();
      this.#drag = undefined;
      this.changed(true);
    } else if (click) {
      const projected = points.map((point) => frame.project(point));
      const hit = this.mode === 'vertex' ? pickVertex(projected, click) : this.mode === 'edge' ? pickEdge(edges, projected, click) : pickFace(this.file, points, frame.ray(click));
      this.selection = clickSelection(this.selection, this.mode, hit, frame.additive);
      this.changed(false);
    }
    if (center) frame.drawGizmo();
  }
}
