import { ClipboardPaste, Copy, CopyPlus, Magnet, Package, Play, Plus, Redo2, Save, Square, Trash2, Undo2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, Splitter } from '@zerodep-dev/vue-tsx-pro-ui';
import { onMounted, onUnmounted } from 'vue';
import { AssetBrowser } from './AssetBrowser';
import { LOCALES, locale, setLocale, type Locale } from './i18n';
import { Inspector } from './Inspector';
import { t } from './messages';
import { SceneTree } from './SceneTree';
import { GraphPanel } from './GraphPanel';
import { TimelinePanel } from './TimelinePanel';
import type { EditorSession } from './session';
import { Viewport } from './Viewport';

/** 画幅参考线的选项：名字和宽高比（0 是关）。 */
const FRAME_GUIDES: readonly (readonly [string, number])[] = [['', 0], ['16:9', 16 / 9], ['9:16', 9 / 16], ['2.39:1', 2.39], ['1.85:1', 1.85], ['4:3', 4 / 3], ['1:1', 1]];

const styles = css.create({
  app: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '_background', color: '_text' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  notice: { marginInlineStart: '_sm', color: '_dangerText', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  title: { marginInlineStart: '_sm', color: '_textMuted', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  spacer: { flex: '1' },
  snap: { display: 'flex', alignItems: 'center', gap: '_sm', marginInlineStart: '_sm', color: '_textMuted', fontSize: '0.8rem' },
  step: { width: '3.6em', marginInlineStart: '_xs' },
  language: { fontSize: '0.8rem' },
  body: { flex: '1', minHeight: '0' },
  // 分栏里套的分栏铺满那一栏：栏里的滚动区域的内容层按内容定高，height: 100% 撑不住，长的属性面板会把整排（场景树、视口）
  // 一起撑高、一起滚；绝对定位到滚动区域（它是 relative）上，各栏自己滚
  fill: { position: 'absolute', inset: '0' },
});

/** 编辑器的整个界面：工具条；左边场景树，中间视口（游戏页面），右边属性面板；下面资源。 */
export const App = _component(({ session }: { session: EditorSession }) => {
  let playing = _state(false);
  const { dirty, opened, scene, version } = session;

  const shortcut = (event: KeyboardEvent) => {
    // 在输入框里按 Delete 是删字
    const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]');
    if (event.key === 'Delete' && !typing && !playing) {
      session.deleteSelection();
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    // 复制粘贴实体：在输入框里是复制粘贴文字
    if ((key === 'c' || key === 'v' || key === 'd') && (typing || playing)) return;
    if (key === 's') void session.save();
    else if (key === 'c') session.copySelection();
    else if (key === 'v') void session.paste(event.shiftKey);
    else if (key === 'd') void session.duplicateSelection();
    else if (key === 'z' && !event.shiftKey) session.undo();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) session.redo();
    else return;
    event.preventDefault();
  };
  onMounted(() => {
    window.addEventListener('keydown', shortcut);
    void session.start();
  });
  onUnmounted(() => window.removeEventListener('keydown', shortcut));

  // 试玩是不带编辑状态重新打开游戏页面，读的是磁盘上的文件：先保存
  const togglePlay = async () => {
    if (!playing && dirty.value) await session.save();
    playing = !playing;
  };

  /** 吸附：开关（拖操纵器时按住 Ctrl 反过来）和移动、旋转、缩放的步长。 */
  const snapControls = () => {
    const snap = session.snap.value;
    if (!snap) return undefined;
    const step = (key: 'translate' | 'rotate' | 'scale', min: number) => (
      <label title={t.snapStep[key].title}>
        {t.snapStep[key].label}
        <input {...css.attrs(styles.step)} type="number" min={min} step="any" value={snap[key]} onChange={(event: Event) => {
          const value = Number((event.target as HTMLInputElement).value);
          if (Number.isFinite(value) && value > 0) session.setSnap({ [key]: value });
        }} />
      </label>
    );
    return (
      <span {...css.attrs(styles.snap)} role="group" aria-label={t.snap}>
        <IconButton icon={Magnet} variant={snap.enabled ? 'soft' : 'ghost'} aria-pressed={snap.enabled} aria-label={snap.enabled ? t.snapOn : t.snapOff} onClick={() => session.setSnap({ enabled: !snap.enabled })} />
        {step('translate', 0.001)}
        {step('rotate', 0.01)}
        {step('scale', 0.001)}
      </span>
    );
  };

  return () => {
    void version.value;
    return (
      <div {...css.attrs(styles.app)}>
        <div {...css.attrs(styles.toolbar)} role="toolbar">
          <IconButton icon={Save} aria-label={t.save} disabled={!dirty.value || playing} onClick={() => void session.save()} />
          <IconButton icon={Undo2} aria-label={t.undo} disabled={!session.canUndo || playing} onClick={() => session.undo()} />
          <IconButton icon={Redo2} aria-label={t.redo} disabled={!session.canRedo || playing} onClick={() => session.redo()} />
          <IconButton icon={Plus} aria-label={t.addEntity} disabled={!session.agent.value || playing} onClick={() => void session.addEntity(session.selection.value.length === 1 ? session.selection.value[0]! : null)} />
          <IconButton icon={Trash2} aria-label={t.deleteSelection} disabled={session.selection.value.length === 0 || playing} onClick={() => session.deleteSelection()} />
          <IconButton icon={Copy} aria-label={t.copySelection} disabled={session.selection.value.length === 0 || playing} onClick={() => session.copySelection()} />
          <IconButton icon={ClipboardPaste} aria-label={t.paste} disabled={!session.clipboard.value || playing} onClick={() => void session.paste()} />
          <IconButton icon={CopyPlus} aria-label={t.duplicate} disabled={session.selection.value.length === 0 || playing} onClick={() => void session.duplicateSelection()} />
          <IconButton icon={Package} aria-label={t.makePrefab} disabled={session.selection.value.length !== 1 || playing} onClick={() => void session.makePrefabFromSelection()} />
          <IconButton icon={playing ? Square : Play} aria-label={playing ? t.stopPlaying : t.play} onClick={() => void togglePlay()} />
          {snapControls()}
          <span {...css.attrs(styles.title)}>{opened.value ? (opened.value.kind === 'prefab' ? t.prefabTitle(opened.value.path) : opened.value.path) : '……'}{dirty.value ? ' *' : ''}</span>
          {session.notice.value
            ? <span {...css.attrs(styles.notice)} role="status" title={session.notice.value}>{session.notice.value}</span>
            : session.status.value && <span {...css.attrs(styles.title)} role="status" title={session.status.value}>{session.status.value}</span>}
          {opened.value?.kind === 'prefab' && scene.value && (
            <Button size="sm" variant="ghost" disabled={playing} onClick={() => void session.openAsset(scene.value!)}>{t.backToScene(scene.value.path.slice(scene.value.path.lastIndexOf('/') + 1))}</Button>
          )}
          <span {...css.attrs(styles.spacer)} />
          <select {...css.attrs(styles.language)} aria-label={t.frameGuide} title={t.frameGuide} value={String(session.frameGuide.value)} onChange={(event: Event) => (session.frameGuide.value = Number((event.target as HTMLSelectElement).value))}>
            {FRAME_GUIDES.map(([label, aspect]) => <option value={String(aspect)}>{aspect === 0 ? t.frameGuideOff : label}</option>)}
          </select>
          <select {...css.attrs(styles.language)} aria-label={t.language} title={t.language} value={locale.value} onChange={(event: Event) => setLocale((event.target as HTMLSelectElement).value as Locale)}>
            {(Object.keys(LOCALES) as Locale[]).map((code) => <option value={code}>{LOCALES[code]}</option>)}
          </select>
        </div>
        <Splitter
          {...css.attrs(styles.body)}
          orientation="vertical"
          // 节点图开着时下面让出一半高度（节点、参数要地方）
          _size={session.graphOpen.value && session.inspected.value?.kind === 'material' ? 50 : 78}
          maxSize={92}
          start={
            <Splitter
              {...css.attrs(styles.fill)}
              _size={18}
              minSize={10}
              start={<SceneTree session={session} />}
              end={
                <Splitter
                  {...css.attrs(styles.fill)}
                  _size={74}
                  start={<Viewport session={session} playing={playing} onShortcut={shortcut} />}
                  end={<Inspector session={session} />}
                />
              }
            />
          }
          end={session.timeline.value ? (
            <Splitter {...css.attrs(styles.fill)} _size={30} minSize={15} start={<AssetBrowser session={session} />} end={<TimelinePanel session={session} />} />
          ) : session.graphOpen.value && session.inspected.value?.kind === 'material' ? (
            <Splitter {...css.attrs(styles.fill)} _size={22} minSize={12} start={<AssetBrowser session={session} />} end={<GraphPanel session={session} />} />
          ) : <AssetBrowser session={session} />}
        />
      </div>
    );
  };
});
