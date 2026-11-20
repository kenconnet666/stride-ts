/**
 * 工作台的布局（参考 JetBrains IDE 的工具窗口）：场景树、资源、属性面板、时间轴这些面板是"工具窗口"，各停在左、右、下一边；
 * 两侧的竖条上是它们的图标按钮，点一下显示、再点隐藏。左边可以上下各放一个（场景树在上、资源在下），右边、下边各一个。
 * 下边的几个（时间轴、节点图、粒子）跟着正在编辑的东西出现：打开时间轴、材质的节点图、实体的粒子编辑器时自动显示。
 *
 * 显示哪些、各占多大记在 localStorage 里（只是这台机器上的习惯，读不到就用默认的）。
 */
import { shallowRef } from 'vue';

export type ToolWindowId = 'scene' | 'assets' | 'inspector' | 'timeline' | 'graph' | 'particles';

/** 停在哪：左上、左下、右边、下边。 */
export type ToolAnchor = 'left' | 'leftSplit' | 'right' | 'bottom';

export const TOOL_ANCHORS: Readonly<Record<ToolWindowId, ToolAnchor>> = {
  scene: 'left', assets: 'leftSplit', inspector: 'right', timeline: 'bottom', graph: 'bottom', particles: 'bottom',
};

export interface WorkbenchLayout {
  /** 每一边显示的工具窗口；undefined 是这一边收起来了。 */
  readonly shown: Readonly<Record<ToolAnchor, ToolWindowId | undefined>>;
  /** 左栏占工作区的宽度（%）。 */
  readonly leftSize: number;
  /** 左栏里上面那个占的高度（%）。 */
  readonly leftSplitSize: number;
  /** 右栏占（左栏以外的）宽度的 %：从右边量。 */
  readonly rightSize: number;
  /** 下栏占工作区的高度（%）：从下面量。 */
  readonly bottomSize: number;
}

const DEFAULT_LAYOUT: WorkbenchLayout = {
  shown: { left: 'scene', leftSplit: 'assets', right: 'inspector', bottom: undefined },
  leftSize: 18,
  leftSplitSize: 55,
  rightSize: 24,
  bottomSize: 40,
};

const STORAGE_KEY = 'stride-editor-layout';

function load(): WorkbenchLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<WorkbenchLayout> | null;
    // 下栏的窗口跟着编辑的东西出现，不从上次恢复
    return saved ? { ...DEFAULT_LAYOUT, ...saved, shown: { ...DEFAULT_LAYOUT.shown, ...saved.shown, bottom: undefined } } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** 工作台的布局状态（整个编辑器一份）。 */
export const layout = shallowRef<WorkbenchLayout>(load());

function update(change: Partial<WorkbenchLayout>): void {
  layout.value = { ...layout.value, ...change };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout.value));
  } catch {
    // 存不了（隐私模式）就只在这次有效
  }
}

export function isShown(id: ToolWindowId): boolean {
  return layout.value.shown[TOOL_ANCHORS[id]] === id;
}

/** 显示这个工具窗口（同一边原来的那个让开）。 */
export function showToolWindow(id: ToolWindowId): void {
  update({ shown: { ...layout.value.shown, [TOOL_ANCHORS[id]]: id } });
}

export function hideToolWindow(id: ToolWindowId): void {
  if (isShown(id)) update({ shown: { ...layout.value.shown, [TOOL_ANCHORS[id]]: undefined } });
}

/** 竖条上的按钮：显示着就收起，收着就显示。 */
export function toggleToolWindow(id: ToolWindowId): void {
  if (isShown(id)) hideToolWindow(id);
  else showToolWindow(id);
}

export function resizeLayout(change: Partial<Pick<WorkbenchLayout, 'leftSize' | 'leftSplitSize' | 'rightSize' | 'bottomSize'>>): void {
  update(change);
}
