import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { NumberField, Switch, TextField } from '@zerodep-dev/vue-tsx-pro-ui';
import type { Field, FieldType } from '@stride-ts/engine/editor-fields';
import { colorToHex, emptyValue, eulerToQuaternion, hexToColor, quaternionToEuler } from './values';

/** 文件里一个值的路径（相对 FieldEditor 拿到的值）。 */
export type ValuePath = readonly (string | number)[];

/** 资源字段的输入框提示的资源列表（`<datalist>`）的 id：每种资源一个，属性面板画。 */
export const assetListId = (kind: string): string => `stride-assets-${kind}`;

/** 字段编辑器要的场景信息：选实体的下拉框列出哪些实体。 */
export interface FieldContext {
  readonly entities: readonly { readonly id: string; readonly name: string }[];
}

export interface FieldEditorProps {
  type: FieldType;
  value: unknown;
  context: FieldContext;
  /** 把 path 上的值设成 value（undefined 是删掉这个键）。 */
  onSet: (path: ValuePath, value: unknown) => void;
}

const styles = css.create({
  row: { display: 'grid', gridTemplateColumns: 'minmax(6em, 35%) 1fr', alignItems: 'center', gap: '_xs', minHeight: '1.9em' },
  label: { color: '_textMuted', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  unset: { opacity: '0.6' },
  vector: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(3.5em, 1fr))', gap: '2px' },
  nested: { display: 'flex', flexDirection: 'column', gap: '2px', paddingInlineStart: '_sm', borderInlineStartWidth: '1px', borderInlineStartStyle: 'solid', borderInlineStartColor: '_border' },
  item: { display: 'flex', gap: '_xs', alignItems: 'center' },
  json: { width: '100%', minHeight: '4em', fontFamily: 'monospace', fontSize: '0.85em' },
  select: { width: '100%' },
  color: { display: 'flex', gap: '_xs', alignItems: 'center' },
});

/** 数不分千位（2000 不写成 2,000），小数留到六位：引擎的值不是金额。 */
const NUMBER_FORMAT = { useGrouping: false, maximumFractionDigits: 6 } as const;

/** 一行：名字加它的编辑器。文件里没写（可选、用默认值）的名字淡一点。 */
export const FieldRow = _component(({ field, value, context, onSet }: { field: Field; value: unknown; context: FieldContext; onSet: FieldEditorProps['onSet'] }) => {
  return () => {
    const missing = value === undefined;
    const shown = missing ? field.default : value;
    return (
      <div {...css.attrs(styles.row)}>
        <span {...css.attrs(styles.label, missing && styles.unset)} title={field.description ?? field.name}>{field.label ?? field.name}</span>
        {field.nullable && shown === null ? (
          <button type="button" onClick={() => onSet([], emptyValue(field.type))}>设置</button>
        ) : (
          <FieldEditor type={field.type} value={shown} context={context} onSet={onSet} />
        )}
      </div>
    );
  };
});

