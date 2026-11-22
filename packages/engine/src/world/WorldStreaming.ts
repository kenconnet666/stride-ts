/**
 * 世界的流式加载（Stride 没有，新加的；照虚幻 5 的 World Partition）：`game.world.load('Worlds/Island')` 读 `.world.json`，常驻场景
 * 当根场景，之后每帧看流式源（主画面的相机、带 StreamingSource 的实体）在哪，按各图层的加载半径加载附近有内容的格子、卸载远了的。
 *
 * - 格子是普通的场景（content/formats/worldFormat.ts），加载时 offset 是格子的原点，挂在常驻场景下面；
 * - 同时最多 MAX_LOADING 个格子在读，近的先读；读好时已经不要了（走远了、换了世界）就马上卸载；
 * - 卸载有滞后：离开加载半径的 1.25 倍才卸载，在边上来回走不会反复加载；
 * - 编辑状态（`game.editing`）不自己流式加载：编辑器按编辑相机加载格子（以后的世界视图）。
 *
 * `stride call world` 看加载了哪些格子、在读哪些、流式源在哪。
 */
import { Matrix } from '../data/Matrix';
import { component } from '../engine/component';
import { prop } from '../data/prop';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';
import type { Game } from '../engine/Game';
import type { SceneInstance } from '../content/ContentManager';
import { cellOrigin, distanceToCell, worldCellPath, type WorldFile } from '../content/formats/worldFormat';

/** 流式源：世界的格子按它（和主画面的相机）附近加载。玩家、载具、要提前加载的远处的过场相机上放一个。 */
export const StreamingSource = component('StreamingSource', {
  /** 加载半径乘它（比如飞得快的载具给 1.5，提前加载前方）。 */
  radiusScale: prop.f32().default(1).min(0),
});

/** 同时在读的格子最多几个：读和建实体都在主线程上，一次读太多一帧会卡。 */
const MAX_LOADING = 2;
/** 离开加载半径的这么多倍才卸载。 */
const UNLOAD_SLACK = 1.25;

interface CellState {
  readonly layer: string;
  readonly x: number;
  readonly z: number;
  readonly path: string;
  /** 加载好了是场景；还在读是 undefined。 */
  scene: SceneInstance | undefined;
}

/** 一个流式源：XZ 上的位置和加载半径的倍数。 */
interface Source {
  readonly x: number;
  readonly z: number;
  readonly scale: number;
}

/** 世界的流式加载（`game.world`）。 */
export class WorldStreaming {
  readonly #game: Game;
  /** 正在用的世界；没加载世界时是 undefined。 */
  file: WorldFile | undefined;
  path: string | undefined;
  /** 常驻场景（格子挂在它下面）。 */
  root: SceneInstance | undefined;
  /** 格子的键（`图层/x_z`）→ 状态。 */
  readonly #cells = new Map<string, CellState>();
  /** 每个图层有内容的格子（键 `x_z`），按世界文件的索引。 */
  #index = new Map<string, Set<string>>();
  /** 换世界时加一：读好的格子发现世界换了就扔掉。 */
  #generation = 0;
  /** 上一帧的流式源（调试命令看）。 */
  sources: readonly Source[] = [];
  /** 一共加载、卸载了几次格子（统计）。 */
  loads = 0;
  unloads = 0;

