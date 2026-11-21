import { Search } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { CommandPalette, IconButton } from '@zerodep-dev/vue-tsx-pro-ui';
import type { AssetKind } from '../protocol.ts';
import { t } from './messages';
import type { EditorSession } from './session';

/** 命令面板里的一项：一个操作、场景里的一个实体或一个资源；选中就 run。 */
interface PaletteItem {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly group: string;
  readonly run: () => unknown;
}

/** 在编辑器里能打开的资源（双击资源浏览器里的也是这几种）；别的选中后在属性面板里看。 */
const OPENABLE: ReadonlySet<AssetKind> = new Set(['scene', 'prefab', 'timeline']);

/**
 * 到处搜（照 JetBrains 的 Search Everywhere）：Ctrl+K 或连按两下 Shift 打开（快捷键在 App 里接，焦点在视口里也认），搜操作、
 * 场景里的实体和资源；回车执行操作、选中实体、打开资源（场景、预制体、时间轴）或在属性面板里看它。列表打开时才建。
 */
export const SearchEverywhere = _component(({ session, playing, onTogglePlay }: { session: EditorSession; playing: boolean; onTogglePlay: () => void }) => {
  const { palette } = session;

  /** 现在做得了的操作（试玩时只有停止）。 */
  const actions = (): PaletteItem[] => {
    const action = (key: string, label: string, run: () => unknown, available = true): PaletteItem[] =>
      available ? [{ key: `action:${key}`, label, group: t.palette.actions, run }] : [];
    if (playing) return action('play', t.stopPlaying, onTogglePlay);
    const selected = session.selection.value.length;
    const ready = session.agent.value !== undefined;
    const snap = session.snap.value;
    return [
      ...action('save', `${t.save} (Ctrl+S)`, () => session.save(), session.dirty.value),
      ...action('undo', `${t.undo} (Ctrl+Z)`, () => session.undo(), session.canUndo),
      ...action('redo', `${t.redo} (Ctrl+Y)`, () => session.redo(), session.canRedo),
      ...action('play', t.play, onTogglePlay),
      ...action('add', t.addEntity, () => session.addEntity(selected === 1 ? session.selection.value[0]! : null), ready),
      ...action('delete', `${t.deleteSelection} (Delete)`, () => session.deleteSelection(), selected > 0),
      ...action('duplicate', `${t.duplicate} (Ctrl+D)`, () => session.duplicateSelection(), selected > 0),
      ...action('copy', t.copySelection, () => session.copyToSystem(), selected > 0),
      ...action('paste', t.paste, () => session.pasteFromSystem(), ready),
      ...action('prefab', t.makePrefab, () => session.makePrefabFromSelection(), selected === 1),
      ...action('realtime', t.palette.toggleRealtime, () => session.setRealtime(!session.realtime.value), ready),
      ...(snap
        ? [
            ...action('snap', t.palette.toggleSnap, () => session.setSnap({ enabled: !snap.enabled })),
            ...action('surface', t.palette.toggleSurfaceSnap, () => session.setSnap({ surface: !snap.surface })),
            ...action('vertex', t.palette.toggleVertexSnap, () => session.setSnap({ vertex: !snap.vertex })),
          ]
        : []),
    ];
  };

  const items = (): PaletteItem[] => {
    if (!palette.value) return [];
    const entities: PaletteItem[] = playing ? [] : session.expanded.map((entity) => ({
      key: `entity:${entity.id}`,
      label: entity.name || '(unnamed)',
      group: t.palette.entities,
      run: () => session.select([entity.id]),
    }));
    const assets: PaletteItem[] = playing ? [] : session.assets.value.map((asset) => ({
      key: `asset:${asset.kind}:${asset.path}`,
      label: asset.path.slice(asset.path.lastIndexOf('/') + 1),
      description: `${asset.kind} · ${asset.path}`,
      group: t.palette.assets,
      run: () =>
        !OPENABLE.has(asset.kind) ? session.inspectAsset(asset.kind, asset.path)
          : asset.kind === 'timeline' ? session.openTimeline(asset.path)
            : session.openAsset({ kind: asset.kind as 'scene' | 'prefab', path: asset.path }),
    }));
    return [...actions(), ...entities, ...assets];
  };

  return () => (
    <CommandPalette
      items={items()}
      toOption={(item: PaletteItem) => ({ value: item.key, label: item.label, group: item.group, ...(item.description ? { description: item.description } : {}) })}
      onAction={(item: PaletteItem) => void item.run()}
      _open={palette.value}
      onUpdate:_open={(open: boolean) => (palette.value = open)}
      hotkey={false}
      label={t.palette.title}
      placeholder={t.palette.placeholder}
      trigger={(props) => <IconButton {...props} size="sm" variant="ghost" icon={Search} aria-label={t.palette.title} title={`${t.palette.title} (Ctrl+K, Shift Shift)`} />}
    />
  );
});
