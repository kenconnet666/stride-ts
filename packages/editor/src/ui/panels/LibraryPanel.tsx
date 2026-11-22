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
import { Button, ScrollArea, ToggleGroup, ToggleItem } from '@zerodep-dev/vue-tsx-pro-ui';
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
  panel: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '_sm', height: '100%', minHeight: '0', boxSizing: 'border-box' },
  scroll: { flex: '1', minHeight: '0' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  // 类别多时折行，不被窗口的宽度截掉
  chips: { flexWrap: 'wrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '8px' },
  card: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '4px', borderRadius: '6px', cursor: 'grab',
    borderWidth: '1px', borderStyle: 'solid', borderColor: 'transparent', backgroundColor: { default: 'transparent', ':hover': '_surfaceRaised' },
  },
  selected: { borderColor: '_accent' },
  thumbnail: { width: '72px', height: '72px', borderRadius: '4px', objectFit: 'cover', backgroundColor: '_surfaceMuted' },
  name: { fontSize: '0.8em', textAlign: 'center', lineHeight: '1.2' },
  hint: { color: '_textMuted', fontSize: '0.8em' },
});

type Shelf = 'materials' | 'effects';

export const LibraryPanel = _component(({ session }: { session: EditorSession }) => {
  let shelf = _state<Shelf>('materials');
  let category = _state<string>('all');
  let selected = _state<string | undefined>(undefined);

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

  return () => (
    <div {...css.attrs(styles.panel)}>
      <div {...css.attrs(styles.row)}>
        <ToggleGroup size="sm" required _value={shelf} onUpdate:_value={(next: string | null) => { shelf = (next ?? 'materials') as Shelf; category = 'all'; selected = undefined; }}>
          <ToggleItem value="materials">{t.library.materials}</ToggleItem>
          <ToggleItem value="effects">{t.library.effects}</ToggleItem>
        </ToggleGroup>
        <Button size="sm" variant="soft" tone="neutral" icon={shelf === 'materials' ? Wand : Plus} disabled={!selected || (shelf === 'materials' && session.selection.value.length === 0)}
          onClick={() => void use().catch((error: unknown) => (session.notice.value = (error as Error).message))}>{shelf === 'materials' ? t.library.use : t.library.add}</Button>
      </div>
      <ToggleGroup {...css.attrs(styles.chips)} size="sm" required _value={category} onUpdate:_value={(next: string | null) => (category = next ?? 'all')}>
        <ToggleItem value="all">{t.library.all}</ToggleItem>
        {categories().map((value) => <ToggleItem value={value}>{t.library.categories[value]}</ToggleItem>)}
      </ToggleGroup>
      <ScrollArea {...css.attrs(styles.scroll)}>
      <div {...css.attrs(styles.grid)} role="listbox" aria-label={shelf === 'materials' ? t.library.materials : t.library.effects}>
        {items().filter((item) => category === 'all' || item.category === category).map((item) => (
          <div {...css.attrs(styles.card, selected === item.id && styles.selected)} role="option" aria-selected={selected === item.id} draggable title={t.library.names[item.id] ?? item.id}
            onClick={() => (selected = item.id)}
            onDblclick={() => { selected = item.id; void use(); }}
            onDragstart={(event: DragEvent) => {
              selected = item.id;
              event.dataTransfer?.setData(LIBRARY_DRAG_TYPE, `${shelf === 'materials' ? 'material' : 'effect'}:${item.id}`);
              session.libraryDragging.value = true;
            }}
            onDragend={() => (session.libraryDragging.value = false)}>
            {THUMBNAILS[item.id] ? <img {...css.attrs(styles.thumbnail)} src={THUMBNAILS[item.id]} alt="" draggable={false} /> : <div {...css.attrs(styles.thumbnail)} />}
            <span {...css.attrs(styles.name)}>{t.library.names[item.id] ?? item.id}</span>
          </div>
        ))}
      </div>
      </ScrollArea>
      <span {...css.attrs(styles.hint)}>{t.library.hint}</span>
    </div>
  );
});