  readonly #collectSources = system('WorldStreaming.sources', {
    with: { source: StreamingSource, transform: Transform },
    update: ({ source, transform, count }) => {
      for (let row = 0; row < count; row++) {
        const at = transform.slot[row]! * 16;
        this.#found.push({ x: transform.world[at + 12]!, z: transform.world[at + 14]!, scale: source.radiusScale[row]! });
      }
    },
  });
  #found: Source[] = [];
  readonly #inverse = new Float32Array(16);

  constructor(game: Game) {
    this.#game = game;
  }

  /**
   * 换成这个世界：读世界文件，常驻场景（没有时是一个空场景）当根场景，原来的世界和根场景卸掉。格子在之后的帧里按流式源加载。
   */
  async load(path: string): Promise<WorldFile> {
    const game = this.#game;
    const file = await game.content.loadWorld(path);
    this.unload();
    const root = await game.setRootScene(file.persistent ?? { name: file.name, entities: [] });
    this.#use(path, file, root, false);
    return file;
  }

  /**
   * 编辑器用：把这个世界的格子挂在 root（正在编辑的场景）下面一起看，不换根场景；编辑状态下也按流式源（编辑相机）加载，格子的
   * 实体不在编辑的文档里（点选点不到、改不了，见 EditAgent.showWorld）。路径相同时只换 root。
   */
  async attach(path: string, root: SceneInstance): Promise<WorldFile> {
    const file = await this.#game.content.loadWorld(path);
    this.unload();
    this.#use(path, file, root, true);
    return file;
  }

  /** 挂在编辑的场景下面（attach），不是游戏里加载的（load）。 */
  get attached(): boolean {
    return this.#attached;
  }

  #attached = false;

  #use(path: string, file: WorldFile, root: SceneInstance, attached: boolean): void {
    this.file = file;
    this.path = path;
    this.root = root;
    this.#attached = attached;
    this.#index = new Map(file.layers.map((layer) => [layer.name, new Set((file.cells[layer.name] ?? []).map(([x, z]) => `${x}_${z}`))]));
  }

  /** 卸掉世界的格子（根场景留着，换根场景时自然卸掉）。 */
  unload(): void {
    const game = this.#game;
    this.#generation++;
    for (const cell of this.#cells.values()) if (cell.scene) game.unloadScene(cell.scene);
    this.#cells.clear();
    this.file = undefined;
    this.path = undefined;
    this.root = undefined;
    this.#attached = false;
  }

  /** 已经加载好的格子（`图层/x_z`）和在读的。 */
  get loaded(): string[] {
    return [...this.#cells].filter(([, cell]) => cell.scene).map(([key]) => key);
  }

  get loading(): string[] {
    return [...this.#cells].filter(([, cell]) => !cell.scene).map(([key]) => key);
  }

  /** @internal Game 每帧在变换更新之后调用：按流式源加载、卸载格子。 */
  update(): void {
    const game = this.#game;
    const file = this.file;
    // 编辑状态只流式加载编辑器挂上的世界（attach），游戏里 load 的不动
    if (!file || (game.editing && !this.#attached)) return;
    // 根场景换了（游戏自己 setRootScene），世界跟着结束；挂在编辑的场景下面的由编辑器在换文档时卸掉（EditAgent.hideWorld）
    if (!this.#attached && game.rootScene !== this.root) {
      this.unload();
      return;
    }
    this.sources = this.#sources(game);
    if (this.sources.length === 0) return;
    // 要的格子：每个图层、每个源的加载半径里有内容的格子，按到最近的源的距离排
    const wanted: { key: string; layer: string; x: number; z: number; distance: number }[] = [];
    for (const layer of file.layers) {
      const index = this.#index.get(layer.name)!;
      if (index.size === 0) continue;
      const seen = new Set<string>();
      for (const source of this.sources) {
        const radius = layer.loadRadius * source.scale;
        const x0 = Math.floor((source.x - radius) / file.cellSize), x1 = Math.floor((source.x + radius) / file.cellSize);
        const z0 = Math.floor((source.z - radius) / file.cellSize), z1 = Math.floor((source.z + radius) / file.cellSize);
        for (let x = x0; x <= x1; x++) {
          for (let z = z0; z <= z1; z++) {
            const cell = `${x}_${z}`;
            if (seen.has(cell) || !index.has(cell)) continue;
            const distance = distanceToCell(file, source.x, source.z, x, z);
            if (distance > radius) continue;
            seen.add(cell);
            wanted.push({ key: `${layer.name}/${cell}`, layer: layer.name, x, z, distance });
          }
        }
      }
    }
    // 卸载：离所有源都超过加载半径的 1.25 倍（还在读的读好时再看）
    for (const [key, cell] of this.#cells) {
      if (!cell.scene) continue;
      const radius = file.layers.find((layer) => layer.name === cell.layer)!.loadRadius;
      const near = this.sources.some((source) => distanceToCell(file, source.x, source.z, cell.x, cell.z) <= radius * source.scale * UNLOAD_SLACK);
      if (near) continue;
      game.unloadScene(cell.scene);
      this.#cells.delete(key);
      this.unloads++;
    }
    // 加载：近的先读，同时最多 MAX_LOADING 个
    wanted.sort((a, b) => a.distance - b.distance);
    let loading = this.loading.length;
    for (const cell of wanted) {
      if (loading >= MAX_LOADING) break;
      if (this.#cells.has(cell.key)) continue;
      loading++;
      this.#loadCell(game, cell.key, cell.layer, cell.x, cell.z);
    }
  }

  #loadCell(game: Game, key: string, layer: string, x: number, z: number): void {
    const file = this.file!, root = this.root!;
    const state: CellState = { layer, x, z, path: worldCellPath(this.path!, layer, x, z), scene: undefined };
    this.#cells.set(key, state);
    const generation = this.#generation;
    game.loadScene(state.path, { parent: root, offset: cellOrigin(file, x, z), applySettings: false }).then((scene) => {
      // 读的时候世界换了，或者这个格子已经不要了（被别的状态替掉）
      if (generation !== this.#generation || this.#cells.get(key) !== state) {
        game.unloadScene(scene);
        return;
      }
      state.scene = scene;
      this.loads++;
      game.requestFrames();
    }, (error: unknown) => {
      if (this.#cells.get(key) === state) this.#cells.delete(key);
      console.error(`[stride] world ${this.path}: cell ${key} failed to load`, error);
    });
  }

  /** 流式源：主画面的相机，加上带 StreamingSource 的实体。 */
  #sources(game: Game): Source[] {
    this.#found = [];
    game.entities.run(this.#collectSources, game.updateTime);
    const view = (game.graphicsCompositor as Game['graphicsCompositor'] | undefined)?.mainView;
    // 视图在渲染空间里（D18）：相机的位置加上渲染原点才是世界坐标
    const origin = game.renderOrigin;
    if (view && Matrix.invert(this.#inverse, view.view)) this.#found.push({ x: this.#inverse[12]! + origin[0], z: this.#inverse[14]! + origin[2], scale: 1 });
    return this.#found;
  }
}
