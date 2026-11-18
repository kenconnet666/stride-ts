// 资源管线（Node）：现在有 Stride 工程导入器，把 Stride 的场景、模型、材质转成运行时内容。
export { StrideImporter, svgSize, type ImporterOptions, type ImportResult } from './stride/importer.ts';
export { addTangents, compressMeshes, MAX_QUANTIZED_EXTENT, MAX_QUANTIZED_UV_RANGE, octEncode, type SourceMesh } from './mesh.ts';
export { floatToHalf, fromRgb9e5, halfToFloat, readDdsCubemap, regenerateMips, toHalf, toRgb9e5, type FloatCubemap } from './hdr.ts';
export { StrideProject, type AssetEntry, type AssetRoot } from './stride/project.ts';
export { asNumber, asObject, dictionaryKey, parseAssetReference, parseObjectReference, parseStrideYaml, type StrideObject, type StrideValue } from './stride/yaml.ts';
export { importCompositor, type ImportedCompositor } from './stride/compositor.ts';
