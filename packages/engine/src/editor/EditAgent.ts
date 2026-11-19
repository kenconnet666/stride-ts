/**
 * 游戏页面开在编辑状态时（Game.editing），编辑器在这个页面里的代理：`game.editor`。编辑器的界面在外面（另一个页面，
 * 把游戏页面嵌在里面），经它操作游戏里的东西：让实体跟着场景文档、点选、选中的框、操纵器（Gizmo）、编辑相机。
 *
 * 编辑状态下游戏照自己的入口启动（加载它的默认场景），只是场景不挂脚本、仿真不走；所以应用的代码不用为编辑器改。
 * 试玩是把页面不带编辑状态重新打开：一个干净的游戏，脚本在试玩里改的状态不会漏回编辑状态。
 *
 * 编辑器自己的相机不在场景里：单独的实体，用自己的相机槽位，主画面改画它。
 *
 * 视口里的操作（EditorViewport，挂在编辑相机的实体上）：
 * - 左键点一下：选中点到的实体（Ctrl 是加选、再点去掉），点空处取消选中；
 * - 左键拖操纵器的把手：改选中的实体的位置、旋转、缩放，每帧一个修改（同一次拖并成撤销的一步）；
 * - W、E、R：移动、旋转、缩放；F：把选中的东西放到画面中间；相机的操作见 EditorCamera。
 */
import type { SceneFile } from '../content/format';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { Game } from '../games/Game';
import { Matrix, type Matrix4 } from '../mathematics/Matrix';
import { Quaternion, Vector3 } from '../mathematics/vectors';
import { screenToWorldRaySegment, worldToScreen } from '../rendering/cameraRays';
import { Camera, Model, ModelPart } from '../rendering/components';
import { Mesh } from '../rendering/Mesh';
import type { DebugColor } from '../debug/DebugDraw';
import { EditorCameraController } from './EditorCamera';
import { scriptFields, type Field } from './fields';
import { LiveScene, type SceneSource } from './LiveScene';
import type { SceneEdit } from './SceneDocument';
import { applyGizmoChange, TransformGizmo, type GizmoAxis, type GizmoHandle, type Ray } from './TransformGizmo';

/** 编辑相机用的相机槽位（场景里的相机用 0 起的小数字）。 */
export const EDITOR_CAMERA_SLOT = 0xed17;

/** 选中的东西的框的颜色（线性）。 */
const SELECTION_COLOR: DebugColor = [1, 0.55, 0.1, 1];
const AXIS_COLORS: Readonly<Record<GizmoAxis, DebugColor>> = { x: [1, 0.15, 0.15, 1], y: [0.25, 0.9, 0.2, 1], z: [0.2, 0.4, 1, 1] };
const ACTIVE_COLOR: DebugColor = [1, 0.9, 0.2, 1];
/** 操纵器的轴在画面上有多长（画面高度的倍数）。 */
const GIZMO_SCREEN_SIZE = 0.14;
/** 按下到松开鼠标挪了不到这么多像素算点一下。 */
const CLICK_PIXELS = 4;

export interface WorldSphere {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

/**
 * 能改的场景文档：现在的文件，加上"做一个修改"和"这一次连着的修改结束了"（UndoStack 就是）。界面在外面的页面里时，
 * 它给的对象在做修改的同时刷新自己的面板。
 */
export interface EditableScene extends SceneSource {
  apply(edit: SceneEdit, mergeKey?: string): void;
  commit(): void;
}

export class EditAgent {
  readonly game: Game;
  /** 编辑相机所在的实体。 */
  readonly camera: Entity;
  /** 操纵器；mode 可以直接改（W、E、R 也改它）。 */
  readonly gizmo = new TransformGizmo();
  /** 移动、旋转的操纵器按世界的轴还是按选中实体自己的轴（缩放总是按自己的轴）。 */
  gizmoSpace: 'world' | 'local' = 'world';
  /** 用户在视口里点选以后调（参数是新的选中）。 */
  onSelectionChanged: ((ids: readonly string[]) => void) | undefined;
  #live: LiveScene | undefined;
  #target: EditableScene | undefined;
  #selection: readonly string[] = [];

