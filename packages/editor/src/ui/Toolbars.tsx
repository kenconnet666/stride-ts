/**
 * 工作台的几条横栏（参考 JetBrains IDE）：
 * - MainToolbar：最上面，工程名、保存、撤销重做，右边是试玩（运行）；
 * - DocumentTabs：视口上面打开的文档的页签（场景；编辑预制体时再多一个预制体的页签，关掉它回到场景）；
 * - ViewportToolbar：视口上面，对选中实体的操作、吸附、画幅参考线；
 * - StatusBar：最下面，提示和出错、选中几个、界面语言。
 */
import { ClipboardPaste, Copy, CopyPlus, Magnet, Package, Play, Plus, Redo2, Save, Square, Trash2, Undo2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton, NumberField, Select, Separator, Tab, TabList, Tabs } from '@zerodep-dev/vue-tsx-pro-ui';
import { LOCALES, locale, setLocale, type Locale } from './i18n';
import { t } from './messages';
import type { EditorSession } from './session';

/** 画幅参考线的选项：名字和宽高比（0 是关）。 */
const FRAME_GUIDES: readonly (readonly [string, number])[] = [['', 0], ['16:9', 16 / 9], ['9:16', 9 / 16], ['2.39:1', 2.39], ['1.85:1', 1.85], ['4:3', 4 / 3], ['1:1', 1]];

const bar = { display: 'flex', alignItems: 'center', gap: '2px', flexShrink: '0', paddingInline: '_xs' } as const;

