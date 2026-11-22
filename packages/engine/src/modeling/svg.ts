/** SVG 里的数：留一位小数（毫米），去掉尾巴。 */
export const svgNumber = (value: number): string => String(Math.round(value * 10) / 10);
