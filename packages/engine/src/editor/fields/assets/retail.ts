/** 店里的资源的字段：商品包装、货架、堆放、招牌、天花板、器具。 */
import { CEILING, DEBRIS, FRACTURE, FIXTURE, PILE, PRODUCT, SHELF, SIGN } from '../../../content/formats/format.ts';
import { schemaFields } from '../../../content/schema/schema.ts';

/** 商品包装（ProductFile）：后端生成同名的模型、标签贴图（.svg）和材质。字段由格式的模式给出（content/formats/productFormat.ts）。 */
export const PRODUCT_FIELDS = schemaFields(PRODUCT);

/** 货架（ShelfFile）：后端生成同名的模型、标签图集和材质。字段由格式的模式给出（content/formats/shelfFormat.ts）。 */
export const SHELF_FIELDS = schemaFields(SHELF);

/** 地上的碎石杂物（DebrisFile）：后端跑物理、生成同名的模型、图集和材质。 */
export const DEBRIS_FIELDS = schemaFields(DEBRIS);
/** 可破碎物体的预先切块（FractureFile）：后端切成同名的碎块模型。 */
export const FRACTURE_FIELDS = schemaFields(FRACTURE);

/** 物理堆放（PileFile）：后端跑物理、生成同名的模型、标签图集和材质。 */
export const PILE_FIELDS = schemaFields(PILE);

/** 招牌（SignFile）：后端生成同名的模型、图集和材质。 */
export const SIGN_FIELDS = schemaFields(SIGN);

/** 天花板（CeilingFile）：后端生成同名的模型、图集和材质。 */
export const CEILING_FIELDS = schemaFields(CEILING);

/** 店里的器具（FixtureFile）：后端生成同名的模型、图集和材质。 */
export const FIXTURE_FIELDS = schemaFields(FIXTURE);
