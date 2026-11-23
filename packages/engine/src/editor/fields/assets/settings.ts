/** 游戏设置和导入设置（模型、位图）的字段。 */
import type { ModelImportFile, ImageImportFile, GameSettingsFile } from '../../../content/formats/format';
import { nullable, fields, number, integer, bool, string, oneOf, vector, asset, object, optional } from '../builders.ts';

/**
 * 游戏设置（.game.json，Stride 的 GameSettings）。根渲染器（合成器的根是游戏自己的渲染器时，SpriteFonts、CustomEffect）的类型是
 * 游戏登记的名字，属性的字段由游戏的代码定：按文件里现在的值推（record）。
 */
export const GAME_SETTINGS_FIELDS = fields<GameSettingsFile>({
  name: string,
  defaultScene: { ...nullable(asset('scene')), description: 'the scene the game opens with; null when the root renderer draws everything (no scene)' },
  renderer: {
    ...nullable(object([
      { name: 'type', type: string, description: 'the name the game registered its renderer under (loadGameSettings renderers)' },
      { name: 'props', type: { kind: 'record' } },
    ])),
    description: 'the compositor root when the game draws with its own renderer: its registered type name and properties',
  },
  defaultBackBufferSize: { ...optional(vector(2, 'px'), [1280, 720]), description: 'the design resolution (desktop Stride opens its window this size)' },
});

/** 属性面板能编辑的资源（选中资源浏览器里的它时）：种类 → 字段。模型只有 JSON 写的那种能编辑。 */
/** 源模型的导入设置（ModelImportFile，.import.json）：改了马上存，编辑器后端照新的设置重新导入。 */
export const MODEL_IMPORT_FIELDS = fields<ModelImportFile>({
  source: { type: oneOf('glb', 'gltf', 'fbx', 'obj'), description: 'format of the source file next to these settings (same name); drop a new file to replace it' },
  scale: { type: number({ min: 0.001, step: 0.001 }), description: 'uniform scale applied to vertices, bones and animation (0.01 for an FBX made in centimeters)' },
  materials: { type: bool, description: 'import materials and their textures; off: meshes use the default material. Material files already there are kept on reimport' },
  animations: { type: bool, description: 'import each animation as a clip (the skeleton comes too)' },
  sampleRate: { type: integer(1, 240), description: 'animation keyframes per second when baking' },
});

/** 贴图的导入设置（ImageImportFile，.image.json）：改了马上存，编辑器后端照新的设置压缩（或改回源图片）。 */
export const IMAGE_IMPORT_FIELDS = fields<ImageImportFile>({
  source: { type: oneOf('png', 'jpeg', 'webp'), description: 'format of the source image next to these settings (same name)' },
  compress: { type: oneOf('none', 'uastc', 'etc1s'), description: 'none: use the source image; uastc: KTX2, high quality; etc1s: KTX2, smallest file' },
  mipmaps: { type: bool, description: 'generate mipmaps when compressing' },
  maxSize: { type: integer(0, 16384), description: 'when compressing, scale down so the longer side is at most this many pixels; 0: no limit' },
  srgb: { type: bool, description: 'color image (stored as sRGB); turn off for normal, roughness and other data maps' },
  alpha: { type: asset('image'), optional: true, description: 'when compressing, replace the alpha with the brightness of this image (a height map packed into a normal map for parallax)' },
});
