/** 编辑器 MCP 服务的工具：二维和声音、库：切精灵表、合成音效、材质库和特效库。 */
import type { McpServer } from '@modelcontextprotocol/server';
import { SceneDocument, type EntitiesFile, type SceneEdit } from '@stride-ts/engine/editor-document';
import { autoRegions, gridRegions, replaceSprites } from '@stride-ts/engine/editor-sprites';
import { mutateSound, seededRandom, soundSynth, SOUND_PRESETS, SOUND_SYNTH_RATE, synthesizeSound, type SoundPreset } from '@stride-ts/engine/audio-synth';
import type { SceneEntityFile, SoundFile, SpriteSheetFile } from '@stride-ts/engine/content-format';
import * as z from 'zod';
import { LIBRARY_EFFECTS, LIBRARY_MATERIALS, libraryAssetName, libraryMaterialPath } from '../../../library/index.ts';
import { assetPath, imageEncodingOf, json, type McpProjects } from '../shared.ts';

export function registerMediaTools(server: McpServer, projects: McpProjects): void {
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
}
