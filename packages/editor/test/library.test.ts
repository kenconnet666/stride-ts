import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { ASSET_FIELDS, checkEntity, checkFields } from '@stride-ts/engine/editor-fields';
import { compileMaterialGraph } from '@stride-ts/engine/material-graph';
import { ColorTreeCompiler } from '../../engine/src/rendering/mesh/colorTree.ts';
import { LIBRARY_EFFECTS, LIBRARY_MATERIALS, libraryMaterialPath } from '../src/library/index.ts';
import { editorMessages } from '../src/ui/messages.ts';

const thumbnails = path.join(import.meta.dirname, '../src/library/thumbnails');
const items = [...LIBRARY_MATERIALS, ...LIBRARY_EFFECTS];

describe('材质库和特效库', () => {
  test('id 不重，每个都有缩略图、中英文的名字和类别', () => {
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) {
      expect(existsSync(path.join(thumbnails, `${item.id}.webp`)), `${item.id} 的缩略图（node tools/library-thumbnails.ts --only ${item.id}）`).toBe(true);
      for (const messages of Object.values(editorMessages)) {
        expect(messages!.library.names[item.id], item.id).toBeTruthy();
        expect(messages!.library.categories[item.category], item.category).toBeTruthy();
      }
    }
    expect(libraryMaterialPath('brushedSteel')).toBe('Materials/Library/BrushedSteel');
  });

  test('材质照字段描述没有问题，节点图编得过、不用贴图', () => {
    for (const { id, material } of LIBRARY_MATERIALS) {
      const fields = ASSET_FIELDS.material;
      const issues = fields.flatMap((field) => {
        const value = (material as unknown as Record<string, unknown>)[field.name];
        return value === undefined ? [] : checkFields(value, field.type, `${id}.${field.name}`);
      });
      expect(issues, id).toEqual([]);
      if (material.graph) {
        const compiler = new ColorTreeCompiler({ texture: () => undefined, shaderClass: () => undefined }, 3);
        const compiled = compileMaterialGraph(material.graph, compiler, () => undefined, id);
        expect(compiled.code, id).toContain('graph_baseColor');
        expect(material.graph.nodes.some((node) => node.type === 'texture'), id).toBe(false);
      }
    }
  });

  test('特效的粒子系统组件照字段描述没有问题，每个发射器都有颜色和大小随时间', () => {
    for (const { id, particleSystem } of LIBRARY_EFFECTS) {
      const entity = { id, name: id, parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { particleSystem } };
      expect(checkEntity(entity as never), id).toEqual([]);
      const emitters = (particleSystem as { particleSystem: { emitters: { updaters: { $type: string }[] }[] } }).particleSystem.emitters;
      for (const emitter of emitters) expect(emitter.updaters.map((updater) => updater.$type), id).toEqual(expect.arrayContaining(['updaterColorOverTime', 'updaterSizeOverTime']));
    }
  });
});
