/**
 * 视口里的编辑工具（画贴图、雕刻地形、编辑多边形、样条、白盒）：开着一个工具时左键交给它，不再是点选实体、拖操纵器。EditAgent
 * 同一时间只开一个（`agent.tool`），EditorViewport 每帧把这一帧的输入和换算（ViewportFrame）交给它的 update。
 *
 * 工具自己记着编辑的状态（文件、选中的东西、正在拖的），改了以后调回调告诉编辑器（存文件、记撤销）；编辑器的界面在另一个页面里，
 * 只经 EditAgent 的工厂方法（editPoly、sculptTerrain……）拿到工具，不自己 new（游戏页面是另一个 realm）。
 */
import type { Game } from '../../../engine/Game';
import type { InputManager } from '../../../input/InputManager';
import { Matrix, type MatrixSource } from '../../../data/Matrix';
import type { DebugColor } from '../../../debug/DebugDraw';
import type { EditAgent } from '../EditAgent';
import type { GizmoHandle, Ray } from '../TransformGizmo';

export type Pixel = readonly [number, number];
export type Point3 = readonly [number, number, number];

/** 两次按下隔多久以内算双击（毫秒）。 */
const DOUBLE_CLICK_MS = 400;
/** 按下到松开鼠标挪了不到这么多像素算点一下（双击的两次按下也要离这么近）。 */
export const CLICK_PIXELS = 4;

/** EditorViewport 给工具的一帧：输入、光标、按键的状态，屏幕和世界之间的换算，操纵器。 */
export interface ViewportFrame {
  readonly game: Game;
  readonly agent: EditAgent;
  readonly input: InputManager;
  /** 光标在画布上的位置（CSS 像素）。 */
  readonly pixel: Pixel;
  /** 正在转视角（按着 Alt、右键、中键）：左键不归工具。 */
  readonly navigating: boolean;
  /** 这一帧按下了左键（没在转视角）。 */
  readonly pressed: boolean;
  /** 这一帧左键按着（包括这一帧刚按下的）。 */
  readonly down: boolean;
  /** 这一帧松开了左键。 */
  readonly released: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  /** 加选（按着 Shift 或 Ctrl）。 */
  readonly additive: boolean;
  /** 这一帧按下左键那一刻的位置（帧率低时按下、拖动、松开可能落在同一帧）；没按下时是光标的位置。 */
  readonly pressPixel: Pixel;
  /** 过这个像素的视线（世界坐标）。 */
  ray(pixel: Pixel): Ray;
  /** 世界里的点投到画布上（CSS 像素）；在相机后面时是 undefined。 */
  project(point: Point3): Pixel | undefined;
  /** 画面在这个点那么远的地方有多高（世界单位）：顶点的方块、手柄按它定大小，画面上看着一样大。 */
  viewHeight(point: Point3): number;
  /** 编辑相机到这一点的距离。 */
  distanceTo(point: Point3): number;
  /**
   * 操纵器放在 center（世界坐标）：拖的时候朝向不变，不拖时按 world（实体的世界矩阵）的旋转（局部空间、缩放）或世界的轴；
   * 按吸附的设置（Ctrl 反过来）；不拖、不转视角时记下光标指着的把手（画的时候高亮）。
   */
  placeGizmo(center: Point3, world: MatrixSource, dragging: boolean): void;
  /** 这个像素上的操纵器把手。 */
  pickGizmo(pixel: Pixel): GizmoHandle | undefined;
  /** 画操纵器（拖着的、指着的把手高亮）。 */
  drawGizmo(): void;
}

/** 工具画的线：没选中的线框、选中的（同选中实体的框）、拖着和指着的把手（同操纵器）。 */
export const EDGE_COLOR: DebugColor = [0.85, 0.88, 0.95, 0.7];
export const SELECTED_COLOR: DebugColor = [1, 0.55, 0.1, 1];
export const ACTIVE_COLOR: DebugColor = [1, 0.9, 0.2, 1];
/** 顶点、控制点、手柄的小方块的半边长（画面高度的倍数）。 */
export const VERTEX_SCREEN_SIZE = 0.004;

