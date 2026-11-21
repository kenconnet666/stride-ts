import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import {
  NumberField,
  PROPERTY_MIXED,
  PropertyEditor,
  PropertyGrid,
  Select,
  TextField,
  hasMixed,
  type PropertyEditors,
  type PropertyPath,
  type PropertyUpdate,
} from '@zerodep-dev/vue-tsx-pro-ui';
import type { Field, FieldType } from '@stride-ts/engine/editor-fields';
import { fieldDescription, fieldName } from './fieldMessages';
import { t } from './messages';
import { eulerToQuaternion, quaternionToEuler } from './values';

/** 文件里一个值的路径（相对编辑器拿到的值）。 */
export type ValuePath = PropertyPath;

/**
 * 按原来的值算新值：多选时每个实体各算各的（只改了欧拉角的一个分量、只换了颜色不动 alpha、换联合的种类时留下各自的共有
 * 字段）。onSet 的值是函数时就是它。
 */
export type ValueUpdate = PropertyUpdate;

/** 资源字段的输入框提示的资源列表（`<datalist>`）的 id：每种资源一个，属性面板画。 */
export const assetListId = (kind: string): string => `stride-assets-${kind}`;

/** 字段编辑器要的场景信息：选实体的下拉框列出哪些实体。 */
export interface FieldContext {
  readonly entities: readonly { readonly id: string; readonly name: string }[];
}

/** 引擎自己的值（vue-tsx-pro 的 PropertyGrid 没有的种类）：旋转、资源、实体。 */
type EngineKind = Extract<FieldType, { kind: 'rotation' | 'asset' | 'entity' }>;

const styles = css.create({
  vector: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(3.5em, 1fr))', gap: '2px' },
  full: { width: '100%' },
});

/** 数不分千位、小数留到六位：引擎的值不是金额。 */
const NUMBER_FORMAT = { useGrouping: false, maximumFractionDigits: 6 } as const;
const AXES = ['X', 'Y', 'Z'];

/** 引擎的三种值的编辑器；context 读的是最新的（实体列表跟着场景变）。 */
function engineEditors(context: () => FieldContext): PropertyEditors<EngineKind> {
  return {
    rotation: {
      // 文件里是四元数，面板上按欧拉角改；多选时各个实体的旋转不一样就三个角都显示"多个值"，改一个角时每个实体留着自己的另外两个角
      render: ({ value, label, set }) => {
        const euler: unknown[] = hasMixed(value) ? [PROPERTY_MIXED, PROPERTY_MIXED, PROPERTY_MIXED] : quaternionToEuler(Array.isArray(value) ? (value as number[]) : [0, 0, 0, 1]);
        const setAngle = (i: number, next: number) => (current: unknown) =>
          eulerToQuaternion(quaternionToEuler(Array.isArray(current) ? (current as number[]) : [0, 0, 0, 1]).map((angle, j) => (j === i ? next : angle)));
        return (
          <div {...css.attrs(styles.vector)} title={t.eulerHint}>
            {euler.map((angle, i) => (
              <NumberField
                size="sm"
                stepper={false}
                format={NUMBER_FORMAT}
                step={1}
                aria-label={`${label} ${AXES[i]}`}
                _value={typeof angle === 'number' ? angle : null}
                {...(angle === PROPERTY_MIXED ? { placeholder: '—', title: t.mixed } : {})}
                onUpdate:_value={(next: number | null) => next !== null && set([], setAngle(i, next))}
              />
            ))}
          </div>
        );
      },
      empty: () => [0, 0, 0, 1],
    },
    asset: {
      // 输入时列出这一种的资源（属性面板里每种一个 datalist，见 assetListId）；敲完（回车、失焦）才写回：敲到一半的路径不是资源
      render: ({ type, value, label, set }) => {
        const path = value === PROPERTY_MIXED ? PROPERTY_MIXED : type.form === 'ref' ? (value as { $asset?: unknown } | null)?.$asset : value;
        return (
          <TextField
            {...css.attrs(styles.full)}
            size="sm"
            aria-label={label}
            list={assetListId(type.asset)}
            _value={typeof path === 'string' ? path : ''}
            placeholder={path === PROPERTY_MIXED ? t.mixed : type.asset}
            onChange={(event: Event) => set(type.form === 'ref' ? ['$asset'] : [], (event.target as HTMLInputElement).value)}
          />
        );
      },
      empty: (type) => (type.form === 'ref' ? { $asset: '', kind: type.refKind ?? type.asset } : ''),
    },
    entity: {
      render: ({ type, value, label, set }) => {
        const id = value === PROPERTY_MIXED ? PROPERTY_MIXED : type.form === 'ref' ? (value as { $entity?: unknown } | null)?.$entity : value;
        return (
          <Select
            {...css.attrs(styles.full)}
            size="sm"
            searchable
            aria-label={label}
            placeholder={t.mixed}
            items={[{ value: '', label: t.none }, ...context().entities.map((entity) => ({ value: entity.id, label: entity.name || entity.id }))]}
            _value={id === PROPERTY_MIXED ? null : typeof id === 'string' ? id : ''}
            onUpdate:_value={(selected: string | null) => {
              if (selected === null) return;
              const next = selected || null;
              set([], type.form === 'ref' ? (next === null ? null : { $entity: next }) : next);
            }}
          />
        );
      },
      empty: () => null,
    },
  };
}

// 名字、说明按翻译表（引擎的字段描述是 Field，PropertyGrid 给回来的是同一个对象）
const getLabel = (field: unknown) => fieldName(field as Field);
const getDescription = (field: unknown) => fieldDescription(field as Field);

interface CommonProps {
  context: FieldContext;
  /**
   * 把 path 上的值设成 value（undefined 是删掉这个键；ValueUpdate 是按原来的值算）。value 里可以有 PROPERTY_MIXED（多选时
   * 几个实体不一样的地方，显示"多个值"）。
   */
  onSet: (path: ValuePath, value: unknown) => void;
}

/** 一组字段（引擎的字段描述），名字加编辑器：vue-tsx-pro 的 PropertyGrid 加上引擎的三种值。 */
export const Fields = _component(({ fields, value, context, onSet }: CommonProps & { fields: readonly Field[]; value: unknown }) => {
  const editors = engineEditors(() => context);
  return () => (
    <PropertyGrid<EngineKind> fields={fields} value={value} editors={editors} getLabel={getLabel} getDescription={getDescription} numberFormat={NUMBER_FORMAT} onSet={onSet} />
  );
});

/** 按字段的类型画一个值的编辑器（组件、脚本、场景设置这一整个值）。 */
export const FieldEditor = _component(({ type, value, label, context, onSet }: CommonProps & { type: FieldType; value: unknown; label?: string }) => {
  const editors = engineEditors(() => context);
  return () => (
    <PropertyEditor<EngineKind> type={type} value={value} {...(label !== undefined ? { label } : {})} editors={editors} getLabel={getLabel} getDescription={getDescription} numberFormat={NUMBER_FORMAT} onSet={onSet} />
  );
});
