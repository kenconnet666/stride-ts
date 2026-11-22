/**
 * 合成的那批（货架、堆放：引擎 modeling/productBatch.ts 的 MergedProducts）写成文件：模型（槽 0 是图集的材质，有玻璃时槽 1 是
 * 玻璃）、颜色图集 `<path>.svg`、表面图集 `<path>.surface.svg`、有发光的格子时自发光图集 `<path>.emissive.svg`、材质 `<path>`，
 * 有玻璃时玻璃的材质 `<path>.glass`。都是生成的，改源文件（`.shelf.json`、`.pile.json`）。
 */
import { encodeModel, EXTENSIONS } from '@stride-ts/engine/content-format';
import { mergedGlassMaterial, mergedMaterial, type MergedProducts } from '@stride-ts/engine/modeling';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from '../mesh.ts';
import type { BakedFile } from './productModel.ts';

export function mergedFiles(tools: StrideTools, name: string, path: string, model: MergedProducts): BakedFile[] {
  const encoder = new TextEncoder();
  const json = (value: object) => encoder.encode(`${JSON.stringify(value, null, 1)}\n`);
  const meshes: SourceMesh[] = [];
  if (model.indices.length > 0) meshes.push({ name: 'batch', material: 0, vertices: model.vertices, indices: model.indices });
  if (model.glass) meshes.push({ name: 'glass', material: 1, vertices: model.glass.vertices, indices: model.glass.indices });
  const glass = `${path}.glass`;
  return [
    { path: path + EXTENSIONS.model, bytes: encodeModel({ meshes: meshes.length > 0 ? compressMeshes(meshes, tools) : [], materials: model.glass ? [path, glass] : [path] }) },
    { path: `${path}.svg`, bytes: encoder.encode(model.colorSvg) },
    { path: `${path}.surface.svg`, bytes: encoder.encode(model.surfaceSvg) },
    ...(model.emissiveSvg ? [{ path: `${path}.emissive.svg`, bytes: encoder.encode(model.emissiveSvg) }] : []),
    { path: path + EXTENSIONS.material, bytes: json(mergedMaterial(name, path, model.atlasPixels, model.emissive)) },
    ...(model.glass ? [{ path: glass + EXTENSIONS.material, bytes: json(mergedGlassMaterial(name)) }] : []),
  ];
}
