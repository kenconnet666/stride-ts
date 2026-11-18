/**
 * Names components, scripts and systems after the module that exports them: `gameplay/health#Health`.
 * The game passes `import.meta.glob('./**\/*.ts', { eager: true })` (a Vite feature: keys stay source paths
 * in production builds); scene files, hot reload and the editor refer to things by these names.
 * Engine and library components pass an explicit name instead, which is kept.
 */
import { ComponentType } from './component';
import { isScriptClass, scriptName, type ScriptConstructor } from './scripts';
import { System } from './system';

export type Registered = ComponentType<any> | System<any> | ScriptConstructor;

export class Registry {
  readonly #byName = new Map<string, Registered>();

  /** Registers every component, script and system the modules export. modules: path → module namespace. */
  registerModules(modules: Readonly<Record<string, unknown>>): void {
    for (const [path, module] of Object.entries(modules)) {
      if (typeof module !== 'object' || module === null) continue;
      const base = modulePath(path);
      for (const [exportName, value] of Object.entries(module)) this.#register(value, `${base}#${exportName}`);
    }
  }

  /** Registers one thing under its explicit name (engine and library components). */
  register(value: Registered): void {
    const name = nameOf(value);
    if (name === undefined) throw new Error('register() needs a named component, script or system; game code is named by registerModules');
    this.#add(name, value);
  }

  get(name: string): Registered | undefined {
    return this.#byName.get(name);
  }

  get names(): IterableIterator<string> {
    return this.#byName.keys();
  }

  #register(value: unknown, derived: string): void {
    if (value instanceof ComponentType || value instanceof System) {
      if (!value.isNamed) value.setName(derived);
      this.#add(value.name, value);
    } else if (isScriptClass(value)) {
      // An own scriptName is set by props(name, ...) or an earlier registration; otherwise name it here
      if (!Object.hasOwn(value, 'scriptName') || value.scriptName === undefined) {
        Object.defineProperty(value, 'scriptName', { value: inheritedExplicitName(value) ?? derived });
      }
      this.#add(scriptName(value), value);
    }
  }

  #add(name: string, value: Registered): void {
    const existing = this.#byName.get(name);
    // The same thing re-exported from another module keeps its first name
    if (existing === value) return;
    if (existing) throw new Error(`two different things are named '${name}'`);
    this.#byName.set(name, value);
  }
}

/** './gameplay/health.ts' and '/src/gameplay/health.ts' both become 'gameplay/health'. */
export function modulePath(path: string): string {
  return path.replace(/^\.?\//, '').replace(/^src\//, '').replace(/\.[cm]?[jt]sx?$/, '');
}

function nameOf(value: Registered): string | undefined {
  if (value instanceof ComponentType || value instanceof System) return value.isNamed ? value.name : undefined;
  return value.scriptName;
}

/**
 * props('Gameplay.Player', ...) puts the explicit name on the intermediate class that props() returns;
 * the user's class extends it directly, so the name is found one step up.
 */
function inheritedExplicitName(script: ScriptConstructor): string | undefined {
  const parent = Object.getPrototypeOf(script) as ScriptConstructor;
  return Object.hasOwn(parent, 'scriptName') ? parent.scriptName : undefined;
}
