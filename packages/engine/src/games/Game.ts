import { createStrideNative, type NativeFeature, type StrideNative, type TransformStore } from '@stride-ts/native';
import { AnimationSystem } from '../animation/AnimationSystem';
import { modelNodeLinkSystem } from '../animation/ModelNodeLink';
import { uiElementLinkSystem } from '../ui/UIElementLink';
import { hook } from '../engine/events';
import { ContentManager, type GameSettings, type LoadSceneOptions, type SceneInstance, type SceneReference } from '../content/ContentManager';
import { registerGameCommands } from '../debug/commands';
import { Debug } from '../debug/Debug';
import { DebugText } from '../debug/DebugText';
import { DebugTextRenderer } from '../debug/DebugTextRenderer';
import type { ScopedDefaults } from '../engine/defaults';
import type { EntityScene } from '../engine/Entity';
import { EntityManager } from '../engine/EntityManager';
import { Registry } from '../engine/registry';
import { GraphicsDevice } from '../graphics/GraphicsDevice';
import { InputManager } from '../input/InputManager';
import { Simulation } from '../physics/Simulation';
import { NavigationSystem } from '../navigation/NavigationSystem';
import { AudioEmitterComponent, AudioListenerComponent } from '../audio/AudioEmitterComponent';
import { RecastNavigationComponent } from '../navigation/RecastNavigationComponent';
import { BackgroundRenderFeature } from '../rendering/BackgroundRenderFeature';
import { ForwardRenderer } from '../rendering/ForwardRenderer';
import { MeshRenderFeature } from '../rendering/MeshRenderFeature';
import type { MeshEffect } from '../rendering/meshEffect';
import { SpriteRenderFeature } from '../rendering/SpriteRenderFeature';
import { RenderSystem, type SceneRenderer } from '../rendering/RenderSystem';
import { browserImageDecoder, ktx2Decoder } from '../rendering/Texture';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleSystemComponent, ParticleSystems } from '../particles/ParticleSystemComponent';
import { UIComponent } from '../ui/UIComponent';
import { UISystem } from '../ui/UISystem';
import { GameTime } from './GameTime';

export type GameStatus = 'starting' | 'running' | 'failed' | 'exited';

export interface GameOptions {
  /** 原生模块任务系统的工作线程数；默认 hardwareConcurrency - 1。 */
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
  /** 变换存储的槽位数，即最多有多少个带 Transform 的实体；默认 65536（每个约 108 字节）。 */
  maxTransforms?: number;
  /** 物理仿真最多的物体数（nativeFeatures 里有 physics 时），默认 4096。 */
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
}

// 更长的间隔（标签页在后台、断点停住）不在一步里模拟完。
const MAX_ELAPSED = 0.25;
/** GameOptions.stats 隔多少秒（游戏时间）更新一次。 */
const STATS_INTERVAL = 0.25;
const DEFAULT_MAX_TRANSFORMS = 65536;
const DEFAULT_MAX_BODIES = 4096;
/** 暂停时单步、没设 fixedTimeStep 时每步的秒数。 */
const STEP_SECONDS = 1 / 60;

/** Vite 的 `import.meta.hot` 里引擎用到的部分。 */
export interface HotContext {
  readonly data: Record<string, unknown>;
}

declare global {
  /** 正在运行的游戏，控制台和调试命令的 eval 读它。 */
  var strideGame: Game | undefined;
}

/**
 * 拥有原生模块、图形设备、实体和帧循环（对应 Stride 的 Game）。
 * 继承它并重写 loadContent 和 update（要调用 super.update，脚本和系统在里面跑）；draw 默认交给图形合成器，
 * 重写时可以不调用 super.draw，自己画。run() 初始化之后才有 `native`、`graphicsDevice` 和渲染系统。其中任何一处抛异常，或 AsyncScript 被拒绝，游戏都会停下，状态为 'failed'。
 */
/** Game.loadScene 的选项（同 LoadSceneOptions；parent 给了就是子场景）。 */
export type LoadChildSceneOptions = LoadSceneOptions;

