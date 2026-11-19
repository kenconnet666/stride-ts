/**
 * 按导出它们的模块给组件、脚本、系统起名：`gameplay/health#Health`。
 * 游戏传入 `import.meta.glob('./**\/*.ts', { eager: true })` 的结果（Vite 自带的功能，正式构建里键名
 * 仍是源文件路径）；场景文件、热重载、编辑器都按这些名字引用。引擎和库的组件显式给名字，登记时保留。
 */
import { ComponentType } from './component';
import { isShaderClass, type ShaderClass } from '../rendering/shaderClass';
import { isScriptClass, scriptName, type ScriptConstructor } from './scripts';
import { System } from './system';

export type Registered = ComponentType<any> | System<any> | ScriptConstructor;

/** 热重载时同一个名字换了新对象。 */
export interface HotChange {
  readonly name: string;
  readonly previous: Registered;
  readonly next: Registered;
}

/** 游戏的粒子模块类（继承 ParticleSpawner、ParticleInitializer、ParticleUpdater、ParticleShapeBuilder 的，基类上有 particleModuleKind）。 */
export interface ParticleModuleExport {
  readonly particleModuleKind: string;
  new (...args: never[]): object;
}

export class Registry {
  readonly #byName = new Map<string, Registered>();
  /** 粒子模块：导出名首字母小写（同场景文件里的 $type）→ 类。 */
  readonly #particleModules = new Map<string, ParticleModuleExport>();
  /** 着色器类：导出名（同 Stride 的 MixinReference）→ WGSL。 */
  readonly #shaderClasses = new Map<string, ShaderClass>();

  /**
   * 登记这些模块导出的所有组件、脚本、系统，和粒子模块、着色器类（按导出名，Stride 场景里的粒子模块、着色器类按类名找它）。
   * modules：路径 → 模块命名空间对象。
   */
  registerModules(modules: Readonly<Record<string, unknown>>): void {
    for (const [name, value] of this.#named(modules)) this.#add(name, value);
    this.#registerParticleModules(modules);
  }

  /**
   * 热重载：Vite 重新执行了改动的模块，同名的东西换成了新对象。新对象取代旧的登记，返回取代了哪些；
   * 没改的模块还是同一个对象，跳过；新出现的照常登记。
   */
  update(modules: Readonly<Record<string, unknown>>): HotChange[] {
    // 粒子模块换成新的类，之后建的粒子系统用它（已经建好的不换）
    this.#registerParticleModules(modules);
    const changes: HotChange[] = [];
    for (const [name, next] of this.#named(modules)) {
      const previous = this.#byName.get(name);
      this.#byName.set(name, next);
      if (previous === undefined || previous === next) continue;
      if (kindOf(previous) !== kindOf(next)) throw new Error(`hot update: '${name}' changed from a ${kindOf(previous)} to a ${kindOf(next)}; reload the page`);
      changes.push({ name, previous, next });
    }
    return changes;
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

  /** 粒子模块类，type 是类名（首字母大小写都行）。 */
  particleModule(type: string): ParticleModuleExport | undefined {
    return this.#particleModules.get(type.charAt(0).toLowerCase() + type.slice(1));
  }

  /** 着色器类（名字区分大小写，同 Stride）。 */
  shaderClass(name: string): ShaderClass | undefined {
    return this.#shaderClasses.get(name);
  }

  #registerParticleModules(modules: Readonly<Record<string, unknown>>): void {
    for (const module of Object.values(modules)) {
      if (typeof module !== 'object' || module === null) continue;
      for (const [exportName, value] of Object.entries(module)) {
        if (isShaderClass(value)) this.#shaderClasses.set(exportName, value);
        if (typeof value !== 'function' || typeof (value as Partial<ParticleModuleExport>).particleModuleKind !== 'string') continue;
        this.#particleModules.set(exportName.charAt(0).toLowerCase() + exportName.slice(1), value as ParticleModuleExport);
      }
    }
  }

  /** 名字是 name、或 `路径#name` 的脚本（Stride 场景里的脚本按类名找翻译过来的 TS 脚本）。 */
  scriptsNamed(name: string): ScriptConstructor[] {
    const found: ScriptConstructor[] = [];
    for (const [registered, value] of this.#byName) {
      if (kindOf(value) === 'script' && (registered === name || registered.endsWith(`#${name}`))) found.push(value as ScriptConstructor);
    }
    return found;
  }

  /** 模块导出的组件、脚本、系统和它们的名字；还没名字的按 `路径#导出名` 起名。 */
  *#named(modules: Readonly<Record<string, unknown>>): Generator<[string, Registered]> {
    for (const [path, module] of Object.entries(modules)) {
      if (typeof module !== 'object' || module === null) continue;
      const base = modulePath(path);
      for (const [exportName, value] of Object.entries(module)) {
        const derived = `${base}#${exportName}`;
        if (value instanceof ComponentType || value instanceof System) {
          if (!value.isNamed) value.setName(derived);
          yield [value.name, value];
        } else if (isScriptClass(value)) {
          // 自己的 scriptName 来自 props(name, ...) 或之前的登记；都没有就在这里起名
          if (!Object.hasOwn(value, 'scriptName') || value.scriptName === undefined) {
            Object.defineProperty(value, 'scriptName', { value: inheritedExplicitName(value) ?? derived });
          }
          yield [scriptName(value), value];
        }
      }
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

function kindOf(value: Registered): 'component' | 'system' | 'script' {
  return value instanceof ComponentType ? 'component' : value instanceof System ? 'system' : 'script';
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
