/**
 * 招牌（`.sign.json`，Stride 没有）：店门口、超市里的灯箱和挂牌（"上蔬永辉""沙县小吃""收银""1 号门"）。文件存尺寸、字和配色，
 * 编辑器后端生成同名的模型、图集和材质（modeling/sign.ts，同货架走 ProductBatch）：一个框，正面（两面的话背面也有）是字面；
 * 灯箱的字面整块发光（背光从里面透出来），挂牌不发光。立体的发光字用 3D 文字（`.text.json`）。
 *
 * 坐标是米，原点在招牌的中心，字面朝 +Z。
 */
export interface SignFile {
  readonly name: string;
  /** 字，`\n` 换行。 */
  readonly text: string;
  /** 字体资源（要有中文就用资源包的 Shared/Fonts/ZCOOLQingKeHuangYou）。 */
  readonly font: string;
  /** 宽、高、厚（米）。 */
  readonly size: readonly [number, number, number];
  /** 灯箱（字面发光）或者挂牌（不发光）。 */
  readonly style?: 'lightbox' | 'panel';
  /** 两面都有字面（挂在通道上方的）。 */
  readonly doubleSided?: boolean;
  /** 配色（sRGB 的 #rrggbb）：字面的底、字、外框。 */
  readonly colors?: { readonly background?: string; readonly text?: string; readonly frame?: string };
  /** 灯箱的亮度（自发光的强度），默认 3。 */
  readonly brightness?: number;
}
