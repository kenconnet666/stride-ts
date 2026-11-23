import { Matrix } from '../data/Matrix';
import { createStrideNative, type NativeFeature, type StrideNative, type TransformStore } from '@stride-ts/native';
import { AnimationSystem } from '../animation/AnimationSystem';
import { modelNodeLinkSystem } from '../animation/ModelNodeLink';
import { uiElementLinkSystem } from '../ui/UIElementLink';
import { WorldClock } from '../world/WorldClock';
import { PersistenceSystem } from '../world/Persistence';
import { GameEventBus } from './GameEvents';
import { dayNightCycleSystem } from '../rendering/sky/DayNightCycle';
import { hook } from './events';
import { failLoading, finishLoading, reportLoading } from './loadingScreen';
import { ContentManager, type CompositorSettings, type GameSettings, type LoadSceneOptions, type SceneInstance, type SceneReference } from '../content/ContentManager';
import type { SceneFile } from '../content/formats/format';
import { Metrics } from '../debug/Metrics';
import type { EditAgent } from '../editor/viewport/EditAgent';
import { registerGameCommands } from '../debug/commands';
import { Debug } from '../debug/Debug';
import { DebugText } from '../debug/DebugText';
import { DebugDraw } from '../debug/DebugDraw';
import { DebugDrawRenderer } from '../debug/DebugDrawRenderer';
import { DebugTextRenderer } from '../debug/DebugTextRenderer';
import type { ScopedDefaults } from './defaults';
import type { Entity, EntityScene } from './Entity';
import { entityAtSlot, Transform } from './transform';
import { ModelPart } from '../rendering/components';
import { EntityManager } from './EntityManager';
import { Registry } from './registry';
import { GraphicsDevice } from '../graphics/GraphicsDevice';
import { InputManager } from '../input/InputManager';
import { Simulation } from '../physics/Simulation';
import { NavigationSystem } from '../physics/NavigationSystem';
import { AudioEmitterComponent, AudioListenerComponent } from '../audio/AudioEmitterComponent';
import { Train, TrainDoor } from '../world/Train';
import { TimelinePlayer } from '../animation/TimelinePlayer';
import { Vehicle } from '../physics/Vehicle';
import { Ragdoll } from '../physics/Ragdoll';
import { Rope } from '../physics/Rope';
import { Breakable } from '../physics/Breakable';
import { Cloth } from '../physics/Cloth';
import { CrowdAgent } from '../physics/CrowdAgent';
import { Animator } from '../animation/Animator';
import { StateTreeRunner } from '../ai/StateTreeRunner';
import { PerceptionSystem } from '../ai/Perception';
import { SmartObject, SmartObjectSystem } from '../ai/SmartObjects';
import { FootIk } from '../animation/FootIk';
import { LookAt } from '../animation/LookAt';
import { SoftBody } from '../physics/SoftBody';
import { Deformable } from '../physics/Deformable';
import { cameraRigSystem } from '../rendering/CameraRig';
import { RecastNavigationComponent } from '../physics/RecastNavigationComponent';
import { AtmosphereRenderFeature } from '../rendering/sky/AtmosphereRenderFeature';
import { BackgroundRenderFeature } from '../rendering/sky/BackgroundRenderFeature';
import { ForwardRenderer } from '../rendering/ForwardRenderer';
import { MeshRenderFeature } from '../rendering/mesh/MeshRenderFeature';
import type { MeshEffect } from '../rendering/mesh/meshEffect';
import { SpriteRenderFeature } from '../rendering/SpriteRenderFeature';
import { RenderSystem, type SceneRenderer } from '../rendering/RenderSystem';
import { browserImageDecoder, ktx2Decoder } from '../graphics/Texture';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleSystemComponent, ParticleSystems } from '../particles/ParticleSystemComponent';
import { gust, WindField } from '../world/WindField';
import { VEGETATION_LOCAL_WINDS } from '../rendering/mesh/wgsl/view';
import { PrecipitationSystem } from '../world/Precipitation';
import { WeatherSystem } from '../world/Weather';
import { WorldStreaming } from '../world/WorldStreaming';
import { TerrainSystem } from '../world/TerrainSystem';
import { ScatterSystem } from '../world/Scatter';
import { CitySystem } from '../world/City';
import { BuoyancySystem } from '../world/Buoyancy';
import { UIComponent } from '../ui/UIComponent';
import { UISystem } from '../ui/UISystem';
import { GameTime } from './GameTime';
import { UserPreferences } from './UserPreferences';

export type GameStatus = 'starting' | 'running' | 'failed' | 'exited';

export interface GameOptions {
  /**
   * 原生模块任务系统的工作线程数；默认 hardwareConcurrency - 1、最多 8（多了只多占 CPU，见 docs/decisions.md）。调试时页面地址的 `?stride-workers=N` 也能给（同一个标签页里
   * 一直有效），回归用它固定线程数：每个线程的栈算在原生内存里，线程数随机器变的话 `native.allocated.bytes` 的预算就没法比。
   */
  workerThreads?: number;
  /**
   * 用调试版的原生运行时：Jolt 断言（失败时 console.error 带 C++ 调用栈）和 Emscripten 的运行时检查，比正式版慢。
   * 游戏入口一般传 `import.meta.env.DEV`：开发服务器上用调试版，构建出来的页面用正式版。
   */
  debugNative?: boolean;
  /**
   * 要加载的原生侧模块，从 `@stride-ts/native/<名字>` 导入：physics（Jolt）、texture（KTX2 贴图转码，内容里有 KTX2
   * 贴图时要有它）、navigation（Recast/Detour），也可以是第三方插件。没列出的不会下载，构建时也不会输出。
   */
  nativeFeatures?: readonly NativeFeature[];
  /** 变换存储一开始的槽位数（带 Transform 的实体数）；不够时自动翻倍增长，没有上限（到 2^31 - 2）。默认 16384。 */
  initialTransforms?: number;
  /**
   * 物理仿真最多的物体数（nativeFeatures 里有 physics 时），默认 16384。Jolt 在建世界时就按它定数组、不能再长，超了加不进去；
   * 物体多的大世界传大一些（每个物体约 0.2 KB，65536 个比默认多占 12 MB）。
   */
  maxBodies?: number;
  /**
   * 游戏的模块，即 `import.meta.glob('./**\/*.ts', { eager: true })` 的结果：loadContent 之前，按路径和导出名
   * 给其中的组件、脚本、系统起名（见 engine/registry.ts）。
   */
  modules?: Readonly<Record<string, unknown>>;
  /**
   * 连开发服务器上的调试中枢，让 `stride` 命令（@stride-ts/cli）能查看和操作这个游戏，见 debug/Debug.ts。
   * undefined（默认）时看页面地址带不带 ?debug；游戏入口一般传 `import.meta.env.DEV || undefined`：开发服务器上总是打开。
   */
  debug?: boolean | undefined;
  /** 把帧号和帧率写进这个页面元素（样例页面角上的那行字），每秒 4 次。 */
  stats?: HTMLElement;
  /**
   * 开在编辑状态（见 Game.editing）。undefined（默认）时：打开了 debug、页面地址又带 ?stride-edit 就是编辑状态——编辑器
   * 这样打开游戏页面，应用的入口不用改。
   */
  editing?: boolean | undefined;
}

