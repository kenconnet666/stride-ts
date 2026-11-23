/**
 * 数据表（`.table.json`，Stride 没有；照虚幻的 DataTable）：一张表的列（名字和类型）和按 id 排的行——物品、商品价格、NPC 的日程、
 * 车型参数这类"一样的字段、很多条"的数据。表自己带着列的描述，编辑器按它画表格、agent 按它写，加载时按列检查每一行。
 *
 * 列的类型：number（可带 min、max、unit）、integer、string、bool、enum（values 列出可选的）、asset（引用一种资源，编辑器移动、改名
 * 资源时改写）、color（线性 RGB）、vector（size 2～4）。行是对象：`id`（表里唯一）加各列的值；没写的列用列的 default，没有 default
 * 的列每行都要写。运行时见 content/DataTable.ts。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const TABLE_COLUMN = s.union('type', {
  number: { min: s.number().optional(), max: s.number().optional(), unit: s.string().optional() },
  integer: { min: s.integer().optional(), max: s.integer().optional() },
  string: {},
  bool: {},
  enum: { values: s.list(s.string()) },
  /** 引用一种资源（资源种类的名字：model、material、sound……），值是内容路径或 null。 */
  asset: { asset: s.string() },
  color: {},
  vector: { size: s.integer(2, 4) },
}, {
  name: s.string(),
  /** 行里没写这一列时的值；没有 default 的列每行都要写。 */
  default: s.json().optional(),
  description: s.string().optional(),
});

export const TABLE = s.object({
  name: s.string(),
  columns: s.list(TABLE_COLUMN).label('Table columns'),
  /** 每行：id 加各列的值。 */
  rows: s.list(s.record()).label('Table rows'),
});

export type TableFile = InputOf<typeof TABLE>;
export type TableColumn = Infer<typeof TABLE_COLUMN>;

/** 表的一行（检查过、补了默认值）。 */
export type TableRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** 检查数据表：列名不重复、不叫 id；每行有唯一的 id，各列的值合列的类型，没写的补 default。返回补好的行；不对时报错（where 开头）。 */
export function checkTable(input: unknown, where: string): { readonly name: string; readonly columns: readonly TableColumn[]; readonly rows: readonly TableRow[] } {
  const file = TABLE.parse(input, where);
  const names = new Set<string>();
  for (const column of file.columns) {
    if (column.name === 'id') throw new Error(`${where}: a column can't be called 'id' (every row has its own id)`);
    if (names.has(column.name)) throw new Error(`${where}: two columns are called '${column.name}'`);
    names.add(column.name);
  }
  const ids = new Set<string>();
  const rows = file.rows.map((row, i): TableRow => {
    const id = row['id'];
    const at = `${where}: row ${i}${typeof id === 'string' ? ` ('${id}')` : ''}`;
    if (typeof id !== 'string' || id === '') throw new Error(`${at}: needs a string id`);
    if (ids.has(id)) throw new Error(`${at}: the id '${id}' is used twice`);
    ids.add(id);
    for (const key of Object.keys(row)) if (key !== 'id' && !names.has(key)) throw new Error(`${at}: no column '${key}'`);
    const out: Record<string, unknown> = { id };
    for (const column of file.columns) {
      const value = row[column.name] ?? column.default;
      if (value === undefined) throw new Error(`${at}: '${column.name}' is missing and the column has no default`);
      const problem = tableValueProblem(column, value);
      if (problem) throw new Error(`${at}: '${column.name}' ${problem}`);
      out[column.name] = value;
    }
    return out as TableRow;
  });
  return { name: file.name, columns: file.columns, rows };
}

/** 值不合列的类型时说哪里不对（"should be a number, got …"），合适时是 undefined。编辑器的表格面板改格子时也用它。 */
export function tableValueProblem(column: TableColumn, value: unknown): string | undefined {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  switch (column.type) {
    case 'number':
    case 'integer':
      if (!isNumber || (column.type === 'integer' && !Number.isInteger(value))) return `should be ${column.type === 'integer' ? 'an integer' : 'a number'}, got ${JSON.stringify(value)}`;
      if (column.min !== undefined && value < column.min) return `is ${value}, below the minimum ${column.min}`;
      if (column.max !== undefined && value > column.max) return `is ${value}, above the maximum ${column.max}`;
      return undefined;
    case 'string':
      return typeof value === 'string' ? undefined : `should be a string, got ${JSON.stringify(value)}`;
    case 'bool':
      return typeof value === 'boolean' ? undefined : `should be true or false, got ${JSON.stringify(value)}`;
    case 'enum':
      return typeof value === 'string' && column.values.includes(value) ? undefined : `should be one of ${column.values.join(', ')}, got ${JSON.stringify(value)}`;
    case 'asset':
      return value === null || typeof value === 'string' ? undefined : `should be a content path or null, got ${JSON.stringify(value)}`;
    case 'color':
      return isNumberList(value, 3) ? undefined : `should be [r, g, b], got ${JSON.stringify(value)}`;
    case 'vector':
      return isNumberList(value, column.size) ? undefined : `should be ${column.size} numbers, got ${JSON.stringify(value)}`;
  }
}

const isNumberList = (value: unknown, size: number): boolean => Array.isArray(value) && value.length === size && value.every((n) => typeof n === 'number' && Number.isFinite(n));
