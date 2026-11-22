/**
 * 编辑器的 MCP 服务（路线图 F1）：agent 工具不点界面也能做编辑器里人能做的事。`stride-editor mcp [工程目录]` 用 stdio 起服务，
 * 在自己的进程里开一个 EditorBackend（不用开发服务器）：资源的读写、新建、删除、移动、导入，场景和预制体的修改（场景文档的
 * SceneEdit，照字段描述检查），字段描述的 JSON Schema。开发服务器开着时，它的监视器看到文件变了，编辑器和游戏页面照常热重载；
 * 截图、页面命令经开发服务器的调试中枢（stride CLI 的那个）。
 *
 * 工具的名字、参数和编辑器的 HTTP 接口（protocol.ts）、`stride` CLI 的命令一一对应；新的创作功能同时加界面和这里的工具。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { HubClient } from '@stride-ts/cli/client';
import { EXTENSIONS } from '@stride-ts/engine/content-format';
import { SceneDocument, type EntitiesFile, type SceneEdit } from '@stride-ts/engine/editor-document';
import { assetSchemas, componentSchemas, entitySchema, sceneSettingSchemas } from '@stride-ts/engine/editor-field-schema';
import { checkEntity } from '@stride-ts/engine/editor-fields';
import { applyPolyOperation, POLY_OPERATIONS, type PolyOperation } from '@stride-ts/engine/modeling';
import { autoRegions, gridRegions, replaceSprites } from '@stride-ts/engine/editor-sprites';
import { mutateSound, seededRandom, soundSynth, SOUND_PRESETS, SOUND_SYNTH_RATE, synthesizeSound, type SoundPreset } from '@stride-ts/engine/audio-synth';
import type { PolyMeshFile, SceneEntityFile, SoundFile, SpriteSheetFile, TerrainFeatureFile, TerrainFile, TerrainStrokeFile, TextureEncoding } from '@stride-ts/engine/content-format';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import type { AssetKind, AssetRecord } from '../protocol.ts';
import { LIBRARY_EFFECTS, LIBRARY_MATERIALS, libraryAssetName, libraryMaterialPath } from '../library/index.ts';
import type { EditorBackend } from './EditorBackend.ts';

/** 资源的种类：内容格式的扩展名表里的（字形块算字体的），加上源图片、源音频。 */
const ASSET_KINDS = [...Object.keys(EXTENSIONS).filter((key) => key !== 'glyphs'), 'image', 'audio'] as unknown as [AssetKind, ...AssetKind[]];
const kind = z.enum(ASSET_KINDS).describe('asset kind');
const assetPath = z.string().describe('content path of the asset, without extension (e.g. "Materials/Ground")');

/** 结果写成 JSON 文本（agent 读得懂，也能原样转给别的工具）。 */
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }] });
/** 资源的记录去掉 agent 用不着的（修改时间、字节数）。 */
const brief = (record: AssetRecord) => ({ kind: record.kind, path: record.path, ...(record.references.length > 0 ? { references: record.references } : {}), ...(record.error ? { error: record.error } : {}) });

/** MCP 服务编辑的工程：一次一个，switch_project 换（同一个服务能改仓库里的各个样例）。 */
export interface McpProjects {
  readonly current: EditorBackend;
  /** 能换到的工程（仓库根下的相对路径，比如 apps/open-world）。 */
  list(): Promise<string[]>;
  /** 换到 project（list 里的路径或者工程目录的名字），返回新的后端。 */
  switch(project: string): Promise<EditorBackend>;
}

