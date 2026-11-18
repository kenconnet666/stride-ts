/** 缩进的 JSON，但只含简单值的数组和对象（向量、矩阵、位置）放一行，省得读的人（和 agent）翻很多行。 */
export function formatJson(value: unknown, indent = ''): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const entries = Array.isArray(value) ? value.map((item) => [undefined, item] as const) : Object.entries(value);
  if (entries.length === 0) return Array.isArray(value) ? '[]' : '{}';
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const key = (name: string | undefined) => (name === undefined ? '' : `${JSON.stringify(name)}: `);
  const flat = entries.every(([, item]) => item === null || typeof item !== 'object');
  if (flat) {
    const line = `${open}${entries.map(([name, item]) => key(name) + JSON.stringify(item)).join(', ')}${close}`;
    // 数字数组（矩阵）再长也放一行
    const numbers = Array.isArray(value) && value.length <= 64 && value.every((item) => typeof item === 'number');
    if (numbers || line.length + indent.length <= 120) return line;
  }
  const inner = indent + '  ';
  return `${open}\n${entries.map(([name, item]) => inner + key(name) + formatJson(item, inner)).join(',\n')}\n${indent}${close}`;
}
