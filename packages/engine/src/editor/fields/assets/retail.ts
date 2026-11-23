/** 店里的资源的字段：商品包装、货架、堆放、招牌、天花板、器具。 */
import { CEILING, DEBRIS, FIXTURE, PILE, SHELF, SIGN, type ProductFile } from '../../../content/formats/format.ts';
import { schemaFields } from '../../../content/schema/schema.ts';
import { fields, number, integer, bool, string, oneOf, vector, asset, object, type FieldSpec } from '../../../content/schema/builders.ts';

/** 颜色写成 sRGB 的 #rrggbb。 */
export const hexColor = (description: string): FieldSpec => ({ type: string, optional: true, description: `${description} (sRGB #rrggbb; picked from the seed when missing)` });

/** 商品包装（ProductFile）：后端生成同名的模型、标签贴图（.svg）和材质。 */
export const PRODUCT_FIELDS = fields<ProductFile>({
  name: string,
  shape: {
    type: oneOf('box', 'bottle', 'can', 'jar', 'tub', 'pouch', 'jug', 'round', 'onion', 'garlic', 'nut', 'tuber', 'leaf', 'bowl', 'plate'),
    description: 'box: carton; bottle: narrow neck and cap; can; jar: wide lid; tub: wider at the top, with a lid; pouch: pillow-shaped bag sealed at both ends; jug: 5 l oil jug (rounded square body, spout moved to the front, a handle at the back); produce without a label (round: tomato, orange; onion; garlic; nut: walnut; tuber: potato; leaf: a fallen leaf lying flat, width × curl height × length); ware for cooked food: bowl (foot ring, wall thickness), plate (shallow rounded square)',
  },
  size: { type: vector(3, 'm'), description: 'width (diameter for bottles, cans, jars, tubs and bowls), height, depth (cartons, pouches and plates; produce: elongated when given)' },
  font: { type: asset('font'), optional: true, description: 'font of the label text (Shared/Fonts/ZCOOLQingKeHuangYou from @stride-ts/assets has Chinese); no text without one' },
  brand: { type: string, optional: true, description: 'brand name in big letters; two or three common characters picked from the seed when missing' },
  text: { type: string, optional: true, description: 'product kind under the brand (e.g. 生抽, 矿泉水); none when missing' },
  colors: {
    type: object(fields<NonNullable<ProductFile['colors']>>({
      background: hexColor('label background'),
      accent: hexColor('pattern color'),
      text: hexColor('text color (black or white by contrast when missing)'),
      cap: hexColor('cap or lid color'),
      trim: hexColor('trim lines and emblem color (gold, white or off-white)'),
    })),
    optional: true,
    description: 'label colors; the missing ones come from the seed, so variants of one file differ in them',
  },
  pattern: { type: oneOf('plain', 'band', 'stripes', 'split', 'wave', 'dots', 'floral'), optional: true, description: 'label pattern (floral: blue-and-white porcelain bands for ware); picked from the seed when missing, ware: bowls floral, plates plain' },
  surface: { type: oneOf('paper', 'plastic', 'metal', 'glass', 'skin', 'ceramic'), optional: true, description: 'material (roughness, metalness); by shape when missing: cartons paper, cans metal, jars glass, produce skin, ware ceramic, others plastic' },
  food: {
    type: object(fields<NonNullable<ProductFile['food']>>({
      color: { type: string, description: 'main ingredient color (sRGB #rrggbb)' },
      accent: { type: string, optional: true, description: 'side ingredient color (red pepper, scallion; sRGB #rrggbb); a darker main color when missing' },
      sauce: { type: string, optional: true, description: 'sauce under the food (sRGB #rrggbb); the main color darkened when missing' },
      level: { type: number(), optional: true, default: 0.7, description: 'how high the food reaches the wall (0..1 of the inner depth)' },
      mound: { type: number(), optional: true, default: 0.15, description: 'how much the middle heaps up (fraction of the ware height)' },
      pieces: { type: oneOf('chunks', 'strands', 'beans', 'smooth'), optional: true, default: 'chunks', description: 'what the food looks like: chunks (braised pork, fried chicken), strands (shredded potato, bean sprouts), beans (peanuts, soybeans), smooth (mashed, custard)' },
      dropped: { type: number(), optional: true, default: 0, description: 'how many real pieces (by pieces: chunks, strands, beans; not smooth) are dropped on top and settled with physics when baking; 0 draws the food only on the surface texture' },
      pieceSize: { type: number(), optional: true, description: 'size of one dropped piece in meters: chunk edge, strand thickness (strands are 10..16 times as long), bean length; 0.02, 0.004, 0.009 when missing' },
    })),
    optional: true,
    description: 'a dish of food in a bowl or plate; empty ware when missing',
  },
  motif: { type: oneOf('leaf', 'drop', 'peanut', 'corn', 'sunflower', 'wheat', 'sesame', 'none'), optional: true, description: 'small picture of the ingredient on both sides of the brand (on a white disc); picked from the seed when missing (leaf, drop, wheat, sunflower or none)' },
  badge: { type: string, optional: true, description: 'text of the starburst in the lower right corner ("5L", "non-GMO"); none when missing' },
  detail: { type: bool, optional: true, default: true, description: 'print details: emblem, ingredient pictures, fine print, badge, trim lines and shading of the band; false draws only the color blocks, pattern and text (a cartoon look)' },
  wear: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.5, description: 'how handled the package looks (0..1): each variant fades a little and gets a few grimy smudges and scuffs near the edges, from the seed; 0 is fresh from the factory; produce and ware ignore it' },
  transmission: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'how much light passes through the body (0..1: oil and drink bottles show what is inside); the label background is the body, printed parts (cap, pattern, text) stay opaque; produce and ware ignore it' },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed of everything not written: another number is another brand of the same product' },
});

/** 货架（ShelfFile）：后端生成同名的模型、标签图集和材质。字段由格式的模式给出（content/formats/shelfFormat.ts）。 */
export const SHELF_FIELDS = schemaFields(SHELF);

/** 地上的碎石杂物（DebrisFile）：后端跑物理、生成同名的模型、图集和材质。 */
export const DEBRIS_FIELDS = schemaFields(DEBRIS);

/** 物理堆放（PileFile）：后端跑物理、生成同名的模型、标签图集和材质。 */
export const PILE_FIELDS = schemaFields(PILE);

/** 招牌（SignFile）：后端生成同名的模型、图集和材质。 */
export const SIGN_FIELDS = schemaFields(SIGN);

/** 天花板（CeilingFile）：后端生成同名的模型、图集和材质。 */
export const CEILING_FIELDS = schemaFields(CEILING);

/** 店里的器具（FixtureFile）：后端生成同名的模型、图集和材质。 */
export const FIXTURE_FIELDS = schemaFields(FIXTURE);
