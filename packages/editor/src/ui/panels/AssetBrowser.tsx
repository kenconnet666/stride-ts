import { Box, Check, ExternalLink, File, Folder, FolderOpen, Image, Music, Plus, Trash2, Type } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton, Menu, MenuItem, TextField, Tree, type TreeMove } from '@zerodep-dev/vue-tsx-pro-ui';
import { freeAssetPath, newAssetOptions } from '../../shared/newAssets';
import type { AssetRecord, MoveRequest } from '../../shared/protocol';
import { assetLabel, newAssetLabel, t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%' },
  bar: { display: 'flex', gap: '2px', alignItems: 'center', paddingInline: '_xs', paddingBlock: '2px' },
  path: { flex: '1', minWidth: '0' },
  status: { flex: '1', minWidth: '0', color: '_textMuted', fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingInlineStart: '_xs' },
  tree: { flex: '1', minHeight: '0' },
  scroll: { flex: '1', minHeight: '0' },
  kind: { color: '_textMuted', marginInlineStart: '_xs', fontSize: '0.8em' },
});

/** 资源树的一个节点：文件夹（内容路径的一段），或者一个资源。 */
interface Node {
  readonly key: string;
  readonly name: string;
  /** 内容路径（文件夹是它的前缀）。 */
  readonly path: string;
  readonly asset?: AssetRecord;
  readonly children: Node[];
}

const FOLDER = 'folder:';

