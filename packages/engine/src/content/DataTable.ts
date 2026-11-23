/**
 * 加载好的数据表（`.table.json`，格式见 content/formats/tableFormat.ts）：`game.content.loadTable('Data/Items')`，或者脚本属性
 * `prop.asset('table')`。
 *
 *   const items = await this.game.content.loadTable('Data/Items');
 *   const apple = items.require('apple');  // { id: 'apple', price: 3, … }
 *
 * 行的类型默认是 TableRow（值是 unknown）；代码里有行的模式时 `table.as(ITEM)` 按它再检查一遍，拿到有类型的行（字段写错了这时报出来）。
 */
import type { Schema } from './schema/schema';
import type { TableColumn, TableRow } from './formats/tableFormat';

export class DataTable<Row extends { readonly id: string } = TableRow> {
  readonly path: string;
  readonly name: string;
  readonly columns: readonly TableColumn[];
  /** 行，文件里的顺序。 */
  readonly rows: readonly Row[];
  readonly #byId: ReadonlyMap<string, Row>;

  constructor(path: string, name: string, columns: readonly TableColumn[], rows: readonly Row[]) {
    this.path = path;
    this.name = name;
    this.columns = columns;
    this.rows = rows;
    this.#byId = new Map(rows.map((row) => [row.id, row]));
  }

  /** 这个 id 的行；没有时是 undefined。 */
  get(id: string): Row | undefined {
    return this.#byId.get(id);
  }

  /** 这个 id 的行；没有时报错（说是哪张表）。 */
  require(id: string): Row {
    const row = this.#byId.get(id);
    if (!row) throw new Error(`table ${this.path}: no row '${id}'`);
    return row;
  }

  /** 按代码里的行模式（`s.object({ id: s.string(), price: s.number(), … })`）检查每一行，返回有类型的表。 */
  as<R extends { readonly id: string }>(row: Schema<R, unknown>): DataTable<R> {
    return new DataTable(this.path, this.name, this.columns, this.rows.map((value, i) => row.parse(value, `table ${this.path} row ${i} ('${value.id}')`)));
  }
}
