/**
 * 节点图面板（材质的 graph，引擎 content/formats/nodeGraph.ts、rendering/mesh/materialGraph.ts）：属性面板里开着的材质的节点图，画在
 * vue-tsx-pro 的 Diagram 上（平移缩放、选择、拖节点、端口之间连线都是它的）。节点是卡片，输出在右、输入在左，参数在下面直接改；
 * 最右边是材质的输出（基础色、金属度……）。操作：
 * - 拖节点移动（材质的输出跟着最右边的节点，不能拖），拖空白处平移（小手），滚轮或触控板捏合缩放；
 * - 从输出端口拖到输入端口（或材质输出）连线，一个输入只接一条线（新的替换旧的）；
 * - 点节点或连线选中，Delete 删掉（删节点时连到它的线一起去掉，删连线是断开）；"加节点"菜单按分类列出节点库。
 * 每次修改经 session.editMaterialGraph 存（同属性面板，稍等一下存），材质热重载，视口里马上看到。节点卡片的行高是定的，
 * 端口的位置按行算（Diagram 的端口 at），不量 DOM。
 */
import { CircleX, Plus } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, Menu, MenuGroup, MenuItem } from '@zerodep-dev/vue-tsx-pro-ui';
import { Diagram, type DiagramConnection, type DiagramEdgeItem, type DiagramNodeItem, type DiagramNodeMove, type DiagramPortItem, type DiagramSelection } from '@zerodep-dev/vue-tsx-pro-ui/diagram';
import type { GraphFile, GraphLink, GraphNodeFile, NodeSpec } from '@stride-ts/engine/node-graph';
import { MATERIAL_GRAPH_OUTPUTS, MATERIAL_NODE_SPECS } from '@stride-ts/engine/material-graph';
import { Fields, type FieldContext } from './FieldEditor';
import { t } from './messages';
import type { EditorSession } from './session';

const WIDTH = 190;
const HEADER = 24;
const ROW = 20;
/** 卡片的边框：行从边框里面排起 */
const BORDER = 1;
/** 参数一行（属性面板的字段行 28 加行间距 2）的高度。 */
const PARAM_ROW = 30;
const OUTPUT_NODE = '$output';
const SPECS = new Map(MATERIAL_NODE_SPECS.map((spec) => [spec.type, spec]));
const OUTPUT_PORTS = Object.entries(MATERIAL_GRAPH_OUTPUTS).map(([name, type]) => ({ name, type }));

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.75rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  grow: { flex: '1', color: '_textMuted' },
  canvas: { flex: '1', minHeight: '0', position: 'relative' },
  diagram: { position: 'absolute', inset: '0' },
  card: { width: '100%', height: '100%', borderWidth: '1px', borderStyle: 'solid', borderColor: '_border', borderRadius: '6px', backgroundColor: '_surface', boxShadow: '0 1px 4px rgba(0,0,0,0.3)', overflow: 'hidden' },
  selected: { borderColor: '_accent' },
  header: { boxSizing: 'border-box', height: `${HEADER}px`, lineHeight: `${HEADER}px`, paddingInline: '8px', fontWeight: '600', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  row: { height: `${ROW}px`, display: 'flex', alignItems: 'center', paddingInline: '10px' },
  outputRow: { justifyContent: 'flex-end' },
  params: { padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '2px' },
  hint: { color: '_textMuted', padding: '_sm' },
});

/** 端口的颜色按种类（数、二维、三维、颜色）。 */
const PORT_COLORS: Readonly<Record<string, string>> = { float: '#9aa0a6', vec2: '#6fbf73', vec3: '#5b9bd5', color: '#e8a33d' };

/** 画布上的一个节点：图里的节点（或材质的输出），带 Diagram 要的位置、大小、端口。 */
interface CardItem extends DiagramNodeItem {
  readonly node?: GraphNodeFile;
  readonly spec?: NodeSpec;
}

/** 卡片里第 row 行（标题下面从 0 数）的中心在卡片高度里的比例：端口对准它。 */
const rowAt = (row: number, height: number) => (BORDER + HEADER + row * ROW + ROW / 2) / height;

