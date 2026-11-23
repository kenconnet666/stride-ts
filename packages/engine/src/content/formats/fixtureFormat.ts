/**
 * 店里的器具（`.fixture.json`，Stride 没有）：收银台、购物车、购物篮、寄存柜、入口的闸机。都是方块和圆管拼出来的，参数少，
 * 编辑器后端生成同名的模型、图集和材质（modeling/fixture.ts，走 ProductBatch）。货架、冷柜、冰柜见 `.shelf.json`。
 *
 * 坐标是米，原点在器具底面的中心，正面朝 +Z（收银台的顾客那一边、购物车的推手那一头朝 -Z）；吸顶的轨道射灯原点在轨道顶面的中心，
 * 往 -Y 挂下来。
 */
export interface FixtureFile {
  readonly name: string;
  /**
   * checkout：收银台（带传送带的台面、收银机的屏、扫码台、上方挂着号码牌的灯箱）；cart：购物车；basket：手提的购物篮；
   * locker：寄存柜（一格格的小门，每格一个指示灯）；gate：入口的单向闸机（立柱和摆臂）；track：吸顶的轨道射灯（一根轨道上等距
   * 几个灯头，往正面斜着照；灯具只发光，照亮东西的聚光灯由场景按 modeling/fixture.ts 的 trackSpots 放）；selfCheckout：自助
   * 收银机（顾客在 +Z：左边柜体上平放的扫码玻璃和竖的扫码窗，中间立柱上往后仰的触摸屏——发光的界面——屏下吐出一截小票的出票口
   * 和刷卡器，右边低一截的称重台上是购物袋架：两根立杆、两根往前伸的挂臂撑着一个打开的袋子；顶上一根带号码的指示灯柱）。
   */
  readonly type: 'checkout' | 'cart' | 'basket' | 'locker' | 'gate' | 'track' | 'selfCheckout';
  /** 主色（sRGB 的 #rrggbb）：收银台、自助收银机的柜体，购物车的车筐、篮子、寄存柜的门、闸机的柱子；没写时按种类。 */
  readonly color?: string;
  /** 收银台、自助收银机的号码（灯箱、指示灯柱上的字，屏上的界面也要 font）；寄存柜几列、几行（默认 6、4）。 */
  readonly number?: string;
  readonly font?: string;
  readonly columns?: number;
  readonly rows?: number;
  /** 轨道射灯：轨道长（米，默认 3）、几个灯头（默认 4）、灯头偏离竖直往 +Z 倾斜的角度（度，默认 30）。 */
  readonly length?: number;
  readonly heads?: number;
  readonly tilt?: number;
}
