import { X } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { IconButton } from '@zerodep-dev/vue-tsx-pro-ui';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import { SCENE_SETTING_KEYS, type SceneEdit, type SceneSettingKey } from '@stride-ts/engine/editor-document';
import { ASSET_FIELDS, COMPONENT_FIELDS, ENTITY_FIELDS, SCENE_FIELDS, type FieldType } from '@stride-ts/engine/editor-fields';
import { PaintLayers } from './PaintLayers';
import { assetListId, FieldEditor, FieldRow, type FieldContext, type ValuePath, type ValueUpdate } from './FieldEditor';
import type { EditorSession } from './session';
import { labelText } from './fieldMessages';
import { t } from './messages';
import { mergeValues } from './values';

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', gap: '_sm', padding: '_sm', fontSize: '0.875rem' },
  section: { display: 'flex', flexDirection: 'column', gap: '2px' },
  heading: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: '600', marginBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  hint: { color: '_textMuted', padding: '_sm' },
  add: { marginBlockStart: '_sm' },
});

type ComponentKey = keyof typeof COMPONENT_FIELDS;
type Entities = readonly SceneEntityFile[];

/** 属性面板能编辑的资源种类的名字。 */

/** "添加组件"下拉框里脚本的值的前缀（组件的值是 COMPONENT_FIELDS 的键）。 */
const SCRIPT_OPTION = 'script:';

/** 脚本的类名：登记的名字（`gameplay/player#Player`、`Gameplay.Boss`）或 Stride 的类型名的最后一段。 */
const scriptClass = (type: string): string => type.slice(Math.max(type.lastIndexOf('.'), type.lastIndexOf('#')) + 1);

/** 实体上第 k 个（从 0 数）类名是 name 的脚本在脚本列表里的下标；没有是 -1。 */
function scriptIndex(entity: SceneEntityFile, name: string, k: number): number {
  let seen = 0;
  return (entity.components.scripts ?? []).findIndex((script) => scriptClass(script.type) === name && seen++ === k);
}

/**
 * 几个实体都有的脚本：按第一个实体上的顺序，每个是"第 k 个类名是 name 的"（同一种脚本挂了两个时也一一对上）。
 * 只选了一个实体时就是它的全部脚本。
 */
function commonScripts(entities: Entities): { type: string; name: string; k: number }[] {
  const counts = new Map<string, number>();
  return (entities[0]!.components.scripts ?? [])
    .map(({ type }) => {
      const name = scriptClass(type);
      const k = counts.get(name) ?? 0;
      counts.set(name, k + 1);
      return { type, name, k };
    })
    .filter(({ name, k }) => entities.every((entity) => scriptIndex(entity, name, k) >= 0));
}

/** 能加的脚本：游戏登记的、不是每个实体上都已经有的（按类名比，导入的场景里写的是 Stride 的类型名）。重名的类显示全名。 */
function addableScripts(registered: readonly string[], entities: Entities): { type: string; label: string }[] {
  const everywhere = (name: string) => entities.every((entity) => scriptIndex(entity, name, 0) >= 0);
  const counts = new Map<string, number>();
  for (const type of registered) counts.set(scriptClass(type), (counts.get(scriptClass(type)) ?? 0) + 1);
  return registered.filter((type) => !everywhere(scriptClass(type))).map((type) => ({ type, label: counts.get(scriptClass(type))! > 1 ? type : scriptClass(type) }));
}

/** 实体上有的组件（场景文件的键，脚本不算）。 */
const keysOf = (entity: SceneEntityFile): ComponentKey[] => (Object.keys(COMPONENT_FIELDS) as ComponentKey[]).filter((key) => entity.components[key] !== undefined);

/** JSON 值（实体、场景文件）里 path 上的值（列表按下标）。 */
function valueAt(root: unknown, path: ValuePath): unknown {
  let value: unknown = root;
  for (const key of path) value = value !== null && typeof value === 'object' ? (value as Record<string | number, unknown>)[key] : undefined;
  return value;
}

/** 实例的根、成员上的说明：属于哪个预制体，这个实体上有几处覆盖。 */
function instanceHint(session: EditorSession, { id, name }: SceneEntityFile) {
  const target = session.instanceMember(id);
  if (!target) return undefined;
  const { path, set = [], removed = [] } = target.instance.prefab!;
  const own = set.filter((override) => override.entity === target.member).length;
  const where = target.instance.id === id ? t.instanceOf(path) : t.memberOf(path, target.instance.name, name || target.member);
  return (
    <div {...css.attrs(styles.hint)}>
      {where}{t.instanceChanges(own, target.instance.id === id ? removed.length : 0)}
    </div>
  );
}

