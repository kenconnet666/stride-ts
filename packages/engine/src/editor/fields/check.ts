/** 照字段描述检查值（checkFields、checkEntity）：保存前、读别人写的文件时。 */
import type { SceneEntityFile } from '../../content/formats/format';
import { string, entity, type FieldType, type Field } from './builders.ts';
import { COMPONENT_FIELDS, ENTITY_FIELDS, type ComponentDescription } from './components.ts';

/**
 * 照着描述检查一个值，返回问题的列表（空的就是没问题）：缺了必填的字段、多了描述里没有的字段、种类不对、数超出范围、
 * 枚举里没有这个值。where 是报在前面的位置。不检查引用的资源、实体在不在（那要数据库和场景）。
 */
export function checkFields(value: unknown, type: FieldType, where: string): string[] {
  const issues: string[] = [];
  check(value, type, where, issues);
  return issues;
}

function check(value: unknown, type: FieldType, where: string, issues: string[]): void {
  const fail = (expected: string) => void issues.push(`${where}: expected ${expected}, got ${JSON.stringify(value) ?? 'undefined'}`);
  const numbers = (count: number) => Array.isArray(value) && value.length === count && value.every((item) => typeof item === 'number' && Number.isFinite(item));
  switch (type.kind) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('a number');
      if (type.integer && !Number.isInteger(value)) fail('an integer');
      if ((type.min !== undefined && value < type.min) || (type.max !== undefined && value > type.max)) fail(`a number in ${type.min ?? '-inf'}..${type.max ?? 'inf'}`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') fail('true or false');
      return;
    case 'string':
      if (typeof value !== 'string') fail('a string');
      return;
    case 'enum':
      if (!type.values.includes(value as string)) fail(`one of ${type.values.join(', ')}`);
      return;
    case 'vector':
      if (!numbers(type.size)) fail(`${type.size} numbers`);
      return;
    case 'rotation':
      if (!numbers(4)) fail('a quaternion (4 numbers)');
      return;
    case 'color':
      if (!numbers(type.alpha ? 4 : 3)) fail(`a color (${type.alpha ? 4 : 3} numbers)`);
      return;
    case 'asset':
      if (type.form === 'path' ? typeof value !== 'string' : typeof (value as { $asset?: unknown } | null)?.$asset !== 'string') fail(`a ${type.asset} asset`);
      return;
    case 'entity':
      if (type.form === 'id' ? typeof value !== 'string' : typeof (value as { $entity?: unknown } | null)?.$entity !== 'string') fail('an entity');
      return;
    case 'list':
      if (!Array.isArray(value)) return fail('a list');
      value.forEach((item, index) => {
        if (!(item === null && type.nullableItems)) check(item, type.item, `${where}[${index}]`, issues);
      });
      return;
    case 'object':
      checkObject(value, type.fields, where, issues);
      return;
    case 'union': {
      const tag = (value as Record<string, unknown> | null)?.[type.tag];
      const variant = typeof tag === 'string' ? type.variants[tag] : undefined;
      if (!variant) return void issues.push(`${where}.${type.tag}: expected one of ${Object.keys(type.variants).join(', ')}, got ${JSON.stringify(tag) ?? 'undefined'}`);
      checkObject(value, [{ name: type.tag, type: string }, ...variant, ...(type.common ?? [])], where, issues);
      return;
    }
    case 'record':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) issues.push(`${where}: expected an object, got ${JSON.stringify(value) ?? 'undefined'}`);
      return;
    case 'json':
      return;
  }
}

function checkObject(value: unknown, of: readonly Field[], where: string, issues: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return void issues.push(`${where}: expected an object, got ${JSON.stringify(value) ?? 'undefined'}`);
  const object = value as Record<string, unknown>;
  const known = new Set<string>();
  for (const field of of) {
    known.add(field.name);
    const item = object[field.name];
    if (item === undefined) {
      if (!field.optional) issues.push(`${where}.${field.name}: missing`);
    } else if (!(item === null && field.nullable)) check(item, field.type, `${where}.${field.name}`, issues);
  }
  for (const key of Object.keys(object)) if (!known.has(key)) issues.push(`${where}.${key}: not a field of this component`);
}

/** 场景文件里一个实体能有的键（SceneEntityFile）。 */
const ENTITY_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'parent', 'prefab', 'position', 'rotation', 'scale', 'components'] satisfies (keyof SceneEntityFile)[]);

/** 检查一个实体文件：名字、变换和每种组件（脚本不查，要脚本的类）。 */
export function checkEntity(entity: SceneEntityFile): string[] {
  const where = `entity ${entity.name}`;
  const issues: string[] = [];
  // 实体自己的字段以外的键：写错了地方的（比如脚本写在实体上，应该在 components.scripts 里）加载时会被悄悄忽略
  for (const key of Object.keys(entity)) {
    if (!ENTITY_KEYS.has(key)) issues.push(`${where}.${key}: not an entity field${key === 'scripts' ? ' (scripts go in components.scripts)' : ''}`);
  }
  checkObject({ name: entity.name, position: entity.position, rotation: entity.rotation, scale: entity.scale }, ENTITY_FIELDS, where, issues);
  for (const [key, value] of Object.entries(entity.components ?? {})) {
    if (key === 'scripts') continue;
    const description = (COMPONENT_FIELDS as Readonly<Record<string, ComponentDescription | undefined>>)[key];
    if (!description) issues.push(`${where}.components.${key}: not a component`);
    else check(value, description.type, `${where}.components.${key}`, issues);
  }
  return issues;
}
