/**
 * 参数化的树（`.tree.json`，W4，Stride 没有）：文件存生长的规则和种子（矢量的），编辑器后端照规则长成同名的模型
 * （modeling/tree.ts 生长、pipeline 的 treeModel.ts 写模型），场景、摆放（.scatter.json）照常引用模型；改了参数马上重新长、
 * 视口热重载。同一个文件、同一个种子长出同一棵树，换种子是同一种树的另一棵。
 *
 * 一层一层地长（思路同 ez-tree、Weber–Penn 的分层参数）：第 0 层是树干，每一根枝上沿着长度长出下一层的 children 根枝；
 * 最后一层的枝上长叶片（交叉的两张卡片，贴图是叶簇，材质用 alphaCutoff 挖出叶子的形状）。坐标是米，树根在原点，往 +Y 长。
 */

/** 一层枝的参数（第 0 层是树干）。 */
export interface TreeLevelFile {
  /** 长度（米）；针叶树的侧枝越往上越短（乘 1 − 长在母枝上的位置）。 */
  readonly length: number;
  /** 半径：树干是米，侧枝是长出来那一处母枝半径的倍数。 */
  readonly radius: number;
  /** 这一层的每根枝上长几根下一层的枝。最后一层不用写。 */
  readonly children?: number;
  /** 和母枝的夹角（度），树干不用写。 */
  readonly angle?: number;
  /** 从母枝的哪里开始长（0..1，沿母枝的长度），树干不用写。 */
  readonly start?: number;
  /** 弯曲：每一节随机偏转的幅度（弧度量级），越细的枝偏得越多。 */
  readonly gnarliness?: number;
  /** 从根到梢变细多少（0..1）。 */
  readonly taper?: number;
  /** 每一节绕自己的轴扭多少（弧度）。 */
  readonly twist?: number;
  /** 沿长度分几节、圆周分几段（网格的细密程度）。 */
  readonly sections?: number;
  readonly segments?: number;
}

/** 叶片：最后一层的每根枝上几片、多大（米）、大小随机变多少（0..1）、和枝的夹角（度）、从枝的哪里开始长（0..1）。 */
export interface TreeLeavesFile {
  readonly count: number;
  readonly size: number;
  readonly sizeVariance?: number;
  readonly angle?: number;
  readonly start?: number;
}

export interface TreeFile {
  readonly name: string;
  /** 材质槽：树皮、叶片（叶片的材质一般带叶簇的贴图、alphaCutoff、doubleSided）。 */
  readonly materials: readonly (string | null)[];
  readonly seed?: number;
  /** 阔叶树（侧枝一样长）或针叶树（树干到顶、侧枝越往上越短）。 */
  readonly shape?: 'deciduous' | 'conifer';
  /** 第 0 层是树干，最多 4 层。 */
  readonly levels: readonly TreeLevelFile[];
  readonly leaves?: TreeLeavesFile;
  /** 枝条往哪个方向长（向光、下垂）：direction 是方向，strength 是每一节转多少（按枝的粗细，越细转得越多）。 */
  readonly growth?: { readonly direction: readonly [number, number, number]; readonly strength: number };
}

/** 两个材质槽：树皮、叶片。 */
export const TREE_SLOTS = 2;
