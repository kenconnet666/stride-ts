/**
 * 和 C#、Stride 一样把数值写成文字（脚本拿去 DebugText 打印、拼进 UI 的字）：float 的 ToString（能还原成同一个 float32 的最短写法，
 * 5.6f 写成 5.6 而不是 5.599999904632568）、Vector2/3/4 和 Quaternion 的 "X:1 Y:2 Z:3"、Color 的 "#AARRGGBB"。
 */

/** C# 的 float.ToString()：能还原成同一个 float32 的最短十进制写法；NaN、无穷同 .NET（NaN、∞、-∞）。 */
export function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const single = Math.fround(value);
  if (single === 0) return Object.is(single, -0) ? '-0' : '0';
  for (let digits = 1; digits <= 9; digits++) {
    const text = single.toPrecision(digits);
    if (Math.fround(Number(text)) === single) return formatShortest(Number(text));
  }
  return formatShortest(single);
}

/** .NET 的 float 在指数不大于 -5 或不小于 15 时用科学计数法（1.2E-05、1E+15），否则写成小数（这个范围里 JS 的 toString 也不用指数）。 */
function formatShortest(value: number): string {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent > -5 && exponent < 15) return value.toString();
  const [mantissa, power] = value.toExponential().split('e') as [string, string];
  return `${mantissa}E${power.startsWith('-') ? '-' : '+'}${power.replace(/^[-+]/, '').padStart(2, '0')}`;
}

/** Stride 的 Vector2/3/4、Quaternion 的 ToString："X:1 Y:2 Z:3"（有 w 时加 " W:4"）。 */
export function formatVector(v: { readonly x: number; readonly y: number; readonly z?: number; readonly w?: number }): string {
  let text = `X:${formatFloat(v.x)} Y:${formatFloat(v.y)}`;
  if (v.z !== undefined) text += ` Z:${formatFloat(v.z)}`;
  if (v.w !== undefined) text += ` W:${formatFloat(v.w)}`;
  return text;
}

/** Stride 的 Color.ToString："#AARRGGBB"，通道是 0 到 255 的字节（color 是 0 到 1 的 RGBA）。 */
export function formatColor([r, g, b, a = 1]: readonly number[]): string {
  const hex = (channel: number) => Math.round(Math.min(Math.max(channel!, 0), 1) * 255).toString(16).toUpperCase().padStart(2, '0');
  return `#${hex(a)}${hex(r!)}${hex(g!)}${hex(b!)}`;
}

/** C# 的 bool.ToString()。 */
export function formatBool(value: boolean): string {
  return value ? 'True' : 'False';
}
