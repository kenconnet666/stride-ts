/**
 * 游戏页面开在编辑状态时（Game.editing），编辑器在这个页面里的代理：`game.editor`。编辑器的界面在外面（另一个页面，
 * 把游戏页面嵌在里面），经它操作游戏里的东西：让实体跟着场景文档、点选、选中的框、操纵器（Gizmo）、编辑相机。
 *
 * 编辑状态下游戏照自己的入口启动（加载它的默认场景），只是场景不挂脚本、仿真不走；所以应用的代码不用为编辑器改。
 * 试玩是把页面不带编辑状态重新打开：一个干净的游戏，脚本在试玩里改的状态不会漏回编辑状态。
 *
 * 编辑器自己的相机不在场景里：单独的实体，用自己的相机槽位，主画面改画它。视口里的操作（点选、拖操纵器、快捷键）在
 * EditorViewport，挂在编辑相机的实体上。
 */
import type { SceneFile, TimelineFile, TimelineTrackFile } from '../content/format';
import { evaluateCurve } from '../animation/curves';
import { timelineCurve } from '../timeline/Timeline';
import { sceneComponentKey } from '../content/SceneBuilder';
import { requiredName } from '../content/sceneScripts';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';
import { Camera, Model, ModelPart } from '../rendering/components';
import { Mesh } from '../rendering/mesh/Mesh';
import type { Material } from '../rendering/mesh/Material';
import { MeshPainter, type PaintTarget } from '../rendering/paint/MeshPainter';
import { encodePng } from '../offline/png';
import { EditorCameraController } from './EditorCamera';
import { EditorViewport } from './EditorViewport';
import { scriptFields, type Field } from './fields';
import { LiveScene, type SceneSource } from './LiveScene';
import { TimelinePreview, type TimelinePreviewState } from './TimelinePreview';
import type { SceneEdit } from './SceneDocument';
import { DEFAULT_SNAP, TransformGizmo, type SnapSettings } from './TransformGizmo';
import { currentWorld, probeBoxes, selectionBoxes } from './worldBoxes';

/** 编辑相机用的相机槽位（场景里的相机用 0 起的小数字）。 */
export const EDITOR_CAMERA_SLOT = 0xed17;

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

/** 绘制模式的笔刷设置（半径米，硬度、强度 0..1；erase 是画 0）。 */
export interface PaintBrush {
  readonly radius: number;
  readonly hardness: number;
  readonly strength: number;
  readonly erase: boolean;
}

/** 在模型上画贴图：画哪个实体上用这个材质的网格，画进哪张遮罩。 */
export interface PaintSession {
  readonly entity: string;
  readonly material: Material;
  /** 遮罩贴图的内容路径（线性的 png）。 */
  readonly mask: string;
  readonly painter: MeshPainter;
  brush: PaintBrush;
}

export const DEFAULT_PAINT_BRUSH: PaintBrush = { radius: 0.25, hardness: 0.5, strength: 0.8, erase: false };

const PAINT_HELP = 'Paint a material layer mask on a model in the editor (the viewport page): args entity (scene file id), material and mask (content paths; '
  + 'the mask is a linear png, a layer blend of the material), points ([[x, y, z], ...] world space; dabs every quarter radius along them), '
  + 'radius (m), hardness, strength (0..1), erase. Saves the png through the editor backend.';

