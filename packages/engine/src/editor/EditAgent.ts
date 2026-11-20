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
 * - 左键点一下：选中点到的实体（Ctrl 是加选、再点去掉），点空处取消选中；点得到网格、精灵、粒子、放在 3D 里的 UI（见
 *   Game.pick），全屏的 UI 点不到；选中的框是它们的包围盒、UI 的那块板；
 * - 左键拖操纵器的把手：改选中的实体的位置、旋转、缩放，每帧一个修改（同一次拖并成撤销的一步）；
 * - W、E、R：移动、旋转、缩放；F：把选中的东西放到画面中间；相机的操作见 EditorCamera。
 */
import type { SceneFile } from '../content/format';
import { sceneComponentKey } from '../content/SceneBuilder';
import { requiredName } from '../content/sceneScripts';
import type { Entity } from '../engine/Entity';
import { SyncScript } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';
import { Matrix, type Matrix4 } from '../data/Matrix';
import { Quaternion, Vector3 } from '../data/vectors';
import { screenToWorldRaySegment, worldToScreen } from '../rendering/cameraRays';
import { Camera, Model, ModelPart, ReflectionProbe } from '../rendering/components';
import { Mesh } from '../rendering/mesh/Mesh';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { UIComponent } from '../ui/UIComponent';
import type { DebugColor } from '../debug/DebugDraw';
import type { PointerEvent } from '../input/InputManager';
import { EditorCameraController } from './EditorCamera';
import { scriptFields, type Field } from './fields';
import { LiveScene, type SceneSource } from './LiveScene';
import type { SceneEdit } from './SceneDocument';
import { applyGizmoChange, applySnap, DEFAULT_SNAP, TransformGizmo, type GizmoAxis, type GizmoHandle, type Ray, type SnapSettings } from './TransformGizmo';

/** 编辑相机用的相机槽位（场景里的相机用 0 起的小数字）。 */
export const EDITOR_CAMERA_SLOT = 0xed17;

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