// 更长的间隔（标签页在后台、断点停住）不在一步里模拟完。
const MAX_ELAPSED = 0.25;
/** GameOptions.stats 隔多少秒（游戏时间）更新一次。 */
const STATS_INTERVAL = 0.25;
const DEFAULT_INITIAL_TRANSFORMS = 16384;
const DEFAULT_MAX_BODIES = 16384;
/** 帧时间的统计量取最近这么多帧的平均。 */
const METRIC_FRAMES = 60;
/** 暂停时单步、没设 fixedTimeStep 时每步的秒数。 */
const STEP_SECONDS = 1 / 60;
/** 渲染原点按这么多米对齐（D18）：相机离原点最多几百米，单精度在那里的刻度不到 0.1 毫米；走出一格才换（换时所有实例的矩阵重传一次）。 */
export const RENDER_ORIGIN_CELL = 1024;
/** 按需出帧时叫醒一次出多少帧：异步加载完的贴图、管线，时间累积的效果（TAA、体积云）要几十帧才稳下来。 */
const SETTLE_FRAMES = 120;

/** Vite 的 `import.meta.hot` 里引擎用到的部分。 */
export interface HotContext {
  readonly data: Record<string, unknown>;
}

declare global {
  /** 正在运行的游戏，控制台和调试命令的 eval 读它。 */
  var strideGame: Game | undefined;
}

/** Game.loadScene 的选项（同 LoadSceneOptions；parent 给了就是子场景）。 */
export type LoadChildSceneOptions = LoadSceneOptions;

/** Game.loadGameSettings 的选项：合成器的游戏渲染器怎么建（按 Stride 的类型名），默认场景的加载选项。 */
export interface LoadGameSettingsOptions extends LoadSceneOptions {
  readonly renderers?: Readonly<Record<string, (props: Readonly<Record<string, unknown>>, game: Game) => SceneRenderer | Promise<SceneRenderer>>>;
}

/**
 * 调试时页面地址里的开关（`?stride-workers=4`、`?stride-pointer-lock=virtual`），回归和测量用。地址里的值记进 sessionStorage，
 * 同一个标签页后来的重载和跳转（冒烟脚本会换 `?scene=…`）沿用它。不在调试时一律没有。
 */
function debugSwitch(debugQuery: URLSearchParams | null, name: string): string | null {
  if (!debugQuery) return null;
  const fromQuery = debugQuery.get(name);
  if (fromQuery != null) sessionStorage.setItem(name, fromQuery);
  return fromQuery ?? sessionStorage.getItem(name);
}

/** 原生模块的工作线程数：选项优先，其次是调试开关 `stride-workers`；都没有就不传，用原生模块的默认值。 */
function workerThreadsOption(options: GameOptions, debugQuery: URLSearchParams | null): { workerThreads?: number } {
  if (options.workerThreads !== undefined) return { workerThreads: options.workerThreads };
  const text = debugSwitch(debugQuery, 'stride-workers');
  if (text == null) return {};
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1) throw new Error(`?stride-workers must be a positive integer, got '${text}'`);
  return { workerThreads: count };
}

/**
 * 拥有原生模块、图形设备、实体和帧循环（对应 Stride 的 Game）。
 * 继承它并重写 loadContent 和 update（要调用 super.update，脚本和系统在里面跑）；draw 默认交给图形合成器，
 * 重写时可以不调用 super.draw，自己画。run() 初始化之后才有 `native`、`graphicsDevice` 和渲染系统。其中任何一处抛异常，或 AsyncScript 被拒绝，游戏都会停下，状态为 'failed'。
 */
/**
 * 每帧跑一次的子系统（不属于某个实体的那种：世界的流式加载、地形、天气、风、雨雪、粒子……）。内置的和游戏用
 * `game.addSystem` 加的在同一张表里，同一阶段按加的顺序跑；游戏时间不前进的帧（暂停、编辑状态）不跑 update。
 */
export interface GameSystem {
  /** 在世界矩阵更新之前还是之后跑：会挂上、挪动实体的放 beforeTransforms，读世界矩阵的放 afterTransforms（默认）。 */
  readonly phase?: 'beforeTransforms' | 'afterTransforms';
  update?(game: Game): void;
  /** 渲染原点挪了（大世界，见 Game.renderOrigin）：存着渲染空间坐标的东西跟着挪。 */
  moveOrigin?(dx: number, dy: number, dz: number): void;
  /** 游戏退出时（倒着加的顺序调）。 */
  destroy?(): void;
}