/**
 * 属性面板：选中的实体的名字、变换和每个组件的字段，照着引擎的字段描述（editor/fields.ts）画；脚本的字段问游戏页面
 * （它有脚本的类，见 EditAgent.scriptFields），游戏里没有这个脚本时按原样的 JSON 改。"添加组件"里也列出游戏登记的脚本
 * （EditAgent.scriptTypes），加上的脚本 type 写登记的名字、属性先都用脚本的默认值。改一个值是对场景文档的一次 set，
 * 连着改同一个值（拖数字、打字）并成撤销的一步。
 *
 * 选了几个实体时显示它们都有的组件和脚本，值不一样的地方显示"多个值"（mergeValues）；改一处是对每个实体各一次 set，
 * 一起做、一起撤销；加、去掉组件也是对每个实体。
 *
 * 资源浏览器里选中材质、JSON 写的模型时显示资源自己的字段（引擎的 ASSET_FIELDS）：改了直接存进资源文件，视口里用到它的实体
 * 热重载（session.editInspected）。
 */
export const Inspector = _component(({ session }: { session: EditorSession }) => {
  const { version, selection, agent, assets } = session;
  // 资源字段的提示：每种资源一个 datalist
  const assetLists = _derived.by(() => {
    const byKind = new Map<string, string[]>();
    for (const asset of assets.value) byKind.set(asset.kind, [...(byKind.get(asset.kind) ?? []), asset.path]);
    return [...byKind];
  });
  // 显示的是展开以后的实体（实例的根带着预制体的组件，成员也能选），按场景里的顺序
  const entities = _derived.by((): Entities => {
    void version.value;
    const ids = new Set(selection.value);
    return agent.value && ids.size > 0 ? session.expanded.filter((entity) => ids.has(entity.id)) : [];
  });
  const context = _derived.by((): FieldContext => {
    void version.value;
    return { entities: agent.value ? session.expanded.map(({ id, name }) => ({ id, name })) : [] };
  });

  /** 对每个实体做一个修改（undefined 的跳过），一起做、一起撤销；mergeKey 同 session.apply。 */
  const applyEach = (targets: Entities, edit: (entity: SceneEntityFile) => SceneEdit | undefined, mergeKey?: string) => {
    const edits = targets.map(edit).filter((one): one is SceneEdit => one !== undefined);
    if (edits.length > 0) session.apply(edits.length === 1 ? edits[0]! : { type: 'batch', edits }, mergeKey);
  };

  /** 加、去掉组件和脚本：单独一步撤销。 */
  const change = (targets: Entities, edit: (entity: SceneEntityFile) => SceneEdit | undefined) => {
    applyEach(targets, edit);
    session.commit();
  };

  /**
   * 每个实体上 base(实体) 下面的 path 设成 value（ValueUpdate 按各自现在的值算）；同一处连着改并成一步（换了地方、失去
   * 焦点以后是新的一步）。
   */
  const setter = (targets: Entities, base: (entity: SceneEntityFile) => ValuePath) => (path: ValuePath, value: unknown) => {
    // 按原来的值算时读现在的：连着拖的时候这个回调可能是几次修改之前画的
    const now = typeof value === 'function' ? new Map(session.expanded.map((entity) => [entity.id, entity])) : undefined;
    applyEach(targets, (entity) => {
      const full = [...base(entity), ...path];
      return { type: 'set', entity: entity.id, path: full, value: now ? (value as ValueUpdate)(valueAt(now.get(entity.id) ?? entity, full)) : value };
    }, `${targets.map((entity) => entity.id).join(',')}/${[...base(targets[0]!), ...path].join('/')}`);
  };

  /** 在没有这个脚本的实体上加一个（属性都用脚本的默认值），加在脚本列表的最后。 */
  /**
   * 在没有这个脚本的实体上加一个（属性都用脚本的默认值），加在脚本列表的最后；脚本要的组件（requires）实体上没有的一起加上，
   * 同一步撤销。场景文件里加不了的（游戏代码里加的组件）在工具条上提示。
   */
  const addScript = (targets: Entities, type: string) => {
    const required = agent.value?.requiredComponents(type) ?? [];
    const unavailable = required.filter((entry) => !entry.component && !entry.script).map((entry) => entry.name);
    session.notice.value = unavailable.length > 0 ? t.scriptNeedsComponents(scriptClass(type), unavailable) : '';
    change(targets, (entity) => {
      if (scriptIndex(entity, scriptClass(type), 0) >= 0) return undefined;
      const edits: SceneEdit[] = [];
      const scripts = [...(entity.components.scripts ?? [])];
      for (const { component, script } of required) {
        if (component && (entity.components as Record<string, unknown>)[component] === undefined) {
          edits.push({ type: 'set', entity: entity.id, path: ['components', component], value: structuredClone(COMPONENT_FIELDS[component as ComponentKey]?.initial ?? {}) });
        }
        if (script && !scripts.some((existing) => scriptClass(existing.type) === scriptClass(script))) scripts.push({ type: script, props: {} });
      }
      scripts.push({ type, props: {} });
      edits.push({ type: 'set', entity: entity.id, path: ['components', 'scripts'], value: scripts });
      return edits.length === 1 ? edits[0]! : { type: 'batch', edits };
    });
  };

  /** 去掉组件；实体上有脚本要它（requires）时照样去掉，在工具条上提示这些脚本试玩时不挂。 */
  const removeComponent = (targets: Entities, key: ComponentKey) => {
    const dependents = new Set(targets.flatMap((entity) => [
      // 要它的脚本（requires）和要它的组件（COMPONENT_FIELDS 的 requires，日夜循环要天空）
      ...(entity.components.scripts ?? [])
        .filter((script) => agent.value?.requiredComponents(script.type).some((entry) => entry.component === key))
        .map((script) => scriptClass(script.type)),
      ...keysOf(entity).filter((other) => COMPONENT_FIELDS[other].requires?.includes(key)).map((other) => COMPONENT_FIELDS[other].label),
    ]));
    change(targets, ({ id }) => ({ type: 'set', entity: id, path: ['components', key], value: undefined }));
    session.notice.value = dependents.size > 0 ? t.removedRequired(labelText(COMPONENT_FIELDS[key].label), [...dependents]) : '';
  };

  /** 加组件：它要的组件（COMPONENT_FIELDS 的 requires）实体上没有的一起加上，同一步撤销。 */
  const addComponent = (targets: Entities, key: ComponentKey) =>
    change(targets, ({ id, components }) => {
      const missing = [...(COMPONENT_FIELDS[key].requires ?? []) as ComponentKey[], key].filter((needed) => components[needed] === undefined);
      const edits: SceneEdit[] = missing.map((needed) => ({ type: 'set', entity: id, path: ['components', needed], value: structuredClone(COMPONENT_FIELDS[needed].initial) }));
      return edits.length === 0 ? undefined : edits.length === 1 ? edits[0]! : { type: 'batch', edits };
    });

  /**
   * 没选实体时：场景自己的设置（物理、导航、偏移、合成器）。写了的显示字段（× 去掉），没写的从"添加设置"里加（引擎的默认值）。
   * 改一个值是一次 'scene' 修改，连着改并成一步；合成器、偏移在视口里马上看得见，物理、导航试玩时用上。
   */
  const sceneSettings = () => {
    const file = session.file as unknown as Record<SceneSettingKey, unknown>;
    const setSetting = (key: SceneSettingKey) => (path: ValuePath, value: unknown) => {
      const full = [key, ...path];
      const next = typeof value === 'function' ? (value as ValueUpdate)(valueAt(file, full)) : value;
      session.apply({ type: 'scene', path: full, value: next }, `scene/${full.join('/')}`);
    };
    const change = (key: SceneSettingKey, value: unknown) => {
      session.apply({ type: 'scene', path: [key], value });
      session.commit();
    };
    return (
      <div {...css.attrs(styles.panel)} onFocusout={() => session.commit()}>
        <div {...css.attrs(styles.hint)}>{t.sceneSettingsHint(session.file.name)}</div>
        {SCENE_SETTING_KEYS.filter((key) => file[key] !== undefined).map((key) => (
          <section {...css.attrs(styles.section)}>
            <div {...css.attrs(styles.heading)}>
              {labelText(SCENE_FIELDS[key].label)}
              <IconButton icon={X} variant="ghost" aria-label={t.remove(labelText(SCENE_FIELDS[key].label))} onClick={() => change(key, undefined)} />
            </div>
            <FieldEditor type={SCENE_FIELDS[key].type} value={file[key]} context={context} onSet={setSetting(key)} />
          </section>
        ))}
        <select {...css.attrs(styles.add)} aria-label={t.addSetting} value="" onChange={(event: Event) => {
          const key = (event.target as HTMLSelectElement).value as SceneSettingKey;
          if (key) change(key, structuredClone(SCENE_FIELDS[key].initial));
        }}>
          <option value="">{t.addSettingMenu}</option>
          {SCENE_SETTING_KEYS.filter((key) => file[key] === undefined).map((key) => <option value={key}>{labelText(SCENE_FIELDS[key].label)}</option>)}
        </select>
      </div>
    );
  };

  /** 资源浏览器里选中的资源（材质、JSON 写的模型）的字段。 */
  const assetInspector = (asset: NonNullable<typeof session.inspected.value>) => (
    <div {...css.attrs(styles.panel)}>
      {assetLists.map(([kind, paths]) => <datalist id={assetListId(kind)}>{paths.map((path) => <option value={path} />)}</datalist>)}
      <div {...css.attrs(styles.hint)}>{t.assetHint(t.assetLabels[asset.kind], asset.path)}</div>
      {asset.kind === 'material' && <button type="button" onClick={() => session.openMaterialGraph()}>{t.graphOpen}</button>}
      {asset.kind === 'material' && <PaintLayers session={session} />}
      <FieldEditor type={{ kind: 'object', fields: ASSET_FIELDS[asset.kind] }} value={asset.content} context={context} onSet={(path, value) => session.editInspected(path, value)} />
    </div>
  );

  return () => {
    const list = entities;
    const inspected = session.inspected.value;
    if (inspected) return assetInspector(inspected);
    if (!agent.value) return <div {...css.attrs(styles.hint)}>{t.sceneNotOpen}</div>;
    if (list.length === 0) {
      void version.value;
      return session.opened.value?.kind === 'scene' ? sceneSettings() : <div {...css.attrs(styles.hint)}>{t.pickEntity}</div>;
    }
    const merged = (read: (entity: SceneEntityFile) => unknown) => mergeValues(list.map(read));
    const keys = Object.keys(COMPONENT_FIELDS) as ComponentKey[];
    return (
      <div {...css.attrs(styles.panel)} onFocusout={() => session.commit()}>
        {assetLists.map(([kind, paths]) => <datalist id={assetListId(kind)}>{paths.map((path) => <option value={path} />)}</datalist>)}
        {list.length === 1
          ? instanceHint(session, list[0]!)
          : <div {...css.attrs(styles.hint)}>{t.multiSelection(list.length)}</div>}
        <section {...css.attrs(styles.section)}>
          {ENTITY_FIELDS.map((field) => (
            <FieldRow field={field} value={merged((entity) => (entity as unknown as Record<string, unknown>)[field.name])} context={context} onSet={setter(list, () => [field.name])} />
          ))}
        </section>
        {keys.filter((key) => list.every((entity) => entity.components[key] !== undefined)).map((key) => (
          <section {...css.attrs(styles.section)}>
            <div {...css.attrs(styles.heading)}>
              {labelText(COMPONENT_FIELDS[key].label)}
              <IconButton icon={X} variant="ghost" aria-label={t.remove(labelText(COMPONENT_FIELDS[key].label))} onClick={() => removeComponent(list, key)} />
            </div>
            {key === 'particleSystem' && list.length === 1 && <button type="button" onClick={() => session.openParticles(list[0]!.id)}>{t.particleOpen}</button>}
            <FieldEditor type={COMPONENT_FIELDS[key].type} value={merged((entity) => entity.components[key])} context={context} onSet={setter(list, () => ['components', key])} />
          </section>
        ))}
        {commonScripts(list).map(({ type, name, k }) => {
          const fields = agent.value?.scriptFields(type);
          const fieldType: FieldType = fields ? { kind: 'object', fields } : { kind: 'json' };
          const index = (entity: SceneEntityFile) => scriptIndex(entity, name, k);
          return (
            <section {...css.attrs(styles.section)}>
              <div {...css.attrs(styles.heading)} title={type}>
                {name}
                <IconButton icon={X} variant="ghost" aria-label={t.removeScript} onClick={() => change(list, (entity) => {
                  const rest = (entity.components.scripts ?? []).filter((_, j) => j !== index(entity));
                  return { type: 'set', entity: entity.id, path: ['components', 'scripts'], value: rest.length > 0 ? rest : undefined };
                })} />
              </div>
              <FieldEditor type={fieldType} value={merged((entity) => entity.components.scripts![index(entity)]!.props)} context={context} onSet={setter(list, (entity) => ['components', 'scripts', index(entity), 'props'])} />
            </section>
          );
        })}
        <select {...css.attrs(styles.add)} aria-label={t.addComponent} value="" onChange={(event: Event) => {
          const value = (event.target as HTMLSelectElement).value;
          if (value.startsWith(SCRIPT_OPTION)) addScript(list, value.slice(SCRIPT_OPTION.length));
          else if (value) addComponent(list, value as ComponentKey);
        }}>
          <option value="">{t.addComponentMenu}</option>
          {keys.filter((key) => list.some((entity) => entity.components[key] === undefined)).map((key) => <option value={key}>{labelText(COMPONENT_FIELDS[key].label)}</option>)}
          <optgroup label={t.scripts}>
            {addableScripts(agent.value.scriptTypes(), list).map(({ type, label }) => <option value={SCRIPT_OPTION + type} title={type}>{label}</option>)}
          </optgroup>
        </select>
      </div>
    );
  };
});
