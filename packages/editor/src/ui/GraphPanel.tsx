/**
 * 节点图面板（材质的 graph，引擎 graph/nodeGraph.ts、rendering/mesh/materialGraph.ts）：属性面板里开着的材质的节点图。节点是卡片，
 * 输出在右、输入在左，参数在下面直接改；最右边是材质的输出（基础色、金属度……）。操作：
 * - 拖节点的标题移动，拖空白处平移，滚轮缩放；
 * - 从输出口拖到输入口（或材质输出）连线，点已经连着的输入口断开；
 * - 点标题选中，Delete 删掉（连到它的线一起去掉）；"加节点"菜单按分类列出节点库。
 * 每次修改经 session.editMaterialGraph 存（同属性面板，稍等一下存），材质热重载，视口里马上看到。节点的布局是定的（行高固定），
 * 端口的位置按节点的位置算，不量 DOM。
 */
import { CircleX } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { IconButton } from '@zerodep-dev/vue-tsx-pro-ui';
import { onMounted, onUnmounted, type VNode } from 'vue';
import type { GraphFile, GraphLink, GraphNodeFile, NodeSpec } from '@stride-ts/engine/node-graph';
import { MATERIAL_GRAPH_OUTPUTS, MATERIAL_NODE_SPECS } from '@stride-ts/engine/material-graph';
import { FieldRow, type FieldContext } from './FieldEditor';
import { t } from './messages';
import type { EditorSession } from './session';

const WIDTH = 190;
const HEADER = 24;
const ROW = 20;
const OUTPUT_NODE = '$output';
const SPECS = new Map(MATERIAL_NODE_SPECS.map((spec) => [spec.type, spec]));
const OUTPUT_PORTS = Object.entries(MATERIAL_GRAPH_OUTPUTS).map(([name, type]) => ({ name, type }));

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.75rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  name: { fontWeight: '600', marginInlineEnd: '_sm' },
  grow: { flex: '1', color: '_textMuted' },
  canvas: { flex: '1', position: 'relative', overflow: 'hidden', minHeight: '0', backgroundColor: '_background', cursor: 'grab', touchAction: 'none', userSelect: 'none' },
  layer: { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' },
  node: { position: 'absolute', width: `${WIDTH}px`, borderWidth: '1px', borderStyle: 'solid', borderColor: '_border', borderRadius: '6px', backgroundColor: '_surface', boxShadow: '0 1px 4px rgba(0,0,0,0.3)', cursor: 'default' },
  selected: { borderColor: '_accent' },
  header: { height: `${HEADER}px`, lineHeight: `${HEADER}px`, paddingInline: '8px', fontWeight: '600', cursor: 'move', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  row: { height: `${ROW}px`, display: 'flex', alignItems: 'center', paddingInline: '10px', position: 'relative' },
  outputRow: { justifyContent: 'flex-end' },
  port: { position: 'absolute', width: '10px', height: '10px', borderRadius: '50%', top: `${ROW / 2 - 5}px`, cursor: 'crosshair', borderWidth: '1px', borderStyle: 'solid', borderColor: '_text' },
  params: { padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: '2px' },
  hint: { color: '_textMuted', padding: '_sm' },
});

/** 端口的颜色按种类（数、二维、三维、颜色）。 */
const PORT_COLORS: Readonly<Record<string, string>> = { float: '#9aa0a6', vec2: '#6fbf73', vec3: '#5b9bd5', color: '#e8a33d' };

type Point = readonly [number, number];