  constructor(game: Game) {
    this.game = game;
    // 从场景原来的主相机的位置看起：打开编辑器时画面不跳
    const compositor = game.graphicsCompositor;
    const sceneCamera = game.entities.ids().map((id) => game.entities.entity(id)).find((entity) => entity.get(Camera)?.slot === compositor.cameraSlot);
    this.camera = game.entities.create({ name: 'EditorCamera', components: [Transform, Camera.with({ slot: EDITOR_CAMERA_SLOT })] });
    this.camera.add({ script: EditorCameraController, init: {} });
    this.camera.add({ script: EditorViewport, init: {} });
    this.camera.require(EditorViewport).agent = this;
    const state = this.camera.require(EditorCameraController).state;
    const world = sceneCamera?.get(Transform)?.world;
    if (world) state.setFromPose({ x: world[12]!, y: world[13]!, z: world[14]! }, { x: -world[8]!, y: -world[9]!, z: -world[10]! });
    else state.setFromPose({ x: 0, y: 5, z: 10 }, { x: 0, y: -0.4, z: -1 });
    this.camera.require(EditorCameraController).apply();
    compositor.cameraSlot = EDITOR_CAMERA_SLOT;
  }

  /** 游戏自己启动时加载的根场景的内容路径（编辑器按它去读场景文件）；根场景不是按路径加载的时是 undefined。 */
  get scenePath(): string | undefined {
    return this.game.rootScene?.path;
  }

  /** 正在编辑的场景；open 之前是 undefined。 */
  get live(): LiveScene | undefined {
    return this.#live;
  }

  /** 打开的文档能不能改（给的是 EditableScene）：能改才有操纵器。 */
  get editable(): EditableScene | undefined {
    return this.#target;
  }

  /** 按文档建场景、换成根场景，之后实体跟着这份文档（sync）。给的是只读的 SceneSource 时只能看和选，不能拖。 */
  async open(source: SceneSource | EditableScene): Promise<void> {
    this.#live = await LiveScene.open(this.game, source);
    this.#target = 'apply' in source ? source : undefined;
    this.selection = this.#selection;
  }

  /** 文档改了：让实体跟上（见 LiveScene.sync）。 */
  async sync(): Promise<void> {
    await this.#require().sync();
    this.selection = this.#selection;
  }

  /** 画布上 (x, y)（CSS 像素）最前面的是文档里的哪个实体；没点到东西、点到的不在场景里时是 undefined。 */
  async pick(x: number, y: number): Promise<string | undefined> {
    const entity = await this.game.pick(x, y);
    return entity && this.#require().idOf(entity);
  }

  /** 选中的实体（文档里的 id），画面上给它们画框；设的时候去掉场景里没有的。 */
  get selection(): readonly string[] {
    return this.#selection;
  }

  set selection(ids: readonly string[]) {
    const live = this.#live;
    this.#selection = live ? ids.filter((id) => live.entity(id)?.alive) : [];
  }

  /** 这些实体（默认是选中的）的包围球：它们的模型的包围盒合起来；没有模型的按位置算一个点。都不在时是 undefined。 */
  bounds(ids: readonly string[] = this.#selection): WorldSphere | undefined {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const include = (x: number, y: number, z: number) => {
      const point = [x, y, z];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, point[axis]!);
        max[axis] = Math.max(max[axis]!, point[axis]!);
      }
    };
    for (const id of ids) {
      const entity = this.#live?.entity(id);
      if (!entity?.alive) continue;
      const boxes = modelBoxes(entity);
      const world = currentWorld(entity);
      if (boxes.length === 0) include(world[12]!, world[13]!, world[14]!);
      for (const { matrix, halfExtents: [hx, hy, hz] } of boxes) {
        for (let corner = 0; corner < 8; corner++) {
          const x = corner & 1 ? hx : -hx, y = corner & 2 ? hy : -hy, z = corner & 4 ? hz : -hz;
          include(matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!, matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!, matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!);
        }
      }
    }
    if (min[0] === Infinity) return undefined;
    const center = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2] as const;
    return { center, radius: Math.hypot(max[0]! - center[0], max[1]! - center[1], max[2]! - center[2]) };
  }

  /** 把这些实体（默认是选中的）放到画面中间；没有模型的（包围球是一个点）按 1 个单位的大小看。 */
  focus(ids: readonly string[] = this.#selection): void {
    const sphere = this.bounds(ids);
    if (!sphere) return;
    const [x, y, z] = sphere.center;
    this.camera.require(EditorCameraController).focus({ x, y, z }, sphere.radius > 0 ? sphere.radius : 0.5);
  }

  /**
   * 场景文件里一个脚本（type 是场景里写的类型名，Stride 的带命名空间）在面板上能改的属性。按类名找 TS 脚本，同加载场景时
   * 的规则；游戏里没有这个脚本、有几个重名的时是 undefined（面板按原样的 JSON 显示）。
   */
  scriptFields(type: string): Field[] | undefined {
    const found = this.game.registry.scriptsNamed(type.slice(type.lastIndexOf('.') + 1));
    return found.length === 1 ? scriptFields(found[0]!) : undefined;
  }

  /** 选中的实体里最上层的那些（祖先也被选中的不算：拖父实体时子实体跟着走，不用再各自改一遍）。 */
  selectionRoots(): Entity[] {
    const live = this.#live;
    if (!live) return [];
    const selected = new Set(this.#selection.map((id) => live.entity(id)).filter((entity): entity is Entity => entity?.alive === true));
    return [...selected].filter((entity) => {
      for (let parent = entity.require(Transform).parent; parent; parent = parent.require(Transform).parent) if (selected.has(parent)) return false;
      return true;
    });
  }

  #require(): LiveScene {
    if (!this.#live) throw new Error('the editor has no scene open yet (EditAgent.open)');
    return this.#live;
  }
}

