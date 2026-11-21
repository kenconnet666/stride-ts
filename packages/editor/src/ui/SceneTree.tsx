import { Eye, EyeOff, TriangleAlert } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Icon, IconButton, Tree, type TreeMove, type TreeMoveTarget } from '@zerodep-dev/vue-tsx-pro-ui';
import { watch } from 'vue';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import { availableParent } from '@stride-ts/engine/content-prefabs';
import { t } from './messages';
import type { EditorSession } from './session';

const styles = css.create({
  tree: { height: '100%' },
  scroll: { height: '100%' },
  prefab: { color: '_textMuted', fontSize: '0.85em' },
  noScene: { display: 'block', padding: '_sm', color: '_textMuted', fontSize: '0.85em', whiteSpace: 'normal' },
  member: { fontStyle: 'italic' },
  detached: { display: 'inline-flex', alignItems: 'center', gap: '_xs', color: '_warningText' },
  scene: { fontWeight: '600' },
  // 子场景：名字加一个看不看的开关，没在看的淡一点
  child: { display: 'inline-flex', alignItems: 'center', gap: '_xs' },
  hidden: { color: '_textMuted' },
});

/**
 * 树里的一个节点：一个实体；最上面代表文档（场景、预制体）本身的那个（entity 是 undefined，键是 DOCUMENT）；或者文档下面列出的
 * 一个子场景（scene 是它的内容路径，键以 CHILD_SCENE 开头）。
 */
interface Node {
  readonly key: string;
  readonly entity?: SceneEntityFile;
  readonly scene?: string;
  /** 实体在文档里的父实体不在了（预制体删了它挂着的成员）：节点先挂在最近的实例下面，标出来。 */
  readonly detached?: boolean;
  readonly children: Node[];
}

/** 文档本身那个节点的键（不会和实体的 id 重）。选中它就是不选实体：属性面板显示场景的设置。 */
const DOCUMENT = '\0document';
/** 子场景节点的键的前缀（后面是内容路径）。 */
const CHILD_SCENE = '\0scene:';

/**
 * 实体列表按父子排成树，同级保持文件里的顺序。父实体不在了的（预制体删了它挂着的成员）同游戏里一样挂在最近的实例下面
 * （availableParent），标出来让用户挪。
 */
function buildTree(entities: readonly SceneEntityFile[]): Node[] {
  const nodes = new Map<string, Node>(entities.map((entity) => [entity.id, { key: entity.id, entity, children: [] }]));
  const roots: Node[] = [];
  for (const entity of entities) {
    let node = nodes.get(entity.id)!;
    const parentId = entity.parent === null ? null : availableParent(entity.parent, (id) => nodes.has(id));
    if (entity.parent !== null && parentId !== entity.parent) nodes.set(entity.id, node = { ...node, detached: true });
    (parentId === null ? roots : nodes.get(parentId)!.children).push(node);
  }
  return roots;
}

/** 树里看得见的节点（展开着的往下列），从上到下：Shift 选一段时按它。 */
function visibleOrder(nodes: readonly Node[], expanded: ReadonlySet<string>, out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.entity) out.push(node.key);
    if (expanded.has(node.key)) visibleOrder(node.children, expanded, out);
  }
  return out;
}

