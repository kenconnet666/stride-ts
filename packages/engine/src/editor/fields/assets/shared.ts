/** 几种资源的字段表共用的类型和帮手。 */
import type { FieldType } from '../builders.ts';

/** 编辑器里还没有专门控件的复杂部分（颜色树、材质层……）：按原样的 JSON 改。 */
export const json: FieldType = { kind: 'json' };