export class Game {
  native!: StrideNative;
  /** 所有 Transform 组件的数据，在原生内存里；世界矩阵在每帧 update 之后、draw 之前算。 */
  transforms!: TransformStore;
  graphicsDevice!: GraphicsDevice;
  /** 键盘、鼠标、手柄（Stride 的 InputManager），每帧开头刷新。 */
  input!: InputManager;
  /** 物理仿真（Stride 的 BepuSimulation）；nativeFeatures 里没有 physics 时是 undefined。 */
  simulation: Simulation | undefined;
  /** 导航（Stride 的 RecastMeshSystem）；nativeFeatures 里没有 physics 和 navigation 时是 undefined。 */
  navigation: NavigationSystem | undefined;
  /** 骨骼动画（Stride 的 AnimationProcessor 加蒙皮）：每帧在物理之后求姿势和蒙皮矩阵。 */
  animation!: AnimationSystem;
  /** 渲染特性（默认有 MeshRenderFeature）、视图和光照（Stride 的 RenderSystem）。 */
  renderSystem!: RenderSystem;
  /** 网格的渲染特性（Stride 的 MeshRenderFeature）；场景的合成器指定的网格效果交给它。 */
  meshes!: MeshRenderFeature;
  /** 场景的前向渲染器（Stride 的 GraphicsCompositor 里的 ForwardRenderer），场景的合成器设置交给它。 */
  graphicsCompositor!: ForwardRenderer;
  /** 每帧画整个画面的根渲染器（Stride 的 GraphicsCompositor.Game）；默认是 graphicsCompositor，游戏可以换成自己的。 */
  rootRenderer!: SceneRenderer;
  readonly updateTime = new GameTime();
  readonly registry = new Registry();
  /** 资源管线产出的模型、材质、场景（默认从页面旁边的 content/ 加载，可以换成别的根目录）；材质颜色树里的着色器类按 registry 找。 */
  content = new ContentManager({ shaderClass: (name) => this.registry.shaderClass(name) });
  readonly entities: EntityManager = new EntityManager(this);
  /** 脚本每帧打印的调试文字（Stride 的 DebugTextSystem）。 */
  readonly debugText = new DebugText(() => [this.graphicsDevice.canvas.clientWidth, this.graphicsDevice.canvas.clientHeight]);
  /** 音频（Stride 的 AudioEngine）：Web Audio，用户第一次操作页面后出声。 */
  readonly audio = new AudioEngine();
  /** 风场（Stride 没有）：WindZone 组件的风，`game.wind.sample(x, y, z)` 取某一点的风；粒子的 UpdaterWind 用它。 */
  readonly wind = new WindField();
  /** 雨雪（Stride 没有）：Precipitation 组件让主相机周围下雨下雪（GPU 粒子），强度由外面给（天气状态）。 */
  readonly precipitation = new PrecipitationSystem();
  /** 天气状态（Stride 没有）：Weather 组件想要的天气慢慢过渡，驱动云、雾、风和雨雪；`game.weather.current` 是当前的天气。 */
  readonly weather = new WeatherSystem();
  /** 全局的命名事件：按名字收发（脚本、时间轴、调试命令），见 engine/GameEvents.ts。 */
  readonly events = new GameEventBus(() => this.updateTime.frameCount);
  /** 世界时钟和日历：世界里现在几点、第几天（日夜循环、日程、存档读写它），见 world/WorldClock.ts。编辑状态下不走。 */
  readonly clock = new WorldClock();
  /** 感知：挂 Perceiver 的实体看得见、听得到什么（视觉带遮挡、声音、记忆），见 ai/Perception.ts。 */
  readonly perception = new PerceptionSystem();
  /** 智能物体：长椅、柜台这类东西的槽，占、放开，见 ai/SmartObjects.ts。 */
  readonly smartObjects = new SmartObjectSystem();
  /** 存档和世界状态的持久化：挂 Persistent 的场景实体卸掉再读回来状态还在，save() / load() 存档读档，见 world/Persistence.ts。 */
  readonly persistence = new PersistenceSystem(this.entities, this.clock);
  /**
   * 渲染原点（D18 大世界）：位置都是双精度，GPU 上是单精度——渲染用的世界矩阵（`Transform.renderWorld`）、相机的视图矩阵、灯光、
   * 调试线都减去它。它跟着主画面的相机、按 RENDER_ORIGIN_CELL 米对齐，相机走出一格才换（换的那一帧所有实例的矩阵重传一次）。
   * 把渲染空间的点换回世界：加上它。
   */
  readonly renderOrigin: [number, number, number] = [0, 0, 0];
  /** 世界的流式加载（Stride 没有）：`game.world.load('Worlds/Island')` 换成一个 `.world.json` 的世界，格子按相机和 StreamingSource 加载。 */
  readonly world = new WorldStreaming(this);
  /** 矢量地形（Stride 没有）：Terrain 实体按相机分块、分细节层次求值成网格（world/TerrainSystem.ts）。 */
  readonly terrain = new TerrainSystem(this);
  /** 程序化摆放（Stride 没有）：Scatter 组件按规则在地形上撒模型，相机附近的格子现撒（world/Scatter.ts）。 */
  readonly scatter = new ScatterSystem(this);
  /** 浮力（Stride 没有）：Buoyancy 组件的刚体在水里浮起来、顺着河流走（world/Buoyancy.ts）。 */
  readonly buoyancy = new BuoyancySystem(this);
  /** 城市（Stride 没有）：City 组件按 .city.json 的规则沿路摆楼（world/City.ts）。 */
  readonly city = new CitySystem(this);
  /** 粒子系统（Stride 的 ParticleSystemSimulationProcessor）：每帧变换更新之后模拟。 */
  readonly particles = new ParticleSystems();
  /** UI（Stride 的 UISystem）：UIComponent 的页面画在场景之后。 */
  readonly ui = new UISystem();
  /** 每帧跑的子系统（见 GameSystem）：内置的按这里的顺序，游戏用 addSystem 往后加。 */
  readonly #systems: GameSystem[] = this.#builtinSystems();
  /** 用户在系统里设的偏好：少动画、高对比、深浅色。 */
  readonly userPreferences = new UserPreferences();
  private readonly debugTextRenderer = new DebugTextRenderer();
  /** 调试用的线（线框、包围盒、网格、Gizmo）：脚本每帧调用，画在场景之后、UI 之前。 */
  readonly debugDraw = new DebugDraw(this.renderOrigin);
  private readonly debugDrawRenderer = new DebugDrawRenderer();
  /** 调试命令、计数器、事件和日志转发（debug/Debug.ts）。 */
  readonly debug = new Debug(() => (this.status === 'starting' ? undefined : this.frames));
  /** 各系统的统计和预算（实体数、绘制次数、显存、内存、帧时间……），见 debug/Metrics。 */
  readonly metrics = new Metrics();
  /** 暂停时不跑 update（脚本、系统、物理、游戏时间都停住），画面照常画；step() 单步。 */
  paused = false;
  /** 游戏时间相对真实时间的倍率。 */
  timeScale = 1;
  /** 设了以后每帧固定前进这么多秒，不看真实时间（调试时复现同样的过程）。 */
  fixedTimeStep: number | undefined;

  status: GameStatus = 'starting';
  error: string | undefined;
  /** 启动各阶段完成的时刻（页面开始加载后的毫秒数）：原生模块就绪、loadContent 完成、第一帧画完。 */
  /**
   * 启动各阶段的时刻（performance.now，相对页面开始）：native 原生模块好了、content 内容（loadContent）好了、firstFrame 第一帧画完；
   * warmStart、warmEnd 是预热管线的第一次开始、最后一次完成（后台编译，和别的资源并行，内容要等它），warmedPipelines 是启动时后台
   * 编的管线数（到第一帧）——内容阶段里编译占多少看这三项。
   */
  readonly startup: { native?: number; content?: number; firstFrame?: number; warmStart?: number; warmEnd?: number; warmedPipelines?: number } = {};
  /** 内容加载完成（或换了根场景）时的帧号。 */
  sceneFrame: number | undefined;
  /**
   * 编辑状态（编辑器把游戏页面开成这样，见 editor/viewport/EditAgent）：游戏照常启动、加载它的场景，但场景文件里的脚本不挂、
   * 仿真不走，画面由编辑相机看。run 的时候定，之后不变。
   */
  editing = false;
  /** 编辑状态下编辑器在这个页面里的代理；不在编辑状态时是 undefined。 */
  editor: EditAgent | undefined;
  /** 根场景（Stride 的 SceneSystem.SceneInstance.RootScene），setRootScene 设；loadScene 加的场景不算。 */
  rootScene: SceneInstance | undefined;
  /** loadGameSettings 读到的游戏设置（Stride 的 Game.Settings）；没读过时是 undefined。 */
  settings: GameSettings | undefined;
  /** loadGameSettings 读的游戏设置的内容路径（编辑器改了它时 reloadGameSettings 按它重建根渲染器）。 */
  settingsPath: string | undefined;
  /** loadGameSettings 给的渲染器工厂：重建根渲染器时还用它们。 */
  #renderers: NonNullable<LoadGameSettingsOptions['renderers']> = {};
  /** 加载（loadScene）或卸载（unloadScene）了一个场景之后触发（Stride 里场景的 Children 变了，TopDownRPG 的 EnableDynamicNavigation 听它重建导航网格）。 */
  readonly scenesChanged = hook<{ readonly scene: SceneInstance; readonly loaded: boolean }>('scenesChanged');
  /** 场景的子场景（loadScene 的 parent），unloadScene 时跟着卸载。 */
  readonly #childScenes = new Map<EntityScene, SceneInstance[]>();
  /** 正在换的根场景：连着换几次时按顺序来。 */
  private rootSceneChange: Promise<unknown> = Promise.resolve();

