/**
 * 系统遍历期间记下的结构性改动（创建、销毁实体，加删组件会让行在表之间搬动）；管理器在每个系统跑完后执行。
 */
import type { EntityId } from '../data/prop';
import type { ComponentType } from './component';
import type { EntityArg, EntityDesc, EntityManager } from './EntityManager';

type Op =
  | { readonly kind: 'create'; readonly desc: EntityDesc }
  | { readonly kind: 'destroy'; readonly id: EntityId }
  | { readonly kind: 'add'; readonly id: EntityId; readonly arg: EntityArg }
  | { readonly kind: 'remove'; readonly id: EntityId; readonly type: ComponentType<any> };

export class Commands {
  #ops: Op[] = [];

  create(desc: EntityDesc): void {
    this.#ops.push({ kind: 'create', desc });
  }

  destroy(id: EntityId): void {
    this.#ops.push({ kind: 'destroy', id });
  }

  add(id: EntityId, arg: EntityArg): void {
    this.#ops.push({ kind: 'add', id, arg });
  }

  remove(id: EntityId, type: ComponentType<any>): void {
    this.#ops.push({ kind: 'remove', id, type });
  }

  /** @internal 按顺序执行并清空记下的改动；期间已被销毁的实体跳过。 */
  apply(manager: EntityManager): void {
    if (this.#ops.length === 0) return;
    const ops = this.#ops;
    this.#ops = [];
    for (const op of ops) {
      if (op.kind === 'create') {
        manager.create(op.desc);
        continue;
      }
      if (!manager.isAlive(op.id)) continue;
      if (op.kind === 'destroy') manager.destroy(op.id);
      else if (op.kind === 'add') manager.add(op.id, op.arg);
      else manager.remove(op.id, op.type);
    }
  }
}
