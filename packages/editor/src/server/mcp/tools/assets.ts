/** 编辑器 MCP 服务的工具：资源：列、读、写、删、挪、导入，字段的 JSON Schema。 */
import type { McpServer } from '@modelcontextprotocol/server';
import { assetSchemas, componentSchemas, entitySchema, sceneSettingSchemas } from '@stride-ts/engine/editor-field-schema';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { assetPath, brief, json, kind, type McpProjects } from '../shared.ts';

export function registerAssetsTools(server: McpServer, projects: McpProjects): void {
  server.registerTool('list_assets', {
    description: 'Assets in the content folder (kind, content path, what each refers to). Filter by kind and folder.',
    inputSchema: z.object({ kind: kind.optional(), folder: z.string().optional().describe('only assets under this content folder') }),
  }, async ({ kind, folder }) => json(projects.current.database.list()
    .filter((asset) => (!kind || asset.kind === kind) && (!folder || asset.path.startsWith(`${folder}/`)))
    .map(brief)));

  server.registerTool('read_asset', {
    description: 'The JSON content of an asset file (scene, prefab, material, JSON model, UI page, sound, ...). Binary assets (compiled models, textures) cannot be read.',
    inputSchema: z.object({ kind, path: assetPath }),
  }, async ({ kind, path }) => json(await projects.current.readAsset(kind, path)));

  server.registerTool('write_asset', {
    description: 'Write the whole JSON content of an asset (create: only create a new one, fail if it exists). Field shapes: field_schemas. Editors and the running game hot reload it.',
    inputSchema: z.object({ kind, path: assetPath, content: z.unknown().describe('the JSON content'), create: z.boolean().optional() }),
  }, async ({ kind, path, content, create }) => json(brief(await projects.current.saveAsset(kind, path, content, { create: create ?? false }))));

  server.registerTool('delete_asset', {
    description: 'Delete an asset and its files. Refuses while other assets refer to it, unless force (their references break).',
    inputSchema: z.object({ kind, path: assetPath, force: z.boolean().optional() }),
  }, async ({ kind, path, force }) => json(await projects.current.deleteAsset(kind, path, { force: force ?? false })));

  server.registerTool('move_asset', {
    description: 'Move or rename an asset (give kind) or a whole folder (no kind); files that refer to them are rewritten.',
    inputSchema: z.object({ kind: kind.optional(), from: z.string(), to: z.string() }),
  }, async ({ kind, from, to }) => {
    const result = await projects.current.moveAssets(kind ? { assets: [{ kind, from, to }] } : { folder: from, to });
    return json({ moved: result.moved.map(brief), rewritten: result.rewritten.map(brief) });
  });

  server.registerTool('import_file', {
    description: 'Import a file from disk into a content folder: audio (mp3, ogg, wav, flac, aac) becomes a sound, images (png, jpg, webp, svg) a texture, glb/gltf/fbx/obj a model with materials and textures, ttf/otf/ttc a font.',
    inputSchema: z.object({ file: z.string().describe('absolute path of the file on disk'), folder: z.string().describe('content folder to put it in ("" is the root)') }),
  }, async ({ file, folder }) => {
    const result = await projects.current.importFile(folder, path.basename(file), new Uint8Array(await readFile(file)));
    return json({ asset: brief(result.asset), warnings: result.warnings, ...(result.animations ? { animations: result.animations } : {}) });
  });

  server.registerTool('import_material', {
    description: [
      'Import a scanned material (a set of texture maps from ambientCG, Poly Haven, Quixel, Substance...) as one material: maps are recognized by the',
      'last word of the file name (Color/Albedo/Diff, NormalGL/NormalDX/nor_gl, Roughness/Gloss, Metalness, AmbientOcclusion/AO; resolution suffixes',
      'like _2K are ignored), compressed to KTX2 (UASTC, mipmaps) under <folder>/<name>/, and a <folder>/<name>.material.json is written.',
      'A Height/Displacement map is packed into the alpha of the normal map and turns on parallax occlusion (parallaxDepth meters at full height).',
      'tileSize is how many meters one repeat of the texture covers (generated models use metric world UVs). Record where the data comes from in credit.',
    ].join(' '),
    inputSchema: z.object({
      files: z.array(z.string()).describe('absolute paths of the map images'),
      folder: z.string().describe('content folder to put the material in ("" is the root)'),
      name: z.string().optional().describe('material name; default: the common prefix of the file names'),
      tileSize: z.number().positive().optional().describe('meters covered by one repeat of the texture (default 1)'),
      maxSize: z.number().int().min(0).optional().describe('longest side of the compressed textures in pixels (default 2048, 0: keep)'),
      parallaxDepth: z.number().positive().optional().describe('with a height map: how deep the lowest point looks, in meters (default 0.01)'),
      credit: z.object({ source: z.string(), license: z.string(), author: z.string().optional() }).optional().describe('source URL, license and author of the scanned data'),
    }),
  }, async ({ files, folder, ...options }) => {
    const loaded = await Promise.all(files.map(async (file) => ({ name: path.basename(file), bytes: new Uint8Array(await readFile(file)) })));
    const result = await projects.current.importMaterialSet(folder, loaded, options);
    return json({ asset: brief(result.asset), warnings: result.warnings });
  });

  server.registerTool('field_schemas', {
    description: 'JSON Schemas of what scene files may contain: components (the keys under an entity\'s "components"), scene settings, the entity\'s own fields, and assets edited by fields (material, JSON model). Give name for one of them.',
    inputSchema: z.object({ of: z.enum(['components', 'sceneSettings', 'entity', 'assets']), name: z.string().optional().describe('one component, setting or asset kind') }),
  }, async ({ of, name }) => {
    if (of === 'entity') return json(entitySchema());
    const all = of === 'components' ? componentSchemas() : of === 'sceneSettings' ? sceneSettingSchemas() : assetSchemas();
    if (name === undefined) return json(all);
    const schema = all[name];
    if (!schema) throw new Error(`no ${of} named '${name}'; there are: ${Object.keys(all).join(', ')}`);
    return json(schema);
  });
}