/** 在 point 画一个半边长 half 的小方块（顶点、控制点、手柄；关了深度测试，挡住的也看得见）。 */
export function drawPointBox(frame: ViewportFrame, point: Point3, half: number, color: DebugColor): void {
  frame.game.debugDraw.box(Matrix.compose(new Float32Array(16), point, [0, 0, 0, 1], [1, 1, 1]), [half, half, half], color, { width: 2, depthTest: false });
}

/** 视口里的一个编辑工具。 */
export interface ViewportTool {
  /** 编辑的实体（场景文件的 id）：选中它时不画选中的框，工具自己画。 */
  readonly entity: string;
  /** 每帧调一次：读输入、改状态、画叠加的线。 */
  update(frame: ViewportFrame): void;
  /** 工具关掉（换了别的工具、结束编辑）：放掉它占的资源。 */
  dispose?(): void;
}

/** 按下、点一下、双击：工具共用的左键手势。 */
export class Clicks {
  #pressed: Pixel | undefined;
  #last: { readonly time: number; readonly at: Pixel } | undefined;

  /**
   * 这一帧按下了左键：按下的位置，和算不算双击（离上一次按下够近、够快；帧率低、自动化发的双击两次按下落在同一帧里也算）。
   * 记下按下的位置，松开时 click 判断是不是点一下；按下就开始拖的（按在把手上）调 cancel。
   */
  press(frame: ViewportFrame): { readonly at: Pixel; readonly double: boolean } | undefined {
    if (!frame.pressed) return undefined;
    const at = frame.pressPixel, now = performance.now(), last = this.#last;
    const presses = frame.input.pointerEvents.filter((event) => event.device === 'mouse' && event.eventType === 'pressed').length;
    const double = presses >= 2 || (last !== undefined && now - last.time < DOUBLE_CLICK_MS && Math.hypot(at[0] - last.at[0], at[1] - last.at[1]) < CLICK_PIXELS);
    this.#last = { time: now, at };
    this.#pressed = at;
    return { at, double };
  }

  /** 这次按下不当点一下（开始拖了、双击已经做了事）。 */
  cancel(): void {
    this.#pressed = undefined;
  }

  /** 这一帧松开了左键、按下以后没挪远：点一下的位置（松开处）；否则 undefined。松开时清掉按下的记录。 */
  click(frame: ViewportFrame): Pixel | undefined {
    if (!frame.released) return undefined;
    const pressed = this.#pressed;
    this.#pressed = undefined;
    return pressed && Math.hypot(frame.pixel[0] - pressed[0], frame.pixel[1] - pressed[1]) < CLICK_PIXELS ? frame.pixel : undefined;
  }
}

/**
 * 编辑一个资源文件的工具（多边形网格、样条、白盒）：哪个实体上的模型、它的源文件路径、文件现在的内容（拖的时候每帧换）和
 * 选中的东西。改了以后调 onChanged：commit 是一次操作做完（松开把手、加了点），编辑器这时存文件、记一步撤销；不是 commit 的
 * （拖的中途、换了选中的）只刷新界面。
 */
export abstract class FileEditTool<F, S> implements ViewportTool {
  readonly entity: string;
  /** 源文件的内容路径（烘成同名的模型）。 */
  readonly path: string;
  file: F;
  selection: S;
  onChanged: ((commit: boolean) => void) | undefined;

  constructor(entity: string, path: string, file: F, selection: S) {
    this.entity = entity;
    this.path = path;
    this.file = file;
    this.selection = selection;
  }

  abstract update(frame: ViewportFrame): void;

  protected changed(commit: boolean): void {
    this.onChanged?.(commit);
  }
}