export const GraphPanel = _component(({ session }: { session: EditorSession }) => {
  let view = _state({ x: 40, y: 30, scale: 1 });
  let selected = _state<string | undefined>(undefined);
  /** 正在拖的节点的位置（松手才存）。 */
  let dragging = _state<{ id: string; at: Point } | undefined>(undefined);
  /** 正在拉的线：从哪个输出、鼠标在哪（面板坐标）。 */
  let wiring = _state<{ link: GraphLink; to: Point } | undefined>(undefined);
  let canvas: HTMLElement | undefined;

  const graph = (): GraphFile | undefined => session.inspected.value?.content['graph'] as GraphFile | undefined;
  const position = (node: GraphNodeFile): Point => (dragging?.id === node.id ? dragging.at : node.position ?? [0, 0]);
  const outputNodeAt = (file: GraphFile): Point => [Math.max(0, ...file.nodes.map((node) => position(node)[0])) + WIDTH + 80, 0];

  /** 面板上的点（屏幕的像素）换成图的坐标。 */
  const toGraph = (event: PointerEvent | WheelEvent): Point => {
    const rect = canvas!.getBoundingClientRect();
    return [(event.clientX - rect.left - view.x) / view.scale, (event.clientY - rect.top - view.y) / view.scale];
  };
  const outputPort = (node: GraphNodeFile, index: number): Point => [position(node)[0] + WIDTH, position(node)[1] + HEADER + index * ROW + ROW / 2];
  const inputPort = (at: Point, index: number, outputs: number): Point => [at[0], at[1] + HEADER + (outputs + index) * ROW + ROW / 2];

  const edit = (change: (file: GraphFile) => GraphFile) => session.editMaterialGraph(change);

  const connect = (from: GraphLink, node: string, port: string) => edit((file) => (node === OUTPUT_NODE
    ? { ...file, outputs: { ...file.outputs, [port]: from } }
    : { ...file, nodes: file.nodes.map((n) => (n.id === node && n.id !== from.node ? { ...n, inputs: { ...n.inputs, [port]: from } } : n)) }));
  const disconnect = (node: string, port: string) => edit((file) => (node === OUTPUT_NODE
    ? { ...file, outputs: Object.fromEntries(Object.entries(file.outputs).filter(([name]) => name !== port)) }
    : { ...file, nodes: file.nodes.map((n) => (n.id === node ? { ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).filter(([name]) => name !== port)) } : n)) }));
  const remove = (id: string) => edit((file) => ({
    nodes: file.nodes.filter((n) => n.id !== id).map((n) => ({ ...n, inputs: Object.fromEntries(Object.entries(n.inputs ?? {}).filter(([, link]) => link.node !== id)) })),
    outputs: Object.fromEntries(Object.entries(file.outputs).filter(([, link]) => link?.node !== id)),
  }));
  const add = (type: string) => edit((file) => {
    let n = file.nodes.length + 1;
    while (file.nodes.some((node) => node.id === `${type}${n}`)) n++;
    const rect = canvas!.getBoundingClientRect();
    const at: Point = [Math.round((rect.width / 2 - view.x) / view.scale - WIDTH / 2), Math.round((rect.height / 2 - view.y) / view.scale - 40)];
    return { ...file, nodes: [...file.nodes, { id: `${type}${n}`, type, position: at }] };
  });
  /** 改参数：路径直接交给属性面板的修改（向量的一个分量、按旧值算的更新都照它的规矩）。 */
  const setParam = (id: string, name: string, path: readonly (string | number)[], value: unknown) => {
    const index = graph()?.nodes.findIndex((n) => n.id === id) ?? -1;
    if (index >= 0) session.editInspected(['graph', 'nodes', index, 'params', name, ...path], value);
  };

  /** 拖：按下时记起点，移动时按 move 改，松手时 done。 */
  const drag = (event: PointerEvent, move: (dx: number, dy: number, event: PointerEvent) => void, done?: (event: PointerEvent) => void) => {
    event.stopPropagation();
    const startX = event.clientX, startY = event.clientY;
    const onMove = (e: PointerEvent) => move((e.clientX - startX) / view.scale, (e.clientY - startY) / view.scale, e);
    const onUp = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      done?.(e);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const panStart = (event: PointerEvent) => {
    selected = undefined;
    const start = { ...view };
    drag(event, (dx, dy) => (view = { ...start, x: start.x + dx * view.scale, y: start.y + dy * view.scale }));
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const [gx, gy] = toGraph(event);
    const scale = Math.min(2, Math.max(0.3, view.scale * Math.exp(-event.deltaY * 0.001)));
    const rect = canvas!.getBoundingClientRect();
    view = { scale, x: event.clientX - rect.left - gx * scale, y: event.clientY - rect.top - gy * scale };
  };
  const moveStart = (event: PointerEvent, node: GraphNodeFile) => {
    selected = node.id;
    const start = node.position ?? [0, 0];
    drag(event, (dx, dy) => (dragging = { id: node.id, at: [Math.round(start[0] + dx), Math.round(start[1] + dy)] }), () => {
      const moved = dragging;
      dragging = undefined;
      if (moved && (moved.at[0] !== start[0] || moved.at[1] !== start[1])) edit((file) => ({ ...file, nodes: file.nodes.map((n) => (n.id === moved.id ? { ...n, position: moved.at } : n)) }));
    });
  };
  /** 从输出口拉线：松手的地方是输入口（data-node、data-port）就连上。 */
  const wireStart = (event: PointerEvent, link: GraphLink) => {
    wiring = { link, to: toGraph(event) };
    drag(event, (_dx, _dy, e) => (wiring = { link, to: toGraph(e) }), (e) => {
      wiring = undefined;
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-port]');
      if (target?.dataset['node'] && target.dataset['port']) connect(link, target.dataset['node'], target.dataset['port']);
    });
  };

  const keydown = (event: KeyboardEvent) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && selected && !(event.target as HTMLElement).closest('input, textarea, select')) {
      remove(selected);
      selected = undefined;
    }
  };
  onMounted(() => window.addEventListener('keydown', keydown));
  onUnmounted(() => window.removeEventListener('keydown', keydown));

  const curve = (a: Point, b: Point, color: string) => {
    const dx = Math.max(40, Math.abs(b[0] - a[0]) / 2);
    return <path d={`M ${a[0]} ${a[1]} C ${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`} stroke={color} stroke-width="2" fill="none" />;
  };

  const context: FieldContext = { entities: [] };

  const nodeCard = (node: GraphNodeFile, spec: NodeSpec) => {
    const [x, y] = position(node);
    return (
      <div {...css.attrs(styles.node, selected === node.id && styles.selected)} style={{ left: `${x}px`, top: `${y}px` }} onPointerdown={(e: PointerEvent) => e.stopPropagation()}>
        <div {...css.attrs(styles.header)} title={node.id} onPointerdown={(e: PointerEvent) => moveStart(e, node)}>{t.graphNodes[node.type] ?? node.type}</div>
        {spec.outputs.map((port) => (
          <div {...css.attrs(styles.row, styles.outputRow)}>
            {t.graphPorts[port.name] ?? port.name}
            <span {...css.attrs(styles.port)} style={{ right: '-6px', backgroundColor: PORT_COLORS[port.type] }} onPointerdown={(e: PointerEvent) => wireStart(e, { node: node.id, output: port.name })} />
          </div>
        ))}
        {spec.inputs.map((port) => (
          <div {...css.attrs(styles.row)}>
            <span {...css.attrs(styles.port)} data-node={node.id} data-port={port.name} style={{ left: '-6px', backgroundColor: node.inputs?.[port.name] ? PORT_COLORS[port.type] : 'transparent' }}
              title={node.inputs?.[port.name] ? t.graphDisconnect : undefined}
              onPointerdown={(e: PointerEvent) => { e.stopPropagation(); if (node.inputs?.[port.name]) disconnect(node.id, port.name); }} />
            {t.graphPorts[port.name] ?? port.name}
          </div>
        ))}
        {spec.params.length > 0 && (
          <div {...css.attrs(styles.params)}>
            {spec.params.map((param) => (
              <FieldRow field={{ name: param.name, type: param.type, optional: true, default: param.default, ...(param.description ? { description: param.description } : {}) }}
                value={node.params?.[param.name]} context={context} onSet={(path, value) => setParam(node.id, param.name, path, value)} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return () => {
    const inspected = session.inspected.value;
    const file = graph();
    if (inspected?.kind !== 'material' || !file) return <div {...css.attrs(styles.hint)}>{t.graphNoMaterial}</div>;
    const out = outputNodeAt(file);
    const links: VNode[] = [];
    const portOf = (link: GraphLink): Point | undefined => {
      const node = file.nodes.find((n) => n.id === link.node);
      const spec = node && SPECS.get(node.type);
      if (!node || !spec) return undefined;
      const index = link.output === undefined ? 0 : spec.outputs.findIndex((p) => p.name === link.output);
      return index < 0 ? undefined : outputPort(node, index);
    };
    for (const node of file.nodes) {
      const spec = SPECS.get(node.type);
      if (!spec) continue;
      spec.inputs.forEach((port, i) => {
        const link = node.inputs?.[port.name];
        const from = link && portOf(link);
        if (from) links.push(curve(from, inputPort(position(node), i, spec.outputs.length), PORT_COLORS[port.type]!));
      });
    }
    OUTPUT_PORTS.forEach((port, i) => {
      const link = file.outputs[port.name];
      const from = link && portOf(link);
      if (from) links.push(curve(from, inputPort(out, i, 0), PORT_COLORS[port.type]!));
    });
    if (wiring) {
      const from = portOf(wiring.link);
      if (from) links.push(curve(from, wiring.to, '#ffffff'));
    }
    const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    return (
      <div {...css.attrs(styles.panel)}>
        <div {...css.attrs(styles.toolbar)}>
          <span {...css.attrs(styles.name)}>{t.graphTitle(inspected.path)}</span>
          <select aria-label={t.graphAddNode} value="" onChange={(event: Event) => { const select = event.target as HTMLSelectElement; if (select.value) add(select.value); select.value = ''; }}>
            <option value="">{t.graphAddNode}</option>
            {[...new Set(MATERIAL_NODE_SPECS.map((spec) => spec.category))].map((category) => (
              <optgroup label={t.graphCategories[category] ?? category}>
                {MATERIAL_NODE_SPECS.filter((spec) => spec.category === category).map((spec) => <option value={spec.type}>{t.graphNodes[spec.type] ?? spec.type}</option>)}
              </optgroup>
            ))}
          </select>
          <span {...css.attrs(styles.grow)}>{t.graphHint}</span>
          <IconButton icon={CircleX} variant="ghost" aria-label={t.graphClose} onClick={() => session.closeMaterialGraph()} />
        </div>
        <div {...css.attrs(styles.canvas)} ref={(element: unknown) => (canvas = element as HTMLElement)} onPointerdown={panStart} onWheel={wheel}>
          <svg {...css.attrs(styles.layer)} style={{ transform, overflow: 'visible' }} width="1" height="1">{links}</svg>
          <div {...css.attrs(styles.layer)} style={{ transform }}>
            {file.nodes.map((node) => {
              const spec = SPECS.get(node.type);
              return spec ? nodeCard(node, spec) : undefined;
            })}
            <div {...css.attrs(styles.node)} style={{ left: `${out[0]}px`, top: `${out[1]}px` }} onPointerdown={(e: PointerEvent) => e.stopPropagation()}>
              <div {...css.attrs(styles.header)}>{t.graphOutput}</div>
              {OUTPUT_PORTS.map((port) => (
                <div {...css.attrs(styles.row)}>
                  <span {...css.attrs(styles.port)} data-node={OUTPUT_NODE} data-port={port.name}
                    style={{ left: '-6px', backgroundColor: file.outputs[port.name] ? PORT_COLORS[port.type] : 'transparent' }}
                    title={file.outputs[port.name] ? t.graphDisconnect : undefined}
                    onPointerdown={(e: PointerEvent) => { e.stopPropagation(); if (file.outputs[port.name]) disconnect(OUTPUT_NODE, port.name); }} />
                  {t.graphOutputs[port.name as keyof typeof t.graphOutputs] ?? port.name}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };
});
