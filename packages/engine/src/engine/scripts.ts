/**
 * 脚本，结构同 Stride：StartupScript（start）、SyncScript（start，加上每帧的 update）、
 * AsyncScript（execute，用 nextFrame 或 delay 等待）。属性用 props() 声明，类型靠推导：
 *
 *   export class PlayerController extends SyncScript.props({
 *     maxRunSpeed: prop.number().min(0).default(10).stat(),
 *     jumpHeight: 1.2,
 *   }) {
 *     override update(time: GameTime): void { this.maxRunSpeed; }   // number，已经算上修饰
 *   }
 *
 * 脚本通过 `this.disposables`、`this.on`、`this.receive` 登记的东西，在脚本移除时和 `this.signal` 的中止
 * 一起释放。
 */
import type { InheritedOf, InitOf, ScriptValues, Shape, StatKeys } from '../data/prop';
import { createSchema, type Schema } from '../data/schema';
import type { Game } from '../games/Game';
import type { GameTime } from '../games/GameTime';
import { checkVariants, variantValues } from './component';
import type { Entity } from './Entity';
import type { EventKey, EventReceiver, Hook, HookHandler } from './events';
import type { Stat } from './stats';

/** 脚本自己成员用的名字；属性叫这些名字会把成员盖掉。 */
const RESERVED = new Set([
  'entity', 'game', 'enabled', 'signal', 'disposables', 'attached', 'stats', 'statTable', 'on', 'receive',
  'start', 'update', 'cancel', 'execute', 'nextFrame', 'delay', 'detach', 'constructor',
]);

/** 任意脚本类，抽象的也算。 */
export type ScriptConstructor<T extends ScriptComponent = ScriptComponent> = (abstract new () => T) & {
  readonly schema: Schema;
  readonly variants: Readonly<Record<string, object>>;
  readonly scriptName: string | undefined;
};

/** 脚本类用 props() 声明的 shape；没有时是 {}。 */
export type ShapeOfScript<C> = C extends { readonly __shape: infer S extends Shape } ? S : {};
/** 脚本类用 props() 声明的变体名。 */
export type VariantsOfScript<C> = C extends { readonly __variants: infer V extends string } ? V : never;

/** 脚本类加上创建时的取值：`PlayerController.with({ maxRunSpeed: 12 })`。 */
export interface ScriptInit<C extends ScriptConstructor = ScriptConstructor> {
  readonly script: C;
  readonly init: object | undefined;
}

/** 所有属性都有默认值的脚本类，可以直接列出。 */
export type BareScript = ScriptConstructor & { readonly __bare: true };

export interface ScriptOptions<S extends Shape, V extends string> {
  readonly variants?: { readonly [K in V]: Partial<InitOf<S, 'script'>> };
}

/** script.stats：每个标了 .stat() 的属性一个 Stat。 */
export type StatsOf<S extends Shape> = { readonly [K in StatKeys<S>]: Stat };

/** props() 返回的类：在基类的实例上加上声明的属性。 */
export type WithProps<B extends ScriptConstructor, S extends Shape, V extends string> = (abstract new () => InstanceType<B> &
  ScriptValues<S> & { readonly stats: StatsOf<S> }) &
  Omit<B, 'prototype' | '__shape' | '__bare' | '__variants'> & {
    /** 基类用 props() 声明的属性也在里面（脚本类可以一层层地加属性）。 */
    readonly __shape: ShapeOfScript<B> & S;
    readonly __variants: V;
    readonly __bare: {} extends InitOf<ShapeOfScript<B> & S, 'script'> ? true : false;
  };

/** props() 建的类上记着的 shape（含基类的），子类再调 props() 时合并。 */
const PROPS_SHAPE = Symbol('propsShape');

/** @internal 脚本启动过的标记（symbol 键，不和脚本自己的字段重名）。 */
export const STARTED = Symbol('started');

export abstract class ScriptComponent {
  declare static readonly __shape: {};
  declare static readonly __variants: never;
  declare static readonly __bare: true;
  /** @internal 属性；props() 给每个脚本类一份自己的。 */
  static schema: Schema = createSchema({}, 'number', RESERVED, 'script');
  /** @internal */
  static variants: Readonly<Record<string, object>> = {};
  /** @internal 传给 props() 的名字，或游戏登记模块后得出的 `路径#导出名`。 */
  static scriptName: string | undefined;

  /** start() 之前设好；脚本被移除之前一直属于这个实体。 */
  entity!: Entity;
  game!: Game;
  /** 脚本移除或游戏退出时释放（事件接收器、钩子、计时器、资源）。 */
  protected readonly disposables = new DisposableStack();
  readonly #abort = new AbortController();
  #enabled = true;