export function createEditorMcpServer(projects: McpProjects): McpServer {
  const server = new McpServer({ name: 'stride-editor', version: '0.2.0' });

  server.registerTool('project', {
    description: 'The stride-ts project this server edits: name, folders, how many assets of each kind, broken references, and the other projects of the repository (switch_project).',
    inputSchema: z.object({}),
  }, async () => {
    const counts: Record<string, number> = {};
    for (const asset of projects.current.database.list()) counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
    const { project } = projects.current;
    return json({ name: project.manifest.name, root: project.root, content: project.contentDir, assets: counts, missingReferences: projects.current.database.missing(), otherProjects: await projects.list() });
  });

  server.registerTool('switch_project', {
    description: 'Switch this server to another stride-ts project of the repository (e.g. apps/open-world, or just open-world); every other tool then works on it. See project for the list.',
    inputSchema: z.object({ project: z.string().describe('project folder relative to the repository root, or its name') }),
  }, async ({ project }) => {
    const editor = await projects.switch(project);
    return json({ name: editor.project.manifest.name, root: editor.project.root, assets: editor.database.size });
  });

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
      'tileSize is how many meters one repeat of the texture covers (generated models use metric world UVs). Record where the data comes from in credit.',
    ].join(' '),
    inputSchema: z.object({
      files: z.array(z.string()).describe('absolute paths of the map images'),
      folder: z.string().describe('content folder to put the material in ("" is the root)'),
      name: z.string().optional().describe('material name; default: the common prefix of the file names'),
      tileSize: z.number().positive().optional().describe('meters covered by one repeat of the texture (default 1)'),
      maxSize: z.number().int().min(0).optional().describe('longest side of the compressed textures in pixels (default 2048, 0: keep)'),
      credit: z.object({ source: z.string(), license: z.string(), author: z.string().optional() }).optional().describe('source URL, license and author of the scanned data'),
    }),
  }, async ({ files, folder, ...options }) => {
    const loaded = await Promise.all(files.map(async (file) => ({ name: path.basename(file), bytes: new Uint8Array(await readFile(file)) })));
    const result = await projects.current.importMaterialSet(folder, loaded, options);
    return json({ asset: brief(result.asset), warnings: result.warnings });
  });

  server.registerTool('sculpt_terrain', {
    description: [
      'Sculpt a vector terrain asset (kind terrain, .terrain.json) and save it; viewports re-evaluate only the tiles the change covers.',
      'Coordinates are the terrain\'s local meters (x, z; the terrain entity\'s position is the origin), heights in meters.',
      'strokes are appended in order: raise / lower {x, z, radius, strength (m)}, flatten {x, z, radius, strength 0..1, height}, smooth {x, z, radius, strength 0..1}.',
      'features are appended: flatten {points: [[x, z], ...] polygon, height, falloff (m), strength 0..1} for roads, plazas, foundations.',
      'undo removes that many of the last strokes first. Returns the stroke and feature counts.',
      'To move, reshape or delete existing features, read_asset the terrain and write_asset it back with the edited features list.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      strokes: z.array(z.object({
        op: z.enum(['raise', 'lower', 'flatten', 'smooth']),
        x: z.number(), z: z.number(), radius: z.number().positive(), strength: z.number(), height: z.number().optional(),
      })).optional(),
      features: z.array(z.object({
        type: z.literal('flatten'), name: z.string().optional(),
        points: z.array(z.tuple([z.number(), z.number()])).min(3), height: z.number(), falloff: z.number().min(0).optional(), strength: z.number().min(0).max(1).optional(),
      })).optional(),
      undo: z.number().int().min(0).optional(),
    }),
  }, async ({ path, strokes = [], features = [], undo = 0 }) => {
    const file = await projects.current.readAsset('terrain', path) as TerrainFile;
    const kept = (file.strokes ?? []).slice(0, Math.max(0, (file.strokes?.length ?? 0) - undo));
    // zod 的可选字段带 undefined，文件的类型不带：JSON 存盘时 undefined 的字段本来就不写
    const next: TerrainFile = { ...file, strokes: [...kept, ...(strokes as TerrainStrokeFile[])], features: [...(file.features ?? []), ...(features as TerrainFeatureFile[])] };
    await projects.current.saveAsset('terrain', path, next);
    return json({ strokes: next.strokes!.length, features: next.features!.length });
  });

  server.registerTool('edit_poly', {
    description: [
      'Edit a poly mesh asset (kind poly, .poly.json) with one modeling operation and save it (the backend bakes its model; editors hot reload).',
      'Vertices and faces are indices into the file (read_asset); an edge is a vertex pair [a, b]. Operations:',
      'extrude {faces, distance} pushes the faces out along their normals and adds side faces;',
      'inset {faces, amount 0..1} shrinks each face toward its center with a ring of quads around it;',
      'bevel {edges, distance} cuts a slanted face along edges whose ends have three faces each;',
      'merge {vertices} collapses them to their center; split {edge, t} adds a vertex on an edge; connect {face, a, b} splits a face between two of its vertices;',
      'move {delta:[x,y,z], vertices|faces|edges}; delete {faces}; flip {faces}; material {faces, material}.',
      'The result tells what is selected after the operation (the extruded faces, the new vertex, ...) so operations chain.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      op: z.enum(POLY_OPERATIONS),
      faces: z.array(z.number().int()).optional(),
      edges: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
      vertices: z.array(z.number().int()).optional(),
      edge: z.tuple([z.number().int(), z.number().int()]).optional(),
      face: z.number().int().optional(),
      a: z.number().int().optional(),
      b: z.number().int().optional(),
      distance: z.number().optional(),
      amount: z.number().optional(),
      t: z.number().optional(),
      delta: z.tuple([z.number(), z.number(), z.number()]).optional(),
      material: z.number().int().optional(),
    }),
  }, async ({ path, ...operation }) => {
    const mesh = await projects.current.readAsset('poly', path) as PolyMeshFile;
    const result = applyPolyOperation(mesh, operation as unknown as PolyOperation);
    await projects.current.saveAsset('poly', path, result.mesh);
    return json({ saved: `poly ${path}`, vertexCount: result.mesh.vertices.length, faceCount: result.mesh.faces.length, selected: { faces: result.faces, edges: result.edges, vertices: result.vertices } });
  });

  server.registerTool('slice_sprites', {
    description: [
      'Slice a texture into sprites and put them in a sprite sheet (kind spriteSheet, .sheet.json; created when missing), replacing the sprites of the sheet on that texture.',
      'mode grid: columns x rows cells, or cellWidth x cellHeight cells (fully transparent cells are skipped);',
      'mode auto: each 8-connected blob of pixels with alpha above alphaThreshold becomes one sprite (bounding box; overlapping boxes merge; blobs smaller than minSize pixels are noise).',
      'New sprites are named <texture name>_<n>, with the origin at their center. Edit names, pixelsPerUnit, borders afterwards with read_asset/write_asset.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      texture: assetPath,
      mode: z.enum(['grid', 'auto']),
      columns: z.number().int().positive().optional(),
      rows: z.number().int().positive().optional(),
      cellWidth: z.number().int().positive().optional(),
      cellHeight: z.number().int().positive().optional(),
      alphaThreshold: z.number().int().min(0).max(254).optional(),
      minSize: z.number().int().positive().optional(),
      pixelsPerUnit: z.number().positive().optional(),
    }),
  }, async ({ path, texture, mode, alphaThreshold, minSize, pixelsPerUnit, ...grid }) => {
    const pixels = await projects.current.decodeImage(texture);
    const regions = mode === 'auto'
      ? autoRegions(pixels, { ...(alphaThreshold !== undefined ? { alphaThreshold } : {}), ...(minSize !== undefined ? { minSize } : {}) })
      : gridRegions(pixels.width, pixels.height, grid, pixels, alphaThreshold ?? 0);
    const existing = await projects.current.readAsset('spriteSheet', path).catch(() => undefined) as SpriteSheetFile | undefined;
    const sheet = existing ?? { name: path.slice(path.lastIndexOf('/') + 1), sprites: [] };
    const encoding = imageEncodingOf(projects.current.database.get('image', texture)?.files ?? []);
    const replaced = replaceSprites(sheet, { texture, encoding }, regions, pixelsPerUnit);
    await projects.current.saveAsset('spriteSheet', path, replaced.sheet);
    return json({ saved: `spriteSheet ${path}`, texture: [pixels.width, pixels.height], sliced: regions.length, sprites: replaced.sheet.sprites.length, regions });
  });

  server.registerTool('generate_sound', {
    description: [
      'Generate a sound effect (kind sound, .sound.json with encoding "synth": sfxr parameters, synthesized when loaded, no audio file; created when missing) like the sound generator in the editor.',
      'preset picks a random sound of that kind; mutate instead changes the parameters of the existing sound a little. seed makes the choice repeatable.',
      'Fine-tune afterwards with read_asset/write_asset (field_schemas lists the parameters and their ranges). Returns the parameters and the length in seconds.',
    ].join(' '),
    inputSchema: z.object({
      path: assetPath,
      preset: z.enum(Object.keys(SOUND_PRESETS) as [SoundPreset, ...SoundPreset[]]).optional(),
      mutate: z.boolean().optional(),
      seed: z.number().int().optional(),
      spatialized: z.boolean().optional(),
    }),
  }, async ({ path, preset, mutate, seed, spatialized }) => {
    const existing = await projects.current.readAsset('sound', path).catch(() => undefined) as SoundFile | undefined;
    const random = seededRandom(seed ?? Math.floor(Math.random() * 0x7fffffff));
    if (mutate && existing?.encoding !== 'synth') throw new Error(`generate_sound: mutate needs an existing generated sound at ${path}`);
    const synth = mutate ? mutateSound(soundSynth(existing!.synth ?? {}), random) : SOUND_PRESETS[preset ?? 'random'](random);
    const file: SoundFile = { name: path.slice(path.lastIndexOf('/') + 1), encoding: 'synth', streamFromDisk: false, spatialized: spatialized ?? existing?.spatialized ?? false, synth };
    await projects.current.saveAsset('sound', path, file);
    return json({ saved: `sound ${path}`, seconds: synthesizeSound(synth).length / SOUND_SYNTH_RATE, synth });
  });

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

  server.registerTool('list_library', {
    description: 'The built-in material and effect library of the editor (the Library window): ids and categories. Materials need no textures (plain PBR or material node graphs); effects are particle systems. Use one with use_library.',
    inputSchema: z.object({}),
  }, async () => json({
    materials: LIBRARY_MATERIALS.map(({ id, category }) => ({ id, category, path: libraryMaterialPath(id) })),
    effects: LIBRARY_EFFECTS.map(({ id, category }) => ({ id, category })),
  }));

  server.registerTool('use_library', {
    description: [
      'Use a library item (list_library) like the Library window does.',
      'A material is copied into the project as Materials/Library/<Name> when missing (an existing copy is kept: it may have been edited); with scene and entities, every material slot of those entities\' model components is set to it.',
      'An effect becomes a new entity with that particle system in the scene, at position (default the origin). Returns what was saved.',
    ].join(' '),
    inputSchema: z.object({
      id: z.string(),
      kind: z.enum(['scene', 'prefab']).optional(),
      scene: assetPath.optional().describe('scene or prefab to change'),
      entities: z.array(z.string()).optional().describe('material: entity ids to use it on'),
      position: z.tuple([z.number(), z.number(), z.number()]).optional().describe('effect: where to put the new entity'),
      entityId: z.string().optional().describe('effect: id of the new entity (default a random UUID; give one to keep a scripted build repeatable)'),
    }),
  }, async ({ id, kind = 'scene', scene, entities, position, entityId }) => {
    const material = LIBRARY_MATERIALS.find((item) => item.id === id), effect = LIBRARY_EFFECTS.find((item) => item.id === id);
    if (!material && !effect) throw new Error(`no library item '${id}' (list_library lists them)`);
    const result: Record<string, unknown> = {};
    if (material) {
      const path = libraryMaterialPath(id);
      if (!projects.current.database.get('material', path)) await projects.current.saveAsset('material', path, material.material, { create: true });
      result['material'] = path;
    }
    if (!scene) {
      if (effect) throw new Error('use_library: an effect needs the scene to add it to');
      return json(result);
    }
    const document = new SceneDocument(await projects.current.readAsset(kind, scene) as EntitiesFile);
    if (material) {
      const changed = document.file.entities.filter((entity) => (entities ?? []).includes(entity.id) && entity.components['model'] !== undefined);
      const edits: SceneEdit[] = changed.map((entity) => {
        const slots = (entity.components['model'] as { materials?: readonly unknown[] }).materials ?? [];
        return { type: 'set', entity: entity.id, path: ['components', 'model', 'materials'], value: (slots.length > 0 ? slots : [null]).map(() => libraryMaterialPath(id)) };
      });
      document.apply({ type: 'batch', edits });
      result['used'] = changed.map((entity) => ({ id: entity.id, name: entity.name }));
    } else {
      const added: SceneEntityFile = { id: entityId ?? crypto.randomUUID(), name: libraryAssetName(id), parent: null, position: position ?? [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { particleSystem: structuredClone(effect!.particleSystem) } };
      document.apply(document.addChild(added));
      result['added'] = { id: added.id, name: added.name };
    }
    await projects.current.saveAsset(kind, scene, document.file);
    return json({ saved: `${kind} ${scene}`, ...result });
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

  // 下面两个要游戏页面开着（开发服务器起着、浏览器里开着游戏或编辑器）
  const hub = () => HubClient.find(projects.current.project.manifest.name);

  server.registerTool('open_in_editor', {
    description: 'Open a scene or a prefab in the editor UI the user has open (needs the project\'s dev server and the editor page open in a browser); the open document is saved first if it was changed.',
    inputSchema: z.object({
      path: z.string().describe('content path of the scene or prefab, without extension'),
      kind: z.enum(['scene', 'prefab']).optional().describe('default scene'),
    }),
  }, async ({ path: assetPath, kind }) => json(await (await hub()).call('editor-open', { path: assetPath, kind: kind ?? 'scene' })));

  server.registerTool('screenshot', {
    description: 'A PNG of the running game page (needs the project\'s dev server and the game or the editor open in a browser).',
    inputSchema: z.object({}),
  }, async () => {
    const { png, width, height } = await (await hub()).call('screenshot') as { png: string; width: number; height: number };
    return { content: [{ type: 'image' as const, data: png, mimeType: 'image/png' }, { type: 'text' as const, text: `${width}x${height}` }] };
  });

  server.registerTool('render', {
    description: 'Offline render the running game (or, from the editor page, a hidden play-mode page) to an MP4 (H.264 + AAC) or a PNG sequence in the exports folder of the project: '
      + 'fixed time step, sub-frame antialiasing and motion blur, the sounds played mixed in. Give a timeline entity to render a cutscene from its start (its length is the duration).',
    inputSchema: z.object({
      name: z.string().optional().describe('file name without extension (default "render")'),
      preset: z.enum(['landscape1080', 'vertical1080', 'square1080', 'landscape4k']).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      timeline: z.string().optional().describe('entity with a TimelinePlayer script'),
      seconds: z.number().positive().optional(),
      samples: z.number().int().positive().optional().describe('sub-frames per frame (default 8)'),
      shutter: z.number().min(0).max(1).optional().describe('fraction of the frame interval the shutter is open (default 0.5)'),
      format: z.enum(['mp4', 'png']).optional(),
      pathTracing: z.boolean().optional().describe('path trace the diffuse indirect light per pixel (accumulated over the sub-frames: give more samples, e.g. 32)'),
    }),
  }, async (args) => json(await (await hub()).call('render', args, { timeout: 30 * 60_000 })));

  server.registerTool('game_command', {
    description: 'Call a debug command on the running game page (the commands of the `stride` CLI: status, entities, inspect, set, eval, perf, ...; "commands" lists them).',
    inputSchema: z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  }, async ({ command, args }) => json(await (await hub()).call(command, args ?? {})));

  return server;
}

/** 贴图的文件读成精灵表里的编码：有浏览器能解的源图片用它（KTX2 以外的），只有 KTX2 时是 ktx2。 */
function imageEncodingOf(files: readonly string[]): TextureEncoding {
  const source = files.map((file) => file.slice(file.lastIndexOf('.')).toLowerCase()).find((extension) => extension !== '.ktx2');
  return source === '.jpg' || source === '.jpeg' ? 'jpeg' : source === '.webp' ? 'webp' : source === '.svg' ? 'svg' : source === '.png' ? 'png' : 'ktx2';
}
