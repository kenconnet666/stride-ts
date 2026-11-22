/** 店里的资源的字段：商品包装、货架、堆放、招牌、天花板、器具。 */
import type { ProductFile, ShelfFile, PileFile, SignFile, CeilingFile, FixtureFile } from '../../../content/formats/format';
import { fields, number, integer, bool, string, oneOf, vector, asset, list, object, type FieldSpec } from '../builders.ts';

/** 颜色写成 sRGB 的 #rrggbb。 */
export const hexColor = (description: string): FieldSpec => ({ type: string, optional: true, description: `${description} (sRGB #rrggbb; picked from the seed when missing)` });

/** 商品包装（ProductFile）：后端生成同名的模型、标签贴图（.svg）和材质。 */
export const PRODUCT_FIELDS = fields<ProductFile>({
  name: string,
  shape: {
    type: oneOf('box', 'bottle', 'can', 'jar', 'tub', 'pouch', 'round', 'onion', 'garlic', 'nut', 'tuber', 'bowl', 'plate'),
    description: 'box: carton; bottle: narrow neck and cap; can; jar: wide lid; tub: wider at the top, with a lid; pouch: pillow-shaped bag sealed at both ends; produce without a label (round: tomato, orange; onion; garlic; nut: walnut; tuber: potato); ware for cooked food: bowl (foot ring, wall thickness), plate (shallow rounded square)',
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
    })),
    optional: true,
    description: 'a dish of food in a bowl or plate; empty ware when missing',
  },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed of everything not written: another number is another brand of the same product' },
});

/** 货架（ShelfFile）：后端生成同名的模型、标签图集和材质。 */
export const SHELF_FIELDS = fields<ShelfFile>({
  name: string,
  sides: { type: integer(1, 2), description: '1: against a wall, front facing +Z; 2: an island with a second face toward -Z' },
  length: { type: number({ min: 0.1, step: 0.25, unit: 'm' }), description: 'length along X' },
  height: { type: number({ min: 0.1, step: 0.1, unit: 'm' }), description: 'total height' },
  depth: { type: number({ min: 0.05, step: 0.05, unit: 'm' }), description: 'depth of the shelf boards on each face' },
  levels: { type: list(number({ min: 0, step: 0.05, unit: 'm' })), description: 'height of the top of each shelf board from the floor, bottom up; the first is the base' },
  bay: { type: number({ min: 0.2, step: 0.25, unit: 'm' }), optional: true, default: 1, description: 'spacing of the uprights' },
  frameColor: { type: string, optional: true, description: 'color of the frame and boards (sRGB #rrggbb, light grey when missing)' },
  stripColor: { type: string, optional: true, description: 'color of the price strips (sRGB #rrggbb, white when missing)' },
  font: { type: asset('font'), optional: true, description: 'font of the prices on the tags; plain tags without one' },
  stock: {
    type: object(fields<NonNullable<ShelfFile['stock']>>({
      products: { type: list(asset('product')), description: 'products to stock; each level only takes those that fit under the next board' },
      variants: { type: integer(1, 32), optional: true, default: 3, description: 'brands of each product (product variants: the colors and brand the product file leaves out)' },
      facings: { type: vector(2), optional: true, default: [2, 5], description: 'how many of one item stand side by side (min, max)' },
      rows: { type: integer(1, 16), optional: true, default: 4, description: 'at most this many rows deep (fewer when the board is shallower)' },
      gaps: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.05, description: 'share of empty spots (sold out)' },
    })),
    optional: true,
    description: 'what goes on the shelf; empty shelves without it',
  },
  type: { type: oneOf('gondola', 'fridge', 'freezer', 'pegboard', 'stack', 'deli'), optional: true, default: 'gondola', description: 'gondola: open shelves; fridge: one face behind glass doors with light strips and a lit header; freezer: a chest with goods lying in the well under sliding glass lids (depth is the whole width, only the first level is used: the well floor); pegboard: goods hanging on rows of hooks (levels are the hook rows, depth the hook length); stack: a floor display stacked in tapering blocks on a platform (only the first level is used: the platform top; depth is the stack depth; centered); deli: a black counter with a white quartz front ledge and rows of bowls and plates in a sunken black tray, gold heat lamps every bay above (only the first level is used: the tray top; height is the bottom of the lamp shades; depth is the whole counter)' },
  header: { type: string, optional: true, description: 'text on the lit header of a fridge (needs the font)' },
  priceTags: { type: oneOf('paper', 'electronic'), optional: true, default: 'paper', description: 'paper tags (white or yellow, red price) or electronic shelf labels (a small housing with an e-ink screen, black price and a QR code, some with a red promo bar)' },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed of the stocking and the prices' },
});

