/**
 * 节点图面板（材质的 graph，引擎 content/formats/nodeGraph.ts、rendering/mesh/materialGraph.ts）：属性面板里开着的材质的节点图，画在
 * vue-tsx-pro 的 Diagram 上（平移缩放、选择、拖节点、端口之间连线都是它的）。节点是卡片，输出在右、输入在左，参数在下面直接改；
 * 最右边是材质的输出（基础色、金属度……）。操作：
 * - 拖节点移动（材质的输出跟着最右边的节点，不能拖），拖空白处平移（小手），滚轮或触控板捏合缩放；
 * - 从输出端口拖到输入端口（或材质输出）连线，一个输入只接一条线（新的替换旧的）；
 * - 点节点或连线选中，Delete 删掉（删节点时连到它的线一起去掉，删连线是断开）；"加节点"菜单按分类列出节点库；
 * - "整理"按连线分层重排所有节点（输入在左、输出在右，vue-tsx-pro 的 graphLayout），节点变高了互相压住时用；没写位置的节点
 *   （agent 写的图常这样）也按它画。
 * 每次修改经 session.editMaterialGraph 存（同属性面板，稍等一下存），材质热重载，视口里马上看到。节点卡片的行高是定的，
 * 端口的位置按行算（Diagram 的端口 at），不量 DOM。每个节点在端口行下面有一张预览图（第一个输出在 UV 平面上的样子，引擎的
 * materialGraphPreview.ts 画；编辑器界面自己拿一个 WebGPU 设备，图一改就重画）。
 */
import { CircleX, LayoutDashboard, Plus } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, Empty, Flex, IconButton, Menu, MenuGroup, MenuItem, Text, Toolbar } from '@zerodep-dev/vue-tsx-pro-ui';
import { graphLayout } from '@zerodep-dev/vue-tsx-pro-ui/charts';
import { Diagram, DiagramPortNode, portNodeLayout, useDiagram, type DiagramConnection, type DiagramEdgeItem, type DiagramNodeItem, type DiagramNodeMove, type DiagramSelection, type PortNodePort } from '@zerodep-dev/vue-tsx-pro-ui/diagram';
import type { GraphFile, GraphLink, GraphNodeFile, NodeSpec } from '@stride-ts/engine/node-graph';
import { MATERIAL_GRAPH_OUTPUTS, MATERIAL_NODE_SPECS } from '@stride-ts/engine/material-graph';
import { MATERIAL_PREVIEW_SIZE, MaterialGraphPreviewer } from '@stride-ts/engine/material-graph-preview';
import { nextTick, onUnmounted, watch } from 'vue';
import { Fields, type FieldContext } from '../fields/FieldEditor';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

const WIDTH = 190;
/** 有列表参数的节点（颜色渐变的色标）宽一些：列表的每项是序号加一组字段，190 放不下。 */
const WIDE = 280;
/** 参数一行（属性面板的字段行 28 加行间距 2）的高度。 */
const PARAM_ROW = 30;

/**
 * 参数区占几行（属性面板的画法）：一个字段一行；列表是名字一行、每项按它的字段数、最后"加一项"一行（颜色渐变的色标）。
 * 节点的高度按它算，参数区不量 DOM。
 */
function paramRows(spec: NodeSpec, node: GraphNodeFile): number {
  return spec.params.reduce((rows, param) => {
    if (param.type.kind !== 'list') return rows + 1;
    const value = node.params?.[param.name] ?? param.default;
    const items = Array.isArray(value) ? value.length : 0;
    const perItem = param.type.item.kind === 'object' ? param.type.item.fields.length : 1;
    return rows + 2 + items * perItem;
  }, 0);
}
/** 预览图占的高（图加上下的空）。 */
const PREVIEW_ROW = MATERIAL_PREVIEW_SIZE + 8;
/** 图改了以后等这么久没再改才重画预览（拖数值时不每帧都画）。 */
const PREVIEW_DELAY_MS = 150;
/** 新加的节点和上面的节点之间的空。 */
const NODE_GAP = 24;
const OUTPUT_NODE = '$output';
const SPECS = new Map(MATERIAL_NODE_SPECS.map((spec) => [spec.type, spec]));
const OUTPUT_PORTS = Object.entries(MATERIAL_GRAPH_OUTPUTS).map(([name, type]) => ({ name, type }));

const styles = css.create({
  panel: { height: '100%', minHeight: '0', fontSize: '0.75rem' },
  canvas: { flex: '1', minHeight: '0', position: 'relative' },
  diagram: { position: 'absolute', inset: '0' },
  preview: { display: 'block', alignSelf: 'center', width: `${MATERIAL_PREVIEW_SIZE}px`, height: `${MATERIAL_PREVIEW_SIZE}px`, borderRadius: '_sm', backgroundColor: '_surfaceMuted' },
});

