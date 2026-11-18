/**
 * 按导出它们的模块给组件、脚本、系统起名：`gameplay/health#Health`。
 * 游戏传入 `import.meta.glob('./**\/*.ts', { eager: true })` 的结果（Vite 自带的功能，正式构建里键名
 * 仍是源文件路径）；场景文件、热重载、编辑器都按这些名字引用。引擎和库的组件显式给名字，登记时保留。
 */
import { ComponentType } from './component';
import { isScriptClass, scriptName, type ScriptConstructor } from './scripts';
import { System } from './system';

export type Registered = ComponentType<any> | System<any> | ScriptConstructor;

export class Registry {
  readonly #byName = new Map<string, Registered>();

  /** 登记这些模块导出的所有组件、脚本、系统。modules：路径 → 模块命名空间对象。 */
  registerModules(modules: Readonly<Record<string, unknown>>): void {
    for (const [path, module] of Object.entries(modules)) {
      if (typeof module !== 'object' || module === null) continue;
      const base = modulePath(path);
      for (const [exportName, value] of Object.entries(module)) this.#register(value, `${base}#${exportName}`);
    }
  }

  /** 按显式的名字登记一个东西（引擎和库的组件）。 */
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
      // 自己的 scriptName 来自 props(name, ...) 或之前的登记；都没有就在这里起名
      if (!Object.hasOwn(value, 'scriptName') || value.scriptName === undefined) {
        Object.defineProperty(value, 'scriptName', { value: inheritedExplicitName(value) ?? derived });
      }
      this.#add(scriptName(value), value);
    }
  }

  #add(name: string, value: Registered): void {
    const existing = this.#byName.get(name);
    // 同一个东西从别的模块再导出，保留第一次的名字
    if (existing === value) return;
    if (existing) throw new Error(`two different things are named '${name}'`);
    this.#byName.set(name, value);
  }
}

/** './gameplay/health.ts' 和 '/src/gameplay/health.ts' 都变成 'gameplay/health'。 */
export function modulePath(path: string): string {
  return path.replace(/^\.?\//, '').replace(/^src\//, '').replace(/\.[cm]?[jt]sx?$/, '');
}

function nameOf(value: Registered): string | undefined {
  if (value instanceof ComponentType || value instanceof System) return value.isNamed ? value.name : undefined;
  return value.scriptName;
}

/**
 * props('Gameplay.Player', ...) 把显式的名字放在 props() 返回的中间类上；
 * 用户的类直接继承它，所以往上找一层就能找到名字。
 */
function inheritedExplicitName(script: ScriptConstructor): string | undefined {
  const parent = Object.getPrototypeOf(script) as ScriptConstructor;
  return Object.hasOwn(parent, 'scriptName') ? parent.scriptName : undefined;
}