/**
 * 实体现在的世界矩阵。世界矩阵平时每帧统一算一次；文档刚改过（或者场景刚打开）的这一帧里它还是旧的，所以编辑器要用
 * 世界位姿的地方都先算一下这个实体和它的祖先。
 */
function currentWorld(entity: Entity): Float32Array {
  const transform = entity.require(Transform);
  transform.updateWorldMatrix();
  return transform.world;
}

/** 实体的模型（它自己的和引擎给多出来的网格建的子实体的）在世界里的包围盒：盒子的矩阵（中心在原点）和半边长。 */
function modelBoxes(entity: Entity): { matrix: Matrix4; halfExtents: [number, number, number] }[] {
  const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
  const boxes: { matrix: Matrix4; halfExtents: [number, number, number] }[] = [];
  for (const part of parts) {
    const mesh = Mesh.byId(part.get(Model)?.mesh ?? -1);
    if (!mesh) continue;
    const { min, max } = mesh.bounds;
    const center = Matrix.scaleTranslation(new Float32Array(16), 1, 1, 1, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    boxes.push({
      matrix: Matrix.multiply(new Float32Array(16), currentWorld(part), center),
      halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
    });
  }
  return boxes;
}

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
class EditorViewport extends SyncScript {
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
      const boxes = modelBoxes(entity);
      for (const { matrix, halfExtents } of boxes) draw.box(matrix, halfExtents, SELECTION_COLOR, { width: 2, depthTest: false });
      if (boxes.length === 0) draw.axes(currentWorld(entity), 0.5, { width: 2, depthTest: false });
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
    if (roots.length > 0) this.#placeGizmo(agent, roots[0]!);
    else if (this.#drag) this.#endDrag(agent);

    if (roots.length > 0 && !this.#drag) this.#hover = navigating ? undefined : gizmo.pick(pixel, this.#project);
    if (input.isMouseButtonPressed('left') && !navigating) {
      if (roots.length > 0 && this.#hover && gizmo.begin(this.#hover, this.#ray(pixel), pixel)) {
        this.#drag = { starts: roots.map((entity) => this.#dragStart(live, entity)), key: `gizmo:${++this.#drags}` };
      } else {
        this.#pressed = pixel;
      }
    }
    if (this.#drag && input.isMouseButtonDown('left')) this.#applyDrag(agent, pixel);
    if (input.isMouseButtonReleased('left')) {
      if (this.#drag) this.#endDrag(agent);
      else if (this.#pressed && Math.hypot(pixel[0] - this.#pressed[0], pixel[1] - this.#pressed[1]) < CLICK_PIXELS) this.#click(agent, pixel, input.isKeyDown('ControlLeft') || input.isKeyDown('ControlRight'));
      this.#pressed = undefined;
    }
    if (roots.length > 0) this.#drawGizmo(gizmo);
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

export type { SceneFile, SceneSource };
