import { Box, File, Folder, FolderOpen, Image, Music, Type } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Tree } from '@zerodep-dev/vue-tsx-pro-ui';
import type { AssetRecord } from '../protocol';
import type { EditorSession } from './session';

const styles = css.create({
  tree: { height: '100%' },
  kind: { color: '_textMuted', marginInlineStart: '_xs', fontSize: '0.8em' },
});

/** 资源树的一个节点：文件夹（内容路径的一段），或者一个资源。 */
interface Node {
  readonly key: string;
  readonly name: string;
  readonly asset?: AssetRecord;
  readonly children: Node[];
}

/** 资源按内容路径排成文件夹树；同一个文件夹里文件夹在前。 */
function buildTree(assets: readonly AssetRecord[]): Node[] {
  const root: Node = { key: '', name: '', children: [] };
  const folders = new Map<string, Node>([['', root]]);
  const folder = (path: string): Node => {
    const found = folders.get(path);
    if (found) return found;
    const slash = path.lastIndexOf('/');
    const node: Node = { key: `folder:${path}`, name: path.slice(slash + 1), children: [] };
    folder(slash < 0 ? '' : path.slice(0, slash)).children.push(node);
    folders.set(path, node);
    return node;
  };
  for (const asset of assets) {
    const slash = asset.path.lastIndexOf('/');
    folder(slash < 0 ? '' : asset.path.slice(0, slash)).children.push({ key: `${asset.kind}:${asset.path}`, name: asset.path.slice(slash + 1), asset, children: [] });
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => (!a.asset === !b.asset ? (a.name < b.name ? -1 : 1) : a.asset ? 1 : -1));
    for (const node of nodes) sort(node.children);
  };
  sort(root.children);
  return root.children;
}

const ICONS = { model: Box, image: Image, texture: Image, audio: Music, sound: Music, font: Type } as const;

/** 资源浏览器：内容目录里的资源按文件夹列出（后端推送变化时跟着变）。 */
export const AssetBrowser = _component(({ session }: { session: EditorSession }) => {
  const { assets } = session;
  const roots = _derived(buildTree(assets.value));
  let expanded = _state<string[]>([]);

  return () => (
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
        <span>
          {node.name}
          {node.asset && <span {...css.attrs(styles.kind)}>{node.asset.kind}</span>}
        </span>
      )}
      _expanded={expanded}
      selectionMode="single"
    />
  );
});
