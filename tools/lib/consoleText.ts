/** DevTools 协议 Runtime.consoleAPICalled 的一个参数的文字：字符串照原样，别的值按 JSON，对象（没有值）用它的描述。 */
export function consoleArgText(arg: { readonly value?: unknown; readonly description?: string }): string {
  if (typeof arg.value === 'string') return arg.value;
  if (arg.value !== undefined) return JSON.stringify(arg.value) ?? '';
  return arg.description ?? '';
}
