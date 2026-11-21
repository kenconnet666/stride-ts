import { describe, expect, test } from 'vitest';
import { COMPONENT_FIELDS } from '../src/editor/fields';
import { assetSchemas, componentSchemas, fieldTypeSchema, sceneSettingSchemas } from '../src/editor/fieldSchema';

describe('字段描述换成 JSON Schema', () => {
  test('数、向量、颜色、资源和实体的两种写法、可空的列表项', () => {
    expect(fieldTypeSchema({ kind: 'number', min: 0, max: 1, unit: 'm' })).toEqual({ type: 'number', minimum: 0, maximum: 1, description: 'unit: m' });
    expect(fieldTypeSchema({ kind: 'vector', size: 3 })).toEqual({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 });
    expect(fieldTypeSchema({ kind: 'color', alpha: true, space: 'linear' })).toMatchObject({ minItems: 4, description: 'linear color with alpha, 0..1' });
    expect(fieldTypeSchema({ kind: 'asset', asset: 'model', form: 'path' })).toMatchObject({ type: 'string' });
    expect(fieldTypeSchema({ kind: 'asset', asset: 'sound', form: 'ref' })).toMatchObject({ required: ['$asset', 'kind'], properties: { kind: { const: 'sound' } } });
    expect(fieldTypeSchema({ kind: 'entity', form: 'ref' })).toMatchObject({ required: ['$entity'] });
    expect(fieldTypeSchema({ kind: 'list', item: { kind: 'string' }, nullableItems: true })).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } });
  });

  test('组件：可选的字段不在 required 里，带默认值和说明；按种类分的是 oneOf，种类是 enum', () => {
    const schemas = componentSchemas();
    expect(Object.keys(schemas)).toEqual(Object.keys(COMPONENT_FIELDS));
    const model = schemas['model'] as { title: string; required: string[]; properties: Record<string, { default?: unknown; description?: string }>; additionalProperties: boolean };
    expect(model.title).toBe('Model');
    expect(model.required).toContain('model');
    expect(model.required).not.toContain('materials');
    expect(model.properties['materials']).toMatchObject({ default: [] });
    expect(model.properties['materials']!.description).toContain('material slot');
    expect(model.additionalProperties).toBe(false);
    const light = schemas['light'] as { oneOf: { properties: { type: { enum: string[] } } }[] };
    expect(light.oneOf.map((variant) => variant.properties.type.enum[0])).toContain('directional');
    expect(Object.keys(sceneSettingSchemas())).toContain('compositor');
    expect(Object.keys(assetSchemas())).toEqual(['material', 'model', 'timeline', 'brush', 'sdf', 'poly']);
  });
});