function findNode(nodes: readonly Node[], id: string): Node | undefined {
  for (const node of nodes) {
    if (node.key === id) return node;
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
 * 换顺序（本地的变换不变）；成员跟着预制体，不能拖，但可以当拖去的父实体（拖进去的实体在文档里挂在成员下面）。
 * 最上面一个节点是文档（场景、预制体）本身：选中它（或者在视口里点空处）属性面板显示场景的设置，实体拖到它上面就挂到根上。
 */
export const SceneTree = _component(({ session }: { session: EditorSession }) => {
  const { version, selection, agent } = session;
  const roots = _derived.by((): Node[] => {
    void version.value;
    if (!agent.value || !session.opened.value) return [];
    // 场景的子场景（参考场景）列在实体后面
    const children = session.opened.value.kind === 'scene' ? (session.file.children ?? []).map((scene): Node => ({ key: CHILD_SCENE + scene, scene, children: [] })) : [];
    return [{ key: DOCUMENT, children: [...buildTree(session.expanded), ...children] }];
  });
  const documentName = () => {
    const path = session.opened.value?.path ?? session.file.name;
    return path.slice(path.lastIndexOf('/') + 1);
  };

  /** 树里的位置（兄弟里有成员）换成文档里兄弟的位置。 */
  const move = ({ key, target }: TreeMove<Node>) => {
    if (key === DOCUMENT) return;
    const parent = target.parent === DOCUMENT ? null : target.parent ?? null;
    const siblings = buildTree(session.expanded);
    const list = parent === null ? siblings : findNode(siblings, parent)?.children ?? [];
    const position = list.filter((node) => node.key !== key).slice(0, target.index).filter((node) => !session.isMember(node.key)).length;
    session.moveEntity(key, parent, position);
  };
  let expanded = _state<string[]>([DOCUMENT]);
  // 选中的实体（粘贴、复制出来的，视口里点到的）在树里看得见：展开它们的祖先
  watch(selection, (ids) => {
    if (!agent.value) return;
    const parentOf = new Map(session.expanded.map((entity) => [entity.id, entity.parent]));
    const open = new Set([DOCUMENT, ...expanded]);
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
  const choose = (picked: string[]) => {
    // 点了文档本身：不选实体
    if (picked.includes(DOCUMENT) && selection.value.length > 0) return session.select([]);
    const ids = picked.filter((id) => id !== DOCUMENT && !id.startsWith(CHILD_SCENE));
    const before = new Set(selection.value);
    // 树报上来的是加进或去掉了一个：那个就是这次点的
    const clicked = ids.find((id) => !before.has(id)) ?? selection.value.find((id) => !ids.includes(id));
    if (clicked === undefined) return session.select(ids);
    if (modifiers.range && anchor !== undefined) {
      const order = visibleOrder(roots, new Set([DOCUMENT, ...expanded]));
      const [from, to] = [order.indexOf(anchor), order.indexOf(clicked)];
      if (from >= 0 && to >= 0) return session.select(order.slice(Math.min(from, to), Math.max(from, to) + 1));
    }
    anchor = clicked;
    session.select(modifiers.toggle ? ids : [clicked]);
  };

  /** 子场景的一行：名字（双击单独打开它编辑）和看不看的开关（在视口里一起看，只看不改）。 */
  const childScene = (path: string) => {
    const shown = session.references.value.includes(path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    return (
      <span {...css.attrs(styles.child)} title={t.childSceneHint(path)} onDblclick={() => void session.openAsset({ kind: 'scene', path })}>
        <span {...css.attrs(!shown && styles.hidden)}>{name}</span>
        <IconButton icon={shown ? Eye : EyeOff} size="sm" variant="ghost" tone="neutral" aria-pressed={shown} aria-label={shown ? t.hideChildScene(name) : t.showChildScene(name)}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            void session.toggleReference(path);
          }} />
      </span>
    );
  };

  return () => (
    <div {...css.attrs(styles.tree)} ref={listen}>
    <Tree
      {...css.attrs(styles.tree)}
      propsScrollArea={{ sx: styles.scroll }}
      aria-label={t.sceneEntities}
      loading={session.opening.value}
      // 页面起来了却没有文档：游戏没有场景
      {...(agent.value && !session.opened.value ? { empty: <span {...css.attrs(styles.noScene)}>{t.noScene}</span> } : {})}
      items={roots}
      getKey={(node: Node) => node.key}
      getLabel={(node: Node) => (node.entity ? node.entity.name || '(unnamed)' : documentName())}
      renderItem={(node: Node) => (node.entity ? (
        node.detached ? (
          <span {...css.attrs(styles.detached)} title={t.parentMissing(session.missingParent(node.entity) ?? '')}>
            <Icon icon={TriangleAlert} />
            {node.entity.name || '(unnamed)'}
          </span>
        ) : (
          <span {...css.attrs(session.isMember(node.key) && styles.member)}>
            {node.entity.name || '(unnamed)'}
            {prefabLabel(session, node.key)}
          </span>
        )
      ) : node.scene !== undefined ? childScene(node.scene) : <span {...css.attrs(styles.scene)} title={t.documentNode}>{documentName()}</span>)}
      getChildren={(node: Node) => node.children}
      hasChildren={(node: Node) => node.children.length > 0}
      selectionMode="multiple"
      _expanded={expanded}
      _selected={selection.value.length === 0 ? [DOCUMENT] : [...selection.value]}
      onUpdate:_selected={choose}
      canDrop={(node: Node, target: TreeMoveTarget) => node.entity !== undefined && !session.isMember(node.key) && target.parent !== null && !target.parent?.startsWith(CHILD_SCENE)}
      onMove={move}
    />
    </div>
  );
});
