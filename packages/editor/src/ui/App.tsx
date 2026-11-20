import { Clapperboard, FolderTree, ListTree, SlidersHorizontal, Sparkles, Workflow } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Splitter } from '@zerodep-dev/vue-tsx-pro-ui';
import { onMounted, onUnmounted, watch, type VNodeChild } from 'vue';
import { AssetBrowser } from './AssetBrowser';
import { GraphPanel } from './GraphPanel';
import { Inspector } from './Inspector';
import { hideToolWindow, layout, resizeLayout, showToolWindow, type ToolWindowId } from './layout';
import { ParticlePanel } from './ParticlePanel';
import { SceneTree } from './SceneTree';
import type { EditorSession } from './session';
import { TimelinePanel } from './TimelinePanel';
import { DocumentTabs, MainToolbar, StatusBar, ViewportToolbar } from './Toolbars';
import { ToolStripe, ToolWindow } from './ToolWindow';
import { Viewport } from './Viewport';

const styles = css.create({
  app: { display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '_background', color: '_text' },
  body: { flex: '1', minHeight: '0', display: 'flex' },
  work: { flex: '1', minWidth: '0', position: 'relative' },
  // 分栏里套的分栏铺满那一栏：栏里的滚动区域的内容层按内容定高，height: 100% 撑不住，长的属性面板会把整排（场景树、视口）
  // 一起撑高、一起滚；绝对定位到滚动区域（它是 relative）上，各栏自己滚
  fill: { position: 'absolute', inset: '0' },
  center: { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' },
  viewport: { flex: '1', minHeight: '0', position: 'relative' },
  hidden: { display: 'none' },
});

const hiddenToggle = { sx: styles.hidden };

/**
 * 编辑器的整个界面（布局参考 JetBrains IDE）：最上面是主工具条；中间是视口，上面是文档页签和视口工具条；工具窗口停在
 * 四周——左边场景树（上）和资源（下），右边属性面板，下边是正在编辑的时间轴、节点图或粒子；两侧竖条上的图标显示、收起
 * 它们（layout.ts）；最下面是状态栏。
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

  // 下边的工具窗口跟着正在编辑的东西：打开时间轴、节点图、粒子编辑器时显示出来，关掉时收起
  const bottomAvailable = (): Readonly<Record<'timeline' | 'graph' | 'particles', boolean>> => ({
    timeline: session.timeline.value !== undefined,
    graph: session.graphOpen.value && session.inspected.value?.kind === 'material',
    particles: session.particleEntity.value !== undefined,
  });
  watch(bottomAvailable, (now, before) => {
    for (const id of ['timeline', 'graph', 'particles'] as const) {
      if (now[id] && !before?.[id]) showToolWindow(id);
      else if (!now[id] && before?.[id]) hideToolWindow(id);
    }
  });

  // 试玩是不带编辑状态重新打开游戏页面，读的是磁盘上的文件：先保存
  const togglePlay = async () => {
    if (!playing && dirty.value) await session.save();
    playing = !playing;
  };

  /** 把一个工具窗口铺满它所在的那一栏。 */
  const fill = (child: VNodeChild) => <div {...css.attrs(styles.fill)}>{child}</div>;

  const windows: Record<ToolWindowId, () => VNodeChild> = {
    scene: () => <ToolWindow id="scene"><SceneTree session={session} /></ToolWindow>,
    assets: () => <ToolWindow id="assets"><AssetBrowser session={session} /></ToolWindow>,
    inspector: () => <ToolWindow id="inspector"><Inspector session={session} /></ToolWindow>,
    timeline: () => <ToolWindow id="timeline" detail={session.timeline.value?.path}><TimelinePanel session={session} /></ToolWindow>,
    graph: () => <ToolWindow id="graph" detail={session.inspected.value?.path}><GraphPanel session={session} /></ToolWindow>,
    particles: () => <ToolWindow id="particles" detail={session.expanded.find((e) => e.id === session.particleEntity.value)?.name}><ParticlePanel session={session} /></ToolWindow>,
  };

  /** 左栏：上下两个工具窗口都显示时上下分开。 */
  const leftArea = () => {
    const { left, leftSplit } = layout.value.shown;
    if (left && leftSplit) {
      return (
        <Splitter {...css.attrs(styles.fill)} orientation="vertical" _size={layout.value.leftSplitSize} minSize={15} maxSize={85}
          onUpdate:_size={(size: number) => resizeLayout({ leftSplitSize: size })}
          start={fill(windows[left]())} end={fill(windows[leftSplit]())} />
      );
    }
    const only = left ?? leftSplit;
    return only && fill(windows[only]());
  };

  const center = () => (
    <div {...css.attrs(styles.center)}>
      <DocumentTabs session={session} playing={playing} />
      <ViewportToolbar session={session} playing={playing} />
      <div {...css.attrs(styles.viewport)}>
        <Viewport session={session} playing={playing} onShortcut={shortcut} />
      </div>
    </div>
  );

  /** 拖开收着的一边：显示这一边默认的工具窗口（下边是能用的第一个）。 */
  const expand = (side: 'left' | 'right' | 'bottom') => {
    const available = bottomAvailable();
    const id = side === 'left' ? 'scene' : side === 'right' ? 'inspector' : (['timeline', 'graph', 'particles'] as const).find((candidate) => available[candidate]);
    if (id) showToolWindow(id);
  };

  /**
   * 工作区：左栏、中间、右栏一排，下栏在它们下面占满整宽（同 JetBrains 的默认）。三层分栏一直在，收起一边是折叠那一栏：
   * 分栏的结构变了 Vue 会重建里面的视口，游戏页面就重新加载了。分栏自带的折叠按钮不要（两侧竖条管显示、收起）。
   */
  const workArea = () => {
    const { shown, leftSize, rightSize, bottomSize } = layout.value;
    const right = shown.right;
    const left = leftArea();
    const bottom = shown.bottom && bottomAvailable()[shown.bottom as 'timeline' | 'graph' | 'particles'] ? shown.bottom : undefined;
    const middle = (
      <Splitter {...css.attrs(styles.fill)} _size={100 - rightSize} minSize={40} maxSize={92} onUpdate:_size={(size: number) => resizeLayout({ rightSize: 100 - size })}
        collapsible="end" _collapsed={!right} onUpdate:_collapsed={(collapsed: boolean) => !collapsed && expand('right')} propsToggle={hiddenToggle}
        start={center()} end={right && fill(windows[right]())} />
    );
    const top = (
      <Splitter {...css.attrs(styles.fill)} _size={leftSize} minSize={8} maxSize={50} onUpdate:_size={(size: number) => resizeLayout({ leftSize: size })}
        collapsible="start" _collapsed={!left} onUpdate:_collapsed={(collapsed: boolean) => !collapsed && expand('left')} propsToggle={hiddenToggle}
        start={left} end={middle} />
    );
    return (
      <Splitter {...css.attrs(styles.fill)} orientation="vertical" _size={100 - bottomSize} minSize={20} maxSize={92} onUpdate:_size={(size: number) => resizeLayout({ bottomSize: 100 - size })}
        collapsible="end" _collapsed={!bottom} onUpdate:_collapsed={(collapsed: boolean) => !collapsed && expand('bottom')} propsToggle={hiddenToggle}
        start={top} end={bottom && fill(windows[bottom]())} />
    );
  };

  return () => {
    void version.value;
    const available = bottomAvailable();
    return (
      <div {...css.attrs(styles.app)}>
        <MainToolbar session={session} playing={playing} onTogglePlay={() => void togglePlay()} />
        <div {...css.attrs(styles.body)}>
          <ToolStripe
            side="start"
            items={[{ id: 'scene', icon: ListTree }, { id: 'assets', icon: FolderTree }]}
            bottom={[
              { id: 'timeline', icon: Clapperboard, available: available.timeline },
              { id: 'graph', icon: Workflow, available: available.graph },
              { id: 'particles', icon: Sparkles, available: available.particles },
            ]}
          />
          <div {...css.attrs(styles.work)}>{workArea()}</div>
          <ToolStripe side="end" items={[{ id: 'inspector', icon: SlidersHorizontal }]} />
        </div>
        <StatusBar session={session} />
      </div>
    );
  };
});