const styles = css.create({
  main: { ...bar, height: '40px', backgroundColor: '_surfaceRaised', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  brand: { fontWeight: '700', paddingInline: '_sm', whiteSpace: 'nowrap' },
  project: { color: '_textMuted', paddingInlineEnd: '_sm', whiteSpace: 'nowrap' },
  spacer: { flex: '1' },
  tabs: { flexShrink: '0', backgroundColor: '_surfaceRaised' },
  viewport: { ...bar, height: '34px', backgroundColor: '_surface', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  step: { width: '6.5em' },
  guide: { width: '8em' },
  status: { ...bar, height: '24px', gap: '_sm', paddingInline: '_sm', fontSize: '0.75rem', color: '_textMuted', backgroundColor: '_surfaceRaised', borderBlockStartWidth: '1px', borderBlockStartStyle: 'solid', borderBlockStartColor: '_borderMuted' },
  message: { flex: '1', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  notice: { color: '_dangerText' },
  language: { width: '7em' },
});

const iconProps = { size: 'sm', variant: 'ghost', tone: 'neutral' } as const;

export const MainToolbar = _component(({ session, playing, onTogglePlay }: { session: EditorSession; playing: boolean; onTogglePlay: () => void }) => {
  return () => (
    <div {...css.attrs(styles.main)} role="toolbar" aria-label={t.mainToolbar}>
      <span {...css.attrs(styles.brand)}>Stride</span>
      <span {...css.attrs(styles.project)}>{session.project.value?.name ?? ''}</span>
      <Separator orientation="vertical" />
      <IconButton {...iconProps} icon={Save} aria-label={t.save} title={`${t.save} (Ctrl+S)`} disabled={!session.dirty.value || playing} onClick={() => void session.save()} />
      <IconButton {...iconProps} icon={Undo2} aria-label={t.undo} title={`${t.undo} (Ctrl+Z)`} disabled={!session.canUndo || playing} onClick={() => session.undo()} />
      <IconButton {...iconProps} icon={Redo2} aria-label={t.redo} title={`${t.redo} (Ctrl+Y)`} disabled={!session.canRedo || playing} onClick={() => session.redo()} />
      <span {...css.attrs(styles.spacer)} />
      {playing
        ? <IconButton size="sm" variant="soft" tone="danger" icon={Square} aria-label={t.stopPlaying} title={t.stopPlaying} onClick={onTogglePlay} />
        : <IconButton size="sm" variant="ghost" tone="success" icon={Play} aria-label={t.play} title={t.play} onClick={onTogglePlay} />}
    </div>
  );
});

/** 文档的页签：文件名（没存的带 •），悬停看路径。 */
export const DocumentTabs = _component(({ session, playing }: { session: EditorSession; playing: boolean }) => {
  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return () => {
    const opened = session.opened.value;
    const scene = session.scene.value;
    if (!opened) return <div {...css.attrs(styles.tabs)} />;
    const prefab = opened.kind === 'prefab' ? opened : undefined;
    const dirty = session.dirty.value ? ' •' : '';
    const back = () => scene && !playing && void session.openAsset(scene);
    return (
      <Tabs {...css.attrs(styles.tabs)} size="sm" _value={opened.path} onUpdate:_value={(path: string) => path === scene?.path && back()}>
        <TabList aria-label={t.openDocuments}>
          {scene && scene.path !== prefab?.path && <Tab value={scene.path} title={scene.path}>{name(scene.path) + (prefab ? '' : dirty)}</Tab>}
          {prefab && <Tab value={prefab.path} title={t.prefabTitle(prefab.path)} {...(scene ? { onClose: back } : {})}>{name(prefab.path) + dirty}</Tab>}
        </TabList>
      </Tabs>
    );
  };
});

export const ViewportToolbar = _component(({ session, playing }: { session: EditorSession; playing: boolean }) => {
  /** 吸附：开关（拖操纵器时按住 Ctrl 反过来）和移动、旋转、缩放的步长。 */
  const snapControls = () => {
    const snap = session.snap.value;
    if (!snap) return undefined;
    const step = (key: 'translate' | 'rotate' | 'scale', min: number) => (
      <NumberField
        {...css.attrs(styles.step)}
        size="sm"
        prefix={t.snapStep[key].label}
        title={t.snapStep[key].title}
        aria-label={t.snapStep[key].title}
        min={min}
        step={key === 'rotate' ? 5 : 0.1}
        format={{ useGrouping: false, maximumFractionDigits: 4 }}
        _value={snap[key]}
        onUpdate:_value={(value: number | null) => value !== null && value > 0 && session.setSnap({ [key]: value })}
      />
    );
    return [
      <IconButton {...iconProps} icon={Magnet} variant={snap.enabled ? 'soft' : 'ghost'} aria-pressed={snap.enabled} aria-label={snap.enabled ? t.snapOn : t.snapOff} title={snap.enabled ? t.snapOn : t.snapOff} onClick={() => session.setSnap({ enabled: !snap.enabled })} />,
      step('translate', 0.001),
      step('rotate', 0.01),
      step('scale', 0.001),
    ];
  };
  return () => {
    const selected = session.selection.value.length;
    const off = playing;
    return (
      <div {...css.attrs(styles.viewport)} role="toolbar" aria-label={t.viewportToolbar}>
        <IconButton {...iconProps} icon={Plus} aria-label={t.addEntity} title={t.addEntity} disabled={!session.agent.value || off} onClick={() => void session.addEntity(selected === 1 ? session.selection.value[0]! : null)} />
        <IconButton {...iconProps} icon={Trash2} aria-label={t.deleteSelection} title={`${t.deleteSelection} (Delete)`} disabled={selected === 0 || off} onClick={() => session.deleteSelection()} />
        <IconButton {...iconProps} icon={Copy} aria-label={t.copySelection} title={`${t.copySelection} (Ctrl+C)`} disabled={selected === 0 || off} onClick={() => session.copySelection()} />
        <IconButton {...iconProps} icon={ClipboardPaste} aria-label={t.paste} title={`${t.paste} (Ctrl+V)`} disabled={!session.clipboard.value || off} onClick={() => void session.paste()} />
        <IconButton {...iconProps} icon={CopyPlus} aria-label={t.duplicate} title={`${t.duplicate} (Ctrl+D)`} disabled={selected === 0 || off} onClick={() => void session.duplicateSelection()} />
        <IconButton {...iconProps} icon={Package} aria-label={t.makePrefab} title={t.makePrefab} disabled={selected !== 1 || off} onClick={() => void session.makePrefabFromSelection()} />
        <Separator orientation="vertical" />
        {snapControls()}
        <span {...css.attrs(styles.spacer)} />
        <Select
          {...css.attrs(styles.guide)}
          size="sm"
          aria-label={t.frameGuide}
          title={t.frameGuide}
          items={FRAME_GUIDES.map(([label, aspect]) => ({ value: String(aspect), label: aspect === 0 ? t.frameGuideOff : label }))}
          _value={String(session.frameGuide.value)}
          onUpdate:_value={(value: string | null) => (session.frameGuide.value = Number(value ?? 0))}
        />
      </div>
    );
  };
});

export const StatusBar = _component(({ session }: { session: EditorSession }) => {
  return () => {
    const notice = session.notice.value;
    const message = notice || session.status.value;
    const selected = session.selection.value.length;
    return (
      <footer {...css.attrs(styles.status)}>
        <span {...css.attrs(styles.message, notice ? styles.notice : undefined)} role="status" title={message}>{message}</span>
        {selected > 0 && <span>{t.selectedCount(selected)}</span>}
        <Select
          {...css.attrs(styles.language)}
          size="xs"
          variant="soft"
          aria-label={t.language}
          title={t.language}
          items={(Object.keys(LOCALES) as Locale[]).map((code) => ({ value: code, label: LOCALES[code] }))}
          _value={locale.value}
          onUpdate:_value={(value: string | null) => value && setLocale(value as Locale)}
        />
      </footer>
    );
  };
});
