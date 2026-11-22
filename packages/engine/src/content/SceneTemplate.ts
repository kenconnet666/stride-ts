/**
 * 当模板用的场景（Stride 里脚本属性引用的 Scene 资源：加载了、不放进游戏，脚本从里面 Clone 实体；SpaceEscape 的 LevelBlocks）：
 * ContentManager.loadSceneTemplate 加载场景文件和它引用的资源，不建实体。`prefab(名字)` 是那个实体连同子实体，实例化一次等于
 * 克隆一次没改过的模板实体（Stride 的 Entity.Clone）；`scriptProps` 读模板上脚本的属性。
 *
 *   const blocks = await game.content.loadSceneTemplate('SpaceEscape/Shared/LevelBlocks');
 *   const [block] = blocks.prefab('Background_a00').instantiate(game.entities);
 */
import type { SceneEntityFile, SceneScriptValue } from './formats/format';
import { Prefab } from './Prefab';

export class SceneTemplate {
  readonly path: string;
  readonly #files: readonly SceneEntityFile[];
  readonly #instantiate: (files: readonly SceneEntityFile[], name: string) => Prefab;
  readonly #prefabs = new Map<string, Prefab>();

  /** @internal ContentManager 建：instantiate 把一组实体文件（父实体在前）做成预制体。 */
  constructor(path: string, files: readonly SceneEntityFile[], instantiate: (files: readonly SceneEntityFile[], name: string) => Prefab) {
    this.path = path;
    this.#files = files;
    this.#instantiate = instantiate;
  }

  /** 场景里实体的名字（按文件里的顺序）。 */
  get entityNames(): readonly string[] {
    return this.#files.map((file) => file.name);
  }

  /** 名字是 name 的实体（第一个）连同它的子实体做成的预制体，根实体是它；同一个名字只建一次。 */
  prefab(name: string): Prefab {
    let prefab = this.#prefabs.get(name);
    if (!prefab) {
      const root = this.#file(name);
      const inSubtree = new Set([root.id]);
      // 文件里父实体在子实体前面，一遍就能收齐
      const files = this.#files.filter((file) => file === root || (file.parent !== null && inSubtree.has(file.parent) && inSubtree.add(file.id)));
      prefab = this.#instantiate(files, `${this.path}#${name}`);
      this.#prefabs.set(name, prefab);
    }
    return prefab;
  }

  /**
   * 实体 name 上类型是 type（Stride 的类型名，可以只写类名）的脚本的属性，键名首字母小写；对实体的引用换成实体的名字
   * （模板里的实体不建出来，用名字去 prefab）。没有这个脚本时是 undefined。
   */
  scriptProps(name: string, type: string): Readonly<Record<string, unknown>> | undefined {
    const script = this.#file(name).components.scripts?.find((s) => s.type === type || s.type.endsWith(`.${type}`));
    return script && (this.#withNames(script.props) as Readonly<Record<string, unknown>>);
  }

  #withNames(value: SceneScriptValue): unknown {
    if (Array.isArray(value)) return value.map((item: SceneScriptValue) => this.#withNames(item));
    if (typeof value !== 'object' || value === null) return value;
    const object = value as Readonly<Record<string, SceneScriptValue>>;
    if (typeof object['$entity'] === 'string') return this.#files.find((file) => file.id === object['$entity'])?.name ?? null;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, this.#withNames(item)]));
  }

  #file(name: string): SceneEntityFile {
    const file = this.#files.find((f) => f.name === name);
    if (!file) throw new Error(`scene template ${this.path} has no entity named '${name}'`);
    return file;
  }
}
