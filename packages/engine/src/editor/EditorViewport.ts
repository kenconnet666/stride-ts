/**
 * 视口里的操作和画在场景上面的东西（EditAgent 的另一半，挂在编辑相机的实体上，每帧跑）：
 * - 左键点一下：选中点到的实体（Ctrl 是加选、再点去掉），点空处取消选中；点得到网格、精灵、粒子、放在 3D 里的 UI（见
 *   Game.pick），全屏的 UI 点不到；选中的框是它们的包围盒、UI 的那块板，反射探针另画它影响的盒子；
 * - 左键拖操纵器的把手：改选中的实体的位置、旋转、缩放，每帧一个修改（同一次拖并成撤销的一步）；吸附照 EditAgent.snap，
 *   按住 Ctrl 反过来；吸附到表面（snap.surface）开着时拖移动的把手，东西落到光标下的表面上（点选读回的深度，拖着的东西
 *   临时放进 SURFACE_DRAG_GROUP 这个渲染组、点选时不画，自己不挡）；吸附到顶点（snap.vertex，或拖的时候按住 V）时，拖着的东西上
 *   离光标最近的顶点对到光标下另一个物体上离点到的地方最近的顶点（同一套点选）；
 * - W、E、R：移动、旋转、缩放；F：把选中的东西放到画面中间；相机的操作见 EditorCamera。
 * - 画贴图（agent.paint）、编辑多边形网格（agent.polyEdit）、编辑样条（agent.splineEdit）、雕刻地形（agent.sculpt）时左键换成
 *   那个工具的：画笔刷；点选点、边、面（1、2、3 换模式，Shift、Ctrl 加选），操纵器拖选中的顶点（PolyEditTool）；点选、拖控制点，
 *   双击路径加点（SplineEditTool）；雕刻的笔刷（[、] 改大小，Shift 反过来）。
 */
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { DebugColor } from '../debug/DebugDraw';
import type { PointerEvent } from '../input/InputManager';
import { Matrix, type Matrix4 } from '../data/Matrix';
import { Quaternion, Vector3 } from '../data/vectors';
import { screenToWorldRaySegment, worldToScreen } from '../rendering/cameraRays';
import { Camera, Model, ModelPart } from '../rendering/components';
import type { EditAgent } from './EditAgent';
import type { LiveScene } from './LiveScene';
import type { SceneEdit } from './SceneDocument';
import { applyGizmoChange, applySnap, type GizmoAxis, type GizmoChange, type GizmoHandle, type Ray, type TransformGizmo } from './TransformGizmo';
import { currentWorld, probeBoxes, selectionBoxes } from './worldBoxes';
import { Mesh } from '../rendering/mesh/Mesh';
import { raycastMesh } from '../rendering/paint/MeshPainter';
import { selectionVertices } from '../modeling/polyEdit';
import { Terrain, TerrainAsset } from '../terrain/Terrain';
import type { TerrainFeatureFile, TerrainStrokeFile } from '../content/terrainFormat';
import type { TerrainHit } from '../terrain/TerrainSystem';
import { clickSelection, EMPTY_POLY_SELECTION, meshEdges, pickEdge, pickFace, pickVertex, selectionCenter, transformPoints, worldVertices, type PolySelectMode } from './PolyEditTool';
import type { PolyMeshFile } from '../content/assetFormat';
import type { SplineFile } from '../content/splineFormat';
import { splineCurve, splinePaths } from '../modeling/spline';
import { insertSplinePoint, moveSplinePoints, pickSplineCurve, splinePointList } from './SplineEditTool';

/** 选中的东西的框的颜色（线性）。 */
const SELECTION_COLOR: DebugColor = [1, 0.55, 0.1, 1];
/** 反射探针的盒子，和外面一圈过渡距离（淡出的范围）。 */
const PROBE_COLOR: DebugColor = [0.2, 0.85, 1, 1];
const PROBE_BLEND_COLOR: DebugColor = [0.2, 0.85, 1, 0.35];
const AXIS_COLORS: Readonly<Record<GizmoAxis, DebugColor>> = { x: [1, 0.15, 0.15, 1], y: [0.25, 0.9, 0.2, 1], z: [0.2, 0.4, 1, 1] };
const ACTIVE_COLOR: DebugColor = [1, 0.9, 0.2, 1];
/** 绘制模式的笔刷：画是白的，擦是红的。 */
const BRUSH_COLOR: DebugColor = [1, 1, 1, 0.9];
const ERASE_COLOR: DebugColor = [1, 0.3, 0.3, 0.9];
/** 雕刻笔刷的圈分几段。 */
const SCULPT_RING_SEGMENTS = 48;
/** 没选中的地物的轮廓。 */
const FEATURE_COLOR: DebugColor = [0.85, 0.95, 1, 0.85];
/** 两次按下隔多久以内算双击（毫秒）。 */
const DOUBLE_CLICK_MS = 400;
/** 点地物的角：光标离角在屏幕上多少像素以内。 */
const CORNER_PIXELS = 10;
/** 多边形编辑的线框和选中的点、边、面。 */
const POLY_EDGE_COLOR: DebugColor = [0.85, 0.88, 0.95, 0.7];
const POLY_SELECTED_COLOR: DebugColor = [1, 0.55, 0.1, 1];
/** 顶点的小方块的半边长（画面高度的倍数）。 */
const POLY_VERTEX_SCREEN_SIZE = 0.004;
const POLY_MODE_KEYS: readonly (readonly [string, PolySelectMode])[] = [['Digit1', 'vertex'], ['Digit2', 'edge'], ['Digit3', 'face']];
/** 操纵器的轴在画面上有多长（画面高度的倍数）。 */
const GIZMO_SCREEN_SIZE = 0.14;
/**
 * 吸附到表面时拖着的东西临时用的渲染组：点选读表面时不画它（视口里照常画，视图的掩码默认是全部）。松开时换回原来的组；
 * 文档不变。游戏自己用了第 31 组的东西拖的时候也会被当成拖着的。
 */
const SURFACE_DRAG_GROUP = 31;
/** 按下到松开鼠标挪了不到这么多像素算点一下。 */
const CLICK_PIXELS = 4;

/** 存进文件的数：去掉 float32 来回换算留下的尾巴。 */
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6;

/** 拖操纵器之前一个实体的样子：世界里的位置和朝向、文件里的缩放、父实体的世界矩阵的逆和朝向的逆（换回本地值用）。 */
interface DragStart {
  readonly id: string;
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly scale: Vector3;
  readonly parentInverse: Matrix4 | undefined;
  readonly parentRotationInverse: Quaternion | undefined;
}

/**
 * 吸附到表面或顶点的一次拖（都靠点选光标下的东西）：换了渲染组的模型（松开时换回）、往哪吸、正在等的点选。
 * - surface：lift 是第一个选中的实体的原点比它的选中框的底面高多少（落到表面上时原点放在表面上方这么高）；
 * - vertex：anchor 是拖着的东西上离按下处最近的顶点（拖之前的世界坐标），它对到点到的物体上离点到的地方最近的顶点；
 *   点到的物体的顶点换成世界坐标后存在 worlds 里（拖的时候它不动）。
 */
