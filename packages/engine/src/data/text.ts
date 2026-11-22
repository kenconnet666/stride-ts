/**
 * 读进来的数据（场景文件、调试命令的参数、JSON）里的文字：字符串照原样，数字、布尔转成文字，没有（undefined、null）时是
 * fallback；对象、列表报错——不悄悄变成 "[object Object]"。
 */
export function textOf(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new Error(`expected text, got ${JSON.stringify(value) ?? typeof value}`);
}
