/**
 * 按 archetype 存储：数据组件组合相同的实体共用一张表，每个组件的每个字段是一列（结构数组）。系统直接
 * 遍历表的列。目前一张表就是一块可增长的存储：容量翻倍时重新分配列，交给系统的列集合原地更新，
 * 所以 chunk 对象不会拿着过期的数组。
 */
import { copyRow, createColumn, growColumn, type Column } from '../data/schema';
import type { ComponentType } from './component';

const INITIAL_CAPACITY = 64;

/** 一个组件在一张表里的列：`columns` 按字段顺序，`byName` 给系统和视图用。 */
export interface ColumnSet {
  readonly type: ComponentType;
  readonly columns: Column[];
  readonly byName: Record<string, Column>;
  /** 声明了 `writes` 这个组件的系统跑过这张表、或有其他写入时递增。 */
  version: number;
}

export class Table {
  /** 组件类型，按编号排序。 */
  readonly types: readonly ComponentType[];
  readonly key: string;
  /** 按组件类型编号索引的列集合；表里没有的类型是 undefined。 */
  readonly sets: (ColumnSet | undefined)[] = [];
  /** 每一行的实体 id。 */
  entities: Float64Array;
  count = 0;
  capacity: number;

  constructor(types: readonly ComponentType[]) {
    this.types = types;
    this.key = tableKey(types);
    this.capacity = INITIAL_CAPACITY;
    this.entities = new Float64Array(this.capacity);
    for (const type of types) {
      const columns = type.tableFields.map((field) => createColumn(field, this.capacity));
      this.sets[type.id] = { type, columns, byName: byName(type, columns), version: 0 };
    }
  }

  has(type: ComponentType): boolean {
    return this.sets[type.id] !== undefined;
  }

  /** 给实体追加一行；由调用方填列。 */
  addRow(entity: number): number {
    if (this.count === this.capacity) this.grow(this.capacity * 2);
    const row = this.count++;
    this.entities[row] = entity;
    return row;
  }

  /**
   * 删除一行：把最后一行搬到这里。返回搬进 `row` 的实体；删的就是最后一行时返回 -1。
   */
  removeRow(row: number): number {
    const last = --this.count;
    for (const type of this.types) {
      const { columns } = this.sets[type.id]!;
      type.tableFields.forEach((field, f) => {
        const column = columns[f]!;
        if (row !== last) copyRow(column, last, column, row, field.stride);
        // 普通数组里放的是字符串：清掉空出来的位置，免得它一直引用着旧值
        if (Array.isArray(column)) column[last] = undefined;
      });
    }
    if (row === last) return -1;
    const moved = this.entities[last]!;
    this.entities[row] = moved;
    return moved;
  }

  /** 把两张表都有的组件的列，从另一张表的一行复制到这张表的一行。 */
  copyShared(from: Table, fromRow: number, toRow: number): void {
    for (const type of this.types) {
      const source = from.sets[type.id];
      if (!source) continue;
      const target = this.sets[type.id]!.columns;
      type.tableFields.forEach((field, f) => copyRow(source.columns[f]!, fromRow, target[f]!, toRow, field.stride));
    }
  }

  private grow(capacity: number): void {
    const entities = new Float64Array(capacity);
    entities.set(this.entities);
    this.entities = entities;
    for (const type of this.types) {
      const set = this.sets[type.id]!;
      type.tableFields.forEach((field, f) => {
        const grown = growColumn(set.columns[f]!, field, capacity);
        set.columns[f] = grown;
        set.byName[field.name] = grown;
      });
    }
    this.capacity = capacity;
  }
}

export function tableKey(types: readonly ComponentType[]): string {
  return types.map((type) => type.id).join(',');
}

function byName(type: ComponentType, columns: readonly Column[]): Record<string, Column> {
  const named: Record<string, Column> = {};
  type.tableFields.forEach((field, f) => (named[field.name] = columns[f]!));
  return named;
}
