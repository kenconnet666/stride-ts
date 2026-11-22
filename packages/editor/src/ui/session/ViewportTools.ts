/**
 * 视口里的编辑工具（画贴图、雕刻地形、编辑多边形、样条、白盒）在界面这边的控制器：开关工具（同一时间一个）、工具条要的状态、
 * 工具条上的操作，撤销重做（FileEditing）。工具本身在游戏页面里（EditAgent 的工厂方法开，见引擎的 editor/viewport/tools），
 * 改了以后经回调告诉这里。会话持有它（`session.tools`），工具条、属性面板、图层栏用它。
 */
import { shallowRef } from 'vue';
import type { BrushEditTool, PaintBrush, PaintTool, PolyEditTool, PolySelection, PolySelectMode, SculptBrush, SculptTool, SplineEditTool } from '@stride-ts/engine';
import { branchFromPoint, deleteBrush, deleteSplinePoints } from '@stride-ts/engine';
import { applyPolyOperation, type PolyEditResult, type PolyOperation } from '@stride-ts/engine/modeling';
import type { BrushFile, BrushShapeFile, PolyMeshFile, SplineFile, TerrainFile } from '@stride-ts/engine/content-format';
import { encodePng } from '@stride-ts/engine/png';
import { freeAssetPath } from '../../newAssets';
import { t } from '../messages';
import type { EditorSession } from '../session';
import { FileEditing } from './FileEditing';

/** 模型能从哪种源文件烘出来、在视口里编辑：多边形网格、样条、白盒。 */
export type ModelSourceKind = 'poly' | 'spline' | 'brush';

const NO_POLY_SELECTION: PolySelection = { vertices: [], edges: [], faces: [] };

export class ViewportTools {
  /** 正在画的材质层（属性面板里开着的材质的第几层、它的遮罩）；没在画时是 undefined。 */
  readonly painting = shallowRef<{ readonly layer: number; readonly mask: string }>();
  /** 绘制的笔刷，换着画别的层时保留。 */
  readonly paintBrush = shallowRef<PaintBrush>({ radius: 0.25, hardness: 0.5, strength: 0.8, erase: false });
  /**
   * 正在雕刻的地形：哪个实体、哪个 .terrain.json，现在存着的文件（工具条显示几笔、选中的地物的字段），左键拖的是笔刷还是
   * 地物，选中的地物（file.features 的下标）。
   */
  readonly sculpting = shallowRef<{ readonly entity: string; readonly path: string; readonly file: TerrainFile; readonly tool: 'brush' | 'features'; readonly feature: number | undefined }>();
  /** 雕刻的笔刷，换着雕别的地形时保留。 */
  readonly sculptBrush = shallowRef<SculptBrush>({ op: 'raise', radius: 40, strength: 4 });
  /** 正在编辑的多边形网格：哪个实体上、哪个 .poly.json，选择模式、选中的东西和现在的网格。 */
  readonly polyEditing = shallowRef<{ readonly entity: string; readonly path: string; readonly mode: PolySelectMode; readonly selection: PolySelection; readonly mesh: PolyMeshFile }>();
  /** 正在编辑的样条：哪个实体上、哪个 .spline.json，选中的控制点和现在的样条。 */
  readonly splineEditing = shallowRef<{ readonly entity: string; readonly path: string; readonly selection: readonly number[]; readonly spline: SplineFile }>();
  /** 正在编辑的白盒：哪个实体上、哪个 .brush.json，选中的笔刷和现在的白盒。 */
  readonly brushEditing = shallowRef<{ readonly entity: string; readonly path: string; readonly selection: number | undefined; readonly brush: BrushFile }>();

  readonly #session: EditorSession;
  /** 正在编辑的文件的撤销、存盘（画贴图没有：一笔一存，覆盖遮罩）；响应式的：主工具条的撤销按钮跟着它换。 */
  readonly #editing = shallowRef<FileEditing<object>>();
  #paint: PaintTool | undefined;
  #poly: PolyEditTool | undefined;
  #spline: SplineEditTool | undefined;
  #brush: BrushEditTool | undefined;
  #sculpt: SculptTool | undefined;

  constructor(session: EditorSession) {
    this.#session = session;
  }

  /** 正开着的工具在编辑的文件的撤销历史（会话的撤销、重做这时归它）；没开、在画贴图时是 undefined。 */
  get history(): FileEditing<object>['history'] | undefined {
    return this.#editing.value?.history;
  }