/** 资源按内容路径排成文件夹树；同一个文件夹里文件夹在前。 */
function buildTree(assets: readonly AssetRecord[]): Node[] {
  const root: Node = { key: FOLDER, name: '', path: '', children: [] };
  const folders = new Map<string, Node>([['', root]]);
  const folder = (path: string): Node => {
    const found = folders.get(path);
    if (found) return found;
    const slash = path.lastIndexOf('/');
    const node: Node = { key: FOLDER + path, name: path.slice(slash + 1), path, children: [] };
    folder(slash < 0 ? '' : path.slice(0, slash)).children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const asset of assets) {
    const slash = asset.path.lastIndexOf('/');
    folder(slash < 0 ? '' : asset.path.slice(0, slash)).children.push({ key: `${asset.kind}:${asset.path}`, name: asset.path.slice(slash + 1), path: asset.path, asset, children: [] });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (!a.asset === !b.asset ? (a.name < b.name ? -1 : 1) : a.asset ? 1 : -1));
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

const ICONS = { model: Box, image: Image, texture: Image, audio: Music, sound: Music, font: Type } as const;

/**
 * 资源浏览器：内容目录里的资源按文件夹列出（后端推送变化时跟着变）。选中一个资源或文件夹可以改它的路径（移动、改名，
 * 引用它的文件跟着改写）、删掉它；把资源、文件夹拖进别的文件夹也是移动。"新建"在选中的文件夹（选中的是资源时是它所在的
 * 文件夹）里建场景、材质、基本形状的模型、UI 页面（newAssets.ts），建好以后选中它，路径框里改名字。从系统里拖进来的
 * 音频、图片导入成声音、贴图，放进同一个文件夹。
 */
export const AssetBrowser = _component(({ session }: { session: EditorSession }) => {
  const { assets } = session;
  const roots = _derived(buildTree(assets.value));
  const nodes = _derived.by(() => {
    const all = new Map<string, Node>();
    const visit = (node: Node) => {
      all.set(node.key, node);
      node.children.forEach(visit);
    };
    roots.forEach(visit);
    return all;
  });
  let expanded = _state<string[]>([]);
  let selected = _state<string[]>([]);
  let target = _state('');
  let status = _state('');
  let busy = _state(false);
  const current = _derived(selected.length === 1 ? nodes.get(selected[0]!) : undefined);

  const run = async (label: string, work: () => Promise<string>) => {
    busy = true;
    status = t.working(label);
    try {
      status = await work();
    } catch (error) {
      status = (error as Error).message;
    } finally {
      busy = false;
    }
  };

  const move = (node: Node, to: string) => run(t.moveRename, async () => {
    const request: MoveRequest = node.asset ? { assets: [{ kind: node.asset.kind, from: node.path, to }] } : { folder: node.path, to };
    const result = await session.moveAssets(request);
    selected = [node.asset ? `${node.asset.kind}:${to}` : FOLDER + to];
    return t.moved(result.moved.length, result.rewritten.length);
  });

  const remove = (node: Node) => run(t.delete, async () => {
    const asset = node.asset!;
    try {
      await session.deleteAsset(asset.kind, asset.path);
    } catch (error) {
      // 还有别的资源引用它：问一下要不要照删（引用会断）
      if (!window.confirm(t.deleteAnyway((error as Error).message))) return t.notDeleted;
      await session.deleteAsset(asset.kind, asset.path, true);
    }
    selected = [];
    return t.deleted(asset.kind, asset.path);
  });

  /** 场景、预制体、时间轴、世界可以在编辑器里打开（双击也行）；世界是打开它的常驻场景、把格子挂上一起看。 */
  const openable = (node: Node | undefined) => node?.asset?.kind === 'scene' || node?.asset?.kind === 'prefab' || node?.asset?.kind === 'timeline' || node?.asset?.kind === 'world';
  const open = (node: Node) => run(t.open, async () => {
    const { kind, path } = node.asset!;
    if (kind === 'timeline') await session.openTimeline(path);
    else if (kind === 'world') await session.openWorld(path);
    else await session.openAsset({ kind: kind as 'scene' | 'prefab', path });
    return t.opened(kind, path);
  });

  /** 新建资源的文件夹：选中的文件夹，或者选中的资源所在的文件夹；没选时是内容目录的根。 */
  const folderForNew = () => {
    const node = current;
    if (!node) return '';
    if (!node.asset) return node.path;
    const slash = node.path.lastIndexOf('/');
    return slash < 0 ? '' : node.path.slice(0, slash);
  };
  const create = (id: string) => {
    const option = newAssetOptions().find((candidate) => candidate.id === id);
    if (!option) return;
    void run(t.newAsset, async () => {
      const folder = folderForNew();
      const path = freeAssetPath(folder, option.name, option.kind, new Set(assets.value.map((asset) => `${asset.kind}:${asset.path}`)));
      await session.createAsset(option.kind, path, option.content(path.slice(path.lastIndexOf('/') + 1), assets.value));
      if (folder) expanded = [...new Set([...expanded, FOLDER + folder])];
      selected = [`${option.kind}:${path}`];
      target = path;
      return t.created(assetLabel(option.kind), path);
    });
  };

  // 从系统里拖进来的文件（不是树里拖动的节点）：导入
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') === true;
  const importDropped = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    void run(t.importing, async () => {
      const folder = folderForNew();
      const records = await session.importFiles(folder, files);
      if (folder) expanded = [...new Set([...expanded, FOLDER + folder])];
      selected = records.slice(-1).map((record) => `${record.kind}:${record.path}`);
      return t.imported(records.map((record) => `${record.kind} ${record.path}`));
    });
  };

  // 拖进文件夹：新路径是那个文件夹加上自己的名字
  const dropped = ({ node, target: { parent } }: TreeMove<Node>) => {
    const folder = parent === undefined ? '' : nodes.get(parent)?.path ?? '';
    const to = folder ? `${folder}/${node.name}` : node.name;
    if (to !== node.path) void move(node, to);
  };

  return () => (
    <div {...css.attrs(styles.panel)} onDragover={(event: DragEvent) => hasFiles(event) && event.preventDefault()} onDrop={importDropped}>
      <div {...css.attrs(styles.bar)} role="toolbar" aria-label={t.assets}>
        <Menu trigger={(props) => <IconButton {...props} icon={Plus} size="sm" variant="ghost" tone="neutral" aria-label={t.newAsset} title={t.newAsset} disabled={busy} />}>
          {newAssetOptions().map((option) => <MenuItem onAction={() => create(option.id)}>{newAssetLabel(option)}</MenuItem>)}
        </Menu>
        <IconButton icon={ExternalLink} size="sm" variant="ghost" tone="neutral" aria-label={t.open} title={t.open} disabled={!openable(current) || busy} onClick={() => current && void open(current)} />
        <IconButton icon={Trash2} size="sm" variant="ghost" tone="neutral" aria-label={t.delete} title={t.delete} disabled={!current?.asset || busy} onClick={() => current && void remove(current)} />
        <span {...css.attrs(styles.status)} title={status}>{status}</span>
      </div>
      {/* 移动、改名的一栏一直占着位置（没选中时不可用）：选中时才出来的话下面的列表往下跳一行，双击的第二下落到别的行上 */}
      <div {...css.attrs(styles.bar)}>
        <TextField
          {...css.attrs(styles.path)}
          size="sm"
          _value={target}
          aria-label={t.moveRename}
          placeholder={t.pathPlaceholder}
          disabled={busy || !current}
          onKeydown={(event: KeyboardEvent) => event.key === 'Enter' && current && target && target !== current.path && void move(current, target)}
        />
        <IconButton icon={Check} size="sm" variant="ghost" tone="neutral" aria-label={t.moveRename} title={t.moveRename} disabled={busy || !current || target === current.path || !target} onClick={() => current && void move(current, target)} />
      </div>
      <Tree
        {...css.attrs(styles.tree)}
        propsScrollArea={{ sx: styles.scroll }}
        aria-label={t.assets}
        // 工程和资源列表还没读到
        loading={session.project.value === undefined}
        items={roots}
        getKey={(node: Node) => node.key}
        getLabel={(node: Node) => node.name}
        getChildren={(node: Node) => node.children}
        hasChildren={(node: Node) => !node.asset}
        getIcon={(node: Node, open: boolean) => (node.asset ? (ICONS as Record<string, typeof File>)[node.asset.kind] ?? File : open ? FolderOpen : Folder)}
        renderItem={(node: Node) => (
          <span>
            {node.name}
            {node.asset && <span {...css.attrs(styles.kind)}>{node.asset.kind}</span>}
          </span>
        )}
        // 双击整行、回车打开（场景、预制体……）
        onActivate={(node: Node) => openable(node) && void open(node)}
        _expanded={expanded}
        selectionMode="single"
        _selected={selected}
        onUpdate:_selected={(keys: string[]) => {
          selected = keys;
          const node = keys.length === 1 ? nodes.get(keys[0]!) : undefined;
          target = node?.path ?? '';
          // 选中材质、JSON 写的模型：属性面板里编辑它（别的种类清掉面板上的资源）
          if (node?.asset) void session.inspectAsset(node.asset.kind, node.asset.path);
          else session.inspected.value = undefined;
        }}
        onMove={dropped}
        canDrop={(_: Node, drop: { parent: string | undefined }) => drop.parent === undefined || drop.parent.startsWith(FOLDER)}
      />
    </div>
  );
});
