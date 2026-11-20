import { ClipboardPaste, Copy, CopyPlus, Play, Plus, Redo2, Save, Square, Trash2, Undo2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, Splitter } from '@zerodep-dev/vue-tsx-pro-ui';
import { onMounted, onUnmounted } from 'vue';
import { AssetBrowser } from './AssetBrowser';
import { Inspector } from './Inspector';
import { SceneTree } from './SceneTree';
import type { EditorSession } from './session';
import { Viewport } from './Viewport';

const styles = css.create({
  app: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '_background', color: '_text' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  notice: { marginInlineStart: '_sm', color: '_dangerText', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  title: { marginInlineStart: '_sm', color: '_textMuted', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  spacer: { flex: '1' },
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

  return () => {
    void version.value;
    return (
      <div {...css.attrs(styles.app)}>
        <div {...css.attrs(styles.toolbar)} role="toolbar">
          <IconButton icon={Save} aria-label="保存（Ctrl+S）" disabled={!dirty.value || playing} onClick={() => void session.save()} />
          <IconButton icon={Undo2} aria-label="撤销（Ctrl+Z）" disabled={!session.canUndo || playing} onClick={() => session.undo()} />
          <IconButton icon={Redo2} aria-label="重做（Ctrl+Y）" disabled={!session.canRedo || playing} onClick={() => session.redo()} />
          <IconButton icon={Plus} aria-label="加实体（选中的实体下面）" disabled={!session.agent.value || playing} onClick={() => void session.addEntity(session.selection.value.length === 1 ? session.selection.value[0]! : null)} />
          <IconButton icon={Trash2} aria-label="删掉选中的实体（Delete）" disabled={session.selection.value.length === 0 || playing} onClick={() => session.deleteSelection()} />
          <IconButton icon={Copy} aria-label="复制选中的实体（Ctrl+C）" disabled={session.selection.value.length === 0 || playing} onClick={() => session.copySelection()} />
          <IconButton icon={ClipboardPaste} aria-label="粘贴到选中的实体后面（Ctrl+V；Ctrl+Shift+V 粘贴成它的子实体）" disabled={!session.clipboard.value || playing} onClick={() => void session.paste()} />
          <IconButton icon={CopyPlus} aria-label="复制一份（Ctrl+D）" disabled={session.selection.value.length === 0 || playing} onClick={() => void session.duplicateSelection()} />
          <IconButton icon={playing ? Square : Play} aria-label={playing ? '停止试玩' : '试玩'} onClick={() => void togglePlay()} />
          <span {...css.attrs(styles.title)}>{opened.value ? `${opened.value.kind === 'prefab' ? '预制体 ' : ''}${opened.value.path}` : '……'}{dirty.value ? ' *' : ''}</span>
          {session.notice.value && <span {...css.attrs(styles.notice)} role="status" title={session.notice.value}>{session.notice.value}</span>}
          {opened.value?.kind === 'prefab' && scene.value && (
            <Button size="sm" variant="ghost" disabled={playing} onClick={() => void session.openAsset(scene.value!)}>回到场景 {scene.value.path.slice(scene.value.path.lastIndexOf('/') + 1)}</Button>
          )}
          <span {...css.attrs(styles.spacer)} />
        </div>
        <Splitter
          {...css.attrs(styles.body)}
          orientation="vertical"
          _size={78}
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
          end={<AssetBrowser session={session} />}
        />
      </div>
    );
  };
});
