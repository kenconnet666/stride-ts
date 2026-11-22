/** 编辑器里能编辑的资源文件的字段描述（各种资源的表按领域分在这个目录里；ASSET_FIELDS：材质、JSON 模型、时间轴、白盒、SDF、多边形、导入设置、精灵表、声音、游戏设置）。 */
import type { Field } from '../builders.ts';
import { MATERIAL_FIELDS } from './materials.ts';
import { PROCEDURAL_MODEL_FIELDS, BRUSH_FIELDS, SDF_FIELDS, POLY_FIELDS, SPLINE_FIELDS, TEXT_FIELDS } from './modeling.ts';
import { TERRAIN_FIELDS, TREE_FIELDS, BUILDING_FIELDS, CITY_FIELDS, WATER_FIELDS, SCATTER_FIELDS } from './world.ts';
import { PRODUCT_FIELDS, SHELF_FIELDS, PILE_FIELDS, SIGN_FIELDS, CEILING_FIELDS, FIXTURE_FIELDS } from './retail.ts';
import { TIMELINE_FIELDS, SPRITE_SHEET_FIELDS, SOUND_FIELDS } from './media.ts';
import { GAME_SETTINGS_FIELDS, MODEL_IMPORT_FIELDS, IMAGE_IMPORT_FIELDS } from './settings.ts';

export { MATERIAL_FIELDS } from './materials.ts';
export { PROCEDURAL_MODEL_FIELDS, BRUSH_FIELDS, SDF_FIELDS, POLY_FIELDS, SPLINE_FIELDS } from './modeling.ts';
export { TERRAIN_FIELDS, TREE_FIELDS, BUILDING_FIELDS, CITY_FIELDS, WATER_FIELDS, SCATTER_FIELDS } from './world.ts';
export { TIMELINE_FIELDS, SPRITE_SHEET_FIELDS, SOUND_FIELDS } from './media.ts';
export { GAME_SETTINGS_FIELDS, MODEL_IMPORT_FIELDS, IMAGE_IMPORT_FIELDS } from './settings.ts';

export const ASSET_FIELDS = { material: MATERIAL_FIELDS, terrain: TERRAIN_FIELDS, model: PROCEDURAL_MODEL_FIELDS, timeline: TIMELINE_FIELDS, brush: BRUSH_FIELDS, sdf: SDF_FIELDS, poly: POLY_FIELDS, modelImport: MODEL_IMPORT_FIELDS, imageImport: IMAGE_IMPORT_FIELDS, spriteSheet: SPRITE_SHEET_FIELDS, text: TEXT_FIELDS, product: PRODUCT_FIELDS, shelf: SHELF_FIELDS, pile: PILE_FIELDS, sign: SIGN_FIELDS, ceiling: CEILING_FIELDS, fixture: FIXTURE_FIELDS, spline: SPLINE_FIELDS, tree: TREE_FIELDS, building: BUILDING_FIELDS, city: CITY_FIELDS, water: WATER_FIELDS, scatter: SCATTER_FIELDS, sound: SOUND_FIELDS, gameSettings: GAME_SETTINGS_FIELDS } as const;

const customFields = new Map<string, readonly Field[]>();

/** 登记一种自定义资源（content/assetKinds.ts 的 registerAssetKind）在属性面板里的字段；再登记一次是替换。 */
export function registerAssetFields(kind: string, assetFields: readonly Field[]): void {
  if (Object.hasOwn(ASSET_FIELDS, kind)) throw new Error(`registerAssetFields: '${kind}' is a built-in asset kind`);
  customFields.set(kind, assetFields);
}

/** 一种资源在属性面板里的字段（内置的 ASSET_FIELDS，加上登记的）；不能在属性面板里改的是 undefined。 */
export function assetFields(kind: string): readonly Field[] | undefined {
  return Object.hasOwn(ASSET_FIELDS, kind) ? ASSET_FIELDS[kind as keyof typeof ASSET_FIELDS] : customFields.get(kind);
}

/** 属性面板能改的全部资源种类和它们的字段。 */
export function allAssetFields(): ReadonlyMap<string, readonly Field[]> {
  return new Map<string, readonly Field[]>([...Object.entries(ASSET_FIELDS), ...customFields]);
}