interface PickDrag {
  readonly groups: readonly (readonly [Entity, number])[];
  readonly target: { readonly kind: 'surface'; readonly lift: number } | { readonly kind: 'vertex'; readonly anchor: Vector3; readonly worlds: Map<Entity, Float32Array> };
  /** 有一次点选在路上（拖的时候一次只发一个）。 */
  picking: boolean;
  /** 松开了：最后一次点选（松开的位置）已经发出，回来以后结束这次拖；之前发的回来了不再用。 */
  ending: boolean;
}

/** 视口里的操作和画在场景上面的东西（选中的框、操纵器）。挂在编辑相机的实体上，每帧跑。 */
export class EditorViewport extends SyncScript {
  static override scriptName = 'EditorViewport';
  agent: EditAgent | undefined;
  #hover: GizmoHandle | undefined;
  #drag: { readonly starts: readonly DragStart[]; readonly key: string; readonly pick?: PickDrag } | undefined;
  #pressed: readonly [number, number] | undefined;
  #drags = 0;
  /** 多边形编辑里正在拖的操纵器：按下时的网格和要动的顶点（结果每帧从它算）。 */
  #polyDrag: { readonly start: PolyMeshFile; readonly vertices: readonly number[] } | undefined;
  /** 样条编辑里正在拖的操纵器：按下时的样条和要动的控制点。 */
  #splineDrag: { readonly start: SplineFile; readonly points: readonly number[] } | undefined;
  /** 上一次在样条编辑里按下左键的时刻和位置（认双击）。 */
  #lastSplineClick: { readonly time: number; readonly at: readonly [number, number] } | undefined;
  /** 绘制模式里正在画的一笔：上一笔落在哪（世界坐标），画没画上。 */
  #stroke: { last: [number, number, number] | undefined; painted: boolean } | undefined;
  /** 拖地物：拖的是哪个地物的哪个角（undefined 是整个地物），按下时光标下的地面（地形本地 x、z），按下时的地物，挪没挪过。 */
  #featureDrag: { readonly feature: number; readonly vertex: number | undefined; readonly anchor: readonly [number, number]; readonly start: readonly TerrainFeatureFile[]; moved: boolean } | undefined;
  /** 上一次在地物模式里按下左键的时刻和位置（认双击）。 */
  #lastFeatureClick: { readonly time: number; readonly at: readonly [number, number] } | undefined;
  /** 雕刻地形时正在拖的一笔：上一笔落在哪（地形本地的 x、z），这一次拖落下的笔画，压平的目标高度（按下处）。 */
  #sculptStroke: { last: [number, number] | undefined; strokes: TerrainStrokeFile[]; height: number } | undefined;

