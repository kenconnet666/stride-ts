/**
 * 合成的那批（货架、堆放：引擎 modeling/productBatch.ts 的 MergedProducts）写成文件：模型（槽 0 是图集的材质，有玻璃、透光的商品时
 * 接着是它们的材质）、颜色图集 `<path>.svg` 和它的矢量版 `<path>.vector`、表面图集 `<path>.surface.svg`、有发光的格子时自发光图集 `<path>.emissive.svg`、
 * 材质 `<path>`，有玻璃时玻璃的材质 `<path>.glass`，有透光的商品时它们的材质 `<path>.clear`，玻璃上有脏时它的材质 `<path>.haze` 和
 * 贴图 `<path>.haze.svg`。都是生成的，改源文件（`.shelf.json`、
 * `.pile.json`）。
 */
import { encodeModel, EXTENSIONS, type MaterialFile } from '@stride-ts/engine/content-format';
import { mergedClearMaterial, mergedGlassMaterial, mergedHazeMaterial, mergedMaterial, svgShapes, type MergedProducts, type MeshArrays } from '@stride-ts/engine/modeling';
import { buildVectorAtlas } from '@stride-ts/engine/vector-atlas';
import type { StrideTools } from '@stride-ts/native/tools';
import { compressMeshes, type SourceMesh } from '../mesh.ts';
import type { BakedFile } from './productModel.ts';

export function mergedFiles(tools: StrideTools, name: string, path: string, model: MergedProducts): BakedFile[] {
  const encoder = new TextEncoder();
  const json = (value: object) => encoder.encode(`${JSON.stringify(value, null, 1)}\n`);
  const meshes: SourceMesh[] = [];
  if (model.indices.length > 0) meshes.push({ name: 'batch', material: 0, vertices: model.vertices, indices: model.indices });
  // 槽 0 是图集的材质，后面按有没有玻璃、透光的商品排
  const materials = [path], extra: BakedFile[] = [];
  const part = (mesh: MeshArrays | undefined, suffix: string, material: MaterialFile) => {
    if (!mesh) return;
    meshes.push({ name: suffix, material: materials.length, vertices: mesh.vertices, indices: mesh.indices });
    materials.push(`${path}.${suffix}`);
    extra.push({ path: `${path}.${suffix}${EXTENSIONS.material}`, bytes: json(material) });
  };
  part(model.glass, 'glass', mergedGlassMaterial(name));
  part(model.clear, 'clear', mergedClearMaterial(name, path, model.atlasPixels));
  const haze = model.haze && model.hazeSvg && model.hazePixels ? model.hazeSvg : undefined;
  if (haze) {
    part(model.haze, 'haze', mergedHazeMaterial(name, path, model.hazePixels!));
    extra.push({ path: `${path}.haze.svg`, bytes: encoder.encode(haze) });
  }
  return [
    { path: path + EXTENSIONS.model, bytes: encodeModel({ meshes: meshes.length > 0 ? compressMeshes(meshes, tools) : [], materials }) },
    { path: `${path}.svg`, bytes: encoder.encode(model.colorSvg) },
    // 颜色图集的矢量版：近处按曲线画（引擎 rendering/mesh/vectorAtlas.ts）
    { path: `${path}.vector`, bytes: new Uint8Array(buildVectorAtlas(svgShapes(model.colorSvg, `${path}.svg`)).buffer) },
    { path: `${path}.surface.svg`, bytes: encoder.encode(model.surfaceSvg) },
    ...(model.emissiveSvg ? [{ path: `${path}.emissive.svg`, bytes: encoder.encode(model.emissiveSvg) }] : []),
    { path: path + EXTENSIONS.material, bytes: json(mergedMaterial(name, path, model.atlasPixels, model.emissive)) },
    ...extra,
  ];
}
