/** 几种资源的字段表共用的类型和帮手。 */
import { TEXTURE_EXTENSIONS, type TextureEncoding, type TextureRef } from '../../../content/formats/assetFormat.ts';
import { asset, bool, fields, oneOf, optional, vector, type FieldType } from '../../../content/schema/builders.ts';

/** 编辑器里还没有专门控件的复杂部分（颜色树、材质层……）：按原样的 JSON 改。 */
export const json: FieldType = { kind: 'json' };
/** 一张贴图文件，或者（精灵、背景）一张渲染目标贴图。 */
export const textureRef = fields<TextureRef>({
  texture: asset('image'),
  encoding: optional(oneOf(...(Object.keys(TEXTURE_EXTENSIONS) as TextureEncoding[])), 'ktx2'),
  size: optional(vector(2, 'px')),
  srgb: optional(bool),
  invertY: optional(bool, false),
});