/** 物理堆放（PileFile）：后端跑物理、生成同名的模型、标签图集和材质。 */
export const PILE_FIELDS = fields<PileFile>({
  name: string,
  container: {
    type: object(fields<PileFile['container']>({
      size: { type: vector(3, 'm'), description: 'inside width, wall height and depth' },
      wall: { type: number({ min: 0.001, step: 0.005, unit: 'm' }), optional: true, default: 0.015, description: 'wall thickness' },
      color: { type: string, optional: true, description: 'color of the container (sRGB #rrggbb, dark grey plastic when missing)' },
      cells: { type: vector(2), optional: true, default: [1, 1], description: 'split into compartments (columns, rows), numbered from back left to front right' },
      lids: { type: bool, optional: true, default: false, description: 'a clear lid on each compartment, hinged at the back and lifted open' },
    })),
    description: 'the bin the items are poured into',
  },
  items: {
    type: list(object(fields<PileFile['items'][number]>({
      product: { type: asset('product'), description: 'what to pour in (produce or packaged goods)' },
      count: { type: integer(0, 5000), description: 'how many' },
      variants: { type: integer(1, 32), optional: true, default: 3, description: 'color or brand variants of it' },
      cell: { type: integer(0, 255), optional: true, description: 'compartment to pour into; the whole container when missing' },
    }))),
    description: 'items dropped into the container; physics settles them and the result is baked into one model',
  },
  heaps: {
    type: list(object(fields<NonNullable<PileFile['heaps']>[number]>({
      cell: { type: integer(0, 255), description: 'compartment of the heap' },
      color: { type: string, description: 'grain color (sRGB #rrggbb)' },
      level: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0.8, description: 'fill height as a share of the wall (the middle rises a bit more)' },
      grain: { type: number({ min: 0.001, step: 0.001, unit: 'm' }), optional: true, default: 0.006, description: 'grain size' },
      speckle: { type: string, optional: true, description: 'darker color between the grains (sRGB #rrggbb, black when missing)' },
    }))),
    optional: true,
    description: 'fine grains (rice, beans, seeds) drawn as a heap instead of single bodies',
  },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed of the drop positions and variants' },
});

/** 招牌（SignFile）：后端生成同名的模型、图集和材质。 */
export const SIGN_FIELDS = fields<SignFile>({
  name: string,
  text: { type: string, description: 'the text on the face; line breaks start new lines' },
  font: { type: asset('font'), description: 'font of the text (Shared/Fonts/ZCOOLQingKeHuangYou from @stride-ts/assets has Chinese)' },
  size: { type: vector(3, 'm'), description: 'width, height, depth (floor stickers: width and length, the length along the top of the texture)' },
  style: { type: oneOf('lightbox', 'panel', 'floor', 'banner', 'stand'), optional: true, default: 'lightbox', description: 'lightbox: the face glows (lit from inside); panel: it does not; floor: a floor sticker, only a transparent SVG of the same name, put on the floor with a decal; banner: a promo flag hanging from the ceiling (printed on both sides, a rod and two cords on top); stand: a price card on a pole with a round base by a floor stack (origin on the floor)' },
  hang: { type: number({ min: 0, step: 0.1 }), optional: true, default: 0.5, description: 'length of the cords of a banner (m)' },
  standHeight: { type: number({ min: 0.2, step: 0.1 }), optional: true, default: 1.2, description: 'height from the floor to the top of a stand card (m)' },
  shape: { type: oneOf('rect', 'round', 'arrow'), optional: true, default: 'rect', description: 'floor sticker shape: rounded rectangle, round badge, arrow (pointing to the top of the texture; turn the entity to aim it)' },
  wear: { type: number({ min: 0, max: 1, step: 0.05 }), optional: true, default: 0, description: 'how worn a floor sticker is (0..1): scratches and scuffed patches from the seed' },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed of the wear' },
  doubleSided: { type: bool, optional: true, default: false, description: 'a face on the back too (signs hanging over an aisle)' },
  colors: {
    type: object(fields<NonNullable<SignFile['colors']>>({
      background: { type: string, optional: true, description: 'face color (sRGB #rrggbb, green when missing)' },
      text: { type: string, optional: true, description: 'text color (sRGB #rrggbb, white when missing)' },
      frame: { type: string, optional: true, description: 'frame color (sRGB #rrggbb, brushed grey when missing; the outline of a floor sticker, white when missing)' },
    })),
    optional: true,
    description: 'colors of the face, the text and the frame',
  },
  brightness: { type: number({ min: 0, step: 0.5 }), optional: true, default: 3, description: 'emissive strength of a lightbox face' },
});

