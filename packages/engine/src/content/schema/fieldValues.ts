/**
 * 照字段描述处理一个值（不依赖组件的描述，模式 schema.ts 和检查实体都用）：checkFields 检查——缺了必填的、多了描述里没有的、
 * 种类不对、数超出范围、枚举里没有；withDefaults 把没写的、有默认值的字段补上。
 */
import { string, type FieldType, type Field } from './builders.ts';

/**
 * 照着描述检查一个值，返回问题的列表（空的就是没问题）：缺了必填的字段、多了描述里没有的字段、种类不对、数超出范围、
 * 枚举里没有这个值。where 是报在前面的位置。不检查引用的资源、实体在不在（那要数据库和场景）。
 */
export function checkFields(value: unknown, type: FieldType, where: string): string[] {
  const issues: string[] = [];
  checkValue(value, type, where, issues);
  return issues;
}

/** checkFields 的递归：问题追加进 issues。 */
export function checkValue(value: unknown, type: FieldType, where: string, issues: string[]): void {
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
        if (!(item === null && type.nullableItems)) checkValue(item, type.item, `${where}[${index}]`, issues);
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

/** 对象：必填的在、写了的照各自的描述查、没有描述以外的键。 */
export function checkObject(value: unknown, of: readonly Field[], where: string, issues: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return void issues.push(`${where}: expected an object, got ${JSON.stringify(value) ?? 'undefined'}`);
  const object = value as Record<string, unknown>;
  const known = new Set<string>();
  for (const field of of) {
    known.add(field.name);
    const item = object[field.name];
    if (item === undefined) {
      if (!field.optional) issues.push(`${where}.${field.name}: missing`);
    } else if (!(item === null && field.nullable)) checkValue(item, field.type, `${where}.${field.name}`, issues);
  }
  for (const key of Object.keys(object)) if (!known.has(key)) issues.push(`${where}.${key}: not a field of this component`);
}

/**
 * 补上没写的、有默认值的字段（深拷贝默认值），一路往对象、列表、几种形状之一里补；不改原来的值，返回新的。值得先过了 checkFields。
 */
export function withDefaults(value: unknown, type: FieldType): unknown {
  switch (type.kind) {
    case 'list':
      return Array.isArray(value) ? value.map((item) => (item === null ? item : withDefaults(item, type.item))) : value;
    case 'object':
      return objectDefaults(value, type.fields);
    case 'union': {
      const tag = (value as Record<string, unknown> | null)?.[type.tag];
      const variant = typeof tag === 'string' ? type.variants[tag] : undefined;
      return variant ? objectDefaults(value, [...variant, ...(type.common ?? [])]) : value;
    }
    default:
      return value;
  }
}

function objectDefaults(value: unknown, of: readonly Field[]): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>, out: Record<string, unknown> = { ...object };
  for (const field of of) {
    const item = object[field.name];
    if (item === undefined) {
      // 默认值照文件的样子写，里面没写的也补上
      if (field.default !== undefined) out[field.name] = withDefaults(structuredClone(field.default), field.type);
    } else if (item !== null) out[field.name] = withDefaults(item, field.type);
  }
  return out;
}
