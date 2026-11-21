import { Clapperboard, FolderTree, ListTree, SlidersHorizontal, Sparkles, Workflow } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { usePersistentState } from '@zerodep-dev/vue-tsx-pro-ui';
import { defaultWorkbenchLayout, Workbench, type WorkbenchWindow } from '@zerodep-dev/vue-tsx-pro-ui/patterns';
import { onMounted, onUnmounted } from 'vue';
import { AssetBrowser } from './AssetBrowser';
import { GraphPanel } from './GraphPanel';
import { Inspector } from './Inspector';
import { t } from './messages';
import { ParticlePanel } from './ParticlePanel';
import { SceneTree } from './SceneTree';
import type { EditorSession } from './session';
import { TimelinePanel } from './TimelinePanel';
import { DocumentTabs, MainToolbar, StatusBar, ViewportToolbar } from './Toolbars';
import { Viewport } from './Viewport';

const styles = css.create({
  center: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' },
  viewport: { flex: '1', minHeight: '0', position: 'relative' },
});

/**
 * 编辑器的整个界面（vue-tsx-pro 的 Workbench，布局参考 JetBrains IDE）：最上面是主工具条；中间是视口，上面是文档页签和视口
 * 工具条；工具窗口停在四周——左边场景树（上）和资源（下），右边属性面板，下边是正在编辑的时间轴、节点图或粒子（打开它们时
 * 自动出来，关掉时收起）；两侧竖条上的图标显示、收起它们，布局记在浏览器里；最下面是状态栏。
 */
export const App = _component(({ session }: { session: EditorSession }) => {
  let playing = _state(false);
  const { dirty, version } = session;

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

  const windows = (): WorkbenchWindow[] => [
    { id: 'scene', title: t.toolWindows.scene, icon: ListTree, anchor: 'left', scroll: 'self', content: () => <SceneTree session={session} /> },
    { id: 'assets', title: t.toolWindows.assets, icon: FolderTree, anchor: 'leftBottom', scroll: 'self', content: () => <AssetBrowser session={session} /> },
    { id: 'inspector', title: t.toolWindows.inspector, icon: SlidersHorizontal, anchor: 'right', content: () => <Inspector session={session} /> },
    {
      id: 'timeline', title: t.toolWindows.timeline, icon: Clapperboard, anchor: 'bottom', scroll: 'self', showWhenAvailable: true,
      available: session.timeline.value !== undefined, ...(session.timeline.value ? { detail: session.timeline.value.path } : {}),
      content: () => <TimelinePanel session={session} />,
    },
    {
      id: 'graph', title: t.toolWindows.graph, icon: Workflow, anchor: 'bottom', scroll: 'self', showWhenAvailable: true,
      available: session.graphOpen.value && session.inspected.value?.kind === 'material', ...(session.inspected.value ? { detail: session.inspected.value.path } : {}),
      content: () => <GraphPanel session={session} />,
    },
    {
      id: 'particles', title: t.toolWindows.particles, icon: Sparkles, anchor: 'bottom', scroll: 'self', showWhenAvailable: true,
      available: session.particleEntity.value !== undefined,
      // 场景打开以前取不到实体（打开之前也不会开着粒子编辑器）
      detail: session.particleEntity.value === undefined ? '' : session.expanded.find((e) => e.id === session.particleEntity.value)?.name ?? '',
      content: () => <ParticlePanel session={session} />,
    },
  ];
  // 显示哪些、各占多大记在这台机器的浏览器里
  let layout = _fromRef(usePersistentState('stride-editor.workbench', defaultWorkbenchLayout(windows())));

  return () => {
    void version.value;
    return (
      <Workbench
        windows={windows()}
        _layout={layout}
        header={<MainToolbar session={session} playing={playing} onTogglePlay={() => void togglePlay()} />}
        footer={<StatusBar session={session} />}
      >
        <div {...css.attrs(styles.center)}>
          <DocumentTabs session={session} playing={playing} />
          <ViewportToolbar session={session} playing={playing} />
          <div {...css.attrs(styles.viewport)}>
            <Viewport session={session} playing={playing} onShortcut={shortcut} />
          </div>
        </div>
      </Workbench>
    );
  };
});
