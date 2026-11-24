/**
 * 材质库的定义工具：类别、条目的类型、节点图的简写（nodeGraph）和 plain。各类别的材质在 materials/ 下各一个文件，
 * index.ts 汇总（前端的库窗口、MCP 的 library 工具共用）。
 */
import type { GraphFile, GraphNodeFile } from '@stride-ts/engine/node-graph';
import type { MaterialFile } from '@stride-ts/engine/content-format';

export type MaterialCategory = 'metal' | 'plastic' | 'glass' | 'emissive' | 'stone' | 'brick' | 'concrete' | 'ceramic' | 'wood' | 'fabric' | 'paper' | 'organic' | 'terrain' | 'road' | 'vehicle' | 'smart';

export interface LibraryMaterial {
  /** 小驼峰的 id：缩略图、翻译表、MCP 按它找；拷进工程时的名字是它的大驼峰。 */
  readonly id: string;
  readonly category: MaterialCategory;
  readonly material: MaterialFile;
}

/** 拷进工程时的资源名：id 的大驼峰。 */
export const libraryAssetName = (id: string): string => id[0]!.toUpperCase() + id.slice(1);
/** 库里的材质拷进工程放在哪个内容路径。 */
export const libraryMaterialPath = (id: string): string => `Materials/Library/${libraryAssetName(id)}`;

// ---- 材质 ----

/** 一个节点：id、种类、参数、输入（端口名 → 源节点 id 或 [节点 id, 输出名]）。不写位置：节点图面板按连线排。 */
export type NodeSpec = readonly [id: string, type: string, params?: Record<string, unknown>, inputs?: Record<string, string | readonly [string, string]>];

/**
 * 按简写建材质的节点图（材质文件的 graph）：节点列表加输出（材质的属性 → 源节点）。库里的材质、搭场景的脚本写节点图都用它。
 * 例：nodeGraph([['uv', 'uv'], ['spots', 'noise', { scale: 8 }, { uv: 'uv' }]], { roughness: 'spots' })
 */
export function nodeGraph(nodes: readonly NodeSpec[], outputs: Record<string, string | readonly [string, string]>): GraphFile {
  const link = (source: string | readonly [string, string]) => (typeof source === 'string' ? { node: source } : { node: source[0], output: source[1] });
  return {
    nodes: nodes.map(([id, type, params, inputs]): GraphNodeFile => ({
      id, type,
      ...(params ? { params } : {}),
      ...(inputs ? { inputs: Object.fromEntries(Object.entries(inputs).map(([port, source]) => [port, link(source)])) } : {}),
    })),
    outputs: Object.fromEntries(Object.entries(outputs).map(([name, source]) => [name, link(source)])),
  };
}

export const plain = (id: string, category: MaterialCategory, material: Omit<MaterialFile, 'name'>): LibraryMaterial => ({ id, category, material: { name: libraryAssetName(id), ...material } });