/** 经编辑器后端写一张 png（PUT /image，同 @stride-ts/editor 的 EditorClient.saveImage）。 */
async function saveImage(path: string, png: Uint8Array<ArrayBuffer>): Promise<void> {
  const response = await fetch(`/__stride/editor/api/image?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'x-stride-editor': '1' }, body: png });
  if (!response.ok) throw new Error(`saving ${path} failed: ${((await response.json()) as { error?: string }).error ?? `HTTP ${response.status}`}`);
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
  /** 在模型上画贴图（S2）：开着时视口里左键拖是画，不是点选、拖操纵器（见 EditorViewport）。 */
  paint: PaintSession | undefined;
  /** 一笔画完（松开左键）以后调：遮罩的内容路径和读回的像素（编辑器存成 png）。 */
  onPaintStroke: ((mask: string, image: { readonly width: number; readonly height: number; readonly rgba: Uint8Array<ArrayBuffer> }) => void) | undefined;
  /** 用户在视口里点选以后调（参数是新的选中）。 */
  onSelectionChanged: ((ids: readonly string[]) => void) | undefined;
  #live: LiveScene | undefined;
  #timelinePreview: TimelinePreview | undefined;
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
    game.debug.command('paint', PAINT_HELP, (args) => this.#paintCommand(args));
  }

  /**
   * 调试命令 paint（agent 不点界面也能在模型上画）：沿着点列（世界坐标）每隔半径的四分之一落一笔，画完经编辑器后端存成 png。
   * 编辑器里正开着绘制模式时用它的设置画同一张遮罩。
   */
  async #paintCommand(args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const { entity, material, mask } = args as { entity?: string; material?: string; mask?: string };
    const points = args['points'] as readonly (readonly [number, number, number])[] | undefined;
    if (typeof entity !== 'string' || typeof material !== 'string' || typeof mask !== 'string' || !Array.isArray(points) || points.length === 0) {
      throw new Error('paint needs entity (scene file id), material and mask (content paths) and points ([[x, y, z], ...] in world space)');
    }
    const brush: PaintBrush = {
      radius: Number(args['radius'] ?? DEFAULT_PAINT_BRUSH.radius), hardness: Number(args['hardness'] ?? DEFAULT_PAINT_BRUSH.hardness),
      strength: Number(args['strength'] ?? DEFAULT_PAINT_BRUSH.strength), erase: args['erase'] === true,
    };
    const reuse = this.paint?.entity === entity && this.paint.mask === mask;
    if (!reuse) await this.beginPaint(entity, material, mask, brush);
    const paint = this.paint!;
    const targets = this.paintTargets();
    if (targets.length === 0) throw new Error(`entity ${entity} has no mesh with material ${material}`);
    let dabs = 0;
    const dab = (center: readonly [number, number, number]) => {
      paint.painter.dab(targets, { center, radius: brush.radius, hardness: brush.hardness, strength: brush.strength, value: brush.erase ? [0, 0, 0, 1] : [1, 1, 1, 1] });
      dabs++;
    };
    dab(points[0]!);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      const gap = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const steps = Math.max(1, Math.ceil(gap / (brush.radius * 0.25)));
      for (let k = 1; k <= steps; k++) dab([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps, a[2] + ((b[2] - a[2]) * k) / steps]);
    }
    paint.painter.commit();
    const image = await paint.painter.read();
    if (this.onPaintStroke && reuse) this.onPaintStroke(mask, image);
    else await saveImage(mask, await encodePng(image.rgba, image.width, image.height));
    if (!reuse) this.endPaint();
    return { dabs, mask };
  }

  /**
   * 开始在模型上画：实体（场景文件里的 id）上用 material 这个材质的网格，画进 mask（材质层遮罩用的线性 png，内容路径）。
   * 之前开着的先结束。
   */
  async beginPaint(entity: string, material: string, mask: string, brush: PaintBrush = this.paint?.brush ?? DEFAULT_PAINT_BRUSH): Promise<void> {
    this.endPaint();
    const [loaded, texture] = await Promise.all([this.game.content.loadMaterial(material), this.game.content.loadTextureRef({ texture: mask, encoding: 'png', srgb: false }, false)]);
    this.paint = { entity, material: loaded, mask, painter: new MeshPainter(this.game.renderSystem.resources, texture), brush };
  }

  endPaint(): void {
    this.paint?.painter.destroy();
    this.paint = undefined;
  }

  /** @internal 正在画的实体上用那个材质的网格和它们现在的世界矩阵（模型多出来的网格在子实体 ModelPart 上）。 */
  paintTargets(): PaintTarget[] {
    const paint = this.paint, entity = paint && this.#live?.entity(paint.entity);
    if (!paint || !entity?.alive) return [];
    const parts = [entity, ...entity.require(Transform).children.filter((child) => child.has(ModelPart))];
    return parts.flatMap((part) => {
      const model = part.get(Model);
      const mesh = model && model.material === paint.material.id ? Mesh.byId(model.mesh) : undefined;
      return mesh ? [{ mesh, world: new Float32Array(currentWorld(part)) }] : [];
    });
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

  /** 资源的文件改了（编辑器给出改了的和间接用到它们的内容路径）：引用它们的实体重建（见 LiveScene.reloadAssets）。 */
  async reloadAssets(paths: readonly string[]): Promise<void> {
    await this.#live?.reloadAssets(paths);
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

  /**
   * 时间轴的预览（编辑器里拖时间）：视口里的场景摆成 file 在 time 秒的样子，不改场景文档；throughCamera 时从时间轴那一刻的
   * 相机里看。返回那一刻的相机（场景文件里的 id）和字幕。
   */
  previewTimeline(file: TimelineFile, time: number, options: { readonly throughCamera?: boolean } = {}): TimelinePreviewState {
    this.#timelinePreview ??= new TimelinePreview(this.game, (id) => this.#live?.entity(id));
    return this.#timelinePreview.show(file, time, options);
  }

  /** 结束预览：场景回到文档的样子，主画面回到编辑相机。 */
  endTimelinePreview(): void {
    this.#timelinePreview?.end();
  }

  /**
   * 时间轴的一条属性轨道按曲线取样（曲线编辑器画线用）：从 0 到 duration 取 samples 个时刻，每个时刻按分量的值。实体或组件
   * 找不到、轨道没有关键帧时 undefined。
   */
  sampleTimelineTrack(track: Extract<TimelineTrackFile, { type: 'property' }>, duration: number, samples: number): { times: number[]; values: number[][] } | undefined {
    const entity = this.#live?.entity(track.entity);
    const component = entity && entity.manager.componentTypes(entity.id).find((type) => type.name === track.component);
    if (!component || track.keys.length === 0) return undefined;
    const curve = timelineCurve('preview', track, component);
    const value = new Float32Array(curve.size);
    const times: number[] = [], values: number[][] = [];
    for (let i = 0; i < samples; i++) {
      const time = (duration * i) / (samples - 1);
      evaluateCurve(curve, time, value);
      times.push(time);
      values.push([...value]);
    }
    return { times, values };
  }

  /**
   * 运行时实体（场景文件里的 id）上一个组件属性现在的值：数，或者按分量的数组（向量 xyz、四元数 xyzw、颜色 rgba）。
   * 时间轴面板"加关键帧"用：拖时间预览着的是曲线的值，刚用操纵器挪过的是挪到的位置。没有时 undefined。
   */
  readProperty(id: string, component: string, property: string): number | number[] | undefined {
    const entity = this.#live?.entity(id);
    const type = entity && entity.manager.componentTypes(entity.id).find((candidate) => candidate.name === component);
    const value = type && (entity.get(type) as Record<string, unknown>)[property];
    if (typeof value === 'number') return value;
    if (value === null || typeof value !== 'object') return undefined;
    const v = value as Record<string, number>;
    return 'r' in v ? [v['r']!, v['g']!, v['b']!, v['a']!] : 'w' in v ? [v['x']!, v['y']!, v['z']!, v['w']!] : [v['x']!, v['y']!, v['z']!];
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

export type { SceneFile, SceneSource };
