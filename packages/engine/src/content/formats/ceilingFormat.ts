/**
 * 天花板（`.ceiling.json`，Stride 没有）：超市、商场、地下车库的顶。文件存范围、高度和样式，编辑器后端生成同名的模型、图集和
 * 材质（modeling/ceiling.ts，走 ProductBatch）：
 * - open：开放式的顶（照片里的超市）：刷深色的楼板，下面露着一排排风管、桥架、喷淋管，灯管吊在杆上；
 * - grid：矿棉板的格栅吊顶，一格格的板、T 形龙骨，嵌着方形的灯盘。
 * 灯只是发光的灯具，照亮场景的光源（面光源）另外放，位置照 `lights` 排出来的（见 ceilingLights）。
 *
 * 坐标是米，原点在这片顶下面地面的中心；风管、灯管沿 X 排。
 */
export interface CeilingFile {
  readonly name: string;
  /** 范围：宽（沿 X）、深（沿 Z）。 */
  readonly size: readonly [number, number];
  /** 楼板底（开放式）或吊顶（格栅）离地的高（米）。 */
  readonly height: number;
  readonly style?: 'open' | 'grid';
  /** 楼板、吊顶的颜色（sRGB 的 #rrggbb）：开放式默认深灰，格栅默认白。 */
  readonly color?: string;
  /** 开放式的管线：几根风管、几条桥架、几根喷淋管（沿 X，均匀地分在深度上），默认 2、2、3。 */
  readonly ducts?: number;
  readonly trays?: number;
  readonly pipes?: number;
  /**
   * 灯：沿 Z 排几排（rows），每排沿 X 每隔 spacing 米一盏，一盏长 length 米；开放式的吊在楼板下 drop 米。默认 2 排、2.2 米、
   * 1.4 米、0.6 米。格栅的灯盘按同样的排布嵌在板里。
   */
  readonly lights?: { readonly rows?: number; readonly spacing?: number; readonly length?: number; readonly drop?: number };
  readonly seed?: number;
}
