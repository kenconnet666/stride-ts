import { Play, Redo2, Save, Square, Undo2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton, Splitter } from '@zerodep-dev/vue-tsx-pro-ui';
import { onMounted, onUnmounted } from 'vue';
import { AssetBrowser } from './AssetBrowser';
import { Inspector } from './Inspector';
import { SceneTree } from './SceneTree';
import type { EditorSession } from './session';
import { Viewport } from './Viewport';

const styles = css.create({
  app: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '_background', color: '_text' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  title: { marginInlineStart: '_sm', color: '_textMuted', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  spacer: { flex: '1' },
  body: { flex: '1', minHeight: '0' },
  fill: { height: '100%' },
});

/** 编辑器的整个界面：工具条；左边场景树，中间视口（游戏页面），右边属性面板；下面资源。 */
export const App = _component(({ session }: { session: EditorSession }) => {
  let playing = _state(false);
  const { dirty, scenePath, version } = session;

  const shortcut = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 's') void session.save();
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
          <IconButton icon={playing ? Square : Play} aria-label={playing ? '停止试玩' : '试玩'} onClick={() => void togglePlay()} />
          <span {...css.attrs(styles.title)}>{scenePath.value ?? '……'}{dirty.value ? ' *' : ''}</span>
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
