/**
 * 调试命令 `material-export`（编辑器节点图面板的"导出贴图"、MCP 的 export_material_textures）：把材质节点图的各个输出在 UV 平面上
 * 烘成 png，经编辑器后端存进内容目录，给别的软件（DCC、别的引擎）用，或者换成普通的贴图材质。编辑状态的页面里就能导出。
 *
 * 每个接了的输出一张：基础色、自发光是 sRGB，法线是切线空间按 0.5 偏移（同材质的法线贴图），金属度、粗糙度、遮蔽是灰度。
 * 只有按 UV 算的部分是对的：接了世界位置、坡度、屏幕遮蔽这些的，用的是平面上的替身（同节点的预览）。
 */
import type { GraphFile } from '../content/formats/nodeGraph';
import { saveImage } from '../editor/backendApi';
import type { Game } from '../engine/Game';
import { MATERIAL_GRAPH_OUTPUTS, type MaterialGraphOutput } from '../rendering/mesh/materialGraph';
import { MaterialGraphBaker } from '../rendering/mesh/materialGraphBake';
import { encodePng } from './png';

/** 导出的结果：每个输出存在哪（内容路径），用了多久（秒）。 */
export interface MaterialExportResult {
  readonly files: readonly { readonly output: MaterialGraphOutput; readonly path: string; readonly bytes: number }[];
  readonly size: number;
  readonly elapsed: number;
}

export async function materialExportCommand(game: Game, args: Readonly<Record<string, unknown>>): Promise<MaterialExportResult> {
  const material = args['material'];
  if (typeof material !== 'string' || material === '') throw new Error('material-export: give material (the content path of a material)');
  const size = args['size'] === undefined ? 1024 : Number(args['size']);
  if (!Number.isInteger(size) || size < 1 || size > 8192) throw new Error(`material-export: size must be a whole number of pixels from 1 to 8192, got ${JSON.stringify(args['size'])}`);
  const started = performance.now();
  const graph = (args['graph'] as GraphFile | undefined) ?? (await game.content.loadMaterialFile(material)).graph;
  if (!graph) throw new Error(`material-export: material ${material} has no node graph`);
  const known = Object.keys(MATERIAL_GRAPH_OUTPUTS) as MaterialGraphOutput[];
  const asked = Array.isArray(args['outputs']) ? (args['outputs'] as string[]) : known;
  const unknown = asked.filter((name) => !known.includes(name as MaterialGraphOutput));
  if (unknown.length > 0) throw new Error(`material-export: unknown outputs ${unknown.join(', ')} (known: ${known.join(', ')})`);
  const outputs = (asked as MaterialGraphOutput[]).filter((name) => graph.outputs[name]);
  if (outputs.length === 0) throw new Error(`material-export: the node graph of ${material} has none of the outputs ${asked.join(', ')} linked`);

  const where = `material ${material}`;
  const textures = await game.content.loadMaterialGraphTextures(graph, where);
  const resources = game.renderSystem.resources;
  const images = await MaterialGraphBaker.for(resources.device).exportOutputs(graph, outputs, size, (key) => {
    const texture = textures.get(key);
    if (!texture) throw new Error(`${where}: '${key}' was not loaded`);
    return resources.texture(texture);
  }, where);
  const prefix = typeof args['path'] === 'string' && args['path'] !== '' ? args['path'] : `${material}_`;
  const files = [];
  for (const [output, rgba] of images) {
    const png = await encodePng(rgba, size, size);
    const path = `${prefix}${output}`;
    await saveImage(path, png);
    files.push({ output, path, bytes: png.length });
  }
  return { files, size, elapsed: (performance.now() - started) / 1000 };
}
