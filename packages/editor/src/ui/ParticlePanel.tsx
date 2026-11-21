/**
 * 粒子面板（S2；参考 Niagara 的发射器模块栈）：选中的实体的粒子系统（particleSystem 组件里的 particleSystem）。上面是发射器
 * 的页签（加、删），下面是这个发射器：自己的参数，然后按栏列出模块——生成、初始化、更新（可以加、删、上下挪）、形状、材质（各
 * 一个，可以换种类）。模块的参数照引擎的模块库（editor/particleModules.ts）画；曲线参数是小曲线编辑器，颜色曲线是渐变编辑器；
 * 库里没有的模块按 JSON 改。
 *
 * 每次修改是场景文档的一个修改（同属性面板：能撤销，视口里的粒子马上重建）；拖曲线的点时同一次拖并成一步。
 */
import { ArrowDown, ArrowUp, CircleX, Film, Plus, X } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, CurveField, GradientField, IconButton, Menu, MenuItem, NumberField, Popover, ScrollArea, Select, Tab, TabList, Tabs, type CurveKey, type GradientStop } from '@zerodep-dev/vue-tsx-pro-ui';
import type { ParticleModuleFile, SceneEntityFile } from '@stride-ts/engine/content-format';
import { curve, EMITTER_FIELDS, isCurve, newEmitter, PARTICLE_MODULES, type ParticleStackKind } from '@stride-ts/engine/editor-particles';
import { FieldEditor, FieldRow, type FieldContext, type ValuePath } from './FieldEditor';
import { t } from './messages';
import type { EditorSession, FlipbookSettings } from './session';

const SPECS = new Map(PARTICLE_MODULES.map((spec) => [spec.type, spec]));
const LISTS: readonly ParticleStackKind[] = ['spawners', 'initializers', 'updaters'];
const SINGLES: readonly ParticleStackKind[] = ['shapeBuilder', 'material'];
const small = { size: 'sm', variant: 'ghost', tone: 'neutral' } as const;

/** 文件里的曲线（Stride 的 ComputeCurveSampler + ComputeAnimationCurve）：横轴是走过的寿命 0..1。 */
interface KeyFrameFile {
  readonly key: number;
  readonly value: number | readonly number[];
  readonly tangentType?: string;
}
interface CurveFile {
  readonly $type?: string | undefined;
  readonly curve: { readonly $type?: string | undefined; readonly keyFrames: readonly KeyFrameFile[] };
}

const framesOf = (file: CurveFile) => [...file.curve.keyFrames].sort((a, b) => a.key - b.key);
const withFrames = (file: CurveFile, keyFrames: readonly KeyFrameFile[]): CurveFile => ({ ...file, curve: { ...file.curve, keyFrames } });
/** 颜色曲线的值是 0..1 的 rgba（同导入的 Stride 文件，不换色彩空间），色标的颜色是 #rrggbbaa。 */
const rgbaToHex = (value: number | readonly number[]) => `#${(Array.isArray(value) ? value : [1, 1, 1, 1]).slice(0, 4).map((c: number) => Math.round(Math.min(Math.max(c, 0), 1) * 255).toString(16).padStart(2, '0')).join('')}`;
const hexToRgba = (hex: string) => [1, 3, 5, 7].map((i) => parseInt(hex.slice(i, i + 2) || 'ff', 16) / 255);

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.8rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  tabs: { flex: '1', minWidth: '0' },
  scroll: { flex: '1', minHeight: '0' },
  body: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '_sm', padding: '_sm', alignItems: 'start' },
  column: { display: 'flex', flexDirection: 'column', gap: '6px' },
  stackTitle: { fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px', minHeight: '28px' },
  stackSelect: { flex: '1', minWidth: '0' },
  card: { borderWidth: '1px', borderStyle: 'solid', borderColor: '_borderMuted', borderRadius: '6px', padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '2px', backgroundColor: '_surfaceMuted' },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '2px', fontWeight: '600' },
  grow: { flex: '1' },
  curveRow: { display: 'grid', gridTemplateColumns: 'minmax(6em, 35%) 1fr', alignItems: 'start', gap: '_xs' },
  label: { color: '_textMuted' },
  curve: { display: 'flex', alignItems: 'flex-start', gap: '2px', minWidth: '0' },
  curveField: { flex: '1', minWidth: '0', height: '4.5em' },
  gradientField: { flex: '1', minWidth: '0' },
  bake: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '_xs', padding: '_sm', width: '20em' },
  bakeWide: { gridColumn: '1 / -1' },
  hint: { color: '_textMuted', padding: '_sm' },
});