/** 脚本要的一种组件在场景文件里怎么加（EditAgent.requiredComponents）。 */
export interface RequiredComponentEntry {
  readonly name: string;
  /** 场景文件里的组件键（`ui`、`model`……）。 */
  readonly component?: string;
  /** 游戏登记的脚本名（要的是另一个脚本时）。 */
  readonly script?: string;
}

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
  /** 吸附：步长和"一直吸附"，拖操纵器时按住 Ctrl 反过来。编辑器的界面记着它，页面重新加载以后再设回来。 */
  snap: SnapSettings = DEFAULT_SNAP;
  /** 用户在视口里点选以后调（参数是新的选中）。 */
  onSelectionChanged: ((ids: readonly string[]) => void) | undefined;
  #live: LiveScene | undefined;
  #target: EditableScene | undefined;
  #selection: readonly string[] = [];
  /** 反射探针上次重拍时的文档（sync 里比，文档变了就重拍）。 */
  #probesFile: SceneFile | undefined;

  constructor(game: Game) {
    this.game = game;
    // 从场景原来的主相机的位置看起：打开编辑器时画面不跳
    const compositor = game.graphicsCompositor;
    const sceneCamera = game.entities.ids().map((id) => game.entities.entity(id)).find((entity) => entity.get(Camera)?.slot === compositor.cameraSlot);
    // 投影也照它的（2D 游戏的相机是正交的）
    const lens = sceneCamera?.get(Camera);
    this.camera = game.entities.create({
      name: 'EditorCamera',
      components: [Transform, Camera.with({
        ...(lens ? { projection: lens.projection, verticalFieldOfView: lens.verticalFieldOfView, orthographicSize: lens.orthographicSize, nearClipPlane: lens.nearClipPlane, farClipPlane: lens.farClipPlane } : {}),
        slot: EDITOR_CAMERA_SLOT,
      })],
    });
    this.camera.add({ script: EditorCameraController, init: {} });
    this.camera.add({ script: EditorViewport, init: {} });
    this.camera.require(EditorViewport).agent = this;
    const state = this.camera.require(EditorCameraController).state;
    // 这时第一帧还没跑，世界矩阵还没算过
    const world = sceneCamera?.has(Transform) ? currentWorld(sceneCamera) : undefined;
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
    const live = this.#require();
    await live.sync();
    this.selection = this.#selection;
    // 场景改了（挪了东西、改了灯和天空）：反射探针重拍。游戏里 refresh 是 once 的探针只在自己加进来、挪了、改了设置时拍，
    // 编辑时拍的是改之前的样子，反射里留着旧的灯光
    if (live.document.file !== this.#probesFile) {
      this.#probesFile = live.document.file;
      this.game.renderSystem.reflectionProbes.refresh();
    }
  }

  /**
   * 画布上 (x, y)（CSS 像素）最前面的是文档里的哪个实体；没点到东西、点到的不在场景里时是 undefined。点到预制体实例的成员时
   * 是那个实例（成员不在文档里，id 是 `实例/预制体里的 id`，见 content/prefabInstances.ts）。
   */
  async pick(x: number, y: number): Promise<string | undefined> {
    const entity = await this.game.pick(x, y);
    const id = entity && this.#require().idOf(entity);
    return id === undefined ? undefined : id.slice(0, id.includes('/') ? id.indexOf('/') : undefined);
  }

  /** 选中的实体（文档里的 id），画面上给它们画框；设的时候去掉场景里没有的。 */
  get selection(): readonly string[] {
    return this.#selection;
  }

  set selection(ids: readonly string[]) {
    const live = this.#live;
    this.#selection = live ? ids.filter((id) => live.entity(id)?.alive) : [];
  }

  /** 这些实体（默认是选中的）的包围球：它们的选中框（见 selectionBoxes）合起来；没有选中框的按位置算一个点。都不在时是 undefined。 */
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
      // 反射探针按它影响的盒子算（探针实体自己一般没有模型，按一个点看会贴得太近）
      const probe = probeBoxes(entity);
      const boxes = [...selectionBoxes(this.game, entity), ...(probe ? [probe] : [])];
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
   * 场景文件里一个脚本（type 是场景里写的类型名：登记的名字，或 Stride 的带命名空间的）在面板上能改的属性。找 TS 脚本的
   * 规则同加载场景（Registry.scriptsForType）；游戏里没有这个脚本、有几个重名的时是 undefined（面板按原样的 JSON 显示）。
   */
  scriptFields(type: string): Field[] | undefined {
    const found = this.game.registry.scriptsForType(type);
    return found.length === 1 ? scriptFields(found[0]!) : undefined;
  }

  /**
   * 脚本（type 同 scriptFields）要实体上有的组件（脚本的 requires），各自在场景文件里怎么加：component 是场景文件的组件键，
   * script 是游戏登记的脚本名；都没有的（游戏代码里加的组件）只有名字，编辑器加不了。
   */
  requiredComponents(type: string): RequiredComponentEntry[] {
    const found = this.game.registry.scriptsForType(type);
    if (found.length !== 1) return [];
    return found[0]!.requires.map((required): RequiredComponentEntry => {
      const value = required();
      const name = requiredName(value);
      const component = sceneComponentKey(value);
      if (component) return { name, component };
      const script = 'scriptName' in value && value.scriptName !== undefined && this.game.registry.get(value.scriptName) === value ? value.scriptName : undefined;
      return script ? { name, script } : { name };
    });
  }

  /** 游戏登记的脚本（"添加组件"列出来的），按名字排；加到实体上时 type 就写这个名字。 */
  scriptTypes(): string[] {
    return this.game.registry.gameScriptNames().sort();
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

/** 世界里的一个盒子：矩阵（中心在原点）和半边长。 */
interface WorldBox {
  readonly matrix: Matrix4;
  readonly halfExtents: readonly [number, number, number];
}

/**
 * 实体在视口里的选中框（点选能点到的那些东西）：模型（它自己的和引擎给多出来的网格建的子实体的）的包围盒；粒子系统的包围
 * 形状，没有时是活着的粒子占的范围；放在 3D 里的 UI 的那块板。
 */
function selectionBoxes(game: Game, entity: Entity): WorldBox[] {
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
  return boxes;
}

/**
 * 反射探针影响的盒子（同 rendering/lighting/ReflectionProbes 的算法）：以实体为中心、按世界的轴摆，边长是 size 乘实体的缩放；blend 是
 * 过渡距离（离盒子的面这么近以内淡出）。实体上没有探针时是 undefined。
 */
function probeBoxes(entity: Entity): { matrix: Matrix4; halfExtents: [number, number, number]; blend: number } | undefined {
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
function modelBoxes(entity: Entity): WorldBox[] {
  const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
  const boxes: WorldBox[] = [];
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

export type { SceneFile, SceneSource };
