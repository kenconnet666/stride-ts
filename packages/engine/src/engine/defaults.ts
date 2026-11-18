/**
 * 作用域默认值：游戏统一设一次，对之后创建的组件或脚本实例都生效；只适用于标了 .inherit() 的属性
 * （调参和外观类，不是状态）：
 *
 *   game.defaults.set(RigidBody, { friction: 0.6 });
 *
 * 优先级在声明的默认值和创建时给的值之间（docs/architecture.md 的“属性的分层、合并和转发”）。
 * 按子树生效的默认值等实体层级做好之后再加。
 */
import type { DataShape, InheritedOf } from '../data/prop';
import type { ComponentType } from './component';
import { scriptName, type ScriptConstructor, type ScriptInherited } from './scripts';

type Owner = ComponentType<any, any> | ScriptConstructor;

export class ScopedDefaults {
  readonly #arrays = new Map<Owner, readonly unknown[]>();

  set<S extends DataShape>(type: ComponentType<S, any>, values: InheritedOf<S, 'data'>): void;
  set<C extends ScriptConstructor>(type: C, values: ScriptInherited<C>): void;
  set(type: Owner, values: object): void {
    const schema = type.schema;
    const owner = typeof type === 'function' ? scriptName(type) : type.name;
    const defaults = [...(this.#arrays.get(type) ?? schema.defaults)];
    for (const [key, value] of Object.entries(values)) {
      const index = schema.fields.findIndex((f) => f.name === key);
      const field = schema.fields[index];
      if (!field) throw new Error(`${owner}: '${key}' is not a property`);
      if (!field.options.inherit) throw new Error(`${owner}.${key} is not marked inherit(), so scoped defaults cannot set it`);
      const issue = schema.validate({ [key]: value }).find((i) => i.path[0] === key);
      if (issue) throw new RangeError(`${owner}.${key}: ${issue.message}`);
      defaults[index] = value;
    }
    this.#arrays.set(type, defaults);
  }

  /** 恢复成声明的默认值。 */
  reset(type: Owner): void {
    this.#arrays.delete(type);
  }

  /** @internal 创建实例时用的默认值。 */
  arrayFor(type: Owner): readonly unknown[] {
    return this.#arrays.get(type) ?? type.schema.defaults;
  }
}