export const GraphPanel = _component(({ session }: { session: EditorSession }) => {
  let selection = _state<DiagramSelection>({ nodes: [], edges: [] });
  const graph = (): GraphFile | undefined => session.inspected.value?.content['graph'] as GraphFile | undefined;
  const edit = (change: (file: GraphFile) => GraphFile) => session.editMaterialGraph(change);
  const context: FieldContext = { entities: [] };

  const connect = (from: GraphLink, node: string, port: string) => edit((file) => (node === OUTPUT_NODE
    ? { ...file, outputs: { ...file.outputs, [port]: from } }
    : { ...file, nodes: file.nodes.map((n) => (n.id === node && n.id !== from.node ? { ...n, inputs: { ...n.inputs, [port]: from } } : n)) }));
  const disconnect = (file: GraphFile, node: string, port: string): GraphFile => (node === OUTPUT_NODE
    ? { ...file, outputs: Object.fromEntries(Object.entries(file.outputs).filter(([name]) => name !== port)) }
    : { ...file, nodes: file.nodes.map((n) => (n.id === node ? { ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).filter(([name]) => name !== port)) } : n)) });
  const removeNode = (file: GraphFile, id: string): GraphFile => ({
    nodes: file.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).filter(([, link]) => link.node !== id)) })),
    outputs: Object.fromEntries(Object.entries(file.outputs).filter(([, link]) => link?.node !== id)),
  });
  const add = (type: string) => edit((file) => {
    let n = file.nodes.length + 1;
    while (file.nodes.some((node) => node.id === `${type}${n}`)) n++;
    // 新节点放在已有节点的下面
    const bottom = Math.max(0, ...file.nodes.map((node) => (node.position?.[1] ?? 0) + 120));
    return { ...file, nodes: [...file.nodes, { id: `${type}${n}`, type, position: [0, bottom] }] };
  });
  /** 改参数：路径直接交给属性面板的修改（向量的一个分量、按旧值算的更新都照它的规矩）。 */
  const setParam = (id: string, path: readonly (string | number)[], value: unknown) => {
    const index = graph()?.nodes.findIndex((n) => n.id === id) ?? -1;
    if (index >= 0) session.editInspected(['graph', 'nodes', index, 'params', ...path], value);
  };

  /** 图里的节点和材质的输出换成 Diagram 的节点（端口对准卡片里的行）。 */
  const cards = (file: GraphFile): CardItem[] => {
    const items: CardItem[] = file.nodes.flatMap((node) => {
      const spec = SPECS.get(node.type);
      if (!spec) return [];
      const height = HEADER + (spec.outputs.length + spec.inputs.length) * ROW + (spec.params.length > 0 ? spec.params.length * PARAM_ROW + 6 : 0) + 2 * BORDER;
      const ports: DiagramPortItem[] = [
        ...spec.outputs.map((port, i): DiagramPortItem => ({ id: port.name, direction: 'out', at: rowAt(i, height), color: PORT_COLORS[port.type]!, label: t.graphPorts[port.name] ?? port.name })),
        ...spec.inputs.map((port, i): DiagramPortItem => ({ id: port.name, direction: 'in', at: rowAt(spec.outputs.length + i, height), color: PORT_COLORS[port.type]!, label: t.graphPorts[port.name] ?? port.name })),
      ];
      const [x, y] = node.position ?? [0, 0];
      return [{ id: node.id, x, y, width: WIDTH, height, ports, node, spec }];
    });
    const right = Math.max(0, ...items.map((item) => item.x)) + WIDTH + 80;
    const height = HEADER + OUTPUT_PORTS.length * ROW + 2 * BORDER;
    items.push({
      id: OUTPUT_NODE, x: right, y: 0, width: WIDTH, height,
      ports: OUTPUT_PORTS.map((port, i) => ({ id: port.name, direction: 'in', at: rowAt(i, height), color: PORT_COLORS[port.type]!, label: port.name })),
    });
    return items;
  };

  /** 输入接的线：连线的 id 是"节点:端口"（删连线时按它断开）。 */
  const links = (file: GraphFile): DiagramEdgeItem[] => {
    const firstOutput = (id: string) => SPECS.get(file.nodes.find((n) => n.id === id)?.type ?? '')?.outputs[0]?.name;
    const edge = (link: GraphLink, node: string, port: string): DiagramEdgeItem[] => {
      const output = link.output ?? firstOutput(link.node);
      return output === undefined ? [] : [{ id: `${node}:${port}`, from: link.node, fromPort: output, to: node, toPort: port }];
    };
    return [
      ...file.nodes.flatMap((node) => Object.entries(node.inputs ?? {}).flatMap(([port, link]) => edge(link, node.id, port))),
      ...Object.entries(file.outputs).flatMap(([port, link]) => (link ? edge(link, OUTPUT_NODE, port) : [])),
    ];
  };

  const onConnect = (connection: DiagramConnection) => {
    if (connection.fromPort === undefined || connection.toPort === undefined) return;
    connect({ node: connection.from, output: connection.fromPort }, connection.to, connection.toPort);
  };
  const onNodesMove = (moves: DiagramNodeMove[]) => edit((file) => ({
    ...file,
    nodes: file.nodes.map((n) => {
      const move = moves.find((m) => m.id === n.id);
      return move ? { ...n, position: [Math.round(move.x), Math.round(move.y)] as [number, number] } : n;
    }),
  }));
  /** Delete：删选中的节点（材质的输出删不掉），断开选中的连线。 */
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if ((event.target as HTMLElement).closest('input, textarea, select')) return;
    const { nodes, edges } = selection;
    if (nodes.length + edges.length === 0) return;
    event.preventDefault();
    edit((file) => {
      let next = file;
      for (const id of edges) {
        const split = id.lastIndexOf(':');
        next = disconnect(next, id.slice(0, split), id.slice(split + 1));
      }
      for (const id of nodes) if (id !== OUTPUT_NODE) next = removeNode(next, id);
      return next;
    });
    selection = { nodes: [], edges: [] };
  };

  const card = (item: CardItem, selected: boolean) => {
    const { node, spec } = item;
    if (!node || !spec) {
      return (
        <div {...css.attrs(styles.card, selected && styles.selected)}>
          <div {...css.attrs(styles.header)}>{t.graphOutput}</div>
          {OUTPUT_PORTS.map((port) => <div {...css.attrs(styles.row)}>{t.graphOutputs[port.name as keyof typeof t.graphOutputs] ?? port.name}</div>)}
        </div>
      );
    }
    return (
      <div {...css.attrs(styles.card, selected && styles.selected)}>
        <div {...css.attrs(styles.header)} title={node.id}>{t.graphNodes[node.type] ?? node.type}</div>
        {spec.outputs.map((port) => <div {...css.attrs(styles.row, styles.outputRow)}>{t.graphPorts[port.name] ?? port.name}</div>)}
        {spec.inputs.map((port) => <div {...css.attrs(styles.row)}>{t.graphPorts[port.name] ?? port.name}</div>)}
        {spec.params.length > 0 && (
          // 参数里拖数值、选下拉框不是拖节点
          <div {...css.attrs(styles.params)} onPointerdown={(event: PointerEvent) => event.stopPropagation()}>
            <Fields
              fields={spec.params.map((param) => ({ name: param.name, type: param.type, optional: true, default: param.default, ...(param.description ? { description: param.description } : {}) }))}
              value={node.params ?? {}}
              context={context}
              onSet={(path, value) => setParam(node.id, path, value)}
            />
          </div>
        )}
      </div>
    );
  };

  return () => {
    const inspected = session.inspected.value;
    const file = graph();
    if (inspected?.kind !== 'material' || !file) return <div {...css.attrs(styles.hint)}>{t.graphNoMaterial}</div>;
    return (
      <div {...css.attrs(styles.panel)}>
        <div {...css.attrs(styles.toolbar)}>
          <Menu trigger={(props) => <Button {...props} size="sm" variant="soft" tone="neutral" icon={Plus}>{t.graphAddNode}</Button>}>
            {[...new Set(MATERIAL_NODE_SPECS.map((spec) => spec.category))].map((category) => (
              <MenuGroup label={t.graphCategories[category] ?? category}>
                {MATERIAL_NODE_SPECS.filter((spec) => spec.category === category).map((spec) => <MenuItem onAction={() => add(spec.type)}>{t.graphNodes[spec.type] ?? spec.type}</MenuItem>)}
              </MenuGroup>
            ))}
          </Menu>
          <span {...css.attrs(styles.grow)}>{t.graphHint}</span>
          <IconButton icon={CircleX} variant="ghost" aria-label={t.graphClose} onClick={() => session.closeMaterialGraph()} />
        </div>
        <div {...css.attrs(styles.canvas)} onKeydown={onKeydown}>
          <Diagram
            {...css.attrs(styles.diagram)}
            nodes={cards(file)}
            edges={links(file)}
            height="100%"
            routing="bezier"
            selectable
            draggable={(item: CardItem) => item.id !== OUTPUT_NODE}
            _selected={selection}
            connectable
            onConnect={onConnect}
            onNodesMove={onNodesMove}
            fitView
            getNodeLabel={(item: CardItem) => (item.node ? t.graphNodes[item.node.type] ?? item.node.type : t.graphOutput)}
            aria-label={t.toolWindows.graph}
          >
            {(item: CardItem, state: { selected: boolean }) => card(item, state.selected)}
          </Diagram>
        </div>
      </div>
    );
  };
});
