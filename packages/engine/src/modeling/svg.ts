/** SVG 里的数：留一位小数（毫米），去掉尾巴。 */
export const svgNumber = (value: number): string => String(Math.round(value * 10) / 10);

/** 颜色乘一个亮度（sRGB 的 #rrggbb，每个通道乘 factor、限在 0..255）。 */
export function shadeColor(hex: string, factor: number): string {
  const v = parseInt(hex.slice(1, 7), 16);
  const channel = (c: number) => Math.max(0, Math.min(255, Math.round(c * factor))).toString(16).padStart(2, '0');
  return `#${channel((v >> 16) & 255)}${channel((v >> 8) & 255)}${channel(v & 255)}`;
}
