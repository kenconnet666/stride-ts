/**
 * 字段描述（fields.ts）换成 JSON Schema（draft 2020-12）：给 agent 工具（编辑器的 MCP 服务）看组件、场景设置、资源文件长什么样，
 * 也能拿去校验。和 checkFields 同一套规则：可选的字段不写进 required，可空的加上 null，对象不许有描述以外的键。
 *
 *   fieldTypeSchema(COMPONENT_FIELDS.light.type)
 *   componentSchemas()   // { model: {...}, light: {...}, ... }
 */
import { ASSET_FIELDS, COMPONENT_FIELDS, ENTITY_FIELDS, SCENE_FIELDS, type Field, type FieldType } from './fields.ts';

export type JsonSchema = { readonly [key: string]: unknown };

/** 一种字段类型的 schema。 */
export function fieldTypeSchema(type: FieldType): JsonSchema {
  switch (type.kind) {
    case 'number':
      return {
        type: type.integer ? 'integer' : 'number',
        ...(type.min !== undefined ? { minimum: type.min } : {}),
        ...(type.max !== undefined ? { maximum: type.max } : {}),
        ...(type.unit !== undefined ? { description: `unit: ${type.unit}` } : {}),
      };
    case 'bool':
      return { type: 'boolean' };
    case 'string':
      return { type: 'string' };
    case 'enum':
      return { enum: [...type.values] };
    case 'vector':
      return numbers(type.size, type.unit === undefined ? undefined : `unit: ${type.unit}`);
    case 'rotation':
      return numbers(4, 'quaternion [x, y, z, w]');
    case 'color':
      return numbers(type.alpha ? 4 : 3, `${type.space === 'srgb' ? 'sRGB' : 'linear'} color${type.alpha ? ' with alpha' : ''}, 0..1`);
    case 'asset':
      return type.form === 'path'
        ? { type: 'string', description: `content path of a ${type.asset} asset (no extension)` }
        : { type: 'object', properties: { $asset: { type: 'string' }, kind: { const: type.refKind ?? type.asset } }, required: ['$asset', 'kind'], additionalProperties: false };
    case 'entity':
      return type.form === 'id'
        ? { type: 'string', description: 'id of an entity in the same scene' }
        : { type: 'object', properties: { $entity: { type: 'string' } }, required: ['$entity'], additionalProperties: false };
    case 'list':
      return { type: 'array', items: type.nullableItems ? { anyOf: [fieldTypeSchema(type.item), { type: 'null' }] } : fieldTypeSchema(type.item) };
    case 'object':
      return objectSchema(type.fields);
    case 'union':
      return {
        oneOf: Object.entries(type.variants).map(([tag, fields]) => objectSchema([{ name: type.tag, type: { kind: 'enum', values: [tag] } }, ...(type.common ?? []), ...fields])),
      };
    case 'json':
      return {};
  }
}

/** 一列字段组成的对象。 */
export function objectSchema(fields: readonly Field[]): JsonSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])),
    required: fields.filter((field) => !field.optional).map((field) => field.name),
    additionalProperties: false,
  };
}

/** 每种组件的 schema（场景文件里实体的 `components` 下面那个键的值；脚本另算）。 */
export function componentSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(COMPONENT_FIELDS).map(([key, description]) => [key, { title: description.label, ...fieldTypeSchema(description.type) }]));
}

/** 场景自己的每种设置（物理、导航、偏移、合成器）的 schema。 */
export function sceneSettingSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(SCENE_FIELDS).map(([key, description]) => [key, { title: description.label, ...fieldTypeSchema(description.type) }]));
}

/** 编辑器能按字段改的资源文件（材质、JSON 写的模型）的 schema。 */
export function assetSchemas(): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(ASSET_FIELDS).map(([kind, fields]) => [kind, objectSchema(fields)]));
}

/** 实体自己的字段（名字、位置、旋转、缩放）。 */
export function entitySchema(): JsonSchema {
  return objectSchema(ENTITY_FIELDS);
}

function fieldSchema(field: Field): JsonSchema {
  const type = fieldTypeSchema(field.type);
  const description = [field.description, type['description']].filter(Boolean).join('; ');
  const schema: JsonSchema = {
    ...(field.nullable ? { anyOf: [type, { type: 'null' }] } : type),
    ...(description ? { description } : {}),
    ...(field.default !== undefined ? { default: field.default } : {}),
  };
  return schema;
}

function numbers(size: number, description?: string): JsonSchema {
  return { type: 'array', items: { type: 'number' }, minItems: size, maxItems: size, ...(description ? { description } : {}) };
}
