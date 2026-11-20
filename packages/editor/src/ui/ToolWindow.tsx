/**
 * 工具窗口的两样东西（参考 JetBrains IDE）：
 * - ToolStripe：工作区两侧的窄竖条，上面是停在这一边的工具窗口的图标按钮（显示着的高亮），下面一组是停在下边的；
 * - ToolWindow：一个工具窗口的框，标题栏（名字、这个窗口自己的操作、收起按钮）加内容。内容默认放在 ScrollArea 里竖着滚
 *   （vue-tsx-pro 的浮层滚动条，不用原生的）；scroll 是 self 时内容铺满、自己管滚动（树、时间轴、粒子这些里面有自己的滚动区域）。
 */
import { Minus } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton, ScrollArea } from '@zerodep-dev/vue-tsx-pro-ui';
import type { VNodeChild } from 'vue';
import { hideToolWindow, isShown, toggleToolWindow, type ToolWindowId } from './layout';
import { t } from './messages';

type Icon = Parameters<typeof IconButton>[0]['icon'];

/** 竖条上的一个按钮：哪个工具窗口、用什么图标、现在能不能用（下边的几个跟着编辑的东西出现）。 */
export interface StripeItem {
  readonly id: ToolWindowId;
  readonly icon: Icon;
  readonly available?: boolean;
}

const styles = css.create({
  stripe: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', paddingBlock: '_xs', width: '36px', flexShrink: '0', backgroundColor: '_surfaceRaised' },
  stripeStart: { borderInlineEndWidth: '1px', borderInlineEndStyle: 'solid', borderInlineEndColor: '_borderMuted' },
  stripeEnd: { borderInlineStartWidth: '1px', borderInlineStartStyle: 'solid', borderInlineStartColor: '_borderMuted' },
  push: { flex: '1' },
  window: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', backgroundColor: '_surface' },
  header: { display: 'flex', alignItems: 'center', gap: '2px', height: '30px', flexShrink: '0', paddingInlineStart: '_sm', paddingInlineEnd: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_borderMuted' },
  title: { fontWeight: '600', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  detail: { color: '_textMuted', fontSize: '0.8rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginInlineStart: '_xs' },
  actions: { display: 'flex', alignItems: 'center', gap: '2px', marginInlineStart: 'auto' },
  body: { flex: '1', minHeight: '0', position: 'relative' },
  fill: { position: 'absolute', inset: '0' },
});

/** 工作区一侧的竖条：上面是这一边的工具窗口，下面（bottom）是停在下边的。 */
export const ToolStripe = _component(({ side, items, bottom = [] }: { side: 'start' | 'end'; items: readonly StripeItem[]; bottom?: readonly StripeItem[] }) => {
  const button = (item: StripeItem) => item.available !== false && (
    <IconButton
      icon={item.icon}
      size="sm"
      variant={isShown(item.id) ? 'soft' : 'ghost'}
      tone="neutral"
      aria-label={t.toolWindows[item.id]}
      aria-pressed={isShown(item.id)}
      title={t.toolWindows[item.id]}
      onClick={() => toggleToolWindow(item.id)}
    />
  );
  return () => (
    <nav {...css.attrs(styles.stripe, side === 'start' ? styles.stripeStart : styles.stripeEnd)} aria-label={t.toolStripe}>
      {items.map(button)}
      <span {...css.attrs(styles.push)} />
      {bottom.map(button)}
    </nav>
  );
});

/** 一个工具窗口：标题栏（名字、detail 是补充说明，比如打开的时间轴的路径；actions 是它自己的按钮）加内容。 */
export const ToolWindow = _component(({ id, detail, actions, scroll = 'area', children }: { id: ToolWindowId; detail?: string | undefined; actions?: VNodeChild; scroll?: 'area' | 'self'; children?: VNodeChild }) => {
  return () => (
    <section {...css.attrs(styles.window)} aria-label={t.toolWindows[id]}>
      <header {...css.attrs(styles.header)}>
        <span {...css.attrs(styles.title)}>{t.toolWindows[id]}</span>
        {detail && <span {...css.attrs(styles.detail)} title={detail}>{detail}</span>}
        <span {...css.attrs(styles.actions)}>
          {actions}
          <IconButton icon={Minus} size="sm" variant="ghost" tone="neutral" aria-label={t.hideToolWindow} title={t.hideToolWindow} onClick={() => hideToolWindow(id)} />
        </span>
      </header>
      {scroll === 'area'
        ? <ScrollArea {...css.attrs(styles.body)}>{children}</ScrollArea>
        : <div {...css.attrs(styles.body)}><div {...css.attrs(styles.fill)}>{children}</div></div>}
    </section>
  );
});