  /** 停用的 SyncScript 不再 update，状态保留（Stride 的 EntityComponent.Enabled）。 */
  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(value: boolean) {
    if (value === this.#enabled) return;
    this.#enabled = value;
    this.onEnabledChanged();
  }

  /** enabled 改了以后调用；比如约束组件用它开关约束。 */
  protected onEnabledChanged(): void {}
  /** @internal 启动过（EntityManager 在第一次 update 之前设）；没启动就移除的脚本不调 cancel，同 Stride。 */
  [STARTED] = false;
  /** @internal 有 .stat() 属性的脚本由管理器设置。 */
  statTable: Readonly<Record<string, Stat>> = {};

  /** 脚本移除或游戏退出时中止；脚本 await 的东西都把它传进去。 */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get attached(): boolean {
    return !this.#abort.signal.aborted;
  }

  /** 标了 .stat() 的属性的修饰：`this.stats.maxRunSpeed.multiply(0.5)`。 */
  get stats(): object {
    return this.statTable;
  }

  /** 处理一个钩子，直到脚本被移除。 */
  protected on<T>(hook: Hook<T>, handler: HookHandler<T>): void {
    this.disposables.use(hook.on(handler));
  }

  /** 事件键的接收器，脚本移除时释放。 */
  protected receive<T>(key: EventKey<T>): EventReceiver<T> {
    return this.disposables.use(key.receiver());
  }

  /**
   * 后台任务（Stride 的 Script.AddTask）：不用 await 它。任务里的 nextFrame()、delay() 在脚本移除后以中止原因拒绝，任务就此结束，
   * 不算错误（同 AsyncScript.execute）；别的错误交给 entities.onError。
   */
  protected addTask(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      if (this.signal.aborted && error === this.signal.reason) return;
      this.entity.manager.onError(error);
    });
  }

  /**
   * 在当前帧末尾兑现，所以它后面的代码在下一帧的脚本和系统之前运行（Stride 的 Script.NextFrame，所有脚本都能用）。
   * 这和 Stride 不同（Stride 在下一帧的脚本阶段里继续）：Promise 的后续代码没法插进同步执行的一帧中间。脚本移除后以
   * AbortError 拒绝。
   */
  nextFrame(): Promise<void> {
    return this.entity.manager.waitFor(this, () => true);
  }

  /** 在游戏时间过了 `seconds` 秒之后的第一个帧末尾兑现（TopDownRPG 的 WaitTime）。脚本移除后以 AbortError 拒绝。 */
  delay(seconds: number): Promise<void> {
    const until = this.game.updateTime.total + seconds;
    return this.entity.manager.waitFor(this, (time) => time.total >= until);
  }

  /** 移除后调用：这时 signal 已中止、disposables 已释放。还没启动就移除的脚本不调（同 Stride 的 ScriptSystem.Remove）。 */
  cancel(): void {}

  static props<B extends ScriptConstructor, S extends Shape, V extends string = never>(this: B, shape: S, options?: ScriptOptions<S, V>): WithProps<B, S, V>;
  static props<B extends ScriptConstructor, S extends Shape, V extends string = never>(this: B, name: string, shape: S, options?: ScriptOptions<S, V>): WithProps<B, S, V>;
  static props(this: ScriptConstructor, a: string | Shape, b?: Shape | ScriptOptions<Shape, string>, c?: ScriptOptions<Shape, string>): unknown {
    const [name, shape, options] = typeof a === 'string' ? [a, (b as Shape) ?? {}, c] : [undefined, a, b as ScriptOptions<Shape, string> | undefined];
    const base = this as unknown as abstract new () => ScriptComponent;
    abstract class Props extends base {}
    // 基类也是 props() 建的时候，它的属性一起放进这一层的 schema
    const merged = { ...((this as { [PROPS_SHAPE]?: Shape })[PROPS_SHAPE] ?? {}), ...shape };
    const schema = createSchema(merged, 'number', RESERVED, name ?? `${this.name} props`);
    Object.defineProperty(Props, PROPS_SHAPE, { value: merged });
    Object.defineProperty(Props, 'schema', { value: schema });
    Object.defineProperty(Props, 'variants', { value: checkVariants(schema, options?.variants ?? {}) });
    Object.defineProperty(Props, 'scriptName', { value: name, writable: true });
    return Props;
  }

  /** 带上属性值的这个脚本，给 entities.create 或 entity.add 用。 */
  static with<C extends ScriptConstructor>(this: C, init: InitOf<ShapeOfScript<C>, 'script'>): ScriptInit<C> {
    return { script: this, init };
  }

  /** 先取变体的值，再叠加 init。 */
  static variant<C extends ScriptConstructor>(this: C, name: VariantsOfScript<C>, init: Partial<InitOf<ShapeOfScript<C>, 'script'>> = {}): ScriptInit<C> {
    return { script: this, init: { ...variantValues(this.variants, name, scriptName(this)), ...init } };
  }

  /** @internal 脚本被移除时由管理器调用。 */
  detach(): void {
    if (!this.attached) return;
    this.#abort.abort(new DOMException(`script ${scriptName(this.constructor as ScriptConstructor)} was removed`, 'AbortError'));
    try {
      this.disposables.dispose();
    } finally {
      if (this[STARTED]) this.cancel();
    }
  }
}

/** 有 start()，在第一帧之前调用一次（对应 Stride 的 StartupScript）。 */
export abstract class StartupScript extends ScriptComponent {
  start(): void {}
}

/** start() 一次，之后启用期间每帧 update()（对应 Stride 的 SyncScript）。 */
export abstract class SyncScript extends StartupScript {
  update(_time: GameTime): void {}
}

/** execute() 运行一次，用 nextFrame() 或 delay() 把工作分摊到多帧（对应 Stride 的 AsyncScript）。 */
export abstract class AsyncScript extends ScriptComponent {
  async execute(): Promise<void> {}
}

export function scriptName(script: ScriptConstructor): string {
  return script.scriptName ?? script.name;
}

export function isScriptClass(value: unknown): value is ScriptConstructor {
  return typeof value === 'function' && value.prototype instanceof ScriptComponent;
}

/** 作用域默认值能给这个脚本类设的属性。 */
export type ScriptInherited<C> = InheritedOf<ShapeOfScript<C>, 'script'>;
