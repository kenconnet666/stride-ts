/**
 * 粒子面板（S2；参考 Niagara 的发射器模块栈）：选中的实体的粒子系统（particleSystem 组件里的 particleSystem）。上面是发射器
 * 的页签（加、删），下面是这个发射器：自己的参数，然后按栏列出模块——生成、初始化、更新（可以加、删、上下挪）、形状、材质（各
 * 一个，可以换种类）。模块的参数照引擎的模块库（editor/particleModules.ts）画；曲线参数是小曲线编辑器，颜色曲线是渐变编辑器；
 * 库里没有的模块按 JSON 改。
 *
 * 每次修改是场景文档的一个修改（同属性面板：能撤销，视口里的粒子马上重建）；拖曲线的点时同一次拖并成一步。
 */
import { CircleX } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton } from '@zerodep-dev/vue-tsx-pro-ui';
import type { ParticleModuleFile, SceneEntityFile } from '@stride-ts/engine/content-format';
import { curve, EMITTER_FIELDS, isCurve, newEmitter, PARTICLE_MODULES, type ParticleStackKind } from '@stride-ts/engine/editor-particles';
import { ColorGradient, FloatCurve } from './CurveEditor';
import { FieldEditor, FieldRow, type FieldContext, type ValuePath } from './FieldEditor';
import { t } from './messages';
import type { EditorSession } from './session';

const SPECS = new Map(PARTICLE_MODULES.map((spec) => [spec.type, spec]));
const LISTS: readonly ParticleStackKind[] = ['spawners', 'initializers', 'updaters'];
const SINGLES: readonly ParticleStackKind[] = ['shapeBuilder', 'material'];

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.8rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border', flexWrap: 'wrap' },
  tab: { paddingInline: '8px' },
  activeTab: { fontWeight: '700', borderBlockEndWidth: '2px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_accent' },
  body: { flex: '1', overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '_sm', padding: '_sm', alignItems: 'start' },
  column: { display: 'flex', flexDirection: 'column', gap: '6px' },
  stackTitle: { fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' },
  card: { borderWidth: '1px', borderStyle: 'solid', borderColor: '_border', borderRadius: '6px', padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '2px' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '4px', fontWeight: '600' },
  grow: { flex: '1' },
  curveRow: { display: 'grid', gridTemplateColumns: 'minmax(6em, 35%) 1fr', alignItems: 'start', gap: '_xs' },
  label: { color: '_textMuted' },
  hint: { color: '_textMuted', padding: '_sm' },
});

