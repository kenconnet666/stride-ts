/**
 * 数据表面板（照虚幻的 DataTable 编辑器）：属性面板里开着数据表（`.table.json`）时下面一栏是表格——第一列 id，后面每列一个表的列。
 * 双击、Enter 或直接打字改一格（数字列是数字框，枚举、开关是下拉，颜色、向量写成 JSON 数组），Tab 到下一格；改的值按列检查
 * （和加载时同一套，content/formats/tableFormat.ts 的 tableValueProblem），不对的标红、不写进去。工具条加一行、删掉勾选的行；
 * 拖行首的把手改顺序。列在属性面板里加删改。每次修改经 session.editInspected 存（稍等一下存），游戏里读它的地方热重载。
 */
import { Plus, Trash2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, DataTable, Empty, Flex, Select, Text, Toolbar, type CellEditorContext, type DataTableColumn } from '@zerodep-dev/vue-tsx-pro-ui';
import { tableValueProblem, type TableColumn, type TableFile } from '@stride-ts/engine/content-format';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

type Row = Readonly<Record<string, unknown>> & { readonly id: string };

const styles = css.create({
  panel: { height: '100%', minHeight: '0', fontSize: '0.75rem' },
  table: { flex: '1', minHeight: '0', maxHeight: 'none' },
});

/** 值写成文字：空的是空字符串，数组、对象是 JSON。 */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean);
}

/** 格子里的值：没写的列是列的默认值；数组（颜色、向量）写成 JSON。 */
function shown(column: TableColumn, row: Row): string | number | boolean | null {
  const value = row[column.name] ?? column.default ?? null;
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : (value as string | number | boolean | null);
}

/** 编辑器交上来的值（文字框给的是字符串）换成这一列的类型；换不了时原样，交给 tableValueProblem 报。 */
function coerce(column: TableColumn, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  switch (column.type) {
    case 'number':
    case 'integer':
      return value.trim() === '' ? value : Number(value);
    case 'bool':
      return value === 'true' ? true : value === 'false' ? false : value;
    case 'color':
    case 'vector':
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    case 'asset':
      return value.trim() === '' ? null : value;
    default:
      return value;
  }
}

/** 下拉选的编辑器（枚举、开关）。 */
const choiceEditor = (values: readonly string[]) => (context: CellEditorContext<Row>) => (
  <Select size="sm" aria-label={t.tableCell} items={values.map((value) => ({ value, label: value }))}
    _value={context.value === undefined || context.value === null ? null : text(context.value)}
    onUpdate:_value={(value: string | null) => {
      context.onChange(value);
      context.commit();
    }} />
);

export const TablePanel = _component(({ session }: { session: EditorSession }) => {
  let selected = _state<string[]>([]);
  const table = (): TableFile | undefined => {
    const inspected = session.inspected.value;
    return inspected?.kind === 'table' ? (inspected.content as unknown as TableFile) : undefined;
  };
  const rows = (): readonly Row[] => (table()?.rows ?? []) as readonly Row[];

  const setCell = (row: Row, key: string, value: unknown) => {
    const index = rows().indexOf(row);
    if (index < 0) return;
    session.editInspected(['rows', index], { ...row, [key]: value });
  };

  /** 新的一行：id 按序号不重复，各列先空着（用列的默认值）。 */
  const addRow = () => {
    const ids = new Set(rows().map((row) => row.id));
    let n = rows().length + 1;
    while (ids.has(`row${n}`)) n++;
    session.editInspected(['rows'], [...rows(), { id: `row${n}` }]);
  };
  const deleteSelected = () => {
    const gone = new Set(selected);
    session.editInspected(['rows'], rows().filter((row) => !gone.has(row.id)));
    selected = [];
  };

  const columns = (file: TableFile): DataTableColumn<Row>[] => [
    {
      key: 'id', header: 'id', width: 140, editable: true, sortable: true,
      validate: (value, row) => {
        const id = text(value).trim();
        if (id === '') return t.tableIdEmpty;
        return rows().some((other) => other !== row && other.id === id) ? t.tableIdTaken(id) : undefined;
      },
    },
    ...(file.columns as readonly TableColumn[]).map((column): DataTableColumn<Row> => ({
      key: column.name,
      header: column.type === 'number' && column.unit ? `${column.name} (${column.unit})` : column.name,
      value: (row) => { const value = shown(column, row); return typeof value === 'boolean' ? String(value) : value; },
      cell: (row) => text(shown(column, row)),
      type: column.type === 'number' || column.type === 'integer' ? 'number' : 'text',
      editable: true,
      sortable: true,
      ...(column.type === 'enum' ? { editor: choiceEditor(column.values) } : column.type === 'bool' ? { editor: choiceEditor(['true', 'false']) } : {}),
      validate: (value) => tableValueProblem(column, coerce(column, value)),
    })),
  ];

  return () => {
    const file = table();
    if (!file) return <Empty size="sm" icon={false} description={t.tableNone} />;
    return (
      <Flex direction="column" sx={styles.panel}>
        <Toolbar aria-label={t.tableToolbar}>
          <Button size="sm" variant="soft" tone="neutral" icon={Plus} onClick={addRow}>{t.tableAddRow}</Button>
          <Button size="sm" variant="ghost" tone="neutral" icon={Trash2} disabled={selected.length === 0} onClick={deleteSelected}>{t.tableDeleteRows(selected.length)}</Button>
          <Text tone="muted">{t.tableCount(rows().length, file.columns.length)}</Text>
        </Toolbar>
        {file.columns.length === 0 ? <Empty size="sm" icon={false} description={t.tableNoColumns} /> : (
          <DataTable
            rows={rows()}
            columns={columns(file)}
            getKey={(row: Row) => row.id}
            selectionMode="multiple"
            _selected={selected}
            aria-label={file.name}
            onCellChange={(row: Row, key: string, value: unknown) => {
              const column = (file.columns as readonly TableColumn[]).find((c) => c.name === key);
              setCell(row, key, column ? coerce(column, value) : text(value).trim());
            }}
            onReorder={(next: Row[]) => session.editInspected(['rows'], next)}
            propsRoot={{ sx: styles.table }}
          />
        )}
      </Flex>
    );
  };
});
