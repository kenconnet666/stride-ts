import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { NumberField, Switch, TextField } from '@zerodep-dev/vue-tsx-pro-ui';
import type { Field, FieldType } from '@stride-ts/engine/editor-fields';
import { sameValue } from '@stride-ts/engine/content-prefabs';
import { colorToHex, emptyValue, eulerToQuaternion, hasMixed, hexToColor, MIXED, quaternionToEuler } from './values';

/** 文件里一个值的路径（相对 FieldEditor 拿到的值）。 */
export type ValuePath = readonly (string | number)[];

/**
 * 按原来的值算新值：多选时每个实体各算各的（只改了欧拉角的一个分量、只换了颜色不动 alpha、换联合的种类时留下各自的共有
 * 字段）。onSet 的值是函数时就是它。
 */
export type ValueUpdate = (current: unknown) => unknown;

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
  /**
   * 把 path 上的值设成 value（undefined 是删掉这个键；ValueUpdate 是按原来的值算）。value 里可以有 MIXED（多选时几个
   * 实体不一样的地方，显示"多个值"）。
   */
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
  mixed: { color: '_textMuted', fontStyle: 'italic' },
});

/** 多选时值不一样的地方。 */
const MIXED_LABEL = '多个值';

/** 数不分千位（2000 不写成 2,000），小数留到六位：引擎的值不是金额。 */
const NUMBER_FORMAT = { useGrouping: false, maximumFractionDigits: 6 } as const;

/**
 * 一行：名字加它的编辑器。文件里没写（可选、用默认值）的名字淡一点。可选的字段设回默认值时不写（同导入器写的文件；
 * 预制体的实例上也就不留和预制体一样的覆盖）。
 */
