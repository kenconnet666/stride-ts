/**
 * Archetype storage: entities with the same set of data components share a table, and each field of each
 * component is one column (structure of arrays). Systems loop over a table's columns directly.
 * A table is one growable chunk for now: capacity doubles, columns are reallocated and the column sets
 * handed to systems are updated in place, so a chunk object never holds a stale array.
 */
import { createColumn, growColumn, type Column } from '../data/schema';
import type { ComponentType } from './component';

const INITIAL_CAPACITY = 64;

/** One component's columns in one table: `columns` in field order, `byName` for systems and views. */
export interface ColumnSet {
  readonly type: ComponentType;
  readonly columns: Column[];
  readonly byName: Record<string, Column>;
  /** Bumped when a system that declared `writes` on this component ran over the table. */
  version: number;
}

export class Table {
  /** Component types, sorted by id. */
  readonly types: readonly ComponentType[];
  readonly key: string;
  /** Column sets indexed by component type id; undefined for types the table does not have. */
  readonly sets: (ColumnSet | undefined)[] = [];
  /** Entity id of each row. */
  entities: Float64Array;
  count = 0;
  capacity: number;

  constructor(types: readonly ComponentType[]) {
    this.types = types;
    this.key = tableKey(types);
    this.capacity = INITIAL_CAPACITY;
    this.entities = new Float64Array(this.capacity);
    for (const type of types) {
      const columns = type.schema.fields.map((field) => createColumn(field.options.kind, this.capacity));
      this.sets[type.id] = { type, columns, byName: byName(type, columns), version: 0 };
    }
  }

  has(type: ComponentType): boolean {
    return this.sets[type.id] !== undefined;
  }

  /** Appends a row for the entity; the caller fills the columns. */
  addRow(entity: number): number {
    if (this.count === this.capacity) this.grow(this.capacity * 2);
    const row = this.count++;
    this.entities[row] = entity;
    return row;
  }

  /**
   * Removes a row by moving the last row into it. Returns the entity that moved into `row`, or -1 when
   * the removed row was the last one.
   */
  removeRow(row: number): number {
    const last = --this.count;
    for (const type of this.types) {
      for (const column of this.sets[type.id]!.columns) {
        const values = column as unknown[];
        if (row !== last) values[row] = values[last];
        // Plain arrays hold strings: drop the reference so the vacated slot does not keep it alive
        if (Array.isArray(column)) values[last] = undefined;
      }
    }
    if (row === last) return -1;
    const moved = this.entities[last]!;
    this.entities[row] = moved;
    return moved;
  }

  /** Copies the columns of every component both tables have, from another table's row into this one's. */
  copyShared(from: Table, fromRow: number, toRow: number): void {
    for (const type of this.types) {
      const source = from.sets[type.id];
      if (!source) continue;
      const target = this.sets[type.id]!.columns;
      for (let f = 0; f < target.length; f++) (target[f] as unknown[])[toRow] = (source.columns[f] as unknown[])[fromRow];
    }
  }

  private grow(capacity: number): void {
    const entities = new Float64Array(capacity);
    entities.set(this.entities);
    this.entities = entities;
    for (const type of this.types) {
      const set = this.sets[type.id]!;
      type.schema.fields.forEach((field, f) => {
        const grown = growColumn(set.columns[f]!, field.options.kind, capacity);
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
  type.schema.fields.forEach((field, f) => (named[field.name] = columns[f]!));
  return named;
}
