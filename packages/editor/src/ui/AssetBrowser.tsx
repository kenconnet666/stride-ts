import { Box, File, Folder, FolderOpen, Image, Music, Type } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, TextField, Tree, type TreeMove } from '@zerodep-dev/vue-tsx-pro-ui';
import type { AssetRecord, MoveRequest } from '../protocol';
import type { EditorSession } from './session';

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%' },
  bar: { display: 'flex', gap: '_xs', alignItems: 'center', paddingInline: '_sm', paddingBlock: '_xs' },
  path: { flex: '1' },
  status: { color: '_textMuted', fontSize: '0.85em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '40%' },
  tree: { flex: '1', minHeight: '0' },
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
 * 引用它的文件跟着改写）、删掉它；把资源、文件夹拖进别的文件夹也是移动。
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
    status = `${label}……`;
    try {
      status = await work();
    } catch (error) {
      status = (error as Error).message;
    } finally {
      busy = false;
    }
  };

  const move = (node: Node, to: string) => run('移动', async () => {
    const request: MoveRequest = node.asset ? { assets: [{ kind: node.asset.kind, from: node.path, to }] } : { folder: node.path, to };
    const result = await session.moveAssets(request);
    selected = [node.asset ? `${node.asset.kind}:${to}` : FOLDER + to];
    return `挪了 ${result.moved.length} 个资源，改写了 ${result.rewritten.length} 个引用它们的文件`;
  });

  const remove = (node: Node) => run('删除', async () => {
    const asset = node.asset!;
    try {
      await session.deleteAsset(asset.kind, asset.path);
    } catch (error) {
      // 还有别的资源引用它：问一下要不要照删（引用会断）
      if (!window.confirm(`${(error as Error).message}\n\n仍然删除？引用它的地方会断掉。`)) return '没有删除';
      await session.deleteAsset(asset.kind, asset.path, true);
    }
    selected = [];
    return `删掉了 ${asset.kind} ${asset.path}`;
  });

  /** 场景、预制体可以在编辑器里打开（双击也行）。 */
  const openable = (node: Node | undefined) => node?.asset?.kind === 'scene' || node?.asset?.kind === 'prefab';
  const open = (node: Node) => run('打开', async () => {
    const { kind, path } = node.asset!;
    await session.openAsset({ kind: kind as 'scene' | 'prefab', path });
    return `打开了 ${kind} ${path}`;
  });

  // 拖进文件夹：新路径是那个文件夹加上自己的名字
  const dropped = ({ node, target: { parent } }: TreeMove<Node>) => {
    const folder = parent === undefined ? '' : nodes.get(parent)?.path ?? '';
    const to = folder ? `${folder}/${node.name}` : node.name;
    if (to !== node.path) void move(node, to);
  };

  return () => (
    <div {...css.attrs(styles.panel)}>
      <div {...css.attrs(styles.bar)}>
        <TextField
          {...css.attrs(styles.path)}
          _value={target}
          placeholder={current ? '新的内容路径' : '选一个资源或文件夹'}
          disabled={!current || busy}
        />
        <Button disabled={!current || busy || target === current.path || !target} onClick={() => current && void move(current, target)}>移动 / 改名</Button>
        <Button disabled={!current?.asset || busy} onClick={() => current && void remove(current)}>删除</Button>
        <Button disabled={!openable(current) || busy} onClick={() => current && void open(current)}>打开</Button>
        <span {...css.attrs(styles.status)} title={status}>{status}</span>
      </div>
      <Tree
        {...css.attrs(styles.tree)}
        aria-label="资源"
        items={roots}
        getKey={(node: Node) => node.key}
        getLabel={(node: Node) => node.name}
        getChildren={(node: Node) => node.children}
        hasChildren={(node: Node) => !node.asset}
        getIcon={(node: Node, open: boolean) => (node.asset ? (ICONS as Record<string, typeof File>)[node.asset.kind] ?? File : open ? FolderOpen : Folder)}
        renderItem={(node: Node) => (
          <span onDblclick={() => openable(node) && void open(node)}>
            {node.name}
            {node.asset && <span {...css.attrs(styles.kind)}>{node.asset.kind}</span>}
          </span>
        )}
        _expanded={expanded}
        selectionMode="single"
        _selected={selected}
        onUpdate:_selected={(keys: string[]) => {
          selected = keys;
          target = keys.length === 1 ? nodes.get(keys[0]!)?.path ?? '' : '';
        }}
        onMove={dropped}
        canDrop={(_: Node, drop: { parent: string | undefined }) => drop.parent === undefined || drop.parent.startsWith(FOLDER)}
      />
    </div>
  );
});