/** Game.loadGameSettings 的选项：合成器的游戏渲染器怎么建（按 Stride 的类型名），默认场景的加载选项。 */
export interface LoadGameSettingsOptions extends LoadSceneOptions {
  readonly renderers?: Readonly<Record<string, (props: Readonly<Record<string, unknown>>, game: Game) => SceneRenderer | Promise<SceneRenderer>>>;
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
  /** 粒子系统（Stride 的 ParticleSystemSimulationProcessor）：每帧变换更新之后模拟。 */
  readonly particles = new ParticleSystems();
  /** UI（Stride 的 UISystem）：UIComponent 的页面画在场景之后。 */
  readonly ui = new UISystem();
  private readonly debugTextRenderer = new DebugTextRenderer();
  /** 调试命令、计数器、事件和日志转发（debug/Debug.ts）。 */
  readonly debug = new Debug(() => (this.status === 'starting' ? undefined : this.frames));
  /** 暂停时不跑 update（脚本、系统、物理、游戏时间都停住），画面照常画；step() 单步。 */
  paused = false;
  /** 游戏时间相对真实时间的倍率。 */
  timeScale = 1;
  /** 设了以后每帧固定前进这么多秒，不看真实时间（调试时复现同样的过程）。 */
  fixedTimeStep: number | undefined;