  private lastFrameTime: number | undefined;
  private pendingSteps = 0;
  /** 正在跑一帧（exit 推迟到帧末）。 */
  private inFrame = false;
  /**
   * 按需出帧（编辑器的视口，见 EditAgent）：开着时没人叫醒（requestFrames、holdFrames：输入、画布变大小、编辑器的修改、调试命令）
   * 就不更新、不画，视口静止时不占显卡；叫醒以后出 SETTLE_FRAMES 帧再停。粒子、天气这类自己会动的东西停着不动——要一直动时关掉它。
   */
  renderOnDemand = false;
  #wakeFrames = 0;
  #holds = 0;
  /** 离线渲染接管着帧循环（takeOverFrames）。 */
  private framesTakenOver = false;
  private exitRequested = false;
  /** GameOptions.stats 和上次写它的游戏时间。 */
  private statsOutput: { readonly element: HTMLElement; time: number } | undefined;

  /** 标了 inherit() 的属性的作用域默认值：之后创建的组件和脚本都取这里的值，见 engine/defaults.ts。 */
  get defaults(): ScopedDefaults {
    return this.entities.defaults;
  }

  get frames(): number {
    return this.updateTime.frameCount;
  }

  async run(canvas: HTMLCanvasElement, options: GameOptions = {}): Promise<void> {
    globalThis.strideGame = this;
    this.entities.onError = (error) => this.fail(error);
    if (options.stats) this.statsOutput = { element: options.stats, time: 0 };
    const query = new URLSearchParams(location.search);
    const debugging = options.debug ?? query.has('debug');
    if (debugging) {
      registerGameCommands(this.debug, this);
      this.debug.connect();
      // 冒烟脚本按资源计时看下载了哪些文件（字体的块、贴图）：开发服务器上每个模块一个请求，浏览器默认只留 250 条，后来的丢掉
      performance.setResourceTimingBufferSize(10_000);
    }
    this.editing = options.editing ?? (debugging && query.has('stride-edit'));
    try {
      if (options.modules) this.registry.registerModules(options.modules);
      reportLoading('native');
      this.native = await createStrideNative({
        debug: options.debugNative ?? false,
        features: options.nativeFeatures ?? [],
        ...workerThreadsOption(options, debugging ? query : null),
      });
      this.startup.native = performance.now();
      reportLoading('content');
      this.transforms = this.native.createTransforms(options.initialTransforms ?? DEFAULT_INITIAL_TRANSFORMS);
      if (this.native.hasFeature('physics')) {
        this.simulation = new Simulation(this.native, this.transforms, this.entities, options.maxBodies ?? DEFAULT_MAX_BODIES);
        this.buoyancy.attach(this.simulation);
      }
      if (this.simulation && this.editing) this.simulation.enabled = false;
      if (this.simulation && this.native.hasFeature('navigation')) this.navigation = new NavigationSystem(this.native, this.simulation, this.entities);
      this.registry.register(RecastNavigationComponent);
      this.registry.register(UIComponent);
      this.registry.register(ParticleSystemComponent);
      this.registry.register(AudioEmitterComponent);
      this.registry.register(AudioListenerComponent);
      this.registry.register(TimelinePlayer);
      this.registry.register(Vehicle);
      this.registry.register(Ragdoll);
      this.registry.register(Rope);
      this.registry.register(Breakable);
      this.registry.register(Cloth);
      this.registry.register(CrowdAgent);
      this.registry.register(Animator);
      this.registry.register(StateTreeRunner);
      this.registry.register(SmartObject);
      this.registry.register(FootIk);
      this.registry.register(LookAt);
      this.registry.register(SoftBody);
      this.registry.register(Deformable);
      this.registry.register(Train);
      this.registry.register(TrainDoor);
      this.animation = new AnimationSystem(this.native, this.entities);
      this.entities.addSystems(this.animation.system, this.animation.morphSystem, this.animation.propertySystem, modelNodeLinkSystem(this.entities, this.transforms, this.animation), uiElementLinkSystem(this.entities, this.transforms, this.ui), dayNightCycleSystem(this.entities, () => (this.editing ? undefined : this.clock)), cameraRigSystem(this.entities, () => this.editing));
      this.content.animationNative ??= this.native;
      // ?stride-limits=default：只要 WebGPU 的默认上限（同 CI 的软件 WebGPU，比如片元阶段最多 16 张采样贴图），本机的回归
      // 也能查出超了上限的绑定
      this.graphicsDevice = await GraphicsDevice.create(canvas, { defaultLimits: new URLSearchParams(location.search).get('stride-limits') === 'default' });
      void this.graphicsDevice.lost.then((error) => this.fail(error));
      // 加载内容、脚本启动时读到的就是画面的实际大小（Stride 的后备缓冲在游戏开始前就建好了）
      this.graphicsDevice.resizeToDisplaySize();
      this.input = new InputManager(canvas);
      this.input.onActivity = () => this.requestFrames();
      new ResizeObserver(() => this.requestFrames()).observe(canvas);
      this.debug.onCall = () => this.holdFrames();
      if (debugSwitch(debugging ? query : null, 'stride-pointer-lock') === 'virtual') this.input.simulatePointerLock();
      this.ui.attach(this);
      if (this.native.hasFeature('texture')) this.content.textureDecoder ??= ktx2Decoder(this.native, this.graphicsDevice);
      this.content.meshoptDecoder ??= (requests) => this.native.decodeMeshoptBatch(requests);
      this.content.imageDecoder ??= browserImageDecoder();
      this.content.audio ??= this.audio;
      this.audio.attach(window);
      this.renderSystem = new RenderSystem(this.graphicsDevice);
      this.renderSystem.renderOrigin = this.renderSystem.clouds.renderOrigin = this.renderOrigin;
      this.meshes = this.renderSystem.addFeature(new MeshRenderFeature());
      // 背景画在网格之后，只落在没画到的地方
      this.renderSystem.addFeature(new BackgroundRenderFeature());
      this.renderSystem.addFeature(new AtmosphereRenderFeature());
      this.renderSystem.addFeature(new SpriteRenderFeature());
      this.graphicsCompositor = new ForwardRenderer(this.renderSystem);
      // 预热：加载场景、预制体时，它们的模型要用的管线在后台编好（和别的资源一起等），建实体以后不用当场编译着色器
      this.content.pipelineWarmer = (uses, postEffects, files) => {
        this.startup.warmStart ??= performance.now();
        const stages = postEffects === undefined ? this.graphicsCompositor.warmStages() : this.graphicsCompositor.warmStages(postEffects !== null, postEffects?.localReflections !== undefined);
        return Promise.all([
          ...uses.map(({ mesh, material, skinned, isShadowCaster }) => this.meshes.warm(mesh, material, skinned, isShadowCaster, stages)),
          ...this.renderSystem.features.flatMap((feature) => feature.warmFiles(files, stages)),
          this.graphicsCompositor.warmPostEffects(postEffects),
        ]).then(() => {
          this.startup.warmEnd = performance.now();
        });
      };
      this.rootRenderer = this.graphicsCompositor;
      this.#registerMetrics();
      await this.loadContent();
      this.startup.content = performance.now();
      reportLoading('scene');
      // 编辑器的代理只在编辑状态用到：单独加载，不进游戏的主包
      if (this.editing) this.editor = new (await import('../editor/viewport/EditAgent')).EditAgent(this);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.sceneFrame = this.frames;
    this.status = 'running';
    requestAnimationFrame(this.#nextFrame);
  }

  /** 引擎自己的统计量；游戏在 loadContent 里接着登记自己的、设预算。 */
  #registerMetrics(): void {
    const metrics = this.metrics, memory = this.graphicsDevice.memory, frames = this.debug.frames;
    const average = (column: Float64Array) => {
      const recent = frames.last(METRIC_FRAMES, column);
      return recent.length === 0 ? 0 : recent.reduce((sum, value) => sum + value, 0) / recent.length;
    };
    metrics.gauge('entities', 'count', () => this.entities.count);
    // 最近一秒左右的平均
    metrics.gauge('frame.ms', 'ms', () => average(frames.interval));
    metrics.gauge('frame.update.ms', 'ms', () => average(frames.update));
    metrics.gauge('frame.draw.ms', 'ms', () => average(frames.draw));
    metrics.gauge('gpu.buffers', 'count', () => memory.buffers.count);
    metrics.gauge('gpu.buffers.bytes', 'bytes', () => memory.buffers.bytes);
    metrics.gauge('gpu.textures', 'count', () => memory.textures.count);
    metrics.gauge('gpu.textures.bytes', 'bytes', () => memory.textures.bytes);
    // 每帧的绘制次数（最近约一秒的中位数，偶尔一帧的大活不算）：所有渲染通道的（场景、阴影、后处理、UI、粒子、调试线），
    // 按通道分的见 stride draws；画的实例数是渲染特性（网格、精灵）上一帧的
    const featureTotal = (key: string) => this.renderSystem.features.reduce((sum, feature) => sum + (feature.stats()[key] ?? 0), 0);
    metrics.gauge('render.drawCalls', 'count', () => this.graphicsDevice.draws.median);
    metrics.gauge('render.instances', 'count', () => featureTotal('drawnInstances'));
    // 渲染图上一帧跑了几个通道、临时贴图实际占了几张
    metrics.gauge('render.passes', 'count', () => this.graphicsCompositor.graphStats.passes.length);
    metrics.gauge('render.targets', 'count', () => this.graphicsCompositor.graphStats.physicalTextures);
    // 管线：当场建的（着色器的编译堵住那一帧）和后台预热的各几条；预热到位的话前者在加载完以后不再涨
    metrics.gauge('gpu.pipelines.sync', 'count', () => this.graphicsDevice.pipelines.sync);
    metrics.gauge('gpu.pipelines.warmed', 'count', () => this.graphicsDevice.pipelines.warmed);
    metrics.gauge('native.heap.bytes', 'bytes', () => this.native.debugSnapshot().memory['heapBytes'] ?? 0);
    metrics.gauge('native.allocated.bytes', 'bytes', () => this.native.debugSnapshot().memory['allocatedBytes'] ?? 0);
    // Chrome 才有（不精确，够看趋势）
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    if (heap) metrics.gauge('js.heap.bytes', 'bytes', () => heap.usedJSHeapSize);
  }

  /**
   * 停止游戏并释放资源。失败之后也可以调用（原来只在 running 时生效，失败的游戏会一直占着原生线程和 GPU 设备）；
   * 初始化中途失败时，还没创建的部分跳过。在一帧里面调用（脚本、UI 的点击处理函数）时，这一帧跑完再停（同 Stride 的
   * Game.Exit），免得这一帧剩下的部分用到已经释放的东西。
   */
  exit(): void {
    if (this.status === 'exited') return;
    if (this.inFrame) {
      this.exitRequested = true;
      return;
    }
    this.status = 'exited';
    this.entities.clear();
    const root = this.rootRenderer as SceneRenderer | undefined;
    if (root !== this.graphicsCompositor) root?.destroy?.();
    (this.graphicsCompositor as ForwardRenderer | undefined)?.destroy();
    this.ui.destroy();
    this.debugTextRenderer.destroy();
    this.debugDrawRenderer.destroy();
    for (const system of this.#systems.toReversed()) system.destroy?.();
    this.audio.destroy();
    (this.renderSystem as RenderSystem | undefined)?.destroy();
    (this.input as InputManager | undefined)?.destroy();
    (this.graphicsDevice as GraphicsDevice | undefined)?.destroy();
    this.simulation?.destroy();
    (this.animation as AnimationSystem | undefined)?.destroy();
    (this.transforms as TransformStore | undefined)?.destroy();
    (this.native as StrideNative | undefined)?.shutdown();
  }

  /**
   * 游戏入口用这个代替 `new`，开发时就有热重载：Vite 每次重新执行入口模块（入口导入的任何游戏模块改了都会）
   * 都返回同一个正在运行的游戏，它换成新的类，并把新版本的模块交给 hotUpdate；第一次执行时才新建。
   * 入口模块要写 `import.meta.hot?.accept()`，自己接住更新，页面才不会整个刷新：
   *
   *   const modules = import.meta.glob('./game/**\/*.ts', { eager: true });
   *   const { game, created } = Game.hotEntry(import.meta.hot, modules, SandboxGame, stats);
   *   if (created) void game.run(canvas, { modules });
   *   import.meta.hot?.accept();
   *
   * 正式构建里 import.meta.hot 是 undefined，就是一次普通的 new。
   */
  static hotEntry<C extends new (...args: any[]) => Game>(
    hot: HotContext | undefined,
    modules: Readonly<Record<string, unknown>>,
    GameClass: C,
    ...args: ConstructorParameters<C>
  ): { game: InstanceType<C>; created: boolean } {
    const running = hot?.data['strideGame'] as InstanceType<C> | undefined;
    if (running && running.status !== 'exited') {
      // 游戏自己的类也可能改了：换原型，下一帧就跑新的 update、draw
      Object.setPrototypeOf(running, GameClass.prototype);
      running.hotUpdate(modules);
      return { game: running, created: false };
    }
    const game = new GameClass(...args) as InstanceType<C>;
    if (hot) hot.data['strideGame'] = game;
    return { game, created: true };
  }

  /**
   * 热重载：modules 是重新执行后的 `import.meta.glob` 结果，改过的模块是新对象。按名字把世界里的旧组件、
   * 脚本、系统换成新版本，状态保留（见 EntityManager.hotUpdate）。出错时游戏继续跑旧版本。
   */
  hotUpdate(modules: Readonly<Record<string, unknown>>): void {
    try {
      const changes = this.registry.update(modules);
      this.entities.hotUpdate(changes);
      console.info(`[stride] hot update: ${changes.map((c) => c.name).join(', ') || 'no component, script or system changed'}`);
    } catch (error) {
      console.error('[stride] hot update failed; the game keeps the previous code', error);
    }
  }

  /** 暂停时再跑 frames 帧，每帧前进 fixedTimeStep（没设时 1/60 秒）；没暂停时不起作用。 */
  step(frames = 1): void {
    this.pendingSteps += frames;
  }

  protected async loadContent(): Promise<void> {}

  /**
   * 按游戏设置启动（Stride 启动时读 GameSettings）：合成器的根是游戏自己的渲染器时，用 renderers 里同名（Stride 的类型名，带
   * 命名空间）的工厂建它、换掉 rootRenderer（找不到时警告，留着前向渲染器）；有默认场景时设成根场景。
   *
   *   await this.loadGameSettings('SpriteFonts/Shared/GameSettings', { renderers: { 'SpriteFonts.FontRenderer': (props) => new FontRenderer(props) } });
   */
  async loadGameSettings(path: string, { renderers = {}, ...sceneOptions }: LoadGameSettingsOptions = {}): Promise<GameSettings> {
    this.settingsPath = path;
    this.#renderers = renderers;
    const settings = await this.#applySettings(path);
    if (settings.defaultScene) await this.setRootScene(settings.defaultScene, sceneOptions);
    return settings;
  }

  /**
   * 游戏设置的文件改了（编辑器里改了根渲染器的属性、它用的贴图）：重新读，用同一个工厂重建根渲染器（旧的有 destroy 就放掉），
   * 下一帧就是新的。默认场景不动（换场景是编辑器打开别的场景）。没有用过 loadGameSettings 时什么也不做。
   */
  async reloadGameSettings(): Promise<void> {
    const path = this.settingsPath;
    if (!path) return;
    this.content.evict([path]);
    const old = this.rootRenderer;
    await this.#applySettings(path);
    if (old !== this.rootRenderer && old !== this.graphicsCompositor) (old as { destroy?(): void }).destroy?.();
  }

  /** 读游戏设置，按它定设计分辨率和根渲染器（游戏自己的渲染器、没有时是合成器）。 */
  async #applySettings(path: string): Promise<GameSettings> {
    const settings = (this.settings = await this.content.loadGameSettings(path));
    // 样例的调试文字是按这么大的窗口摆的
    this.debugText.virtualResolution = settings.defaultBackBufferSize;
    // 新的建好了再换上：建的时候（加载贴图）这几帧还画旧的
    let next: SceneRenderer = this.graphicsCompositor;
    if (settings.renderer) {
      const factory = this.#renderers[settings.renderer.type];
      if (factory) next = await factory(settings.renderer.props, this);
      else console.warn(`[stride] ${path}: no renderer for ${settings.renderer.type}; using the forward renderer (give one in loadGameSettings' renderers option)`);
    }
    this.rootRenderer = next;
    return settings;
  }

  /**
   * 加载场景、创建它的实体（ContentManager.loadScene），场景带的仿真设置交给 simulation。场景里有物理组件时
   * 要在 nativeFeatures 里加上 physics。给了 parent 就是它的子场景（Stride 的 `scene.Parent = Entity.Scene`）：
   *
   *   this.child = await this.game.loadScene(this.childScene, { parent: this.entity.scene, offset: [0, 0.5, 0] });
   */
  async loadScene(reference: string | SceneReference | SceneFile, options: LoadChildSceneOptions = {}): Promise<SceneInstance> {
    // 直接给场景文件的（编辑器，见 editor/LiveScene）不经内容路径
    const file = typeof reference === 'object' && 'entities' in reference ? reference : undefined;
    const path = file ? file.name : typeof reference === 'string' ? reference : (reference as SceneReference).path;
    const { parent } = options;
    // 编辑状态不挂场景文件里的脚本（除非明说要挂）
    const sceneOptions = this.editing ? { attachScripts: false, ...options } : options;
    const scene = file ? await this.content.instantiateScene(file, this.entities, sceneOptions) : await this.content.loadScene(path, this.entities, sceneOptions);
    if (parent) this.#childScenes.set(parent, [...(this.#childScenes.get(parent) ?? []), scene]);
    // 编辑状态里场景就是文件，不套运行时记下的状态
    if (!this.editing) this.persistence.sceneLoaded(scene);
    if (options.applySettings === false) {
      this.scenesChanged.run({ scene, loaded: true });
      return scene;
    }
    if (scene.compositor) this.configureCompositor(scene.compositor, path);
    if (scene.physics) {
      if (!this.simulation) throw new Error(`scene '${path}' has physics; run the game with nativeFeatures: [physics] (import { physics } from '@stride-ts/native/physics')`);
      this.simulation.configure(scene.physics);
    }
    if (scene.navigation && this.navigation) this.navigation.settings = scene.navigation;
    this.scenesChanged.run({ scene, loaded: true });
    return scene;
  }

  /**
   * 换根场景（Stride 里给 SceneSystem.SceneInstance.RootScene 赋值）：加载新场景，加载好后销毁旧根场景的实体
   * （它的子场景、子实体、脚本、物体跟着去掉，见 unloadScene）。加载期间旧场景照常运行。
   *
   *   override update(): void { if (this.input.isKeyPressed('N')) void this.game.setRootScene(this.nextScene); }
   */
  setRootScene(scene: string | SceneReference | SceneFile, options: LoadSceneOptions = {}): Promise<SceneInstance> {
    const change = this.rootSceneChange.catch(() => undefined).then(async () => {
      const next = await this.loadScene(scene, options);
      const previous = this.rootScene;
      // 先换上新场景：旧场景的脚本在 cancel 里出错时，根场景也已经是新的
      this.rootScene = next;
      this.sceneFrame = this.frames;
      if (previous) this.unloadScene(previous);
      return next;
    });
    this.rootSceneChange = change;
    return change;
  }

  /**
   * 加一个每帧跑的子系统（排在已有的后面，同一阶段按加的顺序跑）；返回它。游戏自己的流式加载、模拟、AI 调度这类
   * "每帧一次、不属于某个实体"的事放这里；按组件跑的逻辑用实体系统（engine/system.ts）。
   */
  addSystem<S extends GameSystem>(system: S): S {
    this.#systems.push(system);
    return system;
  }

  /** 去掉 addSystem 加的子系统（不调它的 destroy）。 */
  removeSystem(system: GameSystem): void {
    const index = this.#systems.indexOf(system);
    if (index >= 0) this.#systems.splice(index, 1);
  }

  /** 内置的子系统，按原来写死在帧里的顺序。 */
  #builtinSystems(): GameSystem[] {
    return [
      // 地形的块、摆放的实例、城市的楼在变换更新之前换
      { phase: 'beforeTransforms', update: () => this.terrain.update() },
      { phase: 'beforeTransforms', update: () => this.scatter.update(this.terrain.eyeWorld()) },
      { phase: 'beforeTransforms', update: () => this.city.update() },
      { update: () => this.world.update() },
      { update: () => this.weather.update(this) },
      { update: () => (this.editing ? undefined : this.perception.update(this)) },
      { update: () => this.smartObjects.update(this) },
      { update: () => this.wind.update(this) },
      { update: () => this.#updateRenderWind() },
      { update: () => this.precipitation.update(this) },
      { update: () => this.particles.update(this.updateTime.elapsed), moveOrigin: (dx, dy, dz) => this.particles.moveOrigin(dx, dy, dz), destroy: () => this.particles.destroy() },
    ];
  }

  /** 植被的风（Material.wind）用的全局风：速度乘上这一刻的阵风（同 WindField.sample 的全局部分），写给渲染系统。 */
  #updateRenderWind(): void {
    const global = this.wind.global, out = this.renderSystem?.wind, time = this.wind.time;
    if (!out) return;
    const pulse = 1 + global.pulseMagnitude * gust(time * global.pulseFrequency);
    for (let k = 0; k < 3; k++) out.velocity[k] = global.velocity[k]! * pulse;
    out.turbulence = global.turbulence;
    // 局部风源取离相机最近的几个（风场在渲染空间里：相机的位置减渲染原点）；强度同 WindField.sample 乘上它自己的阵风
    const eye = this.terrain.eyeWorld() ?? [...this.renderOrigin];
    out.locals = this.wind.nearest(eye[0] - this.renderOrigin[0], eye[1] - this.renderOrigin[1], eye[2] - this.renderOrigin[2], VEGETATION_LOCAL_WINDS).map((local) => ({
      center: local.center, radius: local.radius, strength: local.strength * (1 + local.pulseMagnitude * gust(time * local.pulseFrequency)),
    }));
  }