  /** 模型 modelPath 是不是从这种源文件烘出来的：同一路径有那种资源时是它的路径。 */
  sourceOf(kind: ModelSourceKind, modelPath: string): string | undefined {
    return this.#session.assets.value.some((asset) => asset.kind === kind && asset.path === modelPath) ? modelPath : undefined;
  }

  /** 关掉正开着的工具（视口里左键回到点选），工具条收起。 */
  stop(): void {
    const session = this.#session;
    session.agent.value?.endTool();
    if ([t.polyHint, t.splineHint, t.brushHint, t.sculptHint, t.featuresHint].includes(session.status.value)) session.status.value = '';
    this.#forget();
  }

  /** 游戏页面重新加载了（试玩、热重载）：页面里的工具没了，这边的状态清掉。 */
  detach(): void {
    this.#forget();
  }

  #forget(): void {
    this.#editing.value = undefined;
    this.#paint = undefined;
    this.#poly = this.#spline = this.#brush = this.#sculpt = undefined;
    this.painting.value = undefined;
    this.sculpting.value = undefined;
    this.polyEditing.value = undefined;
    this.splineEditing.value = undefined;
    this.brushEditing.value = undefined;
  }

  /** 开一个编辑文件的工具：先关掉别的，读文件，记撤销的起点。 */
  async #open<F extends object>(kind: 'poly' | 'spline' | 'brush' | 'terrain', path: string, restore: (file: F) => void): Promise<F | undefined> {
    const session = this.#session;
    if (!session.agent.value) return undefined;
    this.stop();
    const file = await session.client.readAsset<F>(kind, path);
    this.#editing.value = new FileEditing<F>({ client: session.client, kind, path, file, restore, onError: (message) => (session.notice.value = message) }) as unknown as FileEditing<object>;
    session.notice.value = '';
    return file;
  }

  // ── 画贴图 ──

  /**
   * 给属性面板里开着的材质加一个绘制层：一张全黑的遮罩（1024 x 1024 的线性 png，放在材质旁边的 Masks 文件夹），材质层的 blend
   * 采样它的 r，填充是深灰色、粗糙度 0.6（之后在图层栏里改）。返回新层的下标。
   */
  async addPaintLayer(): Promise<number | undefined> {
    const session = this.#session, inspected = session.inspected.value;
    if (inspected?.kind !== 'material') return undefined;
    const layers = (inspected.content['layers'] as unknown[] | undefined) ?? [];
    const folder = inspected.path.includes('/') ? inspected.path.slice(0, inspected.path.lastIndexOf('/')) : '';
    const base = inspected.path.slice(inspected.path.lastIndexOf('/') + 1);
    const taken = new Set(session.assets.value.map((asset) => `${asset.kind}:${asset.path}`));
    const mask = freeAssetPath(folder ? `${folder}/Masks` : 'Masks', `${base}Layer${layers.length + 1}`, 'image', taken);
    const size = 1024;
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    await session.client.saveImage(mask, await encodePng(rgba, size, size));
    session.editInspected(['layers'], [...layers, {
      blend: { $type: 'computeTextureScalar', texture: { texture: mask, encoding: 'png', srgb: false }, channel: 'r' },
      diffuse: { $type: 'computeColor', value: [0.25, 0.25, 0.25, 1] },
      metalness: { $type: 'computeFloat', value: 0 },
      glossiness: { tree: { $type: 'computeFloat', value: 0.6 }, invert: true },
    }]);
    return layers.length;
  }

  /**
   * 在视口里开始画第 layer 层的遮罩：画选中的实体上用这个材质的网格。一笔画完存 png（覆盖遮罩）。层的遮罩要是线性的 png
   * （addPaintLayer 建的那种）。
   */
  async startPainting(layer: number): Promise<void> {
    const session = this.#session, inspected = session.inspected.value, agent = session.agent.value;
    const entity = session.selection.value[0];
    if (inspected?.kind !== 'material' || !agent) return;
    if (!entity) {
      session.notice.value = t.paintSelectEntity;
      return;
    }
    const blend = ((inspected.content['layers'] as { blend?: { texture?: { texture?: string } } }[] | undefined) ?? [])[layer]?.blend;
    const mask = blend?.texture?.texture;
    if (!mask) {
      session.notice.value = t.paintNoMask;
      return;
    }
    this.stop();
    // 存过还没刷新的材质先存下来：视口里的材质要有这一层
    await session.flushInspected();
    const tool = this.#paint = await agent.paintMesh(entity, inspected.path, mask, this.paintBrush.value);
    tool.onStroke = (path, image) => {
      void encodePng(image.rgba, image.width, image.height).then((png) => session.client.saveImage(path, png)).catch((error: unknown) => (session.notice.value = (error as Error).message));
    };
    this.painting.value = { layer, mask };
    session.notice.value = '';
  }

  setPaintBrush(brush: PaintBrush): void {
    this.paintBrush.value = brush;
    if (this.#paint) this.#paint.brush = brush;
  }

  // ── 雕刻地形 ──

  /** 在视口里雕刻实体 entity 的地形（path 是它的 .terrain.json）：左键拖是雕刻，见引擎的 SculptTool。 */
  async startSculpt(entity: string, path: string): Promise<void> {
    const session = this.#session;
    const file = await this.#open<TerrainFile>('terrain', path, (restored) => this.#showSculpt(restored));
    const agent = session.agent.value;
    if (!file || !agent) return;
    const tool = this.#sculpt = agent.sculptTerrain(entity, this.sculptBrush.value);
    tool.onStroke = (strokePath, strokes) => {
      const before = this.#editing.value?.file as TerrainFile | undefined;
      if (strokePath === path && before) this.#commitSculpt({ ...before, strokes: [...(before.strokes ?? []), ...strokes] });
    };
    tool.onFeatures = (featurePath, features) => {
      const before = this.#editing.value?.file as TerrainFile | undefined;
      if (featurePath === path && before) this.#commitSculpt({ ...before, features });
    };
    tool.onSelect = (feature) => {
      const sculpting = this.sculpting.value;
      if (sculpting) this.sculpting.value = { ...sculpting, feature };
    };
    // 视口里按 [、] 改了笔刷大小：工具条跟着变
    tool.onBrush = (brush) => (this.sculptBrush.value = brush);
    this.sculpting.value = { entity, path, file, tool: tool.tool, feature: undefined };
    session.status.value = tool.tool === 'features' ? t.featuresHint : t.sculptHint;
  }

  setSculptBrush(brush: SculptBrush): void {
    this.sculptBrush.value = brush;
    if (this.#sculpt) this.#sculpt.brush = brush;
  }

  /** 左键拖的是笔刷还是地物（地物的轮廓只在拖地物时画）。 */
  setSculptTool(tool: 'brush' | 'features'): void {
    const sculpt = this.#sculpt, sculpting = this.sculpting.value;
    if (!sculpt || !sculpting) return;
    sculpt.tool = tool;
    sculpt.feature = undefined;
    this.sculpting.value = { ...sculpting, tool, feature: undefined };
    this.#session.status.value = tool === 'features' ? t.featuresHint : t.sculptHint;
    this.#session.agent.value?.refresh();
  }

  /** 新建一个压平的地物：光标最近指着的地面上、边长两倍笔刷半径的方块，压到那里的高度，过渡宽度是半径；选中它。 */
  addTerrainFeature(): void {
    const file = this.#editing.value?.file as TerrainFile | undefined, sculpt = this.#sculpt;
    if (!file || !sculpt) return;
    const [x, z, height] = sculpt.cursor ?? [0, 0, 0];
    const r = this.sculptBrush.value.radius;
    const round = (value: number) => Math.round(value * 100) / 100;
    const points = [[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]].map(([px, pz]) => [round(px!), round(pz!)] as const);
    const features = [...(file.features ?? []), { type: 'flatten' as const, points, height: round(height), falloff: round(r) }];
    this.#commitSculpt({ ...file, features }, features.length - 1);
  }

  /** 改选中的地物的高度、过渡宽度、强度。 */
  updateTerrainFeature(patch: { readonly height?: number; readonly falloff?: number; readonly strength?: number }): void {
    const file = this.#editing.value?.file as TerrainFile | undefined, index = this.sculpting.value?.feature;
    if (!file || index === undefined) return;
    this.#commitSculpt({ ...file, features: (file.features ?? []).map((feature, i) => (i === index ? { ...feature, ...patch } : feature)) }, index);
  }

  deleteTerrainFeature(): void {
    const file = this.#editing.value?.file as TerrainFile | undefined, index = this.sculpting.value?.feature;
    if (!file || index === undefined) return;
    this.#commitSculpt({ ...file, features: (file.features ?? []).filter((_, i) => i !== index) }, undefined);
  }

  /** 雕刻的一步：记撤销、存文件；feature 是之后选中的地物（不给就保留现在的）。 */
  #commitSculpt(file: TerrainFile, feature: number | undefined = this.sculpting.value?.feature): void {
    this.#editing.value?.commit(file);
    this.#showSculpt(file, feature);
  }

  /** 工具条显示这份地形文件；选中的地物不在了就取消选中（视口按热重载回来的文件重算）。 */
  #showSculpt(file: TerrainFile, feature: number | undefined = this.sculpting.value?.feature): void {
    const sculpting = this.sculpting.value;
    if (!sculpting) return;
    const selected = feature !== undefined && feature < (file.features?.length ?? 0) ? feature : undefined;
    if (this.#sculpt) this.#sculpt.feature = selected;
    this.sculpting.value = { ...sculpting, file, feature: selected };
  }

  // ── 多边形网格 ──

  /** 在视口里编辑实体 entity 的模型来自的多边形网格 path（选择从面开始）。 */
  async startPolyEdit(entity: string, path: string): Promise<void> {
    const mesh = await this.#open<PolyMeshFile>('poly', path, (restored) => {
      const tool = this.#poly;
      if (!tool) return;
      // 撤销、重做以后下标可能不对了：选中的清空
      tool.file = restored;
      tool.selection = NO_POLY_SELECTION;
      this.#showPoly();
    });
    const agent = this.#session.agent.value;
    if (!mesh || !agent) return;
    const tool = this.#poly = agent.editPoly(entity, path, mesh);
    tool.onChanged = (commit) => {
      if (commit) this.#editing.value?.commit(tool.file);
      this.#showPoly();
    };
    this.#showPoly();
    this.#session.status.value = t.polyHint;
  }

  /** 换选择模式（点、边、面）；选中的清空。 */
  setPolyMode(mode: PolySelectMode): void {
    this.#poly?.setMode(mode);
  }

  /** 对选中的东西做一个编辑操作（挤出、倒角……，引擎的 applyPolyOperation）；做不了时（选的不对）在状态栏说为什么。 */
  polyOperation(operation: PolyOperation): void {
    const tool = this.#poly;
    if (!tool) return;
    let result: PolyEditResult;
    try {
      result = applyPolyOperation(tool.file, operation);
    } catch (error) {
      this.#session.notice.value = (error as Error).message;
      return;
    }
    tool.file = result.mesh;
    // 操作之后选中它给的东西（挤出后是挤出的面……）；当前模式没有的换到有的那种
    const mode: PolySelectMode = result.faces.length > 0 ? 'face' : result.edges.length > 0 ? 'edge' : result.vertices.length > 0 ? 'vertex' : tool.mode;
    tool.mode = mode;
    tool.selection = { vertices: mode === 'vertex' ? result.vertices : [], edges: mode === 'edge' ? result.edges : [], faces: mode === 'face' ? result.faces : [] };
    this.#session.notice.value = '';
    this.#editing.value?.commit(tool.file);
    this.#showPoly();
  }

  #showPoly(): void {
    const tool = this.#poly;
    if (!tool) return;
    // 网格、选择是直接改在工具上的：视口按需出帧时叫醒它
    this.#session.agent.value?.refresh();
    this.polyEditing.value = { entity: tool.entity, path: tool.path, mode: tool.mode, selection: tool.selection, mesh: tool.file };
  }

  // ── 样条 ──

  /** 在视口里编辑实体 entity 的模型来自的样条 path 的控制点。 */
  async startSplineEdit(entity: string, path: string): Promise<void> {
    const spline = await this.#open<SplineFile>('spline', path, (restored) => {
      const tool = this.#spline;
      if (!tool) return;
      tool.file = restored;
      tool.selection = [];
      this.#showSpline();
    });
    const agent = this.#session.agent.value;
    if (!spline || !agent) return;
    const tool = this.#spline = agent.editSpline(entity, path, spline);
    tool.onChanged = (commit) => {
      if (commit) this.#editing.value?.commit(tool.file);
      this.#showSpline();
    };
    this.#showSpline();
    this.#session.status.value = t.splineHint;
  }

  /** 删掉选中的控制点（一步撤销）；剩不到两个点时在状态栏说为什么。 */
  deleteSplinePoints(): void {
    const tool = this.#spline;
    if (!tool || tool.selection.length === 0) return;
    try {
      tool.file = deleteSplinePoints(tool.file, tool.selection);
    } catch (error) {
      this.#session.notice.value = (error as Error).message;
      return;
    }
    tool.selection = [];
    this.#editing.value?.commit(tool.file);
    this.#showSpline();
  }

  /** 从选中的那一个控制点拉出一条分支（路网；三条路交汇处生成路口），选中分支的末端，接着拖它。 */
  branchSpline(): void {
    const tool = this.#spline;
    if (!tool || tool.selection.length !== 1) return;
    const { spline, index } = branchFromPoint(tool.file, tool.selection[0]!);
    tool.file = spline;
    tool.selection = [index];
    this.#editing.value?.commit(tool.file);
    this.#showSpline();
  }

  #showSpline(): void {
    const tool = this.#spline;
    if (!tool) return;
    this.#session.agent.value?.refresh();
    this.splineEditing.value = { entity: tool.entity, path: tool.path, selection: tool.selection, spline: tool.file };
  }

  // ── 白盒 ──

  /** 在视口里编辑实体 entity 的模型来自的白盒 path 的笔刷。 */
  async startBrushEdit(entity: string, path: string): Promise<void> {
    const brush = await this.#open<BrushFile>('brush', path, (restored) => {
      const tool = this.#brush;
      if (!tool) return;
      tool.file = restored;
      // 选中的还在就留着
      if (tool.selection !== undefined && tool.selection >= restored.brushes.length) tool.selection = undefined;
      this.#showBrush();
    });
    const agent = this.#session.agent.value;
    if (!brush || !agent) return;
    const tool = this.#brush = agent.editBrush(entity, path, brush);
    tool.onChanged = (commit) => {
      if (commit) this.#editing.value?.commit(tool.file);
      this.#showBrush();
    };
    this.#showBrush();
    this.#session.status.value = t.brushHint;
  }

  /** 删掉选中的笔刷（一步撤销）；只剩一个时在状态栏说为什么。 */
  deleteSelectedBrush(): void {
    const tool = this.#brush;
    if (!tool || tool.selection === undefined) return;
    try {
      tool.file = deleteBrush(tool.file, tool.selection);
    } catch (error) {
      this.#session.notice.value = (error as Error).message;
      return;
    }
    tool.selection = undefined;
    this.#editing.value?.commit(tool.file);
    this.#showBrush();
  }

  /** 把选中的笔刷换成加、减、交（一步撤销）。 */
  setBrushOperation(operation: BrushShapeFile['operation']): void {
    const tool = this.#brush, index = tool?.selection;
    if (!tool || index === undefined || tool.file.brushes[index]!.operation === operation) return;
    tool.file = { ...tool.file, brushes: tool.file.brushes.map((shape, i) => (i === index ? { ...shape, operation } : shape)) };
    this.#editing.value?.commit(tool.file);
    this.#showBrush();
  }

  /**
   * 正在编辑的白盒导出成多边形网格（后端存成新的 `.poly.json`、烘出同名的模型），实体的模型换成它（一步撤销），接着编辑多边形。
   * 白盒文件留着（别的实体可能还在用）。
   */
  async exportBrushToPoly(): Promise<void> {
    const session = this.#session, editing = this.brushEditing.value;
    if (!editing) return;
    let poly: string;
    try {
      poly = (await session.client.brushToPoly(editing.path)).path;
    } catch (error) {
      session.notice.value = (error as Error).message;
      return;
    }
    this.stop();
    session.apply({ type: 'set', entity: editing.entity, path: ['components', 'model', 'model'], value: poly });
    session.commit();
    await session.synced;
    await this.startPolyEdit(editing.entity, poly);
  }

  #showBrush(): void {
    const tool = this.#brush;
    if (!tool) return;
    this.#session.agent.value?.refresh();
    this.brushEditing.value = { entity: tool.entity, path: tool.path, selection: tool.selection, brush: tool.file };
  }

  /** 视口里的 Delete：多边形删选中的面，样条删选中的控制点，白盒删选中的笔刷；返回有没有工具接了它。 */
  deleteSelected(): boolean {
    const poly = this.polyEditing.value;
    if (poly) {
      if (poly.selection.faces.length > 0) this.polyOperation({ op: 'delete', faces: poly.selection.faces });
      return true;
    }
    if (this.splineEditing.value) {
      this.deleteSplinePoints();
      return true;
    }
    if (this.brushEditing.value) {
      this.deleteSelectedBrush();
      return true;
    }
    return false;
  }
}