export const FieldRow = _component(({ field, value, context, onSet }: { field: Field; value: unknown; context: FieldContext; onSet: FieldEditorProps['onSet'] }) => {
  const collapse = (next: unknown) => (field.optional && field.default !== undefined && sameValue(next, field.default) ? undefined : next);
  const set = (path: ValuePath, next: unknown) =>
    onSet(path, path.length > 0 ? next : typeof next === 'function' ? (current: unknown) => collapse((next as ValueUpdate)(current)) : collapse(next));
  return () => {
    const missing = value === undefined;
    const shown = missing ? field.default : value;
    return (
      <div {...css.attrs(styles.row)}>
        <span {...css.attrs(styles.label, missing && styles.unset)} title={field.description ?? field.name}>{field.label ?? field.name}</span>
        {field.nullable && shown === null ? (
          <button type="button" onClick={() => onSet([], emptyValue(field.type))}>设置</button>
        ) : (
          <FieldEditor type={field.type} value={shown} context={context} onSet={set} />
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
      {...(current === MIXED ? { placeholder: options.compact ? '—' : MIXED_LABEL, title: MIXED_LABEL } : {})}
      {...(options.min !== undefined ? { min: options.min } : {})}
      {...(options.max !== undefined ? { max: options.max } : {})}
      step={options.step ?? 0.1}
      onUpdate:_value={(next: number | null) => next !== null && set(next)}
    />
  );

  return () => {
    // 多选时整个列表、对象不一样（长短不同、有的没写）：不逐项改
    if (value === MIXED && (type.kind === 'list' || type.kind === 'object' || type.kind === 'json')) return <span {...css.attrs(styles.mixed)}>{MIXED_LABEL}</span>;
    switch (type.kind) {
      case 'number':
        return number(value, (next) => onSet([], type.integer ? Math.round(next) : next), { ...type, step: type.step ?? (type.integer ? 1 : 0.1) });
      case 'bool':
        return (
          <span {...css.attrs(styles.color)}>
            <Switch _checked={value === true} onUpdate:_checked={(next: boolean) => onSet([], next)} />
            {value === MIXED && <span {...css.attrs(styles.mixed)}>{MIXED_LABEL}</span>}
          </span>
        );
      case 'string':
        return <TextField _value={typeof value === 'string' ? value : ''} {...(value === MIXED ? { placeholder: MIXED_LABEL } : {})} onUpdate:_value={(next: string) => onSet([], next)} />;
      case 'enum':
        return (
          <select {...css.attrs(styles.select)} value={value === MIXED ? '' : String(value)} onChange={(event: Event) => onSet([], (event.target as HTMLSelectElement).value)}>
            {value === MIXED && <option value="" disabled>{MIXED_LABEL}</option>}
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
        // 多选时各个实体的旋转不一样就三个角都显示"多个值"；改一个角时每个实体留着自己的另外两个角
        const euler: unknown[] = hasMixed(value) ? [MIXED, MIXED, MIXED] : quaternionToEuler(Array.isArray(value) ? (value as number[]) : [0, 0, 0, 1]);
        const setAngle = (i: number, next: number) => (current: unknown) =>
          eulerToQuaternion(quaternionToEuler(Array.isArray(current) ? (current as number[]) : [0, 0, 0, 1]).map((angle, j) => (j === i ? next : angle)));
        return (
          <div {...css.attrs(styles.vector)} title="角度（度），先绕 Z、再绕 X、再绕 Y（同 Stride）">
            {euler.map((angle, i) => number(angle, (next) => onSet([], setAngle(i, next)), { step: 1, compact: true }))}
          </div>
        );
      }
      case 'color': {
        const channels = Array.isArray(value) ? (value as unknown[]) : [0, 0, 0, 1];
        const rgbMixed = channels.slice(0, 3).some((channel) => channel === MIXED);
        return (
          <div {...css.attrs(styles.color)}>
            <input type="color" value={colorToHex(rgbMixed ? [0, 0, 0] : (channels as number[]), type.space)}
              onInput={(event: Event) => onSet([], (current: unknown) => hexToColor((event.target as HTMLInputElement).value, type.space, Array.isArray(current) ? (current as number[]) : []))} />
            {rgbMixed && <span {...css.attrs(styles.mixed)}>{MIXED_LABEL}</span>}
            {type.alpha && number(channels[3], (next) => onSet([3], next), { min: 0, max: 1, step: 0.01 })}
          </div>
        );
      }
      case 'asset': {
        // 输入时列出这一种的资源（属性面板里每种一个 datalist，见 assetListId）
        const path = value === MIXED ? MIXED : type.form === 'ref' ? (value as { $asset?: string | typeof MIXED } | null)?.$asset : (value as string | null);
        return (
          <input
            {...css.attrs(styles.select)}
            list={assetListId(type.asset)}
            value={path === MIXED ? '' : path ?? ''}
            placeholder={path === MIXED ? MIXED_LABEL : type.asset}
            onChange={(event: Event) => onSet(type.form === 'ref' ? ['$asset'] : [], (event.target as HTMLInputElement).value)}
          />
        );
      }
      case 'entity': {
        const id = value === MIXED ? MIXED : type.form === 'ref' ? (value as { $entity?: string | typeof MIXED } | null)?.$entity : (value as string | null);
        return (
          <select
            {...css.attrs(styles.select)}
            value={id === MIXED ? MIXED_LABEL : id ?? ''}
            onChange={(event: Event) => {
              const next = (event.target as HTMLSelectElement).value || null;
              onSet([], type.form === 'ref' ? (next === null ? null : { $entity: next }) : next);
            }}
          >
            {id === MIXED && <option value={MIXED_LABEL} disabled>{MIXED_LABEL}</option>}
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
        // 多选时种类不一样：只显示共有的字段
        const object = (value === MIXED ? { [type.tag]: MIXED } : value ?? {}) as Record<string, unknown>;
        const tag = object[type.tag] === MIXED ? MIXED_LABEL : String(object[type.tag]);
        const fields = [...(type.common ?? []), ...(type.variants[tag] ?? [])];
        return (
          <div {...css.attrs(styles.nested)}>
            <select
              {...css.attrs(styles.select)}
              value={tag}
              onChange={(event: Event) => {
                // 换了种类：留下（每个实体自己的）共有的字段，这一种自己的字段从空值开始
                const next = (event.target as HTMLSelectElement).value;
                const fresh = Object.fromEntries((type.variants[next] ?? []).filter((field) => !field.optional).map((field) => [field.name, emptyValue(field.type)]));
                onSet([], (current: unknown) => {
                  const own = (current ?? {}) as Record<string, unknown>;
                  return { [type.tag]: next, ...Object.fromEntries((type.common ?? []).map((field) => [field.name, own[field.name]])), ...fresh };
                });
              }}
            >
              {tag === MIXED_LABEL && <option value={MIXED_LABEL} disabled>{MIXED_LABEL}</option>}
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