/** 天花板（CeilingFile）：后端生成同名的模型、图集和材质。 */
export const CEILING_FIELDS = fields<CeilingFile>({
  name: string,
  size: { type: vector(2, 'm'), description: 'width along X and depth along Z' },
  height: { type: number({ min: 0.5, step: 0.1, unit: 'm' }), description: 'height of the slab underside (open) or of the suspended ceiling (grid)' },
  style: { type: oneOf('open', 'grid'), optional: true, default: 'open', description: 'open: a dark slab with exposed ducts, cable trays, sprinkler pipes and hanging tube lights; grid: a suspended tile ceiling with recessed light panels' },
  color: { type: string, optional: true, description: 'slab or tile color (sRGB #rrggbb; dark grey for open, white for grid when missing)' },
  ducts: { type: integer(0, 20), optional: true, default: 2, description: 'air ducts running along X (open)' },
  trays: { type: integer(0, 20), optional: true, default: 2, description: 'cable trays running along X (open)' },
  pipes: { type: integer(0, 20), optional: true, default: 3, description: 'sprinkler pipes running along X (open)' },
  lights: {
    type: object(fields<NonNullable<CeilingFile['lights']>>({
      rows: { type: integer(0, 50), optional: true, default: 2, description: 'rows of lights across the depth' },
      spacing: { type: number({ min: 0.5, step: 0.1, unit: 'm' }), optional: true, default: 2.2, description: 'spacing of lights along X' },
      length: { type: number({ min: 0.1, step: 0.1, unit: 'm' }), optional: true, default: 1.4, description: 'length of one tube light (open)' },
      drop: { type: number({ min: 0, step: 0.05, unit: 'm' }), optional: true, default: 0.6, description: 'how far the lights hang below the slab (open)' },
    })),
    optional: true,
    description: 'light fixtures (they glow; place area lights at the same spots to light the scene)',
  },
  seed: { type: integer(0, 2 ** 31 - 1), optional: true, default: 1, description: 'random seed' },
});

/** 店里的器具（FixtureFile）：后端生成同名的模型、图集和材质。 */
export const FIXTURE_FIELDS = fields<FixtureFile>({
  name: string,
  type: { type: oneOf('checkout', 'cart', 'basket', 'locker', 'gate', 'track'), description: 'checkout counter (belt, scanner, register screens, a lit number sign above), shopping cart, hand basket, coin locker, entrance gate, ceiling track with spotlight heads (origin at the top of the rail; the lights that light things are placed by the scene at trackSpots)' },
  color: { type: string, optional: true, description: 'main color (sRGB #rrggbb; by type when missing)' },
  number: { type: string, optional: true, description: 'number on the checkout sign (needs the font)' },
  font: { type: asset('font'), optional: true, description: 'font of the checkout sign' },
  columns: { type: integer(1, 20), optional: true, default: 6, description: 'locker columns' },
  rows: { type: integer(1, 10), optional: true, default: 4, description: 'locker rows' },
  length: { type: number({ min: 0.2, step: 0.1 }), optional: true, default: 3, description: 'track length (m)' },
  heads: { type: integer(1, 32), optional: true, default: 4, description: 'spotlight heads on the track' },
  tilt: { type: number({ min: 0, max: 90, step: 5 }), optional: true, default: 30, description: 'how far the heads tilt from straight down toward the front (+Z), degrees' },
});