/** 一张预览图：ImageData 画进一个画布（换了图才重画）。 */
const PreviewImage = _component(({ image }: { image: ImageData | undefined }) => {
  let canvas = _state.raw<HTMLCanvasElement | null>(null);
  _effect(() => {
    if (canvas && image) canvas.getContext('2d')?.putImageData(image, 0, 0);
  });
  return () => <canvas ref={_toRef(canvas)} {...css.attrs(styles.preview)} width={MATERIAL_PREVIEW_SIZE} height={MATERIAL_PREVIEW_SIZE} aria-hidden="true" />;
});

/** 端口的颜色按种类（数、二维、三维、颜色）。 */
const PORT_COLORS: Readonly<Record<string, string>> = { float: '#9aa0a6', vec2: '#6fbf73', vec3: '#5b9bd5', color: '#e8a33d' };

/** 画布上的一个节点：图里的节点（或材质的输出），带 Diagram 要的位置、大小、端口。 */
interface CardItem extends DiagramNodeItem {
  readonly node?: GraphNodeFile;
  readonly spec?: NodeSpec;
}

/** 节点的端口：名字按语言，点的颜色按种类。 */
const portsOf = (ports: readonly { readonly name: string; readonly type: string }[], label: (name: string) => string): PortNodePort[] =>
  ports.map((port) => ({ id: port.name, label: label(port.name), color: PORT_COLORS[port.type]! }));
const portLabel = (name: string) => t.graphPorts[name] ?? name;
const outputLabel = (name: string) => t.graphOutputs[name as keyof typeof t.graphOutputs] ?? name;

