/**
 * 货架（`.shelf.json`，Stride 没有）：超市的中岛（双面）、靠墙的单面货架，连同摆在上面的商品。文件存货架的尺寸、每层的高度和
 * 摆货的规则（哪些商品、几个变体、几个排面），编辑器后端照它生成同名的模型、标签图集和材质（modeling/shelf.ts 生成、
 * pipeline 的 bakers/shelfModel.ts 写文件）：架子、价签条、所有商品合成一个模型、一个材质——一排货架几千件商品是一次绘制。
 *
 * 坐标是米，原点在货架底面的中心，沿 X 是长，+Z 是正面（双面的背面朝 -Z），往 +Y 高。商品的变体同 ProductFile：文件里没写的
 * 配色、品牌名按种子换，同一种商品摆出几个牌子。
 */

/** 摆货的规则：从这些商品里挑（每层只挑放得下的），每种出几个变体，一次摆几个排面，往里摆几排。 */
export interface ShelfStockFile {
  /** 商品包装的内容路径（`.product.json`）。 */
  readonly products: readonly string[];
  /** 每种商品出几个牌子（ProductFile 的变体），默认 3。 */
  readonly variants?: number;
  /** 同一件商品挨着摆几个（排面数）的范围，默认 [2, 5]。 */
  readonly facings?: readonly [number, number];
  /** 往里最多摆几排，默认 4；摆满按层深算。 */
  readonly rows?: number;
  /** 架上空着的比例（0..1，卖掉了的空位），默认 0.05。 */
  readonly gaps?: number;
  /**
   * 摆得有多乱（0..1，默认 0.5；0 是出厂一样整整齐齐）：圆的瓶罐被转过（标签朝向不一，最多 ±45°），方的盒子歪一点（挤得紧，
   * 只能歪到碰不着旁边的），一些列被往里推（前面那件被拿走过），左右前后在缝里错开一点。按种子，同一个文件摆出来一样。
   */
  readonly messiness?: number;
  /**
   * 按层摆（从下往上第 i 个是第 i 层，同 levels）：这一层只从这些商品里挑（超市里一层常是一类货）；没写、null 的层用 products。
   */
  readonly levels?: readonly (readonly string[] | null)[];
}

export interface ShelfFile {
  readonly name: string;
  /** 单面（靠墙，正面朝 +Z）或双面（中岛）。 */
  readonly sides: 1 | 2;
  /** 长（米，沿 X）。 */
  readonly length: number;
  /** 总高（米）。 */
  readonly height: number;
  /** 每一面层板的深（米）。 */
  readonly depth: number;
  /** 每层层板上表面离地的高（米，从下往上）；第一层是底座。 */
  readonly levels: readonly number[];
  /** 立柱的间距（米），默认 1。 */
  readonly bay?: number;
  /** 架子和价签条的颜色（sRGB 的 #rrggbb）：架子默认浅灰，价签条默认白。 */
  readonly frameColor?: string;
  readonly stripColor?: string;
  /** 层板的颜色（sRGB 的 #rrggbb，木纹板的浅木色这类）；没写同架子。 */
  readonly boardColor?: string;
  /** 层板的厚（米，默认 0.02；木层板前沿常有 4 厘米厚）。 */
  readonly boardThickness?: number;
  /** 价签上的数字用的字体；没有时价签只是色块。 */
  readonly font?: string;
  readonly stock?: ShelfStockFile;
  /**
   * 种类：货架（gondola，默认）；立式冷柜（fridge：单面，玻璃门，门框上竖着灯带，顶上一条灯箱写着 header）；卧式冰柜（freezer：
   * 货躺在槽里，上面两块玻璃推拉盖；depth 是整个柜子的宽，levels 只用第一个——槽底的高，height 是柜沿的高）；挂钩架（pegboard：
   * 洞洞板上一排排挂钩，袋装、卡装的商品挂在钩上，levels 是每排挂钩的高、depth 是钩长）；堆头（stack：地上一个台子，商品一块块
   * 码成往上收的垛，levels 只用第一个——台面的高，depth 是整个垛的深，原点在台子中心）；熟食柜（deli：黑色的柜体，前面一条白
   * 石英台面，中间下沉的黑托盘上成排摆碗、盘（商品的 bowl、plate，摆货的 rows 是往里几排），上面每隔 bay 挂一盏金色的保温灯；
   * levels 只用第一个——托盘面的高，height 是灯罩底的高，depth 是整个柜子的深）。端架就是短的单面货架。
   */
  readonly type?: 'gondola' | 'fridge' | 'freezer' | 'pegboard' | 'stack' | 'deli';
  /** 冷柜的门框、门下的前脸、顶盖和灯箱的颜色（sRGB 的 #rrggbb；饮料厂家的品牌冷柜，黄的、红的）；没写是深灰门框、架子色的顶、蓝灯箱。 */
  readonly doorColor?: string;
  /** 冷柜顶上灯箱的字（"冷藏饮料"），要有 font；没写时灯箱只发光不写字。 */
  readonly header?: string;
  /**
   * 冷柜门上的广告贴（贴在每扇门的玻璃外面）：门的下面三分之二贴一圈——上面一条横幅写 title（"冰冻专区"），两边各一条边框，
   * 下面一条写 slogan（"天然矿泉水"），中间空着看得见里面的货。color 是贴纸的底色，textColor 是字的颜色（默认白），border 是两边
   * 边框的宽（米，默认 0.05）；字要有 font。
   */
  readonly doorSticker?: ShelfDoorSticker;
  /** 价签：纸的（默认，白底或黄底红字）或电子价签（一个小外壳加一块墨水屏：黑字、角上的二维码，有的带红色的促销条）。 */
  readonly priceTags?: 'paper' | 'electronic';
  /**
   * 价签放在哪：价签条（strip，默认：层板前沿往下的一条，价签贴在正面）或透明挡条（rail：立在层板前沿、略往后仰的一条透明塑料，
   * 纸价签插在它后面，层板下面没有价签条；照片里的木层板货架）。只对货架、冷柜有用。
   */
  readonly tagHolder?: 'strip' | 'rail';
  /** 纸价签右边一块的颜色（sRGB 的 #rrggbb，超市自己的颜色）：写了时价签都是白底深灰字、右边这一块；没写是白底或黄底红字。 */
  readonly tagAccent?: string;
  readonly seed?: number;
}

/** 冷柜门上的广告贴（ShelfFile.doorSticker）。 */
export interface ShelfDoorSticker {
  readonly color: string;
  readonly title?: string;
  readonly slogan?: string;
  readonly textColor?: string;
  readonly border?: number;
}
