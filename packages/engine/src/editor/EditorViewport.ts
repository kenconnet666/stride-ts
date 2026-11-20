/**
 * 视口里的操作和画在场景上面的东西（EditAgent 的另一半，挂在编辑相机的实体上，每帧跑）：
 * - 左键点一下：选中点到的实体（Ctrl 是加选、再点去掉），点空处取消选中；点得到网格、精灵、粒子、放在 3D 里的 UI（见
 *   Game.pick），全屏的 UI 点不到；选中的框是它们的包围盒、UI 的那块板，反射探针另画它影响的盒子；
 * - 左键拖操纵器的把手：改选中的实体的位置、旋转、缩放，每帧一个修改（同一次拖并成撤销的一步）；吸附照 EditAgent.snap，
 *   按住 Ctrl 反过来；
 * - W、E、R：移动、旋转、缩放；F：把选中的东西放到画面中间；相机的操作见 EditorCamera。
 */
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { DebugColor } from '../debug/DebugDraw';
import type { PointerEvent } from '../input/InputManager';
import { Matrix, type Matrix4 } from '../data/Matrix';
import { Quaternion, Vector3 } from '../data/vectors';
import { screenToWorldRaySegment, worldToScreen } from '../rendering/cameraRays';
import { Camera } from '../rendering/components';
import type { EditAgent } from './EditAgent';
import type { LiveScene } from './LiveScene';
import type { SceneEdit } from './SceneDocument';
import { applyGizmoChange, applySnap, type GizmoAxis, type GizmoHandle, type Ray, type TransformGizmo } from './TransformGizmo';
import { currentWorld, probeBoxes, selectionBoxes } from './worldBoxes';

/** 选中的东西的框的颜色（线性）。 */
const SELECTION_COLOR: DebugColor = [1, 0.55, 0.1, 1];
/** 反射探针的盒子，和外面一圈过渡距离（淡出的范围）。 */
const PROBE_COLOR: DebugColor = [0.2, 0.85, 1, 1];
const PROBE_BLEND_COLOR: DebugColor = [0.2, 0.85, 1, 0.35];
const AXIS_COLORS: Readonly<Record<GizmoAxis, DebugColor>> = { x: [1, 0.15, 0.15, 1], y: [0.25, 0.9, 0.2, 1], z: [0.2, 0.4, 1, 1] };
const ACTIVE_COLOR: DebugColor = [1, 0.9, 0.2, 1];
/** 操纵器的轴在画面上有多长（画面高度的倍数）。 */
const GIZMO_SCREEN_SIZE = 0.14;
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

/** 视口里的操作和画在场景上面的东西（选中的框、操纵器）。挂在编辑相机的实体上，每帧跑。 */
export class EditorViewport extends SyncScript {
  static override scriptName = 'EditorViewport';
  agent: EditAgent | undefined;
  #hover: GizmoHandle | undefined;
  #drag: { readonly starts: readonly DragStart[]; readonly key: string } | undefined;
  #pressed: readonly [number, number] | undefined;
  #drags = 0;

  override update(): void {
    const agent = this.agent, live = agent?.live;
    if (!agent || !live) return;
    const input = this.game.input, draw = this.game.debugDraw;
    for (const id of agent.selection) {
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
    const roots = agent.editable ? agent.selectionRoots() : [];
    const gizmo = agent.gizmo;
    // 拖的中途按下、松开 Ctrl 也跟着变
    applySnap(gizmo, agent.snap, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
    if (roots.length > 0) this.#placeGizmo(agent, roots[0]!);
    else if (this.#drag) this.#endDrag(agent);

    if (roots.length > 0 && !this.#drag) this.#hover = navigating ? undefined : gizmo.pick(pixel, this.#project);
    if (input.isMouseButtonPressed('left') && !navigating) {
      // 帧率低（标签页在后台、机器卡）时按下、拖动、松开可能落在同一帧：按下用按下那一刻的位置（指针事件里记着），
      // 不用这一帧鼠标最后在的地方，不然点不到把手、点选点错地方
      const at = this.#pressPixel(input.pointerEvents) ?? pixel;
      const handle = roots.length > 0 ? gizmo.pick(at, this.#project) : undefined;
      if (handle && gizmo.begin(handle, this.#ray(at), at)) {
        this.#drag = { starts: roots.map((entity) => this.#dragStart(live, entity)), key: `gizmo:${++this.#drags}` };
      } else {
        this.#pressed = at;
      }
    }
    // 同一帧里松开的也先拖到松开的位置再结束
    if (this.#drag && (input.isMouseButtonDown('left') || input.isMouseButtonReleased('left'))) this.#applyDrag(agent, pixel);
    if (input.isMouseButtonReleased('left')) {
      if (this.#drag) this.#endDrag(agent);
      else if (this.#pressed && Math.hypot(pixel[0] - this.#pressed[0], pixel[1] - this.#pressed[1]) < CLICK_PIXELS) this.#click(agent, pixel, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
      this.#pressed = undefined;
    }
    if (roots.length > 0) this.#drawGizmo(gizmo);
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
    const camera = this.entity.require(Camera), eye = this.entity.require(Transform).world;
    const viewHeight = camera.projection === 'orthographic'
      ? camera.orthographicSize
      : 2 * Math.hypot(gizmo.pivot.x - eye[12]!, gizmo.pivot.y - eye[13]!, gizmo.pivot.z - eye[14]!) * Math.tan((camera.verticalFieldOfView * Math.PI) / 360);
    gizmo.size = viewHeight * GIZMO_SCREEN_SIZE;
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

  /** 把这一帧拖到的结果换成对文档的修改：每个实体从拖之前的样子算，世界里的值换回本地的。 */
  #applyDrag(agent: EditAgent, pixel: readonly [number, number]): void {
    const change = agent.gizmo.drag(this.#ray(pixel), pixel), target = agent.editable;
    if (!change || !target || !this.#drag) return;
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
