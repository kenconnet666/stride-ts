/** 编辑器 MCP 服务各组工具共用的：参数的 schema、结果的写法、编辑的工程。 */
import { EXTENSIONS } from '@stride-ts/engine/content-format';
import type { TextureEncoding } from '@stride-ts/engine/content-format';
import * as z from 'zod';
import type { AssetKind, AssetRecord } from '../../shared/protocol.ts';
import type { EditorBackend } from '../backend/EditorBackend.ts';

/** 资源的种类：内容格式的扩展名表里的（字形块算字体的），加上源图片、源音频。 */
export const ASSET_KINDS = [...Object.keys(EXTENSIONS).filter((key) => key !== 'glyphs'), 'image', 'audio'] as unknown as [AssetKind, ...AssetKind[]];
export const kind = z.enum(ASSET_KINDS).describe('asset kind');
export const assetPath = z.string().describe('content path of the asset, without extension (e.g. "Materials/Ground")');

/** 结果写成 JSON 文本（agent 读得懂，也能原样转给别的工具）。 */
export const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] });
/** 资源的记录去掉 agent 用不着的（修改时间、字节数）。 */
export const brief = (record: AssetRecord) => ({ kind: record.kind, path: record.path, ...(record.references.length > 0 ? { references: record.references } : {}), ...(record.error ? { error: record.error } : {}) });

/** MCP 服务编辑的工程：一次一个，switch_project 换（同一个服务能改仓库里的各个样例）。 */
export interface McpProjects {
  readonly current: EditorBackend;
  /** 能换到的工程（仓库根下的相对路径，比如 apps/open-world）。 */
  list(): Promise<string[]>;
  /** 换到 project（list 里的路径或者工程目录的名字），返回新的后端。 */
  switch(project: string): Promise<EditorBackend>;
}

/** 贴图的文件读成精灵表里的编码：有浏览器能解的源图片用它（KTX2 以外的），只有 KTX2 时是 ktx2。 */
export function imageEncodingOf(files: readonly string[]): TextureEncoding {
  const source = files.map((file) => file.slice(file.lastIndexOf('.')).toLowerCase()).find((extension) => extension !== '.ktx2');
  return source === '.jpg' || source === '.jpeg' ? 'jpeg' : source === '.webp' ? 'webp' : source === '.svg' ? 'svg' : source === '.png' ? 'png' : 'ktx2';
}
