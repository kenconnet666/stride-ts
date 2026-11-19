import { X } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { IconButton } from '@zerodep-dev/vue-tsx-pro-ui';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import { COMPONENT_FIELDS, ENTITY_FIELDS, type FieldType } from '@stride-ts/engine/editor-fields';
import { assetListId, FieldEditor, FieldRow, type FieldContext, type ValuePath } from './FieldEditor';
import type { EditorSession } from './session';

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', gap: '_sm', padding: '_sm', fontSize: '0.875rem' },
  section: { display: 'flex', flexDirection: 'column', gap: '2px' },
  heading: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: '600', marginBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  hint: { color: '_textMuted', padding: '_sm' },
  add: { marginBlockStart: '_sm' },
});

type ComponentKey = keyof typeof COMPONENT_FIELDS;

/**
 * 属性面板：选中的实体的名字、变换和每个组件的字段，照着引擎的字段描述（editor/fields.ts）画；脚本的字段问游戏页面
 * （它有脚本的类，见 EditAgent.scriptFields），游戏里没有这个脚本时按原样的 JSON 改。改一个值是对场景文档的一次 set，
 * 连着改同一个值（拖数字、打字）并成撤销的一步。
 */
export const Inspector = _component(({ session }: { session: EditorSession }) => {
  const { version, selection, agent, assets } = session;
  // 资源字段的提示：每种资源一个 datalist
  const assetLists = _derived.by(() => {
    const byKind = new Map<string, string[]>();
    for (const asset of assets.value) byKind.set(asset.kind, [...(byKind.get(asset.kind) ?? []), asset.path]);
    return [...byKind];
  });
  const entity = _derived.by((): SceneEntityFile | undefined => {
    void version.value;
    const ids = selection.value;
    return agent.value && ids.length === 1 ? session.file.entities.find((candidate) => candidate.id === ids[0]) : undefined;
  });
  const context = _derived.by((): FieldContext => {
    void version.value;
    return { entities: agent.value ? session.file.entities.map(({ id, name }) => ({ id, name })) : [] };
  });

  /** 加上、去掉（undefined）一个组件：单独一步撤销。 */
  const setComponent = (id: string, key: string, value: unknown) => {
    session.apply({ type: 'set', entity: id, path: ['components', key], value });
    session.commit();
  };

  /** 实体上 base 下面的 path 设成 value；同一处连着改并成一步（换了地方、失去焦点以后是新的一步）。 */
  const setter = (id: string, base: ValuePath) => (path: ValuePath, value: unknown) => {
    const full = [...base, ...path];
    session.apply({ type: 'set', entity: id, path: full, value }, `${id}/${full.join('/')}`);
  };

  return () => {
    const ids = selection.value;
    if (!agent.value) return <div {...css.attrs(styles.hint)}>场景还没打开</div>;
    if (ids.length === 0) return <div {...css.attrs(styles.hint)}>在场景树或视口里选一个实体</div>;
    if (!entity) return <div {...css.attrs(styles.hint)}>选中了 {ids.length} 个实体（多选的一起改还没做）</div>;
    const { id, components } = entity;
    const record = entity as unknown as Record<string, unknown>;
    return (
      <div {...css.attrs(styles.panel)} onFocusout={() => session.commit()}>
        {assetLists.map(([kind, paths]) => <datalist id={assetListId(kind)}>{paths.map((path) => <option value={path} />)}</datalist>)}
        <section {...css.attrs(styles.section)}>
          {ENTITY_FIELDS.map((field) => <FieldRow field={field} value={record[field.name]} context={context} onSet={setter(id, [field.name])} />)}
        </section>
        {(Object.keys(COMPONENT_FIELDS) as ComponentKey[]).filter((key) => components[key] !== undefined).map((key) => (
          <section {...css.attrs(styles.section)}>
            <div {...css.attrs(styles.heading)}>
              {COMPONENT_FIELDS[key].label}
              <IconButton icon={X} variant="ghost" aria-label={`去掉 ${COMPONENT_FIELDS[key].label}`} onClick={() => setComponent(id, key, undefined)} />
            </div>
            <FieldEditor type={COMPONENT_FIELDS[key].type} value={components[key]} context={context} onSet={setter(id, ['components', key])} />
          </section>
        ))}
        {(components.scripts ?? []).map((script, i) => {
          const fields = agent.value?.scriptFields(script.type);
          const type: FieldType = fields ? { kind: 'object', fields } : { kind: 'json' };
          return (
            <section {...css.attrs(styles.section)}>
              <div {...css.attrs(styles.heading)} title={script.type}>
                {script.type.slice(script.type.lastIndexOf('.') + 1)}
                <IconButton icon={X} variant="ghost" aria-label="去掉这个脚本" onClick={() => {
                  const rest = (components.scripts ?? []).filter((_, j) => j !== i);
                  setComponent(id, 'scripts', rest.length > 0 ? rest : undefined);
                }} />
              </div>
              <FieldEditor type={type} value={script.props} context={context} onSet={setter(id, ['components', 'scripts', i, 'props'])} />
            </section>
          );
        })}
        <select {...css.attrs(styles.add)} value="" onChange={(event: Event) => {
          const key = (event.target as HTMLSelectElement).value as ComponentKey;
          if (key) setComponent(id, key, structuredClone(COMPONENT_FIELDS[key].initial));
        }}>
          <option value="">添加组件……</option>
          {(Object.keys(COMPONENT_FIELDS) as ComponentKey[]).filter((key) => components[key] === undefined).map((key) => <option value={key}>{COMPONENT_FIELDS[key].label}</option>)}
        </select>
      </div>
    );
  };
});
