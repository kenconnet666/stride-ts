import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Tree, type TreeMove, type TreeMoveTarget } from '@zerodep-dev/vue-tsx-pro-ui';
import { watch } from 'vue';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import type { EditorSession } from './session';

const styles = css.create({
  tree: { height: '100%' },
  prefab: { color: '_textMuted', fontSize: '0.85em' },
  member: { fontStyle: 'italic' },
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

/** 树里看得见的节点（展开着的往下列），从上到下：Shift 选一段时按它。 */
function visibleOrder(nodes: readonly Node[], expanded: ReadonlySet<string>, out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.entity.id);
    if (expanded.has(node.entity.id)) visibleOrder(node.children, expanded, out);
  }
  return out;
}

function findNode(nodes: readonly Node[], id: string): Node | undefined {
  for (const node of nodes) {
    if (node.entity.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/** 实例的根后面标出预制体的名字。 */
function prefabLabel(session: EditorSession, id: string) {
  const target = session.instanceMember(id);
  if (!target || target.instance.id !== id) return undefined;
  const { path } = target.instance.prefab!;
  return <span {...css.attrs(styles.prefab)} title={path}> ⟨{path.slice(path.lastIndexOf('/') + 1)}⟩</span>;
}

/**
 * 场景树：场景里的实体按父子关系列出（预制体的实例展开着，成员用斜体）；选中和视口里的选中是同一个，Ctrl、Shift 多选。拖动换父实体、
 * 换顺序（本地的变换不变）；成员不在文档里，不能拖，也不能当拖去的父实体。
 */
export const SceneTree = _component(({ session }: { session: EditorSession }) => {
  const { version, selection, agent } = session;
  const roots = _derived.by(() => {
    void version.value;
    return agent.value ? buildTree(session.expanded) : [];
  });

  /** 树里的位置（兄弟里有成员）换成文档里兄弟的位置。 */
  const move = ({ key, target }: TreeMove<Node>) => {
    const parent = target.parent ?? null;
    const siblings = buildTree(session.expanded);
    const list = parent === null ? siblings : findNode(siblings, parent)?.children ?? [];
    const position = list.filter((node) => node.entity.id !== key).slice(0, target.index).filter((node) => !session.isMember(node.entity.id)).length;
    session.moveEntity(key, parent, position);
  };
  let expanded = _state<string[]>([]);
  // 选中的实体（粘贴、复制出来的，视口里点到的）在树里看得见：展开它们的祖先
  watch(selection, (ids) => {
    if (!agent.value) return;
    const parentOf = new Map(session.expanded.map((entity) => [entity.id, entity.parent]));
    const open = new Set(expanded);
    for (const id of ids) for (let parent = parentOf.get(id) ?? null; parent !== null; parent = parentOf.get(parent) ?? null) open.add(parent);
    if (open.size !== expanded.length) expanded = [...open];
  });

  // Ctrl、Shift 多选：树自己的多选模式是点一下加进、再点去掉，这里换成常见的做法——单击只选它，Ctrl+单击加进、去掉，
  // Shift+单击选上次点的到这次点的一段。按键在捕获阶段记下（树在冒泡阶段的 click、keydown 里改选中）
  let modifiers = { toggle: false, range: false };
  let anchor: string | undefined;
  const remember = (event: MouseEvent | KeyboardEvent): void => {
    modifiers = { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey };
  };
  // 同一个监听函数重复加只算一次，重画时调多少次都没关系
  const listen = (element: unknown) => {
    if (!(element instanceof HTMLElement)) return;
    element.addEventListener('click', remember, true);
    element.addEventListener('keydown', remember, true);
  };
  const choose = (ids: string[]) => {
    const before = new Set(selection.value);
    // 树报上来的是加进或去掉了一个：那个就是这次点的
    const clicked = ids.find((id) => !before.has(id)) ?? selection.value.find((id) => !ids.includes(id));
    if (clicked === undefined) return session.select(ids);
    if (modifiers.range && anchor !== undefined) {
      const order = visibleOrder(roots, new Set(expanded));
      const [from, to] = [order.indexOf(anchor), order.indexOf(clicked)];
      if (from >= 0 && to >= 0) return session.select(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    }
    anchor = clicked;
    session.select(modifiers.toggle ? ids : [clicked]);
  };

  return () => (
    <div {...css.attrs(styles.tree)} ref={listen}>
    <Tree
      {...css.attrs(styles.tree)}
      aria-label="场景里的实体"
      items={roots}
      getKey={(node: Node) => node.entity.id}
      getLabel={(node: Node) => node.entity.name || '(unnamed)'}
      renderItem={(node: Node) => (
        <span {...css.attrs(session.isMember(node.entity.id) && styles.member)}>
          {node.entity.name || '(unnamed)'}
          {prefabLabel(session, node.entity.id)}
        </span>
      )}
      getChildren={(node: Node) => node.children}
      hasChildren={(node: Node) => node.children.length > 0}
      selectionMode="multiple"
      _expanded={expanded}
      _selected={[...selection.value]}
      onUpdate:_selected={choose}
      canDrop={(node: Node, target: TreeMoveTarget) => !session.isMember(node.entity.id) && (target.parent == null || !session.isMember(target.parent))}
      onMove={move}
      loading={!agent.value}
    />
    </div>
  );
});
