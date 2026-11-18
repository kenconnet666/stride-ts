/**
 * Scripts, shaped like Stride's: StartupScript (start), SyncScript (start + update every frame) and
 * AsyncScript (execute, awaiting nextFrame or delay). Properties are declared with props() and typed by
 * inference:
 *
 *   export class PlayerController extends SyncScript.props({
 *     maxRunSpeed: prop.number().min(0).default(10),
 *     jumpHeight: 1.2,
 *   }) {
 *     override update(time: GameTime): void { this.maxRunSpeed; }   // number
 *   }
 *
 * Everything a script registers through `this.disposables` is released when it is removed, together with
 * aborting `this.signal`.
 */
import type { InitOf, ScriptValues, Shape } from '../data/prop';
import { createSchema, type Schema } from '../data/schema';
import type { Game } from '../games/Game';
import type { GameTime } from '../games/GameTime';
import type { Entity } from './Entity';

/** Names a script's own members use; a property with one of them would shadow it. */
const RESERVED = new Set([
  'entity', 'game', 'enabled', 'signal', 'disposables', 'attached',
  'start', 'update', 'cancel', 'execute', 'nextFrame', 'delay', 'constructor',
]);

/** Any script class, abstract or not. */
export type ScriptConstructor<T extends ScriptComponent = ScriptComponent> = (abstract new () => T) & {
  readonly schema: Schema;
  readonly scriptName: string | undefined;
};

/** The shape a script class declared with props(); {} when it has none. */
export type ShapeOfScript<C> = C extends { readonly __shape: infer S extends Shape } ? S : {};

/** A script class plus the values to create it with: `PlayerController.with({ maxRunSpeed: 12 })`. */
export interface ScriptInit<C extends ScriptConstructor = ScriptConstructor> {
  readonly script: C;
  readonly init: object | undefined;
}

/** A script class whose properties all have defaults, so it can be listed as is. */
export type BareScript = ScriptConstructor & { readonly __bare: true };

/** The class props() returns: the base class with the declared properties on its instances. */
export type WithProps<B extends ScriptConstructor, S extends Shape> = (abstract new () => InstanceType<B> & ScriptValues<S>) &
  Omit<B, 'prototype' | '__shape' | '__bare'> & {
    readonly __shape: S;
    readonly __bare: {} extends InitOf<S, 'script'> ? true : false;
  };

export abstract class ScriptComponent {
  declare static readonly __shape: {};
  declare static readonly __bare: true;
  /** @internal The properties; props() gives each script class its own. */
  static schema: Schema = createSchema({}, 'number', RESERVED, 'script');
  /** @internal Given to props(), or `path#Export` once the game registered the module. */
  static scriptName: string | undefined;

  /** Set before start(); the script belongs to this entity until it is removed. */
  entity!: Entity;
  game!: Game;
  /** A disabled SyncScript is not updated; its state is kept. */
  enabled = true;
  /** Released when the script is removed or the game exits (event receivers, hooks, timers, assets). */
  protected readonly disposables = new DisposableStack();
  readonly #abort = new AbortController();

  /** Aborted when the script is removed or the game exits; pass it to anything the script awaits. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get attached(): boolean {
    return !this.#abort.signal.aborted;
  }

  /** Called after removal, once the signal is aborted and the disposables are released. */
  cancel(): void {}

  static props<B extends ScriptConstructor, S extends Shape>(this: B, shape: S): WithProps<B, S>;
  static props<B extends ScriptConstructor, S extends Shape>(this: B, name: string, shape: S): WithProps<B, S>;
  static props(this: ScriptConstructor, nameOrShape: string | Shape, maybeShape?: Shape): unknown {
    const [name, shape] = typeof nameOrShape === 'string' ? [nameOrShape, maybeShape ?? {}] : [undefined, nameOrShape];
    const base = this as unknown as abstract new () => ScriptComponent;
    abstract class Props extends base {}
    Object.defineProperty(Props, 'schema', { value: createSchema(shape, 'number', RESERVED, name ?? `${this.name} props`) });
    Object.defineProperty(Props, 'scriptName', { value: name, writable: true });
    return Props;
  }

  /** This script with property values, for entities.create or entity.add. */
  static with<C extends ScriptConstructor>(this: C, init: InitOf<ShapeOfScript<C>, 'script'>): ScriptInit<C> {
    return { script: this, init };
  }

  /** @internal Called by the manager when the script is removed. */
  detach(): void {
    if (!this.attached) return;
    this.#abort.abort(new DOMException(`script ${scriptName(this.constructor as ScriptConstructor)} was removed`, 'AbortError'));
    try {
      this.disposables.dispose();
    } finally {
      this.cancel();
    }
  }
}

/** Has start(), called once before its first frame (Stride's StartupScript). */
export abstract class StartupScript extends ScriptComponent {
  start(): void {}
}

/** start() once, then update() every frame while enabled (Stride's SyncScript). */
export abstract class SyncScript extends StartupScript {
  update(_time: GameTime): void {}
}

/** execute() runs once; it awaits nextFrame() or delay() to spread work over frames (Stride's AsyncScript). */
export abstract class AsyncScript extends ScriptComponent {
  async execute(): Promise<void> {}

  /**
   * Resolves at the end of the current frame, so the code after it runs before the next frame's scripts
   * and systems (unlike Stride, where it resumes inside the next frame's script phase: a promise
   * continuation cannot run in the middle of our synchronous frame). Rejects with an AbortError once the
   * script is removed.
   */
  nextFrame(): Promise<void> {
    return this.entity.manager.waitFor(this, () => true);
  }

  /** Resolves after the first frame on which `seconds` of game time have passed. */
  delay(seconds: number): Promise<void> {
    const until = this.game.updateTime.total + seconds;
    return this.entity.manager.waitFor(this, (time) => time.total >= until);
  }
}

export function scriptName(script: ScriptConstructor): string {
  return script.scriptName ?? script.name;
}

export function isScriptClass(value: unknown): value is ScriptConstructor {
  return typeof value === 'function' && value.prototype instanceof ScriptComponent;
}
