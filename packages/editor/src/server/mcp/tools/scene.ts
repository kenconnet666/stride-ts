/** 编辑器 MCP 服务的工具：场景和世界：改场景、预制体，建世界、往世界里放实体、看世界的格子。 */
import type { McpServer } from '@modelcontextprotocol/server';
import { SceneDocument, type EntitiesFile, type SceneEdit } from '@stride-ts/engine/editor-document';
import { checkEntity } from '@stride-ts/engine/editor-fields';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import * as z from 'zod';
import { assetPath, brief, json, type McpProjects } from '../shared.ts';

export function registerSceneTools(server: McpServer, projects: McpProjects): void {
  server.registerTool('edit_scene', {
    description: [
      'Apply edits to a scene or prefab file and save it (one step; editors and the game hot reload). Each edit is one of:',
      '{type:"set", entity:<id>, path:[...keys], value} sets a value inside an entity (path like ["components","light","intensity"] or ["position"]; value undefined removes the key);',
      '{type:"add", entities:[{entity:<SceneEntityFile>, index}]} adds entities (parents before children);',
      '{type:"remove", entities:[ids]} removes entities (give whole subtrees);',
      '{type:"scene", path:["physics"|"navigation"|"offset"|"compositor", ...keys], value} sets a scene setting (scenes only);',
      '{type:"batch", edits:[...]}.',
      'Changed entities are checked against the field descriptions (field_schemas); with problems nothing is saved unless force.',
    ].join(' '),
    inputSchema: z.object({
      kind: z.enum(['scene', 'prefab']),
      path: assetPath,
      edits: z.array(z.record(z.string(), z.unknown())).describe('SceneEdit objects, applied in order'),
      force: z.boolean().optional().describe('save even if the changed entities do not match the field descriptions'),
    }),
  }, async ({ kind, path, edits, force }) => {
    const document = new SceneDocument(await projects.current.readAsset(kind, path) as EntitiesFile);
    const before = document.file.entities;
    document.apply({ type: 'batch', edits: edits as unknown as SceneEdit[] });
    const previous = new Set(before);
    const changed = document.file.entities.filter((entity) => !previous.has(entity));
    const issues = changed.flatMap((entity) => checkEntity(entity));
    if (issues.length > 0 && !force) throw new Error(`not saved; the edits leave problems:\n${issues.join('\n')}`);
    await projects.current.saveAsset(kind, path, document.file);
    const kept = new Set(document.file.entities.map((entity) => entity.id));
    const removed = before.filter((entity) => !kept.has(entity.id)).map((entity) => ({ id: entity.id, name: entity.name }));
    return json({ saved: `${kind} ${path}`, changed: changed.map((entity) => ({ id: entity.id, name: entity.name })), removed, issues });
  });

  server.registerTool('create_world', {
    description: 'Create a large world (.world.json): the XZ plane is cut into square cells, each cell\'s content is a scene file loaded and unloaded by distance at run time (game.world.load). Layers group content by load radius (terrain far, small props near). persistent is a scene that is always there (sky, sun, settings). Add content with place_in_world.',
    inputSchema: z.object({
      path: assetPath,
      cellSize: z.number().positive().optional().describe('cell edge in meters (default 256)'),
      layers: z.array(z.object({ name: z.string(), loadRadius: z.number().positive() })).optional().describe('default [{name:"default", loadRadius:512}]'),
      persistent: z.string().optional().describe('content path of the always-loaded scene'),
    }),
  }, async ({ path, cellSize, layers, persistent }) => json(brief(await projects.current.createWorld(path, {
    ...(cellSize === undefined ? {} : { cellSize }), ...(layers ? { layers } : {}), ...(persistent ? { persistent } : {}),
  }))));

  server.registerTool('place_in_world', {
    description: 'Put entities into a world: each root entity (parent null) goes into the cell its position (world coordinates, meters) falls in, converted to cell-local; children follow their root. Cell scenes are created as needed and the world\'s cell index is updated. Entities without an id get one. Parents must come before children.',
    inputSchema: z.object({
      world: assetPath.describe('content path of the .world.json'),
      layer: z.string().optional().describe('layer name (default: the first layer)'),
      entities: z.array(z.record(z.string(), z.unknown())).describe('SceneEntityFile objects (id, name, parent, position, rotation, scale, components)'),
    }),
  }, async ({ world, layer, entities }) => {
    const file = await projects.current.readAsset('world', world) as { layers: { name: string }[] };
    return json(await projects.current.placeInWorld(world, layer ?? file.layers[0]!.name, entities as unknown as SceneEntityFile[]));
  });

  server.registerTool('world_info', {
    description: 'A world\'s cell size, layers, persistent scene and which cells have content (per layer), with each cell\'s scene path and entity count.',
    inputSchema: z.object({ world: assetPath.describe('content path of the .world.json') }),
  }, async ({ world }) => {
    const file = await projects.current.readAsset('world', world) as { cellSize: number; persistent?: string; layers: { name: string; loadRadius: number }[]; cells: Record<string, [number, number][]> };
    const cells = await Promise.all(Object.entries(file.cells).flatMap(([layer, list]) => list.map(async ([x, z]) => {
      const scene = `${world}/${layer}/${x}_${z}`;
      const content = projects.current.database.get('scene', scene) ? await projects.current.readAsset('scene', scene) as { entities: unknown[] } : undefined;
      return { layer, cell: [x, z], scene, entities: content?.entities.length ?? 0 };
    })));
    return json({ cellSize: file.cellSize, persistent: file.persistent ?? null, layers: file.layers, cells });
  });
}