export const GraphPanel = _component(({ session }: { session: EditorSession }) => {
  let selection = _state<DiagramSelection>({ nodes: [], edges: [] });
  const diagram = useDiagram();
  const graph = (): GraphFile | undefined => session.inspected.value?.content['graph'] as GraphFile | undefined;
  const edit = (change: (file: GraphFile) => GraphFile) => session.editMaterialGraph(change);
  const context: FieldContext = { entities: [] };

  /** 各节点的预览图（节点 id → 图）；编辑器界面自己的 GPU 设备上画，第一次要用时才建。 */
  let previews = _state.raw<ReadonlyMap<string, ImageData>>(new Map());
  let previewer: Promise<MaterialGraphPreviewer | undefined> | undefined;
  const loadImage = async (path: string) => {
    const url = session.imageUrl(path);
    if (!url) return undefined;
    const response = await fetch(url);
    return response.ok ? createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' }) : undefined;
  };
  const getPreviewer = () => (previewer ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const device = await adapter?.requestDevice();
    return device ? new MaterialGraphPreviewer(device, { loadImage }) : undefined;
  })());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendering = 0;
  // 图一改就重画（合并连着的修改）；画的过程中又改了，只要最后一次的结果
  watch(() => JSON.stringify(graph() ?? null), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const file = graph();
      if (!file) return;
      const ticket = ++rendering;
      void getPreviewer().then((renderer) => renderer?.render(file, session.inspected.value?.path ?? 'material graph')).then((images) => {
        if (images && ticket === rendering) previews = images;
      }).catch((error: unknown) => (session.notice.value = (error as Error).message));
    }, PREVIEW_DELAY_MS);
  }, { immediate: true });
  onUnmounted(() => {
    clearTimeout(timer);
    void previewer?.then((renderer) => renderer?.destroy());
  });

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
    // 新节点放在已有节点的下面（按卡片画出来的高）
    const bottom = Math.max(0, ...cards(file).filter((item) => item.node).map((item) => item.y + item.height + NODE_GAP));
    return { ...file, nodes: [...file.nodes, { id: `${type}${n}`, type, position: [0, bottom] }] };
  });
  /**
   * 按连线分层排（vue-tsx-pro 的 graphLayout，输入在左、输出在右）：节点 id → 左上角，整张图的左上角在原点。items 要带上
   * 材质的输出（它参加排、决定接它的节点的上下顺序），结果里没有它：它照旧跟着最右边的节点。
   */
  const layeredPositions = (file: GraphFile, items: readonly CardItem[]): Map<string, [number, number]> => {
    const centers = graphLayout(items, links(file).map((link) => ({ source: link.from, target: link.to })), { layout: 'layered', direction: 'LR' });
    const corners = items.filter((item) => item.node).map((item) => {
      const center = centers.get(item.id)!;
      return [item.id, center.x - item.width / 2, center.y - item.height / 2] as const;
    });
    const left = Math.min(...corners.map(([, x]) => x)), top = Math.min(...corners.map(([, , y]) => y));
    return new Map(corners.map(([id, x, y]) => [id, [Math.round(x - left), Math.round(y - top)]]));
  };
  /** 整理：所有节点按连线重排（节点变高了互相压住、图乱了时用），排完视口适应内容。 */
  const arrange = () => {
    edit((file) => {
      const at = layeredPositions(file, cards(file));
      return { ...file, nodes: file.nodes.map((node) => (at.has(node.id) ? { ...node, position: at.get(node.id)! } : node)) };
    });
    void nextTick(() => diagram.fit());
  };
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
      // 端口行下面是预览图和参数（属性面板的字段行，每行 PARAM_ROW），端口位置按行算（portNodeLayout）；有参数的节点里有控件
      const layout = portNodeLayout({
        outputs: portsOf(spec.outputs, portLabel),
        inputs: portsOf(spec.inputs, portLabel),
        body: (spec.outputs.length > 0 ? PREVIEW_ROW : 0) + paramRows(spec, node) * PARAM_ROW + 6,
      });
      const [x, y] = node.position ?? [0, 0];
      const width = spec.params.some((param) => param.type.kind === 'list') ? WIDE : WIDTH;
      return [{ id: node.id, x, y, width, ...layout, controls: spec.params.length > 0, node, spec }];
    });
    // 材质的输出在最右边的节点右面
    const output = portNodeLayout({ inputs: portsOf(OUTPUT_PORTS, outputLabel) });
    const withOutput = (nodes: CardItem[]): CardItem[] => [
      ...nodes,
      { id: OUTPUT_NODE, x: Math.max(0, ...nodes.map((item) => item.x + item.width)) + 80, y: 0, width: WIDTH, height: output.height, ports: output.ports },
    ];
    if (file.nodes.every((node) => node.position)) return withOutput(items);
    // 没写位置的节点（agent 写的图常这样）画在分层排的位置上，拖过或整理过才存下位置
    const at = layeredPositions(file, withOutput(items));
    return withOutput(items.map((item) => {
      const placed = item.node?.position ? undefined : at.get(item.id);
      return placed ? { ...item, x: placed[0], y: placed[1] } : item;
    }));
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

  /** 一个节点：标题、端口行，参数在下面直接改（材质的输出只有输入端口）。 */
  const card = (item: CardItem) => {
    const { node, spec } = item;
    if (!node || !spec) return <DiagramPortNode title={t.graphOutput} inputs={portsOf(OUTPUT_PORTS, outputLabel)} />;
    return (
      <DiagramPortNode title={t.graphNodes[node.type] ?? node.type} propsHeader={{ title: node.id }}
        outputs={portsOf(spec.outputs, portLabel)} inputs={portsOf(spec.inputs, portLabel)}>
        {spec.outputs.length > 0 && <PreviewImage image={previews.get(node.id)} />}
        {spec.params.length > 0 && (
          <Fields
            fields={spec.params.map((param) => ({ name: param.name, type: param.type, optional: true, default: param.default, ...(param.description ? { description: param.description } : {}) }))}
            value={node.params ?? {}}
            context={context}
            onSet={(path, value) => setParam(node.id, path, value)}
          />
        )}
      </DiagramPortNode>
    );
  };

  return () => {
    const inspected = session.inspected.value;
    const file = graph();
    if (inspected?.kind !== 'material' || !file) return <Empty size="sm" icon={false} description={t.graphNoMaterial} />;
    return (
      <Flex direction="column" sx={styles.panel}>
        <Toolbar docked="top" aria-label={t.toolWindows.graph}>
          <Menu trigger={(props) => <Button {...props} size="sm" variant="soft" tone="neutral" icon={Plus}>{t.graphAddNode}</Button>}>
            {[...new Set(MATERIAL_NODE_SPECS.map((spec) => spec.category))].map((category) => (
              <MenuGroup label={t.graphCategories[category] ?? category}>
                {MATERIAL_NODE_SPECS.filter((spec) => spec.category === category).map((spec) => <MenuItem onAction={() => add(spec.type)}>{t.graphNodes[spec.type] ?? spec.type}</MenuItem>)}
              </MenuGroup>
            ))}
          </Menu>
          <Button size="sm" variant="ghost" tone="neutral" icon={LayoutDashboard} disabled={file.nodes.length === 0} onClick={arrange}>{t.graphArrange}</Button>
          <Flex grow>
            <Text tone="muted" truncate>{t.graphHint}</Text>
          </Flex>
          <IconButton icon={CircleX} size="sm" variant="ghost" aria-label={t.graphClose} onClick={() => session.closeMaterialGraph()} />
        </Toolbar>
        <div {...css.attrs(styles.canvas)} onKeydown={onKeydown}>
          <Diagram
            {...css.attrs(styles.diagram)}
            controller={diagram}
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
            {(item: CardItem) => card(item)}
          </Diagram>
        </div>
      </Flex>
    );
  };
});