  /** 合成器指定的网格效果：按名字找游戏导出的 meshEffect，找不到时警告、用默认效果。 */
  /** 按场景的合成器设置配置主画面（loadScene 时；编辑器里场景的合成器改了以后 LiveScene 也调）。where 用在报错里。 */
  configureCompositor(compositor: CompositorSettings, where: string): void {
    this.graphicsCompositor.configure(compositor);
    this.meshes.effect = this.#meshEffect(compositor.meshEffect, where);
  }

  #meshEffect(name: string | undefined, where: string): MeshEffect | undefined {
    if (name === undefined) return undefined;
    const effect = this.registry.meshEffect(name);
    if (!effect) console.warn(`[stride] ${where}: no mesh effect named ${name}; using the default (export meshEffect(...) under that name)`);
    return effect;
  }

  /**
   * 卸载 loadScene 加载的场景（Stride 里从 Scene.Children 去掉子场景再 Content.Unload）：先卸载它的子场景，再销毁场景里的
   * 实体，子实体、脚本、物体跟着去掉；已经销毁的跳过。场景里的实体是场景文件建的那些，加上脚本放进来的
   * （`entity.scene = this.entity.scene`，见 Entity.scene）；脚本另建、又没放进场景也没挂到场景实体下面的实体不动。
   */
  unloadScene(scene: SceneInstance): void {
    for (const child of this.#childScenes.get(scene) ?? []) this.unloadScene(child);
    if (!this.editing) this.persistence.sceneUnloading(scene);
    this.#childScenes.delete(scene);
    // 它自己是别人的子场景时，从父场景那里去掉
    for (const [parent, children] of this.#childScenes) {
      if (children.includes(scene)) this.#childScenes.set(parent, children.filter((child) => child !== scene));
    }
    // 场景文件建的和运行时放进来的（Entity.scene）；销毁父实体时子实体已经跟着销毁了
    for (const entity of this.entities.inScene(scene)) {
      if (entity.alive) entity.destroy();
    }
    scene.root?.dispose();
    this.scenesChanged.run({ scene, loaded: false });
  }

  /** 渲染原点跟着上一帧主画面的相机（世界矩阵是双精度的），按格对齐；变了就交给变换存储（渲染用的矩阵跟着重算）。 */
  #updateRenderOrigin(): void {
    const id = (this.graphicsCompositor as Game['graphicsCompositor'] | undefined)?.mainCameraEntity;
    const camera = id === undefined || !this.entities.isAlive(id) ? undefined : this.entities.entity(id).get(Transform)?.world;
    if (!camera) return;
    const snap = (value: number) => Math.round(value / RENDER_ORIGIN_CELL) * RENDER_ORIGIN_CELL;
    const next = [snap(camera[12]!), snap(camera[13]!), snap(camera[14]!)] as const;
    const origin = this.renderOrigin;
    if (next[0] === origin[0] && next[1] === origin[1] && next[2] === origin[2]) return;
    const dx = next[0] - origin[0], dy = next[1] - origin[1], dz = next[2] - origin[2];
    this.debugDraw.moveOrigin(dx, dy, dz);
    for (const system of this.#systems) system.moveOrigin?.(dx, dy, dz);
    origin[0] = next[0];
    origin[1] = next[1];
    origin[2] = next[2];
    this.transforms.setRenderOrigin(origin[0], origin[1], origin[2]);
  }

  /** 运行脚本、系统和物理仿真（在物理前和物理后两组系统之间）；重写时要调用 super.update(time)。 */
  protected update(time: GameTime): void {
    // 远处物理的降级、动画按距离降频都按主相机（上一帧的视图）的位置
    const eye = this.terrain.eyeWorld();
    if (this.simulation) this.simulation.focus = eye;
    if (this.animation) this.animation.focus = eye;
    // 分块流式的导航网格在物理之后看静态物体的变化、引子走到哪了
    this.entities.update(time, this.simulation ? (t) => {
      this.simulation!.update(t);
      this.navigation?.update(t);
    } : undefined);
  }

  /** 画一帧：世界矩阵这时已经算好。默认交给图形合成器。 */
  /**
   * 点选：画布上 (x, y)（CSS 像素，左上角是原点）最前面的东西（网格、精灵、粒子、放在 3D 里的 UI）属于哪个实体；那里什么都没有时是 undefined。
   * 结果要等画一两帧（在 GPU 上画编号、读回，见 ScenePicker）。模型多出来的网格挂在子实体上，点到它们算点到模型所在的实体；
   * 点到粒子、UI 算点到粒子系统、UI 所在的实体；全屏的 UI 点不到，点的是它后面的场景。
   */
  async pick(x: number, y: number): Promise<Entity | undefined> {
    // 点选要画一两帧才有结果：按需出帧时也要出
    const release = this.holdFrames();
    try {
      return await this.#pickNow(x, y);
    } finally {
      release();
    }
  }

  async #pickNow(x: number, y: number): Promise<Entity | undefined> {
    const canvas = this.graphicsDevice.canvas;
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    return this.#pickedEntity(await this.graphicsCompositor.picker.pick(x * ratio, y * ratio));
  }

  /** 变换槽位 → 点到的实体：模型多出来的网格挂在子实体上，算模型所在的实体。 */
  #pickedEntity(slot: number | undefined): Entity | undefined {
    const entity = slot === undefined ? undefined : entityAtSlot(this.entities, slot);
    return entity?.has(ModelPart) ? (entity.require(Transform).parent ?? entity) : entity;
  }

  /**
   * 点选加上表面的位置：画布上 (x, y)（CSS 像素）最前面的表面在世界里的点和它所属的实体（同 pick）。excludeGroups 里的渲染组
   * （位掩码）不算——编辑器拖东西吸附到表面时，拖着的东西自己不挡。什么都没点到时是 undefined。结果要等画一两帧。
   */
  async pickSurface(x: number, y: number, excludeGroups = 0): Promise<{ readonly entity: Entity | undefined; readonly point: [number, number, number] } | undefined> {
    const release = this.holdFrames();
    try {
      const canvas = this.graphicsDevice.canvas;
      const ratio = canvas.width / Math.max(1, canvas.clientWidth);
      const px = Math.floor(x * ratio), py = Math.floor(y * ratio);
      const hit = await this.graphicsCompositor.picker.pickSurface(px, py, excludeGroups);
      const view = this.graphicsCompositor.mainView;
      // 反向 Z：0 是什么都没画（天空）
      if (!hit || hit.depth <= 0 || !view) return undefined;
      // 像素中心换成裁剪空间（y 向上），深度就是 NDC 的 z（0 到 1），用视图投影的逆矩阵换回世界
      const ndcX = ((px + 0.5) / canvas.width) * 2 - 1, ndcY = 1 - ((py + 0.5) / canvas.height) * 2;
      // 视图在渲染空间里：点加上渲染原点才是世界坐标
      const [rx, ry, rz] = Matrix.transformPoint(view.inverseViewProjection, ndcX, ndcY, hit.depth);
      const o = this.renderOrigin;
      return { entity: this.#pickedEntity(hit.slot), point: [rx + o[0], ry + o[1], rz + o[2]] };
    } finally {
      release();
    }
  }

  protected draw(time: GameTime): void {
    this.rootRenderer.draw({ game: this, time });
  }

  private readonly frame = async (now: number): Promise<void> => {
    if (this.status !== 'running') return;
    const interval = this.lastFrameTime === undefined ? 0 : now - this.lastFrameTime;
    this.lastFrameTime = now;
    // 离线渲染接管着帧循环时只排下一次；按需出帧、没人叫醒时也只排下一次
    const idle = this.renderOnDemand && this.#holds === 0 && this.#wakeFrames <= 0;
    if (!idle && this.#wakeFrames > 0) this.#wakeFrames--;
    if (!this.framesTakenOver && !idle) {
      let advance: number | undefined;
      if (!this.paused || this.pendingSteps > 0) {
        if (this.paused) this.pendingSteps--;
        const real = Math.min(interval / 1000, MAX_ELAPSED) * this.timeScale;
        advance = this.fixedTimeStep ?? (this.paused ? STEP_SECONDS : real);
      }
      await this.runFrameBody(interval, advance);
    }
    if (this.exitRequested) {
      this.exit();
      return;
    }
    requestAnimationFrame(this.#nextFrame);
  };

  /** 交给 requestAnimationFrame 的回调（它不管返回的 Promise；帧里的错 frame 自己接住、报出来）。 */
  readonly #nextFrame = (now: number): void => void this.frame(now);

  /** 按需出帧时叫醒：接下来至少出 count 帧（默认够异步加载、时间累积的效果稳下来）。没开按需出帧时什么也不变。 */
  requestFrames(count = SETTLE_FRAMES): void {
    this.#wakeFrames = Math.max(this.#wakeFrames, count);
  }

  /** 按需出帧时一直出帧，直到调返回的函数（之后再出 SETTLE_FRAMES 帧）：要等几帧才有结果的事（点选、调试命令）。 */
  holdFrames(): () => void {
    this.#holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#holds--;
      this.requestFrames();
    };
  }

  /**
   * 离线渲染（offline/OfflineRenderer）接管帧循环：之后 requestAnimationFrame 来了不跑帧，由 runFrame 一帧一帧地跑——不受
   * 显示器的刷新率限制，窗口被挡住、标签页在后台（浏览器把 requestAnimationFrame 降到每秒一次）时也照样快。正在跑的那一帧
   * 跑完才兑现。返回还回去的函数。
   */
  async takeOverFrames(): Promise<() => void> {
    if (this.framesTakenOver) throw new Error('Game.takeOverFrames: the frame loop is already taken over');
    this.framesTakenOver = true;
    // 离线渲染每一帧都要完整：管线没编好也要当场编，不能先不画（网格特性的 deferPipelines）
    this.meshes.deferPipelines = false;
    while (this.inFrame) await new Promise((resolve) => setTimeout(resolve, 0));
    return () => {
      this.framesTakenOver = false;
      this.meshes.deferPipelines = true;
    };
  }

  /** 接管着帧循环时（takeOverFrames）：马上跑一帧，游戏时间前进 seconds 秒再画；0 时只画不更新。 */
  runFrame(seconds: number): Promise<void> {
    if (!this.framesTakenOver) throw new Error('Game.runFrame: call takeOverFrames() first');
    return this.runFrameBody(0, seconds > 0 ? seconds : undefined);
  }

  /** 一帧：advance 不是 undefined 时游戏时间前进这么多秒、更新，然后画。interval 是离上一帧的毫秒数（统计用）。 */
  private async runFrameBody(interval: number, advance: number | undefined): Promise<void> {
    const start = performance.now();
    this.inFrame = true;
    try {
      // 窗口大小在帧开头跟上，这一帧的脚本和绘制看到的一样大
      this.graphicsDevice.resizeToDisplaySize();
      if (advance !== undefined) {
        this.updateTime.advance(advance);
        if (!this.editing) this.clock.advance(this.updateTime.elapsed);
        this.input.update(this.updateTime.elapsed);
        this.debugText.beginFrame();
        this.debugDraw.beginFrame(this.updateTime.total);
        this.update(this.updateTime);
        this.writeStats();
        await scriptContinuations();
        this.#updateRenderOrigin();
        // 挂上、挪动实体的子系统在变换更新之前：新挂上的这一帧就有世界矩阵；读世界矩阵的在之后
        for (const system of this.#systems) if (system.phase === 'beforeTransforms') system.update?.(this);
        this.transforms.update();
        for (const system of this.#systems) if (system.phase !== 'beforeTransforms') system.update?.(this);
      }
      const drawStart = performance.now();
      this.draw(this.updateTime);
      this.ui.draw(this);
      this.particles.drawOverUI(this);
      // 调试线和调试文字画在 UI 上面：编辑器的选中框、操纵器不能被放在 3D 里的 UI 盖住
      this.debugDrawRenderer.draw(this);
      this.debugTextRenderer.draw(this);
      this.graphicsDevice.submitFrame();
      const end = performance.now();
      this.startup.firstFrame ??= end;
      this.startup.warmedPipelines ??= this.graphicsDevice.pipelines.warmed;
      finishLoading();
      this.debug.frames.record(interval, advance !== undefined ? drawStart - start : 0, end - drawStart);
      this.debug.endFrame();
      if (this.debug.connected) this.forwardNativeDebug();
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.inFrame = false;
    }
  }

  /** 调试 CLI 连着时：打开原生侧的收集（计数器、计时），原生日志转给调试桥。 */
  private forwardNativeDebug(): void {
    if (!this.native.debugCollecting) this.native.debugCollecting = true;
    for (const { level, message } of this.native.drainDebugLog()) this.debug.log(level, message, undefined, 'native');
  }

  private writeStats(): void {
    const stats = this.statsOutput, time = this.updateTime;
    if (!stats || time.total - stats.time < STATS_INTERVAL) return;
    stats.time = time.total;
    stats.element.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }

  private fail(error: unknown): void {
    this.status = 'failed';
    this.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
    // 启动阶段出的错：加载骨架停下来、写出原因（第一帧以后骨架已经摘掉了，空操作）
    failLoading(this.error);
  }
}

/**
 * 让这一帧末尾兑现的 nextFrame、delay 的续体先跑完，再算世界矩阵、画：await 之后的代码是微任务，不等的话要到这一帧画完才跑，
 * 异步脚本做的移动晚一帧才画出来（Stride 的异步脚本在同一帧的脚本更新里恢复，当帧就画）。续体里每多套一层 async 函数，
 * 兑现就多传一个微任务，所以多让几轮。
 */
async function scriptContinuations(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
