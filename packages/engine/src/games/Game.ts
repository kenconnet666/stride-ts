import { createStrideNative, type StrideNative, type TransformStore } from '@stride-ts/native';
import { ContentManager } from '../content/ContentManager';
import type { ScopedDefaults } from '../engine/defaults';
import { EntityManager } from '../engine/EntityManager';
import { Registry } from '../engine/registry';
import { GraphicsDevice } from '../graphics/GraphicsDevice';
import { BackgroundRenderFeature } from '../rendering/BackgroundRenderFeature';
import { ForwardRenderer } from '../rendering/ForwardRenderer';
import { MeshRenderFeature } from '../rendering/MeshRenderFeature';
import { RenderSystem } from '../rendering/RenderSystem';
import { browserImageDecoder, ktx2Decoder } from '../rendering/Texture';
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
  /** 变换存储的槽位数，即最多有多少个带 Transform 的实体；默认 65536（每个约 108 字节）。 */
  maxTransforms?: number;
  /**
   * 游戏的模块，即 `import.meta.glob('./**\/*.ts', { eager: true })` 的结果：loadContent 之前，按路径和导出名
   * 给其中的组件、脚本、系统起名（见 engine/registry.ts）。
   */
  modules?: Readonly<Record<string, unknown>>;
}

// 更长的间隔（标签页在后台、断点停住）不在一步里模拟完。
const MAX_ELAPSED = 0.25;
const DEFAULT_MAX_TRANSFORMS = 65536;

/** Vite 的 `import.meta.hot` 里引擎用到的部分。 */
export interface HotContext {
  readonly data: Record<string, unknown>;
}

declare global {
  /** 正在运行的游戏，tools/ 里的脚本读它（`status`、`frames`、`sceneFrame`、`error`）。 */
  var strideGame: Game | undefined;
}

/**
 * 拥有原生模块、图形设备、实体和帧循环（对应 Stride 的 Game）。
 * 继承它并重写 loadContent 和 update（要调用 super.update，脚本和系统在里面跑）；draw 默认交给图形合成器，
 * 重写时可以不调用 super.draw，自己画。run() 初始化之后才有 `native`、`graphicsDevice` 和渲染系统。其中任何一处抛异常，或 AsyncScript 被拒绝，游戏都会停下，状态为 'failed'。
 */
export class Game {
  native!: StrideNative;
  /** 所有 Transform 组件的数据，在原生内存里；世界矩阵在每帧 update 之后、draw 之前算。 */
  transforms!: TransformStore;
  graphicsDevice!: GraphicsDevice;
  /** 渲染特性（默认有 MeshRenderFeature）、视图和光照（Stride 的 RenderSystem）。 */
  renderSystem!: RenderSystem;
  /** 每帧的 draw 交给它（Stride 的 GraphicsCompositor）；骨架阶段是一个前向渲染器。 */
  graphicsCompositor!: ForwardRenderer;
  readonly updateTime = new GameTime();
  readonly registry = new Registry();
  /** 资源管线产出的模型、材质、场景（默认从页面旁边的 content/ 加载，可以换成别的根目录）。 */
  content = new ContentManager();
  readonly entities: EntityManager = new EntityManager(this);

  status: GameStatus = 'starting';
  error: string | undefined;
  /** 内容加载完成时的帧号。 */
  sceneFrame: number | undefined;

  private lastFrameTime: number | undefined;

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
    try {
      if (options.modules) this.registry.registerModules(options.modules);
      this.native = await createStrideNative({ debug: options.debugNative ?? false, ...(options.workerThreads === undefined ? {} : { workerThreads: options.workerThreads }) });
      this.transforms = this.native.createTransforms(options.maxTransforms ?? DEFAULT_MAX_TRANSFORMS);
      this.graphicsDevice = await GraphicsDevice.create(canvas);
      this.content.textureDecoder ??= ktx2Decoder(this.native, this.graphicsDevice);
      this.content.meshoptDecoder ??= (requests) => this.native.decodeMeshoptBatch(requests);
      this.content.imageDecoder ??= browserImageDecoder();
      this.renderSystem = new RenderSystem(this.graphicsDevice);
      this.renderSystem.addFeature(new MeshRenderFeature());
      // 背景画在网格之后，只落在没画到的地方
      this.renderSystem.addFeature(new BackgroundRenderFeature());
      this.graphicsCompositor = new ForwardRenderer(this.renderSystem);
      await this.loadContent();
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
   * 初始化中途失败时，还没创建的部分跳过。
   */
  exit(): void {
    if (this.status === 'exited') return;
    this.status = 'exited';
    this.entities.clear();
    (this.graphicsCompositor as ForwardRenderer | undefined)?.destroy();
    (this.renderSystem as RenderSystem | undefined)?.destroy();
    (this.graphicsDevice as GraphicsDevice | undefined)?.destroy();
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

  protected async loadContent(): Promise<void> {}

  /** 运行脚本和系统；重写时要调用 super.update(time)。 */
  protected update(time: GameTime): void {
    this.entities.update(time);
  }

  /** 画一帧：世界矩阵这时已经算好。默认交给图形合成器。 */
  protected draw(time: GameTime): void {
    this.graphicsCompositor.draw({ game: this, time });
  }

  private readonly frame = (now: number): void => {
    if (this.status !== 'running') return;
    const elapsed = this.lastFrameTime === undefined ? 0 : Math.min((now - this.lastFrameTime) / 1000, MAX_ELAPSED);
    this.lastFrameTime = now;
    try {
      this.updateTime.advance(elapsed);
      this.update(this.updateTime);
      this.transforms.update();
      this.graphicsDevice.resizeToDisplaySize();
      this.draw(this.updateTime);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    requestAnimationFrame(this.frame);
  };

  private fail(error: unknown): void {
    this.status = 'failed';
    this.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(error);
  }
}