export const ParticlePanel = _component(({ session }: { session: EditorSession }) => {
  let emitterIndex = _state(0);
  let bake = _state<FlipbookSettings>({ columns: 4, rows: 4, size: 256, seconds: 2, start: 0, view: 'front' });
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

  const curveEditor = (at: ValuePath, value: unknown, kind: 'Float' | 'Vector4', label: string) => {
    if (!isCurve(value)) {
      return <Button size="sm" variant="soft" tone="neutral" icon={Plus} onClick={() => set(at, curve(kind, kind === 'Float' ? [[0, 1], [1, 1]] : [[0, [1, 1, 1, 1]], [1, [1, 1, 1, 0]]]))}>{t.particleAddCurve}</Button>;
    }
    // 拖一个点的一路修改并成撤销的一步（vue-tsx-pro 的曲线、渐变编辑拖动中实时写回），一次操作结束时收住
    const file = value as unknown as CurveFile;
    const write = (keyFrames: readonly KeyFrameFile[]) => update(at, () => withFrames(file, keyFrames), `curve:${at.join('.')}`);
    const frames = framesOf(file);
    return (
      <span {...css.attrs(styles.curve)}>
        {String(value.$type).endsWith('Float')
          ? <CurveField {...css.attrs(styles.curveField)} aria-label={label} _value={frames.map((f) => ({ x: f.key, y: Number(f.value) }))}
              onUpdate:_value={(keys: readonly CurveKey[]) => write(keys.map((k) => ({ key: k.x, value: k.y, tangentType: 'linear' })))}
              onValueCommit={() => session.commit()} />
          : <GradientField {...css.attrs(styles.gradientField)} aria-label={label} _value={frames.map((f) => ({ offset: f.key, color: rgbaToHex(f.value) }))}
              onUpdate:_value={(stops: readonly GradientStop[]) => write(stops.map((s) => ({ key: s.offset, value: hexToRgba(s.color), tangentType: 'linear' })))}
              onValueCommit={() => session.commit()} />}
        <IconButton {...small} icon={X} aria-label={t.particleRemoveCurve} title={t.particleRemoveCurve} onClick={() => set(at, null)} />
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
          {actions.up && <IconButton {...small} icon={ArrowUp} aria-label={t.particleUp} title={t.particleUp} onClick={actions.up} />}
          {actions.down && <IconButton {...small} icon={ArrowDown} aria-label={t.particleDown} title={t.particleDown} onClick={actions.down} />}
          {actions.remove && <IconButton {...small} icon={X} aria-label={t.particleRemove} title={t.particleRemove} onClick={actions.remove} />}
        </div>
        {spec
          ? spec.fields.map((field) => (field.type.kind === 'json' && field.name.startsWith('sampler')
            ? (
              <div {...css.attrs(styles.curveRow)}>
                <span {...css.attrs(styles.label)}>{t.particleFields[field.name] ?? field.name}</span>
                {curveEditor([...at, field.name], module[field.name], module.$type === 'updaterColorOverTime' ? 'Vector4' : 'Float', t.particleFields[field.name] ?? field.name)}
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
          <Tabs {...css.attrs(styles.tabs)} size="sm" _value={String(index)} onUpdate:_value={(value: string) => (emitterIndex = Number(value))}>
            <TabList
              aria-label={t.particleEmitters}
              propsAdd={{ 'aria-label': t.particleAddEmitter }}
              onAdd={() => { set(base, [...list, newEmitter(t.particleEmitter(list.length + 1))]); emitterIndex = list.length; }}
            >
              {list.map((e, i) => (
                <Tab value={String(i)} propsClose={{ 'aria-label': t.particleRemoveEmitter }} onClose={() => set(base, list.filter((_, j) => j !== i))}>
                  {String(e['emitterName'] || t.particleEmitter(i + 1))}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          <Popover placement="bottom-end" trigger={(props) => <Button {...props} size="sm" variant="soft" tone="neutral" icon={Film} disabled={session.baking.value}>{session.baking.value ? t.particleBaking : t.particleBake}</Button>}>
            <div {...css.attrs(styles.bake)}>
              {(['columns', 'rows', 'size', 'seconds', 'start'] as const).map((key) => (
                <NumberField size="sm" prefix={t.particleBakeFields[key]} aria-label={t.particleBakeFields[key]} min={key === 'start' ? 0 : key === 'seconds' ? 0.1 : 1}
                  step={key === 'size' ? 64 : key === 'seconds' || key === 'start' ? 0.5 : 1} format={{ useGrouping: false, maximumFractionDigits: 2 }}
                  _value={bake[key]} onUpdate:_value={(value: number | null) => value !== null && (bake = { ...bake, [key]: value })} />
              ))}
              <Select size="sm" aria-label={t.particleBakeFields.view} items={(['front', 'side', 'top'] as const).map((view) => ({ value: view, label: t.particleBakeViews[view] }))}
                _value={bake.view} onUpdate:_value={(view: string | null) => view && (bake = { ...bake, view: view as FlipbookSettings['view'] })} />
              <span {...css.attrs(styles.label, styles.bakeWide)}>{t.particleBakeHint(bake.columns * bake.rows)}</span>
              <Button {...css.attrs(styles.bakeWide)} size="sm" icon={Film} disabled={session.baking.value} onClick={() => void session.bakeFlipbook(file.id, bake)}>{t.particleBake}</Button>
            </div>
          </Popover>
          <IconButton {...small} icon={CircleX} aria-label={t.particleClose} title={t.particleClose} onClick={() => session.closeParticles()} />
        </div>
        {emitter && (
          <ScrollArea {...css.attrs(styles.scroll)} propsContent={css.attrs(styles.body)}>
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
                      <Select
                        {...css.attrs(styles.stackSelect)}
                        size="sm"
                        aria-label={t.particleStacks[stack]}
                        items={choices.map((spec) => ({ value: spec.type, label: t.particleModules[spec.type] ?? spec.type }))}
                        _value={String(module?.$type ?? '')}
                        onUpdate:_value={(type: string | null) => {
                          if (!type || type === module?.$type) return;
                          // 换形状时留着大小、旋转的曲线
                          set([...at, stack], { ...SPECS.get(type)!.initial, ...(stack === 'shapeBuilder' && module ? { samplerSize: module['samplerSize'] ?? null, samplerRotation: module['samplerRotation'] ?? null } : {}) });
                        }}
                      />
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
                    <Menu trigger={(props) => <IconButton {...props} {...small} icon={Plus} aria-label={t.particleAddModule} title={t.particleAddModule} />}>
                      {PARTICLE_MODULES.filter((spec) => spec.stack === stack).map((spec) => (
                        <MenuItem onAction={() => set([...at, stack], [...modules, spec.initial])}>{t.particleModules[spec.type] ?? spec.type}</MenuItem>
                      ))}
                    </Menu>
                  </div>
                  {modules.map((module, i) => card(module, [...at, stack, i], {
                    ...(i > 0 ? { up: () => set([...at, stack], moved(modules, i, i - 1)) } : {}),
                    ...(i < modules.length - 1 ? { down: () => set([...at, stack], moved(modules, i, i + 1)) } : {}),
                    remove: () => set([...at, stack], modules.filter((_, j) => j !== i)),
                  }))}
                </div>
              );
            })}
          </ScrollArea>
        )}
      </div>
    );
  };
});