export const ParticlePanel = _component(({ session }: { session: EditorSession }) => {
  let emitterIndex = _state(0);
  const context: FieldContext = { entities: [] };

  const entity = (): SceneEntityFile | undefined => {
    // 文档每改一次 version 加一：读它，改了以后面板跟着重画
    void session.version.value;
    const id = session.particleEntity.value;
    return id === undefined ? undefined : session.expanded.find((e) => e.id === id);
  };
  const system = () => entity()?.components.particleSystem as { particleSystem?: { emitters?: ParticleModuleFile[] } } | undefined;
  const emitters = () => system()?.particleSystem?.emitters ?? [];
  const base: ValuePath = ['components', 'particleSystem', 'particleSystem', 'emitters'];

  /** 改 path 处的值（next 按旧值算），一个场景修改；mergeKey 相同的连着的修改并成撤销的一步。 */
  const update = (path: ValuePath, next: (current: unknown) => unknown, mergeKey?: string) => {
    const file = entity();
    if (!file) return;
    let current: unknown = file;
    for (const key of path) current = current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined;
    session.apply({ type: 'set', entity: file.id, path, value: next(current) }, mergeKey);
  };
  const set = (path: ValuePath, value: unknown) => update(path, () => value);
  /** 字段编辑器交出的修改（path 相对 at，值可能是"按旧值算"的函数）。 */
  const onField = (at: ValuePath) => (path: ValuePath, value: unknown) =>
    update([...at, ...path], (current) => (typeof value === 'function' ? (value as (previous: unknown) => unknown)(current) : value));

  const curveEditor = (at: ValuePath, value: unknown, kind: 'Float' | 'Vector4') => {
    if (!isCurve(value)) {
      return <button type="button" onClick={() => set(at, curve(kind, kind === 'Float' ? [[0, 1], [1, 1]] : [[0, [1, 1, 1, 1]], [1, [1, 1, 1, 0]]]))}>{t.particleAddCurve}</button>;
    }
    // 拖一个点的一路修改并成撤销的一步，松手时结束
    const change = (next: unknown, done: boolean) => {
      update(at, () => next, `curve:${at.join('.')}`);
      if (done) session.commit();
    };
    return (
      <span>
        {String(value.$type).endsWith('Float') ? <FloatCurve value={value as never} onChange={change} /> : <ColorGradient value={value as never} onChange={change} />}
        <button type="button" onClick={() => set(at, null)} title={t.particleRemoveCurve}>×</button>
      </span>
    );
  };

  /** 一个模块的卡片：标题（种类）、上下挪、删；参数照模块库画，曲线参数画曲线编辑器，库里没有的按 JSON。 */
  const card = (module: ParticleModuleFile, at: ValuePath, actions: { up?: () => void; down?: () => void; remove?: () => void }) => {
    const spec = SPECS.get(String(module.$type ?? ''));
    return (
      <div {...css.attrs(styles.card)}>
        <div {...css.attrs(styles.cardHeader)}>
          <span {...css.attrs(styles.grow)}>{t.particleModules[String(module.$type)] ?? String(module.$type)}</span>
          {actions.up && <button type="button" title={t.particleUp} onClick={actions.up}>↑</button>}
          {actions.down && <button type="button" title={t.particleDown} onClick={actions.down}>↓</button>}
          {actions.remove && <button type="button" title={t.particleRemove} onClick={actions.remove}>×</button>}
        </div>
        {spec
          ? spec.fields.map((field) => (field.type.kind === 'json' && field.name.startsWith('sampler')
            ? (
              <div {...css.attrs(styles.curveRow)}>
                <span {...css.attrs(styles.label)}>{t.particleFields[field.name] ?? field.name}</span>
                {curveEditor([...at, field.name], module[field.name], module.$type === 'updaterColorOverTime' ? 'Vector4' : 'Float')}
              </div>
            )
            : <FieldRow field={field} value={module[field.name]} context={context} onSet={onField([...at, field.name])} />))
          : <FieldEditor type={{ kind: 'json' }} value={module} context={context} onSet={onField(at)} />}
      </div>
    );
  };

  const moved = (list: readonly ParticleModuleFile[], from: number, to: number) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  };

  return () => {
    const file = entity();
    if (!file || !system()) return <div {...css.attrs(styles.hint)}>{t.particleNoSystem}</div>;
    const list = emitters();
    const index = Math.min(emitterIndex, Math.max(0, list.length - 1));
    const emitter = list[index];
    const at: ValuePath = [...base, index];
    return (
      <div {...css.attrs(styles.panel)}>
        <div {...css.attrs(styles.toolbar)}>
          <strong>{t.particleTitle(file.name)}</strong>
          {list.map((e, i) => (
            <button type="button" {...css.attrs(styles.tab, i === index && styles.activeTab)} onClick={() => (emitterIndex = i)}>
              {String(e['emitterName'] || t.particleEmitter(i + 1))}
            </button>
          ))}
          <button type="button" onClick={() => { set(base, [...list, newEmitter(t.particleEmitter(list.length + 1))]); emitterIndex = list.length; }}>{t.particleAddEmitter}</button>
          {emitter && <button type="button" onClick={() => set(base, list.filter((_, i) => i !== index))}>{t.particleRemoveEmitter}</button>}
          <span {...css.attrs(styles.grow)} />
          <IconButton icon={CircleX} variant="ghost" aria-label={t.particleClose} onClick={() => session.closeParticles()} />
        </div>
        {emitter && (
          <div {...css.attrs(styles.body)}>
            <div {...css.attrs(styles.column)}>
              <div {...css.attrs(styles.stackTitle)}>{t.particleEmitterSettings}</div>
              {EMITTER_FIELDS.map((field) => <FieldRow field={field} value={emitter[field.name]} context={context} onSet={onField([...at, field.name])} />)}
              {SINGLES.map((stack) => {
                const module = emitter[stack] as ParticleModuleFile | null | undefined;
                const choices = PARTICLE_MODULES.filter((spec) => spec.stack === stack);
                return (
                  <div {...css.attrs(styles.column)}>
                    <div {...css.attrs(styles.stackTitle)}>
                      {t.particleStacks[stack]}
                      <select value={String(module?.$type ?? '')} onChange={(event: Event) => {
                        const type = (event.target as HTMLSelectElement).value;
                        // 换形状时留着大小、旋转的曲线
                        set([...at, stack], { ...SPECS.get(type)!.initial, ...(stack === 'shapeBuilder' && module ? { samplerSize: module['samplerSize'] ?? null, samplerRotation: module['samplerRotation'] ?? null } : {}) });
                      }}>
                        {choices.map((spec) => <option value={spec.type}>{t.particleModules[spec.type] ?? spec.type}</option>)}
                      </select>
                    </div>
                    {module && card(module, [...at, stack], {})}
                  </div>
                );
              })}
            </div>
            {LISTS.map((stack) => {
              const modules = (emitter[stack] as ParticleModuleFile[] | undefined) ?? [];
              return (
                <div {...css.attrs(styles.column)}>
                  <div {...css.attrs(styles.stackTitle)}>
                    {t.particleStacks[stack]}
                    <select value="" onChange={(event: Event) => {
                      const select = event.target as HTMLSelectElement;
                      if (select.value) set([...at, stack], [...modules, SPECS.get(select.value)!.initial]);
                      select.value = '';
                    }}>
                      <option value="">{t.particleAddModule}</option>
                      {PARTICLE_MODULES.filter((spec) => spec.stack === stack).map((spec) => <option value={spec.type}>{t.particleModules[spec.type] ?? spec.type}</option>)}
                    </select>
                  </div>
                  {modules.map((module, i) => card(module, [...at, stack, i], {
                    ...(i > 0 ? { up: () => set([...at, stack], moved(modules, i, i - 1)) } : {}),
                    ...(i < modules.length - 1 ? { down: () => set([...at, stack], moved(modules, i, i + 1)) } : {}),
                    remove: () => set([...at, stack], modules.filter((_, j) => j !== i)),
                  }))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };
});
