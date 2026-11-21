import { Clapperboard, FolderTree, Images, ListTree, SlidersHorizontal, Sparkles, Workflow } from '@lucide/icons';
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
import { SpriteSheetPanel } from './SpriteSheetPanel';
import type { EditorSession } from './session';
import { TimelinePanel } from './TimelinePanel';
import { DocumentTabs, MainToolbar, StatusBar, ViewportToolbar } from './Toolbars';
import { Viewport } from './Viewport';

const styles = css.create({
  center: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' },
  viewport: { flex: '1', minHeight: '0', position: 'relative' },
});

/** 连按两下 Shift 算一次的间隔（毫秒），同 JetBrains 的默认。 */
const DOUBLE_SHIFT_MS = 300;

/**
 * 事件落在输入框里（敲字、复制粘贴文字）。视口里的事件来自 iframe 的文档，那边的 Element 不是这个窗口的，所以不用 instanceof。
 */
function editingText(target: EventTarget | null): boolean {
  return Boolean((target as Partial<Element> | null)?.closest?.('input, textarea, select, [contenteditable]'));
}

/** 事件所在的文档里选着文字（复制面板上的文字），这时复制的是文字不是实体。 */
function hasTextSelection(target: EventTarget | null): boolean {
  const view = (target as Partial<Node> | null)?.ownerDocument?.defaultView ?? window;
  return view.getSelection()?.isCollapsed === false;
}

/**
 * 编辑器的整个界面（vue-tsx-pro 的 Workbench，布局参考 JetBrains IDE）：最上面是主工具条；中间是视口，上面是文档页签和视口
 * 工具条；工具窗口停在四周——左边场景树（上）和资源（下），右边属性面板，下边是正在编辑的时间轴、节点图或粒子（打开它们时
 * 自动出来，关掉时收起）；两侧竖条上的图标显示、收起它们，布局记在浏览器里；最下面是状态栏。
 */
export const App = _component(({ session }: { session: EditorSession }) => {
  let playing = _state(false);
  const { dirty, version } = session;

  // Ctrl+Shift+V 粘贴成子实体：paste 事件不带按键，按下时记着
  let pasteAsChild = false;
  // 连按两下 Shift 打开到处搜（同 JetBrains）：上一次单独按下 Shift 的时刻
  let lastShift = 0;

  const shortcut = (event: KeyboardEvent) => {
    if (event.key === 'Shift' && !event.repeat) {
      const now = performance.now();
      if (now - lastShift < DOUBLE_SHIFT_MS) session.palette.value = true;
      lastShift = now;
      return;
    }
    lastShift = 0;
    // 在输入框里按 Delete 是删字
    const typing = editingText(event.target);
    if (event.key === 'Delete' && !typing && !playing) {
      session.deleteSelection();
      event.preventDefault();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    // 复制粘贴实体：在输入框里是复制粘贴文字
    if ((key === 'c' || key === 'x' || key === 'v' || key === 'd') && (typing || playing)) return;
    // 复制、剪切、粘贴走浏览器的 copy、cut、paste 事件（clipboard），那里能读写系统剪贴板
    if (key === 'v') pasteAsChild = event.shiftKey;
    if (key === 'c' || key === 'x' || key === 'v') return;
    if (key === 's') void session.save();
    else if (key === 'k') session.palette.value = true;
    else if (key === 'd') void session.duplicateSelection();
    else if (key === 'z' && !event.shiftKey) session.undo();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) session.redo();
    else return;
    event.preventDefault();
  };
  /** 复制、剪切选中的实体进系统剪贴板，从系统剪贴板粘贴（别的标签页复制的也行）；在输入框里、选着文字时是文字的。 */
  const clipboard = (event: ClipboardEvent) => {
    const data = event.clipboardData;
    if (!data || playing || editingText(event.target)) return;
    if (event.type === 'paste') {
      event.preventDefault();
      void session.paste(pasteAsChild, data.getData('text/plain'));
      pasteAsChild = false;
      return;
    }
    if (hasTextSelection(event.target)) return;
    const text = session.copySelection();
    if (text === undefined) return;
    data.setData('text/plain', text);
    event.preventDefault();
    if (event.type === 'cut') session.deleteSelection();
  };
  const CLIPBOARD_EVENTS = ['copy', 'cut', 'paste'] as const;

  onMounted(() => {
    window.addEventListener('keydown', shortcut);
    for (const type of CLIPBOARD_EVENTS) window.addEventListener(type, clipboard);
    void session.start();
  });
  onUnmounted(() => {
    window.removeEventListener('keydown', shortcut);
    for (const type of CLIPBOARD_EVENTS) window.removeEventListener(type, clipboard);
  });

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
      id: 'sprites', title: t.toolWindows.sprites, icon: Images, anchor: 'bottom', scroll: 'self', showWhenAvailable: true,
      available: session.inspected.value?.kind === 'spriteSheet', ...(session.inspected.value ? { detail: session.inspected.value.path } : {}),
      content: () => <SpriteSheetPanel session={session} />,
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
            <Viewport session={session} playing={playing} onShortcut={shortcut} onClipboard={clipboard} />
          </div>
        </div>
      </Workbench>
    );
  };
});