  status: GameStatus = 'starting';
  error: string | undefined;
  /** 启动各阶段完成的时刻（页面开始加载后的毫秒数）：原生模块就绪、loadContent 完成、第一帧画完。 */
  readonly startup: { native?: number; content?: number; firstFrame?: number } = {};
  /** 内容加载完成（或换了根场景）时的帧号。 */
  sceneFrame: number | undefined;
  /** 根场景（Stride 的 SceneSystem.SceneInstance.RootScene），setRootScene 设；loadScene 加的场景不算。 */
  rootScene: SceneInstance | undefined;
  /** loadGameSettings 读到的游戏设置（Stride 的 Game.Settings）；没读过时是 undefined。 */
  settings: GameSettings | undefined;
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
    if (options.debug ?? new URLSearchParams(location.search).has('debug')) {
      registerGameCommands(this.debug, this);
      this.debug.connect();
    }
    try {
      if (options.modules) this.registry.registerModules(options.modules);
      this.native = await createStrideNative({
        debug: options.debugNative ?? false,
        features: options.nativeFeatures ?? [],
        ...(options.workerThreads === undefined ? {} : { workerThreads: options.workerThreads }),
      });
      this.startup.native = performance.now();
      this.transforms = this.native.createTransforms(options.maxTransforms ?? DEFAULT_MAX_TRANSFORMS);
      if (this.native.hasFeature('physics')) this.simulation = new Simulation(this.native, this.transforms, this.entities, options.maxBodies ?? DEFAULT_MAX_BODIES);
      if (this.simulation && this.native.hasFeature('navigation')) this.navigation = new NavigationSystem(this.native, this.simulation);
      this.registry.register(RecastNavigationComponent);
      this.registry.register(UIComponent);
      this.registry.register(ParticleSystemComponent);
      this.registry.register(AudioEmitterComponent);
      this.registry.register(AudioListenerComponent);
      this.animation = new AnimationSystem(this.native, this.entities);
      this.entities.addSystems(this.animation.system, this.animation.morphSystem, this.animation.propertySystem, modelNodeLinkSystem(this.entities, this.transforms, this.animation), uiElementLinkSystem(this.entities, this.transforms, this.ui));
      this.content.animationNative ??= this.native;
      this.graphicsDevice = await GraphicsDevice.create(canvas);
      // 加载内容、脚本启动时读到的就是画面的实际大小（Stride 的后备缓冲在游戏开始前就建好了）
      this.graphicsDevice.resizeToDisplaySize();
      this.input = new InputManager(canvas);
      this.ui.attach(this);
      if (this.native.hasFeature('texture')) this.content.textureDecoder ??= ktx2Decoder(this.native, this.graphicsDevice);
      this.content.meshoptDecoder ??= (requests) => this.native.decodeMeshoptBatch(requests);
      this.content.imageDecoder ??= browserImageDecoder();
      this.content.audio ??= this.audio;
      this.audio.attach(window);
      this.renderSystem = new RenderSystem(this.graphicsDevice);
      this.meshes = this.renderSystem.addFeature(new MeshRenderFeature());
      // 背景画在网格之后，只落在没画到的地方
      this.renderSystem.addFeature(new BackgroundRenderFeature());
      this.renderSystem.addFeature(new SpriteRenderFeature());
      this.graphicsCompositor = new ForwardRenderer(this.renderSystem);
      this.rootRenderer = this.graphicsCompositor;
      await this.loadContent();
      this.startup.content = performance.now();
    } catch (error) {
      this.fail(error);
      throw error;
    }
    this.sceneFrame = this.frames;
    this.status = 'running';
    requestAnimationFrame(this.frame);
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
    this.particles.destroy();
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
    const settings = (this.settings = await this.content.loadGameSettings(path));
    // 样例的调试文字是按这么大的窗口摆的
    this.debugText.virtualResolution = settings.defaultBackBufferSize;
    if (settings.renderer) {
      const factory = renderers[settings.renderer.type];
      if (factory) this.rootRenderer = await factory(settings.renderer.props, this);
      else console.warn(`[stride] ${path}: no renderer for ${settings.renderer.type}; using the forward renderer (give one in loadGameSettings' renderers option)`);
    }
    if (settings.defaultScene) await this.setRootScene(settings.defaultScene, sceneOptions);
    return settings;
  }

  /**
   * 加载场景、创建它的实体（ContentManager.loadScene），场景带的仿真设置交给 simulation。场景里有物理组件时
   * 要在 nativeFeatures 里加上 physics。给了 parent 就是它的子场景（Stride 的 `scene.Parent = Entity.Scene`）：
   *
   *   this.child = await this.game.loadScene(this.childScene, { parent: this.entity.scene, offset: [0, 0.5, 0] });
   */
  async loadScene(reference: string | SceneReference, options: LoadChildSceneOptions = {}): Promise<SceneInstance> {
    const path = typeof reference === 'string' ? reference : reference.path;
    const { parent } = options;
    const scene = await this.content.loadScene(path, this.entities, options);
    if (parent) this.#childScenes.set(parent, [...(this.#childScenes.get(parent) ?? []), scene]);
    if (scene.compositor) {
      this.graphicsCompositor.configure(scene.compositor);
      this.meshes.effect = this.#meshEffect(scene.compositor.meshEffect, path);
    }
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
  setRootScene(scene: string | SceneReference, options: LoadSceneOptions = {}): Promise<SceneInstance> {
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

  /** 合成器指定的网格效果：按名字找游戏导出的 meshEffect，找不到时警告、用默认效果。 */
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

  /** 运行脚本、系统和物理仿真（在物理前和物理后两组系统之间）；重写时要调用 super.update(time)。 */
  protected update(time: GameTime): void {
    this.entities.update(time, this.simulation ? (t) => this.simulation!.update(t) : undefined);
  }

  /** 画一帧：世界矩阵这时已经算好。默认交给图形合成器。 */
  protected draw(time: GameTime): void {
    this.rootRenderer.draw({ game: this, time });
  }

  private readonly frame = async (now: number): Promise<void> => {
    if (this.status !== 'running') return;
    const interval = this.lastFrameTime === undefined ? 0 : now - this.lastFrameTime;
    this.lastFrameTime = now;
    const start = performance.now();
    this.inFrame = true;
    try {
      // 窗口大小在帧开头跟上，这一帧的脚本和绘制看到的一样大
      this.graphicsDevice.resizeToDisplaySize();
      const updating = !this.paused || this.pendingSteps > 0;
      if (updating) {
        if (this.paused) this.pendingSteps--;
        const real = Math.min(interval / 1000, MAX_ELAPSED) * this.timeScale;
        this.updateTime.advance(this.fixedTimeStep ?? (this.paused ? STEP_SECONDS : real));
        this.input.update(this.updateTime.elapsed);
        this.debugText.beginFrame();
        this.update(this.updateTime);
        this.writeStats();
        await scriptContinuations();
        this.transforms.update();
        this.particles.update(this.updateTime.elapsed);
      }
      const drawStart = performance.now();
      this.draw(this.updateTime);
      this.ui.draw(this);
      this.particles.drawOverUI(this);
      this.debugTextRenderer.draw(this);
      this.graphicsDevice.submitFrame();
      const end = performance.now();
      this.startup.firstFrame ??= end;
      this.debug.frames.record(interval, updating ? drawStart - start : 0, end - drawStart);
      this.debug.endFrame();
      if (this.debug.connected) this.forwardNativeDebug();
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.inFrame = false;
    }
    if (this.exitRequested) {
      this.exit();
      return;
    }
    requestAnimationFrame(this.frame);
  };

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
  }
}

/**
 * 让这一帧末尾兑现的 nextFrame、delay 的续体先跑完，再算世界矩阵、画：await 之后的代码是微任务，不等的话要到这一帧画完才跑，
 * 异步脚本做的移动晚一帧才画出来（Stride 的异步脚本在同一帧的脚本更新里恢复，当帧就画）。续体里每多套一层 async 函数，
 * 兑现就多传一个微任务，所以多让几轮。
 */
async function scriptContinuations(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i++) await null;
}
