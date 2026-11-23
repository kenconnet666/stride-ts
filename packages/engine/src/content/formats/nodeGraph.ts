/**
 * 节点图（材质节点图，以后的粒子图、可视化逻辑共用）：文件里的格式、节点库的描述和排序。图是有向无环的：一个节点的输出可以
 * 接到好几个地方，求值时只算一次。具体的节点库（每种节点有哪些端口、怎么生成代码）由用它的模块给（rendering/mesh/materialGraph.ts）。
 *
 * 编辑器的节点图面板只认这里的格式和 NodeSpec：节点的位置、端口、参数的字段描述都在里面，换一个节点库不用改面板。
 */
import type { FieldType } from '../../editor/fields/index';

/** 一条连线的源头：哪个节点的哪个输出（没写是它的第一个输出）。 */
export interface GraphLink {
  readonly node: string;
  readonly output?: string;
}

export interface GraphNodeFile {
  readonly id: string;
  readonly type: string;
  /** 参数（节点库里的 params 描述），没写的用默认值。 */
  readonly params?: Readonly<Record<string, unknown>>;
  /** 输入接到哪；没接的用端口的默认值。 */
  readonly inputs?: Readonly<Record<string, GraphLink>>;
  /** 编辑器里的位置（面板坐标，像素）；不写时编辑器按连线自动排（agent 写图不用管位置）。 */
  readonly position?: readonly [number, number];
}

export interface GraphFile {
  readonly nodes: readonly GraphNodeFile[];
  /** 图的输出（材质的各个属性）接到哪；没接的不输出。 */
  readonly outputs: Readonly<Record<string, GraphLink | undefined>>;
}

/** 端口的值的种类。 */
export type PortType = 'float' | 'vec2' | 'vec3' | 'color';

export interface PortSpec {
  readonly name: string;
  readonly type: PortType;
}

/** 节点库里的一种节点：分类（编辑器的"加节点"菜单按它分组）、端口、参数。 */
export interface NodeSpec {
  readonly type: string;
  readonly category: string;
  /** 界面上的名字（按语言）；内置的节点在编辑器的语言包里，工程登记的节点写在这里，都没有时用 type。 */
  readonly label?: string | Readonly<Partial<Record<'zh-CN' | 'en', string>>>;
  readonly inputs: readonly PortSpec[];
  readonly outputs: readonly PortSpec[];
  /** 参数的字段描述（编辑器在节点上按它画编辑控件），默认值在 default 里。 */
  readonly params: readonly { readonly name: string; readonly type: FieldType; readonly default: unknown; readonly description?: string }[];
}

/**
 * 从 roots（图的输出接着的节点）往回走，按"被依赖的在前"排好要求值的节点；没接到输出的节点不算（all 时也排进去，节点的预览用）。连线指向不存在的节点、
 * 节点 id 重复、有环时报错（where 用在消息里）。
 */
export function sortGraph(graph: GraphFile, where: string, { all = false }: { readonly all?: boolean } = {}): GraphNodeFile[] {
  const byId = new Map<string, GraphNodeFile>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) throw new Error(`${where}: two nodes have the id '${node.id}'`);
    byId.set(node.id, node);
  }
  const order: GraphNodeFile[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, from: string): void => {
    const node = byId.get(id);
    if (!node) throw new Error(`${where}: ${from} is linked to node '${id}', which does not exist`);
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`${where}: the graph has a cycle through node '${id}'`);
    state.set(id, 'visiting');
    for (const [input, link] of Object.entries(node.inputs ?? {})) visit(link.node, `input ${input} of node '${id}'`);
    state.set(id, 'done');
    order.push(node);
  };
  for (const [output, link] of Object.entries(graph.outputs)) if (link) visit(link.node, `output ${output}`);
  // 节点的预览要每个节点都算，没接到输出的也排进去
  if (all) for (const node of graph.nodes) visit(node.id, `node '${node.id}'`);
  return order;
}
