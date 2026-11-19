import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Tree, type TreeMove } from '@zerodep-dev/vue-tsx-pro-ui';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import type { EditorSession } from './session';

const styles = css.create({
  tree: { height: '100%' },
});

interface Node {
  readonly entity: SceneEntityFile;
  readonly children: Node[];
}

/** 实体列表按父子排成树，同级保持文件里的顺序。 */
function buildTree(entities: readonly SceneEntityFile[]): Node[] {
  const nodes = new Map(entities.map((entity) => [entity.id, { entity, children: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) {
    const parent = node.entity.parent === null ? undefined : nodes.get(node.entity.parent);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/** 场景树：场景里的实体按父子关系列出；选中和视口里的选中是同一个。拖动换父实体、换顺序（本地的变换不变）。 */
export const SceneTree = _component(({ session }: { session: EditorSession }) => {
  const { version, selection, agent } = session;
  const roots = _derived.by(() => {
    void version.value;
    return agent.value ? buildTree(session.file.entities) : [];
  });
  let expanded = _state<string[]>([]);

  return () => (
    <Tree
      {...css.attrs(styles.tree)}
      aria-label="场景里的实体"
      items={roots}
      getKey={(node: Node) => node.entity.id}
      getLabel={(node: Node) => node.entity.name || '(unnamed)'}
      getChildren={(node: Node) => node.children}
      hasChildren={(node: Node) => node.children.length > 0}
      selectionMode="multiple"
      _expanded={expanded}
      _selected={[...selection.value]}
      onUpdate:_selected={(ids: string[]) => session.select(ids)}
      onMove={(move: TreeMove<Node>) => session.moveEntity(move.key, move.target.parent ?? null, move.target.index)}
      loading={!agent.value}
    />
  );
});