  override update(): void {
    const agent = this.agent, live = agent?.live;
    if (!agent || !live) return;
    const input = this.game.input, draw = this.game.debugDraw;
    for (const id of agent.selection) {
      // 正在编辑多边形的实体画它自己的线框，不画包围盒
      if (agent.polyEdit?.entity === id || agent.splineEdit?.entity === id) continue;
      const entity = live.entity(id);
      if (!entity?.alive) continue;
      const boxes = selectionBoxes(this.game, entity);
      for (const { matrix, halfExtents } of boxes) draw.box(matrix, halfExtents, SELECTION_COLOR, { width: 2, depthTest: false });
      const probe = probeBoxes(entity);
      if (probe) {
        // 盒子挡在墙里也要看得见（深度测试关掉）；过渡距离那一圈淡一点
        draw.box(probe.matrix, probe.halfExtents, PROBE_COLOR, { width: 2, depthTest: false });
        if (probe.blend > 0) draw.box(probe.matrix, probe.halfExtents.map((half) => half + probe.blend) as [number, number, number], PROBE_BLEND_COLOR, { width: 1, depthTest: false });
      }
      if (boxes.length === 0 && !probe) draw.axes(currentWorld(entity), 0.5, { width: 2, depthTest: false });
    }

    const alt = input.isKeyDown('AltLeft') || input.isKeyDown('AltRight');
    const navigating = alt || input.isMouseButtonDown('right') || input.isMouseButtonDown('middle');
    if (!navigating && !this.#drag) {
      if (input.isKeyPressed('KeyW')) agent.gizmo.mode = 'translate';
      if (input.isKeyPressed('KeyE')) agent.gizmo.mode = 'rotate';
      if (input.isKeyPressed('KeyR')) agent.gizmo.mode = 'scale';
      if (input.isKeyPressed('KeyF')) agent.focus();
    }

    const pixel = input.absoluteMousePosition;
    // 在模型上画贴图：左键拖是画，不点选、不拖操纵器
    if (agent.paint) {
      this.#paint(agent, pixel, navigating);
      return;
    }
    if (agent.polyEdit) {
      this.#poly(agent, pixel, navigating);
      return;
    }
    if (agent.splineEdit) {
      this.#spline(agent, pixel, navigating);
      return;
    }
    if (agent.sculpt) {
      this.#sculpt(agent, pixel, navigating);
      return;
    }
    const roots = agent.editable ? agent.selectionRoots() : [];
    const gizmo = agent.gizmo;
    // 拖的中途按下、松开 Ctrl 也跟着变
    applySnap(gizmo, agent.snap, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
    if (roots.length > 0) this.#placeGizmo(agent, roots[0]!);
    else if (this.#drag) this.#endDrag(agent);

    if (roots.length > 0 && !this.#drag) this.#hover = navigating ? undefined : gizmo.pick(pixel, this.#project);
    // 吸附到表面、顶点的拖松开以后还要等最后一次点选回来：那之前不开始新的拖
    if (input.isMouseButtonPressed('left') && !navigating && !this.#drag) {
      // 帧率低（标签页在后台、机器卡）时按下、拖动、松开可能落在同一帧：按下用按下那一刻的位置（指针事件里记着），
      // 不用这一帧鼠标最后在的地方，不然点不到把手、点选点错地方
      const at = this.#pressPixel(input.pointerEvents) ?? pixel;
      const handle = roots.length > 0 ? gizmo.pick(at, this.#project) : undefined;
      if (handle && gizmo.begin(handle, this.#ray(at), at)) {
        const vertex = agent.snap.vertex === true || input.isKeyDown('KeyV');
        const pick = gizmo.mode !== 'translate' ? undefined
          : vertex ? this.#beginPickDrag(roots, 'vertex', at)
            : agent.snap.surface === true ? this.#beginPickDrag(roots, 'surface', at) : undefined;
        this.#drag = { starts: roots.map((entity) => this.#dragStart(live, entity)), key: `gizmo:${++this.#drags}`, ...(pick ? { pick } : {}) };
      } else {
        this.#pressed = at;
      }
    }
    // 同一帧里松开的也先拖到松开的位置再结束
    if (this.#drag && (input.isMouseButtonDown('left') || input.isMouseButtonReleased('left'))) {
      if (this.#drag.pick) this.#pickDrag(agent, pixel, this.#drag.pick, input.isMouseButtonReleased('left'));
      else this.#applyDrag(agent, pixel);
    }
    if (input.isMouseButtonReleased('left')) {
      // 吸附到表面、顶点的拖在最后一次点选回来时自己结束
      if (this.#drag) {
        if (!this.#drag.pick) this.#endDrag(agent);
      }
      else if (this.#pressed && Math.hypot(pixel[0] - this.#pressed[0], pixel[1] - this.#pressed[1]) < CLICK_PIXELS) this.#click(agent, pixel, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
      this.#pressed = undefined;
    }
    if (roots.length > 0) this.#drawGizmo(gizmo);
  }

  /**
   * 绘制模式的一帧：光标下最近的网格面上画出笔刷的球；左键按着时每挪过笔刷半径的四分之一落一笔（拖得快时中间补上），画完
   * 拷回贴图（视口马上看到）；松开时读回像素交给 agent.onPaintStroke 存盘。
   */
  #paint(agent: EditAgent, pixel: readonly [number, number], navigating: boolean): void {
    const paint = agent.paint!;
    const input = this.game.input;
    const ray = this.#ray(pixel);
    const origin = [ray.origin.x, ray.origin.y, ray.origin.z], direction = [ray.direction.x, ray.direction.y, ray.direction.z];
    const targets = agent.paintTargets();
    let hit: ReturnType<typeof raycastMesh>;
    for (const { mesh, world } of targets) {
      const found = raycastMesh(mesh, world, origin, direction);
      if (found && (!hit || found.distance < hit.distance)) hit = found;
    }
    const { brush } = paint;
    if (hit) this.game.debugDraw.sphere(hit.point, brush.radius, brush.erase ? ERASE_COLOR : BRUSH_COLOR, { width: 1, segments: 24 });
    if (input.isMouseButtonPressed('left') && !navigating) this.#stroke = { last: undefined, painted: false };
    const stroke = this.#stroke;
    if (stroke && input.isMouseButtonDown('left') && hit) {
      const spacing = brush.radius * 0.25;
      const from = stroke.last ?? hit.point;
      const gap = Math.hypot(hit.point[0] - from[0], hit.point[1] - from[1], hit.point[2] - from[2]);
      // 第一笔落在按下的地方；之后按间距补上中间的点
      const steps = stroke.last ? Math.floor(gap / spacing) : 1;
      for (let i = 1; i <= steps; i++) {
        const t = stroke.last ? (i * spacing) / gap : 1;
        const center: [number, number, number] = [from[0] + (hit.point[0] - from[0]) * t, from[1] + (hit.point[1] - from[1]) * t, from[2] + (hit.point[2] - from[2]) * t];
        paint.painter.dab(targets, { center, radius: brush.radius, hardness: brush.hardness, strength: brush.strength, value: brush.erase ? [0, 0, 0, 1] : [1, 1, 1, 1] });
        stroke.last = center;
        stroke.painted = true;
      }
      paint.painter.commit();
    }
    if (input.isMouseButtonReleased('left') && stroke) {
      this.#stroke = undefined;
      if (stroke.painted) void paint.painter.read().then((image) => agent.onPaintStroke?.(paint.mask, image));
    }
  }

  /**
   * 雕刻地形的一帧：光标下的地面上画出笔刷的圈（贴着地面）；[、] 缩小、放大笔刷；左键按着时每挪过半径的四分之一落一笔（拖得快
   * 时中间补上），这一帧落的几笔交给 agent.previewSculpt（马上看到）；按住 Shift 抬高、压低反过来；压平压到按下那一点的高度。
   * 松开时把这一次拖落的笔画交给 agent.onSculptStroke 存进文件（撤销的一步）。
   */
  #sculpt(agent: EditAgent, pixel: readonly [number, number], navigating: boolean): void {
    const sculpt = agent.sculpt!, terrain = agent.live?.entity(sculpt.entity);
    const input = this.game.input;
    if (!terrain?.alive || !terrain.has(Terrain)) return;
    if (!navigating) {
      const scale = input.isKeyPressed('BracketRight') ? 1.25 : input.isKeyPressed('BracketLeft') ? 0.8 : 1;
      if (scale !== 1) {
        sculpt.brush = { ...sculpt.brush, radius: round(Math.max(0.5, sculpt.brush.radius * scale), 2) };
        agent.onSculptBrush?.(sculpt.brush);
      }
    }
    const ray = this.#ray(pixel);
    const hit = this.game.terrain.raycast([ray.origin.x, ray.origin.y, ray.origin.z], [ray.direction.x, ray.direction.y, ray.direction.z]);
    const shift = input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight');
    const { radius, strength } = sculpt.brush;
    const op = !shift ? sculpt.brush.op : sculpt.brush.op === 'raise' ? 'lower' : sculpt.brush.op === 'lower' ? 'raise' : sculpt.brush.op;
    const onTerrain = hit?.entity === terrain ? hit : undefined;
    if (onTerrain) sculpt.cursor = [onTerrain.local[0], onTerrain.local[1], onTerrain.height];
    if (sculpt.tool === 'features') {
      this.#features(agent, terrain, pixel, navigating, onTerrain);
      return;
    }
    if (onTerrain) this.#drawSculptBrush(onTerrain.point, radius, op === 'lower' ? ERASE_COLOR : BRUSH_COLOR);
    if (input.isMouseButtonPressed('left') && !navigating && onTerrain) this.#sculptStroke = { last: undefined, strokes: [], height: onTerrain.height };
    const stroke = this.#sculptStroke;
    if (stroke && input.isMouseButtonDown('left') && onTerrain) {
      const spacing = radius * 0.25;
      const [x1, z1] = onTerrain.local;
      const [x0, z0] = stroke.last ?? onTerrain.local;
      const gap = Math.hypot(x1 - x0, z1 - z0);
      const steps = stroke.last ? Math.floor(gap / spacing) : 1;
      const dabs: TerrainStrokeFile[] = [];
      // 一遍拖过去一个点大约被八笔盖到：每笔四分之一，拖过一遍差不多是 strength
      const amount = round(strength * 0.25, 4);
      for (let i = 1; i <= steps; i++) {
        const t = stroke.last ? (i * spacing) / gap : 1;
        const x = round(x0 + (x1 - x0) * t, 2), z = round(z0 + (z1 - z0) * t, 2);
        dabs.push({ op, x, z, radius: round(radius, 2), strength: amount, ...(op === 'flatten' ? { height: round(stroke.height, 2) } : {}) });
        stroke.last = [x, z];
      }
      if (dabs.length > 0) {
        stroke.strokes.push(...dabs);
        agent.previewTerrain(terrain, (file) => ({ ...file, strokes: [...(file.strokes ?? []), ...dabs] }));
      }
    }
    if (input.isMouseButtonReleased('left') && stroke) {
      this.#sculptStroke = undefined;
      const path = TerrainAsset.byId(terrain.require(Terrain).terrain)?.path;
      if (path && stroke.strokes.length > 0) agent.onSculptStroke?.(path, stroke.strokes);
    }
  }

  /**
   * 雕刻模式里拖地物的一帧：每个地物的轮廓贴着地面画出来（选中的高亮），角上画小圈。左键按在角上拖这个角，按在多边形里拖整个
   * 地物，按在空处取消选中；在边上双击加一个角。拖的时候每帧换成预览的版本（agent.previewTerrain），松开交给
   * agent.onSculptFeatures 存文件（撤销的一步）。
   */
  #features(agent: EditAgent, terrain: Entity, pixel: readonly [number, number], navigating: boolean, hit: TerrainHit | undefined): void {
    const sculpt = agent.sculpt!, input = this.game.input, system = this.game.terrain;
    const asset = TerrainAsset.byId(terrain.require(Terrain).terrain);
    if (!asset) return;
    const features = asset.file.features ?? [];
    // 每个角在屏幕上的位置（点选用）和画出来的轮廓
    const corners: { feature: number; vertex: number; screen: readonly [number, number] }[] = [];
    const draw = this.game.debugDraw;
    features.forEach((feature, index) => {
      const color = index === sculpt.feature ? SELECTION_COLOR : FEATURE_COLOR;
      const outline: [number, number, number][] = [];
      feature.points.forEach(([x0, z0], vertex) => {
        const [x1, z1] = feature.points[(vertex + 1) % feature.points.length]!;
        // 边按长度分段，每段贴着地面（地形在边上的起伏也看得见）
        const segments = Math.min(32, Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4)));
        for (let i = 0; i < segments; i++) {
          const point = system.surfacePoint(terrain, x0 + ((x1 - x0) * i) / segments, z0 + ((z1 - z0) * i) / segments);
          if (point) outline.push([point[0], point[1] + 0.2, point[2]]);
        }
        const corner = system.surfacePoint(terrain, x0, z0);
        const screen = corner && this.#project({ x: corner[0], y: corner[1], z: corner[2] });
        if (corner && screen) {
          corners.push({ feature: index, vertex, screen });
          draw.circle(corner, [0, 1, 0], Math.max(0.5, this.#distanceTo(corner) * 0.01), color, { width: 2, depthTest: false });
        }
      });
      if (outline.length > 1) draw.polyline(outline, color, { closed: true, width: 2, depthTest: false });
    });

    if (input.isMouseButtonPressed('left') && !navigating && !this.#featureDrag) {
      const at = this.#pressPixel(input.pointerEvents) ?? pixel;
      const corner = nearestCorner(corners, at);
      const now = performance.now();
      const last = this.#lastFeatureClick;
      // 帧率低、双击很快（或者自动化发的双击）时两次按下落在同一帧里：按这一帧的按下次数也算
      const presses = input.pointerEvents.filter((event) => event.device === 'mouse' && event.eventType === 'pressed').length;
      const double = presses >= 2 || (last !== undefined && now - last.time < DOUBLE_CLICK_MS && Math.hypot(at[0] - last.at[0], at[1] - last.at[1]) < CLICK_PIXELS);
      this.#lastFeatureClick = { time: now, at };
      if (double && !corner) {
        // 双击边：按屏幕上的距离找边（掠射的视角下一个像素是好几米，按米算的容差不稳），新的角放在边上对应的位置
        const edge = nearestScreenEdge(corners, at);
        if (edge) {
          const points = features[edge.feature]!.points;
          const [ax, az] = points[edge.vertex]!, [bx, bz] = points[(edge.vertex + 1) % points.length]!;
          const added = [round(ax + (bx - ax) * edge.t, 2), round(az + (bz - az) * edge.t, 2)] as const;
          const next = features.map((feature, index) => index !== edge.feature ? feature : { ...feature, points: [...feature.points.slice(0, edge.vertex + 1), added, ...feature.points.slice(edge.vertex + 1)] });
          this.#selectFeature(agent, edge.feature);
          this.#commitFeatures(agent, terrain, asset.path, next);
          return;
        }
      }
      if (corner) {
        this.#selectFeature(agent, corner.feature);
        this.#featureDrag = { feature: corner.feature, vertex: corner.vertex, anchor: hit?.local ?? [0, 0], start: features, moved: false };
      } else {
        const inside = hit ? features.findLastIndex((feature) => insidePolygon(feature.points, hit.local)) : -1;
        this.#selectFeature(agent, inside >= 0 ? inside : undefined);
        if (inside >= 0) this.#featureDrag = { feature: inside, vertex: undefined, anchor: hit!.local, start: features, moved: false };
      }
    }
    // 按下以后再读：同一帧里按下又松开（点一下、快的双击）时这一帧就要结束这次拖，不然下一次按下被当成还在拖
    const drag = this.#featureDrag;
    if (drag && input.isMouseButtonDown('left') && hit) {
      const dx = hit.local[0] - drag.anchor[0], dz = hit.local[1] - drag.anchor[1];
      const next = drag.start.map((feature, index) => {
        if (index !== drag.feature) return feature;
        const points = feature.points.map(([x, z], vertex) =>
          drag.vertex === undefined ? [round(x + dx, 2), round(z + dz, 2)] as const
            : vertex === drag.vertex ? [round(hit.local[0], 2), round(hit.local[1], 2)] as const : [x, z] as const);
        return { ...feature, points };
      });
      // 光标挪过一厘米才换版本（按着不动时不重算）
      if (JSON.stringify(next[drag.feature]!.points) !== JSON.stringify(features[drag.feature]!.points)) {
        drag.moved = true;
        agent.previewTerrain(terrain, (file) => ({ ...file, features: next }));
      }
    }
    if (drag && input.isMouseButtonReleased('left')) {
      this.#featureDrag = undefined;
      if (drag.moved) agent.onSculptFeatures?.(asset.path, TerrainAsset.byId(terrain.require(Terrain).terrain)?.file.features ?? []);
    }
  }

  #selectFeature(agent: EditAgent, feature: number | undefined): void {
    const sculpt = agent.sculpt!;
    if (sculpt.feature === feature) return;
    sculpt.feature = feature;
    agent.onSculptSelect?.(feature);
  }

  /** 一下子做完的地物修改（双击加角）：预览、马上存。 */
  #commitFeatures(agent: EditAgent, terrain: Entity, path: string, features: readonly TerrainFeatureFile[]): void {
    agent.previewTerrain(terrain, (file) => ({ ...file, features }));
    agent.onSculptFeatures?.(path, features);
  }

  /** 编辑相机到这一点的距离（米）：按距离定角上小圈的大小、点边的容差，远近看着一样大。 */
  #distanceTo(point: readonly [number, number, number]): number {
    const world = currentWorld(this.entity);
    return Math.hypot(point[0] - world[12]!, point[1] - world[13]!, point[2] - world[14]!);
  }

  /** 雕刻笔刷的圈：贴着地面的一圈线（每段按地形的高度抬一点，不被地面挡住一半）。 */
  #drawSculptBrush(center: readonly [number, number, number], radius: number, color: DebugColor): void {
    const points: [number, number, number][] = [];
    for (let i = 0; i < SCULPT_RING_SEGMENTS; i++) {
      const angle = (i / SCULPT_RING_SEGMENTS) * Math.PI * 2;
      const x = center[0] + Math.cos(angle) * radius, z = center[2] + Math.sin(angle) * radius;
      points.push([x, (this.game.terrain.heightAt(x, z) ?? center[1]) + radius * 0.01, z]);
    }
    const draw = this.game.debugDraw;
    draw.polyline(points, color, { closed: true, width: 2, depthTest: false });
    draw.line(center, [center[0], center[1] + radius * 0.2, center[2]], color, { width: 2, depthTest: false });
  }

  /**
   * 多边形编辑的一帧：画线框（选中的点、边、面高亮），1、2、3 换选择模式；左键点一下按模式点选（Shift、Ctrl 加选、再点去掉，
   * 点空处清空），按在操纵器上拖选中的顶点（移动、旋转、缩放照 W、E、R），每帧把新网格交给 agent.onPolyChanged，松开时
   * commit。线框关了深度测试：背面的边也看得见、点得到。
   */
  #poly(agent: EditAgent, pixel: readonly [number, number], navigating: boolean): void {
    const poly = agent.polyEdit!, entity = agent.live?.entity(poly.entity);
    if (!entity?.alive) return;
    const input = this.game.input, draw = this.game.debugDraw, gizmo = agent.gizmo;
    if (!navigating && !this.#polyDrag) {
      const mode = POLY_MODE_KEYS.find(([key]) => input.isKeyPressed(key))?.[1];
      if (mode && mode !== poly.mode) {
        poly.mode = mode;
        poly.selection = EMPTY_POLY_SELECTION;
        agent.onPolyChanged?.(poly, false);
      }
    }
    const world = currentWorld(entity);
    const points = worldVertices(poly.mesh, world);
    const edges = meshEdges(poly.mesh);
    const { selection } = poly;
    const selectedEdges = new Set(selection.edges.map(([a, b]) => (a < b ? `${a},${b}` : `${b},${a}`)));
    for (const [a, b] of edges) {
      const chosen = selectedEdges.has(`${a},${b}`);
      draw.line(points[a]!, points[b]!, chosen ? POLY_SELECTED_COLOR : POLY_EDGE_COLOR, { width: chosen ? 3 : 1, depthTest: false });
    }
    for (const face of selection.faces) {
      const outline = poly.mesh.faces[face]?.vertices.map((v) => points[v]!);
      if (outline) draw.polyline(outline, POLY_SELECTED_COLOR, { width: 3, depthTest: false, closed: true });
    }
    if (poly.mode === 'vertex') {
      const chosen = new Set(selection.vertices);
      points.forEach((point, v) => {
        const half = this.#viewHeight(point) * POLY_VERTEX_SCREEN_SIZE * (chosen.has(v) ? 1.6 : 1);
        draw.box(Matrix.compose(new Float32Array(16), point, [0, 0, 0, 1], [1, 1, 1]), [half, half, half], chosen.has(v) ? POLY_SELECTED_COLOR : POLY_EDGE_COLOR, { width: 2, depthTest: false });
      });
    }

    const vertices = this.#polyDrag?.vertices ?? selectionVertices(poly.mesh, selection);
    const center = selectionCenter(points, vertices);
    applySnap(gizmo, agent.snap, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
    if (center) {
      gizmo.pivot.set(...center);
      if (!this.#polyDrag) {
        if (agent.gizmoSpace === 'local' || gizmo.mode === 'scale') gizmo.orientation.set(...Matrix.decompose(world).rotation);
        else gizmo.orientation.identity();
      }
      gizmo.size = this.#viewHeight(center) * GIZMO_SCREEN_SIZE;
      if (!this.#polyDrag) this.#hover = navigating ? undefined : gizmo.pick(pixel, this.#project);
    }
    if (input.isMouseButtonPressed('left') && !navigating) {
      const at = this.#pressPixel(input.pointerEvents) ?? pixel;
      const handle = center ? gizmo.pick(at, this.#project) : undefined;
      if (handle && gizmo.begin(handle, this.#ray(at), at)) this.#polyDrag = { start: poly.mesh, vertices };
      else this.#pressed = at;
    }
    const drag = this.#polyDrag;
    if (drag && (input.isMouseButtonDown('left') || input.isMouseButtonReleased('left'))) {
      const change = gizmo.drag(this.#ray(pixel), pixel);
      if (change) {
        poly.mesh = { ...drag.start, vertices: transformPoints(drag.start.vertices, drag.vertices, change, gizmo.dragOrigin ?? gizmo.pivot, gizmo.orientation, world) };
        agent.onPolyChanged?.(poly, false);
      }
    }
    if (input.isMouseButtonReleased('left')) {
      if (drag) {
        gizmo.end();
        this.#polyDrag = undefined;
        agent.onPolyChanged?.(poly, true);
      } else if (this.#pressed && Math.hypot(pixel[0] - this.#pressed[0], pixel[1] - this.#pressed[1]) < CLICK_PIXELS) {
        const projected = points.map(([x, y, z]) => this.#project({ x, y, z }));
        const hit = poly.mode === 'vertex' ? pickVertex(projected, pixel) : poly.mode === 'edge' ? pickEdge(edges, projected, pixel) : pickFace(poly.mesh, points, this.#ray(pixel));
        const additive = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].some((key) => input.isKeyDown(key));
        poly.selection = clickSelection(poly.selection, poly.mode, hit, additive);
        agent.onPolyChanged?.(poly, false);
      }
      this.#pressed = undefined;
    }
    if (center) this.#drawGizmo(gizmo);
  }

  /**
   * 样条编辑的一帧：画路径和控制点（选中的高亮），左键点一下点选控制点（Shift、Ctrl 加选、再点去掉，点空处清空），双击路径
   * 在那里加一个点，按在操纵器上拖选中的点（移动、旋转、缩放照 W、E、R）。每帧把新样条交给 agent.onSplineChanged（路径的
   * 线跟着动，模型等松开后存文件、后端重新烘），松开、加点时 commit。关了深度测试：埋在地里的路也看得见、点得到。
   */
  #spline(agent: EditAgent, pixel: readonly [number, number], navigating: boolean): void {
    const edit = agent.splineEdit!, entity = agent.live?.entity(edit.entity);
    if (!entity?.alive) return;
    const input = this.game.input, draw = this.game.debugDraw, gizmo = agent.gizmo;
    const world = currentWorld(entity);
    const toWorld = (points: readonly (readonly [number, number, number])[]) => worldVertices({ vertices: points }, world);
    // 每条路径（路网的分支也是）每段一组折线
    const curves = splinePaths(edit.spline).map((path) => splineCurve(path.points, path.closed === true).map(toWorld));
    for (const segment of curves.flat()) draw.polyline(segment, POLY_EDGE_COLOR, { width: 2, depthTest: false });
    const points = toWorld(splinePointList(edit.spline).map((entry) => entry.point.position));
    const chosen = new Set(edit.selection);
    points.forEach((point, i) => {
      const half = this.#viewHeight(point) * POLY_VERTEX_SCREEN_SIZE * (chosen.has(i) ? 2 : 1.4);
      draw.box(Matrix.compose(new Float32Array(16), point, [0, 0, 0, 1], [1, 1, 1]), [half, half, half], chosen.has(i) ? POLY_SELECTED_COLOR : POLY_EDGE_COLOR, { width: 2, depthTest: false });
    });

    const indices = this.#splineDrag?.points ?? edit.selection;
    const center = selectionCenter(points, indices);
    applySnap(gizmo, agent.snap, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
    if (center) {
      gizmo.pivot.set(...center);
      if (!this.#splineDrag) {
        if (agent.gizmoSpace === 'local' || gizmo.mode === 'scale') gizmo.orientation.set(...Matrix.decompose(world).rotation);
        else gizmo.orientation.identity();
        this.#hover = navigating ? undefined : gizmo.pick(pixel, this.#project);
      }
      gizmo.size = this.#viewHeight(center) * GIZMO_SCREEN_SIZE;
    }
    if (input.isMouseButtonPressed('left') && !navigating) {
      const at = this.#pressPixel(input.pointerEvents) ?? pixel;
      const handle = center ? gizmo.pick(at, this.#project) : undefined;
      const now = performance.now(), last = this.#lastSplineClick;
      // 两次按下落在同一帧里（帧率低、自动化发的双击）也算双击，同地物的
      const presses = input.pointerEvents.filter((event) => event.device === 'mouse' && event.eventType === 'pressed').length;
      const double = presses >= 2 || (last !== undefined && now - last.time < DOUBLE_CLICK_MS && Math.hypot(at[0] - last.at[0], at[1] - last.at[1]) < CLICK_PIXELS);
      this.#lastSplineClick = { time: now, at };
      const projected = points.map(([x, y, z]) => this.#project({ x, y, z }));
      const onPath = double && pickVertex(projected, at) === undefined
        ? pickSplineCurve(curves.map((segments) => segments.map((segment) => segment.map(([x, y, z]) => this.#project({ x, y, z })))), at)
        : undefined;
      if (handle && gizmo.begin(handle, this.#ray(at), at)) this.#splineDrag = { start: edit.spline, points: indices };
      else if (onPath) {
        const { spline, index } = insertSplinePoint(edit.spline, onPath.path, onPath.segment, onPath.u);
        edit.spline = spline;
        edit.selection = [index];
        agent.onSplineChanged?.(edit, true);
      } else this.#pressed = at;
    }
    const drag = this.#splineDrag;
    if (drag && (input.isMouseButtonDown('left') || input.isMouseButtonReleased('left'))) {
      const change = gizmo.drag(this.#ray(pixel), pixel);
      if (change) {
        edit.spline = moveSplinePoints(drag.start, drag.points, change, gizmo.dragOrigin ?? gizmo.pivot, gizmo.orientation, world);
        agent.onSplineChanged?.(edit, false);
      }
    }
    if (input.isMouseButtonReleased('left')) {
      if (drag) {
        gizmo.end();
        this.#splineDrag = undefined;
        agent.onSplineChanged?.(edit, true);
      } else if (this.#pressed && Math.hypot(pixel[0] - this.#pressed[0], pixel[1] - this.#pressed[1]) < CLICK_PIXELS) {
        const hit = pickVertex(points.map(([x, y, z]) => this.#project({ x, y, z })), pixel);
        const additive = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].some((key) => input.isKeyDown(key));
        edit.selection = clickSelection({ ...EMPTY_POLY_SELECTION, vertices: edit.selection }, 'vertex', hit, additive).vertices;
        agent.onSplineChanged?.(edit, false);
      }
      this.#pressed = undefined;
    }
    if (center) this.#drawGizmo(gizmo);
  }

  /** 这一帧里鼠标按下那一刻在画布上的位置（像素）；这一帧没有按下事件时是 undefined。 */
  #pressPixel(events: readonly PointerEvent[]): readonly [number, number] | undefined {
    const press = events.find((event) => event.device === 'mouse' && event.eventType === 'pressed');
    const canvas = this.game.graphicsDevice.canvas;
    return press && [press.position[0] * canvas.clientWidth, press.position[1] * canvas.clientHeight];
  }

  /** 操纵器放在第一个选中的实体上，大小按它到相机的距离算（画面上一样大）。 */
  #placeGizmo(agent: EditAgent, entity: Entity): void {
    const gizmo = agent.gizmo;
    // 位置跟着实体走；拖的时候朝向不跟着变（旋转时它会跟着实体转起来，角度就算乱了）
    const { translation, rotation } = Matrix.decompose(currentWorld(entity));
    gizmo.pivot.set(...translation);
    if (!this.#drag) {
      if (agent.gizmoSpace === 'local' || gizmo.mode === 'scale') gizmo.orientation.set(...rotation);
      else gizmo.orientation.identity();
    }
    gizmo.size = this.#viewHeight([gizmo.pivot.x, gizmo.pivot.y, gizmo.pivot.z]) * GIZMO_SCREEN_SIZE;
  }

  /** 画面在这个点那么远的地方有多高（世界单位）：操纵器、顶点的方块按它定大小，画面上看着一样大。 */
  #viewHeight(point: readonly number[]): number {
    const camera = this.entity.require(Camera), eye = this.entity.require(Transform).world;
    return camera.projection === 'orthographic'
      ? camera.orthographicSize
      : 2 * Math.hypot(point[0]! - eye[12]!, point[1]! - eye[13]!, point[2]! - eye[14]!) * Math.tan((camera.verticalFieldOfView * Math.PI) / 360);
  }

  readonly #project = (point: { readonly x: number; readonly y: number; readonly z: number }): readonly [number, number] | undefined => {
    const canvas = this.game.graphicsDevice.canvas;
    const screen = worldToScreen(this.game, this.entity, point);
    return screen && [screen.x * canvas.clientWidth, screen.y * canvas.clientHeight];
  };

  #ray(pixel: readonly [number, number]): Ray {
    const canvas = this.game.graphicsDevice.canvas;
    const { start, end } = screenToWorldRaySegment(this.game, this.entity, pixel[0] / (canvas.clientWidth || 1), pixel[1] / (canvas.clientHeight || 1));
    return { origin: start, direction: end.subtract(start).normalize() };
  }

  #dragStart(live: LiveScene, entity: Entity): DragStart {
    const transform = entity.require(Transform);
    const { translation, rotation } = Matrix.decompose(currentWorld(entity));
    const parent = transform.parent && currentWorld(transform.parent);
    const parentInverse = parent && new Float32Array(16);
    if (parent && !Matrix.invert(parentInverse!, parent)) throw new Error(`the parent of '${entity.name}' has a singular world matrix`);
    return {
      id: live.idOf(entity)!,
      position: new Vector3(...translation),
      rotation: new Quaternion(...rotation),
      scale: new Vector3(transform.scale.x, transform.scale.y, transform.scale.z),
      parentInverse,
      parentRotationInverse: parent && new Quaternion(...Matrix.decompose(parent).rotation).invert(),
    };
  }

  /**
   * 开始吸附到表面或顶点的拖：拖着的实体和它们的后代上的模型换进 SURFACE_DRAG_GROUP（点选时不画）。表面：量第一个实体的
   * 原点比它的选中框的底面高多少；顶点：找拖着的模型上投到画面里离按下处最近的顶点（没有模型时用第一个实体的原点）。
   */
  #beginPickDrag(roots: readonly Entity[], kind: 'surface' | 'vertex', pressed: readonly [number, number]): PickDrag {
    const groups: (readonly [Entity, number])[] = [];
    const visit = (entity: Entity) => {
      const model = entity.get(Model);
      if (model) {
        groups.push([entity, model.renderGroup]);
        model.renderGroup = SURFACE_DRAG_GROUP;
      }
      for (const child of entity.require(Transform).children) visit(child);
    };
    roots.forEach(visit);
    const first = roots[0]!;
    const world = currentWorld(first);
    if (kind === 'vertex') {
      let anchor = new Vector3(world[12]!, world[13]!, world[14]!), best = Infinity;
      for (const [entity] of groups) {
        const vertices = worldVerticesOf(entity);
        for (let i = 0; vertices && i < vertices.length; i += 3) {
          const point = { x: vertices[i]!, y: vertices[i + 1]!, z: vertices[i + 2]! };
          const screen = this.#project(point);
          const distance = screen ? (screen[0] - pressed[0]) ** 2 + (screen[1] - pressed[1]) ** 2 : Infinity;
          if (distance < best) [best, anchor] = [distance, new Vector3(point.x, point.y, point.z)];
        }
      }
      return { groups, target: { kind, anchor, worlds: new Map() }, picking: false, ending: false };
    }
    let bottom = Infinity;
    for (const { matrix, halfExtents: [hx, hy, hz] } of selectionBoxes(this.game, first)) {
      // 盒子八个角里最低的
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) bottom = Math.min(bottom, Matrix.transformPoint(matrix, sx * hx, sy * hy, sz * hz)[1]);
    }
    return { groups, target: { kind, lift: Number.isFinite(bottom) ? world[13]! - bottom : 0 }, picking: false, ending: false };
  }

  /**
   * 吸附到表面或顶点的拖的一帧：点选光标下的东西（拖着的不算），读回来以后——表面：把第一个实体的原点放到表面上方 lift 处；
   * 顶点：把 anchor 挪到点到的物体上离点到的地方最近的顶点。别的选中的实体跟着挪一样多。读回要等一两帧：上一次的还没回来时
   * 不再发。点到空处（天空）、点到的东西没有顶点时不动。last（松开了）时不管有没有在路上的都发，回来以后结束这次拖：不然
   * 松开前最后一段拖动没有点选回来，东西停在半路上。
   */
  #pickDrag(agent: EditAgent, pixel: readonly [number, number], pick: PickDrag, last: boolean): void {
    const drag = this.#drag;
    if (!drag || pick.ending || (pick.picking && !last)) return;
    pick.picking = true;
    pick.ending = last;
    void this.game.pickSurface(pixel[0], pixel[1], (1 << SURFACE_DRAG_GROUP) >>> 0).then((hit) => {
      if (!last) pick.picking = false;
      if (this.#drag !== drag || (pick.ending && !last)) return;
      if (hit) this.#moveToPicked(agent, drag.starts[0]!, pick, hit);
      if (last) this.#endDrag(agent);
    });
  }

  /** 点选回来了：按吸附的种类算出挪多少（first 是第一个选中的实体拖之前的样子），改文档。 */
  #moveToPicked(agent: EditAgent, first: DragStart, pick: PickDrag, hit: { readonly entity: Entity | undefined; readonly point: readonly number[] }): void {
    const { target } = pick;
    let from: Vector3, to: readonly number[];
    if (target.kind === 'surface') {
      from = first.position;
      to = [hit.point[0]!, hit.point[1]! + target.lift, hit.point[2]!];
    } else {
      const vertex = hit.entity && nearestVertex(target.worlds, hit.entity, hit.point);
      if (!vertex) return;
      from = target.anchor;
      to = vertex;
    }
    this.#applyChange(agent, { type: 'translate', delta: new Vector3(to[0]! - from.x, to[1]! - from.y, to[2]! - from.z) });
  }

  /** 把这一帧拖到的结果换成对文档的修改：每个实体从拖之前的样子算，世界里的值换回本地的。 */
  #applyDrag(agent: EditAgent, pixel: readonly [number, number]): void {
    const change = agent.gizmo.drag(this.#ray(pixel), pixel);
    if (change) this.#applyChange(agent, change);
  }

  #applyChange(agent: EditAgent, change: GizmoChange): void {
    const target = agent.editable;
    if (!target || !this.#drag) return;
    const edits: SceneEdit[] = [];
    for (const start of this.#drag.starts) {
      const next = applyGizmoChange(change, agent.gizmo.dragOrigin ?? agent.gizmo.pivot, start);
      if (change.type !== 'scale') {
        const local = start.parentInverse ? Matrix.transformPoint(start.parentInverse, next.position.x, next.position.y, next.position.z) : [next.position.x, next.position.y, next.position.z];
        edits.push({ type: 'set', entity: start.id, path: ['position'], value: local.map(tidy) });
      }
      if (change.type === 'rotate') {
        const local = start.parentRotationInverse ? start.parentRotationInverse.clone().multiply(next.rotation).normalize() : next.rotation;
        edits.push({ type: 'set', entity: start.id, path: ['rotation'], value: [local.x, local.y, local.z, local.w].map(tidy) });
      }
      if (change.type === 'scale') edits.push({ type: 'set', entity: start.id, path: ['scale'], value: [next.scale.x, next.scale.y, next.scale.z].map(tidy) });
    }
    target.apply(edits.length === 1 ? edits[0]! : { type: 'batch', edits }, this.#drag.key);
    void agent.sync();
  }

  #endDrag(agent: EditAgent): void {
    // 吸附到表面、顶点时换掉的渲染组换回来（实体可能在拖的时候被删了）
    for (const [entity, group] of this.#drag?.pick?.groups ?? []) {
      const model = entity.alive ? entity.get(Model) : undefined;
      if (model) model.renderGroup = group;
    }
    agent.gizmo.end();
    agent.editable?.commit();
    this.#drag = undefined;
  }

  /** 点一下：选中点到的实体；toggle（按着 Ctrl）是在现有的选中里加上、去掉它，点空处不动。 */
  #click(agent: EditAgent, pixel: readonly [number, number], toggle: boolean): void {
    void agent.pick(pixel[0], pixel[1]).then((id) => {
      const current = agent.selection;
      if (toggle) {
        if (id === undefined) return;
        agent.selection = current.includes(id) ? current.filter((other) => other !== id) : [...current, id];
      } else {
        agent.selection = id === undefined ? [] : [id];
      }
      agent.onSelectionChanged?.(agent.selection);
    });
  }

  #drawGizmo(gizmo: TransformGizmo): void {
    const draw = this.game.debugDraw;
    const active = gizmo.dragging ?? this.#hover;
    const same = (handle: GizmoHandle) => active?.kind === handle.kind && (handle.kind === 'center' || (active as { axis?: GizmoAxis }).axis === handle.axis);
    for (const handle of gizmo.handles()) {
      const color = same(handle) ? ACTIVE_COLOR : handle.kind === 'center' ? ([1, 1, 1, 1] as const) : AXIS_COLORS[handle.axis];
      const options = { width: same(handle) ? 4 : 3, depthTest: false };
      const outline = gizmo.outline(handle).map((point) => [point.x, point.y, point.z] as const);
      if (handle.kind === 'center') draw.sphere(outline[0]!, gizmo.size * 0.07, color, { ...options, segments: 12 });
      else if (handle.kind === 'axis' && gizmo.mode === 'translate') draw.arrow(outline[0]!, outline[1]!, color, { ...options, headLength: gizmo.size * 0.18 });
      else if (handle.kind === 'axis') {
        // 缩放的轴：一段线，头上一个小方块
        draw.line(outline[0]!, outline[1]!, color, options);
        const end = Matrix.compose(new Float32Array(16), outline[1]!, [gizmo.orientation.x, gizmo.orientation.y, gizmo.orientation.z, gizmo.orientation.w], [1, 1, 1]);
        draw.box(end, [gizmo.size * 0.05, gizmo.size * 0.05, gizmo.size * 0.05], color, options);
      } else draw.polyline(outline, color, { ...options, closed: true });
    }
  }
}

/** 实体的模型的顶点（世界坐标，x、y、z 连着排）；没有模型时是 undefined。蒙皮、形变的按绑定时的样子。 */
function worldVerticesOf(entity: Entity): Float64Array | undefined {
  const model = entity.get(Model);
  const mesh = model ? Mesh.byId(model.mesh) : undefined;
  if (!mesh) return undefined;
  const local = mesh.positions(), m = currentWorld(entity);
  const world = new Float64Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i]!, y = local[i + 1]!, z = local[i + 2]!;
    world[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    world[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    world[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  return world;
}

/**
 * entity 的模型上离 point 最近的顶点（世界坐标）。模型的网格不止一个时，多出来的挂在子实体上（ModelPart），点选报的是
 * entity 本身：一起找。顶点换算一次存进 cache（一次拖里它不动）。
 */
function nearestVertex(cache: Map<Entity, Float32Array>, entity: Entity, point: readonly number[]): [number, number, number] | undefined {
  let vertices = cache.get(entity);
  if (!vertices) {
    const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
    const each = parts.map(worldVerticesOf).filter((part) => part !== undefined);
    vertices = new Float32Array(each.reduce((total, part) => total + part.length, 0));
    each.reduce((offset, part) => (vertices!.set(part, offset), offset + part.length), 0);
    cache.set(entity, vertices);
  }
  let best = Infinity, index = -1;
  for (let i = 0; i < vertices.length; i += 3) {
    const distance = (vertices[i]! - point[0]!) ** 2 + (vertices[i + 1]! - point[1]!) ** 2 + (vertices[i + 2]! - point[2]!) ** 2;
    if (distance < best) [best, index] = [distance, i];
  }
  return index < 0 ? undefined : [vertices[index]!, vertices[index + 1]!, vertices[index + 2]!];
}

/** 留 digits 位小数（笔画存进文件，留厘米、万分之一就够，文件好读；除以 10 的幂，不出 0.30000000000000004）。 */
function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** 屏幕上离 at 最近、在 CORNER_PIXELS 以内的地物的角。 */
function nearestCorner<T extends { readonly screen: readonly [number, number] }>(corners: readonly T[], at: readonly [number, number]): T | undefined {
  let best: T | undefined, bestDistance = CORNER_PIXELS;
  for (const corner of corners) {
    const distance = Math.hypot(corner.screen[0] - at[0], corner.screen[1] - at[1]);
    if (distance < bestDistance) [best, bestDistance] = [corner, distance];
  }
  return best;
}

/**
 * 屏幕上离 at 最近、在 CORNER_PIXELS 以内的地物的边（按两个角投到屏幕上的线段算）：哪个地物、从第几个角出发的边、落在边上的比例
 * t（0 是这个角，1 是下一个角；屏幕上的比例，透视下和地面上差一点，加角够用）。
 */
function nearestScreenEdge(corners: readonly { readonly feature: number; readonly vertex: number; readonly screen: readonly [number, number] }[], at: readonly [number, number]): { feature: number; vertex: number; t: number } | undefined {
  let best: { feature: number; vertex: number; t: number } | undefined, bestDistance = CORNER_PIXELS;
  for (const a of corners) {
    // 同一个地物的下一个角（下标绕回 0）；投不到屏幕上的角没有边
    const ring = corners.filter((c) => c.feature === a.feature);
    const b = ring.find((c) => c.vertex === a.vertex + 1) ?? (a.vertex === Math.max(...ring.map((c) => c.vertex)) ? ring.find((c) => c.vertex === 0) : undefined);
    if (!b || b === a) continue;
    const ex = b.screen[0] - a.screen[0], ey = b.screen[1] - a.screen[1], length2 = ex * ex + ey * ey;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((at[0] - a.screen[0]) * ex + (at[1] - a.screen[1]) * ey) / length2)) : 0;
    const distance = Math.hypot(at[0] - a.screen[0] - ex * t, at[1] - a.screen[1] - ey * t);
    if (distance < bestDistance) [best, bestDistance] = [{ feature: a.feature, vertex: a.vertex, t }, distance];
  }
  return best;
}

/** 点在不在多边形里（射线交叉数）。 */
function insidePolygon(points: readonly (readonly [number, number])[], [x, z]: readonly [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!, [xj, zj] = points[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
