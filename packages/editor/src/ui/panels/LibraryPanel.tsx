/// <reference types="vite/client" />
/**
 * 库窗口（S2）：编辑器自带的材质库、特效库（library/），带缩略图的卡片按类别列出。
 * - 材质：拖到视口里的物体上就用上（视口上盖一层接放下，按放下的位置点选实体）；或者选中实体再点"用在选中的实体上"。
 * - 特效：拖到视口里放在放下处的表面上；或者点"加到场景"，放在选中的实体处（没选时在原点）。
 * 用的时候拷一份进工程（session.useLibraryMaterial、addLibraryEffect），之后在工程里随便改，和库没有联系。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Plus, Wand } from '@lucide/icons';
import { Button, Flex, Listbox, ScrollArea, Small, toElement, ToggleGroup, ToggleItem } from '@zerodep-dev/vue-tsx-pro-ui';
import { LIBRARY_EFFECTS, LIBRARY_MATERIALS, type EffectCategory, type MaterialCategory } from '../../library/index.ts';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

/** 缩略图（tools/dev/library-thumbnails.ts 画的），按 id 找。 */
const THUMBNAILS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../../library/thumbnails/*.webp', { eager: true, query: '?url', import: 'default' }))
    .map(([file, url]) => [file.slice(file.lastIndexOf('/') + 1, -'.webp'.length), url]),
);

/** 拖库里的东西时 dataTransfer 里的类型：值是 `material:<id>` 或 `effect:<id>`。 */
export const LIBRARY_DRAG_TYPE = 'application/x-stride-library';

const styles = css.create({
  // 窗口自己管滚动（App 的 scroll: 'self'）：上面的切换按钮固定，下面的卡片网格在滚动区里
  panel: { padding: '_sm', height: '100%', minHeight: '0', boxSizing: 'border-box' },
  scroll: { flex: '1', minHeight: '0' },
  // 卡片能拖到视口里
  card: { cursor: 'grab' },
  thumbnail: { width: '72px', height: '72px', borderRadius: '_sm', objectFit: 'cover', backgroundColor: '_surfaceMuted' },
});

type Shelf = 'materials' | 'effects';

export const LibraryPanel = _component(({ session }: { session: EditorSession }) => {
  let shelf = _state<Shelf>('materials');
  let category = _state<string>('all');
  let selected = _state<string | undefined>(undefined);
  /** 卡片网格滚动的元素（ScrollArea 的视口）：Listbox 在它里面按行虚拟滚动 */
  let scroller = _state.raw<HTMLElement | null>(null);

  const items = () => (shelf === 'materials' ? LIBRARY_MATERIALS : LIBRARY_EFFECTS);
  const categories = () => [...new Set(items().map((item) => item.category))] as (MaterialCategory | EffectCategory)[];

  const use = async () => {
    if (!selected) return;
    const name = t.library.names[selected] ?? selected;
    if (shelf === 'materials') {
      const count = await session.useLibraryMaterial(selected, session.selection.value);
      session.status.value = count > 0 ? t.library.used(name, count) : t.library.noModel;
      return;
    }
    const at = session.expanded.find((entity) => entity.id === session.selection.value[0])?.position ?? [0, 0, 0];
    await session.addLibraryEffect(selected, [at[0]!, at[1]!, at[2]!]);
    session.status.value = t.library.added(name);
  };

  /** 一张卡片能拖到视口里（材质落到物体上、特效落到表面上），双击直接用 */
  const cardProps = (item: { readonly id: string }) => ({
    sx: styles.card,
    draggable: true,
    title: t.library.names[item.id] ?? item.id,
    onDblclick: () => {
      selected = item.id;
      void use();
    },
    onDragstart: (event: DragEvent) => {
      selected = item.id;
      event.dataTransfer?.setData(LIBRARY_DRAG_TYPE, `${shelf === 'materials' ? 'material' : 'effect'}:${item.id}`);
      session.libraryDragging.value = true;
    },
    onDragend: () => (session.libraryDragging.value = false),
  });

  return () => (
    <Flex direction="column" gap="sm" sx={styles.panel}>
      <Flex align="center" gap="sm" wrap>
        <ToggleGroup size="sm" required _value={shelf} onUpdate:_value={(next: string | null) => { shelf = (next ?? 'materials') as Shelf; category = 'all'; selected = undefined; }}>
          <ToggleItem value="materials">{t.library.materials}</ToggleItem>
          <ToggleItem value="effects">{t.library.effects}</ToggleItem>
        </ToggleGroup>
        <Button size="sm" variant="soft" tone="neutral" icon={shelf === 'materials' ? Wand : Plus} disabled={!selected || (shelf === 'materials' && session.selection.value.length === 0)}
          onClick={() => void use().catch((error: unknown) => (session.notice.value = (error as Error).message))}>{shelf === 'materials' ? t.library.use : t.library.add}</Button>
      </Flex>
      {/* 类别多时折行，不被窗口的宽度截掉 */}
      <ToggleGroup size="sm" required wrap _value={category} onUpdate:_value={(next: string | null) => (category = next ?? 'all')}>
        <ToggleItem value="all">{t.library.all}</ToggleItem>
        {categories().map((value) => <ToggleItem value={value}>{t.library.categories[value]}</ToggleItem>)}
      </ToggleGroup>
      <ScrollArea sx={styles.scroll} propsViewport={{ ref: (element: unknown) => (scroller = toElement(element)) }}>
        <Listbox
          items={items().filter((item) => category === 'all' || item.category === category)}
          toOption={(item) => ({ value: item.id, label: t.library.names[item.id] ?? item.id })}
          layout="grid"
          minItemWidth="84px"
          scroller={scroller}
          aria-label={shelf === 'materials' ? t.library.materials : t.library.effects}
          _value={selected ?? null}
          onUpdate:_value={(value: string | null) => (selected = value ?? undefined)}
          propsOption={cardProps}
        >
          {(item) => [
            THUMBNAILS[item.id] ? <img {...css.attrs(styles.thumbnail)} src={THUMBNAILS[item.id]} alt="" draggable={false} /> : <span {...css.attrs(styles.thumbnail)} />,
            <Small align="center">{t.library.names[item.id] ?? item.id}</Small>,
          ]}
        </Listbox>
      </ScrollArea>
      <Small tone="muted">{t.library.hint}</Small>
    </Flex>
  );

});