/** 按字段的类型画编辑器（场景文件里一个值），改了调 onSet。 */
export const FieldEditor = _component(({ type, value, context, onSet }: FieldEditorProps) => {
  // 向量、旋转这种几个数排一行的不要加减按钮，放不下
  const number = (current: unknown, set: (next: number) => void, options: { min?: number; max?: number; step?: number; compact?: boolean } = {}) => (
    <NumberField
      stepper={!options.compact}
      format={NUMBER_FORMAT}
      _value={typeof current === 'number' ? current : null}
      {...(options.min !== undefined ? { min: options.min } : {})}
      {...(options.max !== undefined ? { max: options.max } : {})}
      step={options.step ?? 0.1}
      onUpdate:_value={(next: number | null) => next !== null && set(next)}
    />
  );

  return () => {
    switch (type.kind) {
      case 'number':
        return number(value, (next) => onSet([], type.integer ? Math.round(next) : next), { ...type, step: type.step ?? (type.integer ? 1 : 0.1) });
      case 'bool':
        return <Switch _checked={value === true} onUpdate:_checked={(next: boolean) => onSet([], next)} />;
      case 'string':
        return <TextField _value={typeof value === 'string' ? value : ''} onUpdate:_value={(next: string) => onSet([], next)} />;
      case 'enum':
        return (
          <select {...css.attrs(styles.select)} value={String(value)} onChange={(event: Event) => onSet([], (event.target as HTMLSelectElement).value)}>
            {type.values.map((option) => <option value={option}>{option}</option>)}
          </select>
        );
      case 'vector': {
        const items = Array.isArray(value) ? (value as number[]) : [];
        return (
          <div {...css.attrs(styles.vector)}>
            {Array.from({ length: type.size }, (_, i) => number(items[i], (next) => onSet([i], next), { step: 0.1, compact: true }))}
          </div>
        );
      }
      case 'rotation': {
        const euler = quaternionToEuler(Array.isArray(value) ? (value as number[]) : [0, 0, 0, 1]);
        return (
          <div {...css.attrs(styles.vector)} title="角度（度），先绕 Z、再绕 X、再绕 Y（同 Stride）">
            {euler.map((angle, i) => number(angle, (next) => onSet([], eulerToQuaternion(euler.map((current, j) => (j === i ? next : current)))), { step: 1, compact: true }))}
          </div>
        );
      }
      case 'color': {
        const channels = Array.isArray(value) ? (value as number[]) : [0, 0, 0, 1];
        return (
          <div {...css.attrs(styles.color)}>
            <input type="color" value={colorToHex(channels, type.space)} onInput={(event: Event) => onSet([], hexToColor((event.target as HTMLInputElement).value, type.space, channels))} />
            {type.alpha && number(channels[3], (next) => onSet([3], next), { min: 0, max: 1, step: 0.01 })}
          </div>
        );
      }
      case 'asset': {
        // 输入时列出这一种的资源（属性面板里每种一个 datalist，见 assetListId）
        const path = type.form === 'ref' ? (value as { $asset?: string } | null)?.$asset : (value as string | null);
        return (
          <input
            {...css.attrs(styles.select)}
            list={assetListId(type.asset)}
            value={path ?? ''}
            placeholder={type.asset}
            onChange={(event: Event) => onSet(type.form === 'ref' ? ['$asset'] : [], (event.target as HTMLInputElement).value)}
          />
        );
      }
      case 'entity': {
        const id = type.form === 'ref' ? (value as { $entity?: string } | null)?.$entity : (value as string | null);
        return (
          <select
            {...css.attrs(styles.select)}
            value={id ?? ''}
            onChange={(event: Event) => {
              const next = (event.target as HTMLSelectElement).value || null;
              onSet([], type.form === 'ref' ? (next === null ? null : { $entity: next }) : next);
            }}
          >
            <option value="">（无）</option>
            {context.entities.map((entity) => <option value={entity.id}>{entity.name || entity.id}</option>)}
          </select>
        );
      }
      case 'list': {
        const items = Array.isArray(value) ? (value as unknown[]) : [];
        return (
          <div {...css.attrs(styles.nested)}>
            {items.map((item, i) => (
              <div {...css.attrs(styles.item)}>
                <span>{i}</span>
                {item === null && type.nullableItems ? <span>（默认）</span> : <FieldEditor type={type.item} value={item} context={context} onSet={(path: ValuePath, next: unknown) => onSet([i, ...path], next)} />}
              </div>
            ))}
            <div {...css.attrs(styles.item)}>
              <button type="button" onClick={() => onSet([items.length], emptyValue(type.item))}>添加</button>
              {items.length > 0 && <button type="button" onClick={() => onSet([items.length - 1], undefined)}>去掉最后一项</button>}
            </div>
          </div>
        );
      }
      case 'object': {
        const object = (value ?? {}) as Record<string, unknown>;
        return (
          <div {...css.attrs(styles.nested)}>
            {type.fields.map((field) => <FieldRow field={field} value={object[field.name]} context={context} onSet={(path: ValuePath, next: unknown) => onSet([field.name, ...path], next)} />)}
          </div>
        );
      }
      case 'union': {
        const object = (value ?? {}) as Record<string, unknown>;
        const tag = String(object[type.tag]);
        const fields = [...(type.common ?? []), ...(type.variants[tag] ?? [])];
        return (
          <div {...css.attrs(styles.nested)}>
            <select
              {...css.attrs(styles.select)}
              value={tag}
              onChange={(event: Event) => {
                // 换了种类：留下共有的字段，这一种自己的字段从空值开始
                const next = (event.target as HTMLSelectElement).value;
                const kept = Object.fromEntries((type.common ?? []).map((field) => [field.name, object[field.name]]));
                const fresh = Object.fromEntries((type.variants[next] ?? []).filter((field) => !field.optional).map((field) => [field.name, emptyValue(field.type)]));
                onSet([], { [type.tag]: next, ...kept, ...fresh });
              }}
            >
              {Object.keys(type.variants).map((variant) => <option value={variant}>{variant}</option>)}
            </select>
            {fields.map((field) => <FieldRow field={field} value={object[field.name]} context={context} onSet={(path: ValuePath, next: unknown) => onSet([field.name, ...path], next)} />)}
          </div>
        );
      }
      case 'json':
        return (
          <textarea
            {...css.attrs(styles.json)}
            value={JSON.stringify(value, null, 1)}
            onChange={(event: Event) => {
              try {
                onSet([], JSON.parse((event.target as HTMLTextAreaElement).value));
              } catch {
                // 写到一半的 JSON 不认，等写完整
              }
            }}
          />
        );
    }
  };
});
