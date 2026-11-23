/**
 * 店里的器具（`.fixture.json`，Stride 没有）：收银台、购物车、购物篮、寄存柜、入口的闸机。都是方块和圆管拼出来的，参数少，
 * 编辑器后端生成同名的模型、图集和材质（modeling/fixture.ts，走 ProductBatch）。货架、冷柜、冰柜见 `.shelf.json`。
 *
 * 坐标是米，原点在器具底面的中心，正面朝 +Z（收银台的顾客那一边、购物车的推手那一头朝 -Z）；吸顶的轨道射灯原点在轨道顶面的中心，
 * 往 -Y 挂下来。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const FIXTURE = s.object({
  name: s.string(),
  /**
   * checkout：收银台（带传送带的台面、收银机的屏、扫码台、上方挂着号码牌的灯箱）；cart：购物车；basket：手提的购物篮；
   * locker：寄存柜（一格格的小门，每格一个指示灯）；gate：入口的单向闸机（立柱和摆臂）；track：吸顶的轨道射灯（一根轨道上等距
   * 几个灯头，往正面斜着照；灯具只发光，照亮东西的聚光灯由场景按 modeling/fixture.ts 的 trackSpots 放）；selfCheckout：自助
   * 收银机（顾客在 +Z：左边柜体上平放的扫码玻璃和竖的扫码窗，中间立柱上往后仰的触摸屏——发光的界面——屏下吐出一截小票的出票口
   * 和刷卡器，右边低一截的称重台上是购物袋架：两根立杆、两根往前伸的挂臂撑着一个打开的袋子；顶上一根带号码的指示灯柱）。
   */
  type: s.oneOf('checkout', 'cart', 'basket', 'locker', 'gate', 'track', 'selfCheckout').describe('checkout counter (belt, scanner, register screens, a lit number sign above), shopping cart, hand basket, coin locker, entrance gate, ceiling track with spotlight heads (origin at the top of the rail; the lights that light things are placed by the scene at trackSpots), self-checkout kiosk (customer at +Z: scanner glass, lit touch screen, receipt printer with a strip of paper, card reader, bagging scale with a bag rack holding an open bag, a numbered status light pole)'),
  /** 主色（sRGB 的 #rrggbb）：收银台、自助收银机的柜体，购物车的车筐、篮子、寄存柜的门、闸机的柱子；没写时按种类。 */
  color: s.string().optional().describe('main color (sRGB #rrggbb; by type when missing)'),
  /** 收银台、自助收银机的号码（灯箱、指示灯柱上的字，屏上的界面也要 font）。 */
  number: s.string().default('1').describe('number on the checkout sign (needs the font)'),
  font: s.asset('font').optional().describe('font of the checkout sign'),
  /** 收银台左右镜像：收银员、收银机的屏在 -Z、顾客在 +Z（收银台有左右两种手，摆在墙边时收银员背靠墙）。 */
  mirror: s.bool().default(false).describe('checkout: mirrored, the cashier and the register screen on -Z and the customers on +Z (checkouts come in both hands; by a wall the cashier stands with the back to it)'),
  /** 寄存柜几列、几行。 */
  columns: s.integer(1, 20).default(6).describe('locker columns'),
  rows: s.integer(1, 10).default(4).describe('locker rows'),
  /** 轨道射灯：轨道长（米）、几个灯头、灯头偏离竖直往 +Z 倾斜的角度（度）。 */
  length: s.number({ min: 0.2, step: 0.1 }).default(3).describe('track length (m)'),
  heads: s.integer(1, 32).default(4).describe('spotlight heads on the track'),
  tilt: s.number({ min: 0, max: 90, step: 5 }).default(30).describe('how far the heads tilt from straight down toward the front (+Z), degrees'),
  /** 用旧了多少（0..1；0 是新的）：主色的面上边角掉漆、细划痕、靠底发脏和黑印，按种子。 */
  wear: s.number({ min: 0, max: 1, step: 0.05 }).default(0.4).describe('how used it looks (0..1, 0 brand new): chipped edges, fine scratches, grime and scuff marks near the bottom on the main color, from the seed'),
  seed: s.integer(0, 2 ** 31 - 1).default(1).describe('random seed of the wear'),
});

/** 器具文件的样子（有默认值的可以不写）。 */
export type FixtureFile = InputOf<typeof FIXTURE>;
/** 解析以后的器具（默认值补齐）。 */
export type Fixture = Infer<typeof FIXTURE>;
