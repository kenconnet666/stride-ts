/**
 * 店里器具的生成（`.fixture.json`，格式见 content/formats/fixtureFormat.ts）：收银台、自助收银机、购物车、购物篮、寄存柜、闸机、
 * 轨道射灯，都用 ProductBatch 的方块和圆管拼，出一个模型、图集和材质。收银台上方的号码灯箱、自助收银机的屏和指示灯、寄存柜每格的
 * 指示灯、轨道射灯的灯口发光。
 */
import { FIXTURE, type Fixture, type FixtureFile } from '../content/formats/fixtureFormat.ts';
import { textPath } from './product.ts';
import { ProductBatch, type AtlasCell, type Cell, type MergedProducts } from './productBatch.ts';
import { wornPaintCell } from './wear.ts';
import type { TextFont } from './textOutline.ts';

/**
 * 纯色：主色、不锈钢、深色（传送带、屏、轮子）、浅色（柜体、台面）、绿灯（发光）、玻璃那样的深青（扫码窗、屏面）、射灯口的暖白光、
 * 购物袋和小票的白。
 */
const MAIN = 0, STEEL = 1, DARK = 2, LIGHT = 3, LED = 4, SCREEN = 5, LAMP = 6, PAPER = 7;

const DEFAULT_COLORS: Readonly<Record<FixtureFile['type'], string>> = { checkout: '#d8d6d0', cart: '#2f9e44', basket: '#1e64c8', locker: '#f08c00', gate: '#b8bcc0', track: '#1d1d1f', selfCheckout: '#e9eaec' };

/** 轨道射灯：轨道的截面边长、灯头吊在轨道下多深、灯身的半径和长（米）。 */
const RAIL = 0.035, HEAD_DROP = 0.09, HEAD_RADIUS = 0.04, HEAD_LENGTH = 0.13;

/** 轨道射灯的一个灯头：灯口中心（米，器具的坐标）和照的方向（单位向量）。 */
export interface TrackSpot {
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * 轨道射灯每个灯头放聚光灯的位置和方向：场景照它放（灯具只发光，同天花板的 ceilingLights）。位置在灯口外 2 厘米——放在灯口上
 * 会被灯头自己的灯身挡住，投阴影时整盏灯是黑的。
 */
export function trackSpots(input: FixtureFile): TrackSpot[] {
  const file = FIXTURE.parse(input, input.name);
  return trackLenses(file).map(({ position, direction }) => ({ position: [position[0] + direction[0] * 0.02, position[1] + direction[1] * 0.02, position[2] + direction[2] * 0.02] as const, direction }));
}

/** 每个灯头的灯口中心和照的方向（几何用）。 */
function trackLenses(file: Fixture): TrackSpot[] {
  const length = Math.max(0.2, file.length), heads = Math.max(1, Math.round(file.heads));
  const tilt = ((file.tilt) * Math.PI) / 180;
  const direction = [0, -Math.cos(tilt), Math.sin(tilt)] as const;
  return Array.from({ length: heads }, (_, i) => {
    const x = -length / 2 + ((i + 0.5) * length) / heads;
    // 灯身的中心在转接杆下面，灯口在灯身朝 direction 的那一头
    const center = [x, -RAIL - HEAD_DROP, 0];
    return { position: [center[0]!, center[1]! + direction[1] * HEAD_LENGTH / 2, center[2]! + direction[2] * HEAD_LENGTH / 2] as const, direction };
  });
}

/** 这件器具上要写的字（烘焙时按它取字形）；不写字的种类是空串。 */
export function fixtureText(input: FixtureFile): string {
  const file = FIXTURE.parse(input, input.name);
  const number = file.number;
  return file.type === 'checkout' ? `收银 ${number}` : file.type === 'selfCheckout' ? `${SELF_CHECKOUT_TEXT.join('')}${number}` : '';
}

export function fixtureModel(input: FixtureFile, font: TextFont | undefined, where = input.name): MergedProducts {
  const file = FIXTURE.parse(input, where);
  // 种类不对的文件过不了模式，这里一定有颜色
  const main = file.color ?? DEFAULT_COLORS[file.type];
  const cells: AtlasCell[] = file.type === 'checkout' ? [{
    size: [700, 260], color: '#d7262b', roughness: 0.3, metalness: 0, emissive: 2.5,
    draw: ([x, y, w, h]: Cell) => (font ? textPath(font, `收银 ${file.number}`, x + w / 2, y + h / 2, w * 0.8, h * 0.62, '#ffffff') : undefined),
  }] : file.type === 'selfCheckout' ? selfCheckoutCells(file.number, font) : [];
  const mainSolid = { color: main, roughness: 0.45, metalness: file.type === 'gate' ? 0.8 : 0.1 };
  // 用旧了：主色的盒子贴旧漆格（排在别的格子后面）
  if (file.wear > 0) cells.push(wornPaintCell(main, { ...mainSolid, amount: file.wear, seed: file.seed }));
  const batch = new ProductBatch({ products: new Map(), font: () => undefined }, where, [], {
    solids: [
      mainSolid,
      { color: '#c3c7cb', roughness: 0.25, metalness: 0.9 },
      { color: '#1c1d20', roughness: 0.6, metalness: 0.1 },
      { color: '#eceae6', roughness: 0.4, metalness: 0 },
      { color: '#3cd35a', roughness: 0.4, metalness: 0, emissive: 3 },
      { color: '#1b2a33', roughness: 0.08, metalness: 0.3 },
      { color: '#fff1d8', roughness: 0.4, metalness: 0, emissive: 8 },
      { color: '#e8ecee', roughness: 0.45, metalness: 0 },
    ],
    cells,
  });
  if (file.wear > 0) batch.textureSolid(MAIN, cells.length - 1);
  switch (file.type) {
    case 'checkout': checkout(batch); break;
    case 'cart': cart(batch); break;
    case 'basket': basket(batch); break;
    case 'locker': locker(batch, Math.max(1, Math.round(file.columns)), Math.max(1, Math.round(file.rows))); break;
    case 'gate': gate(batch); break;
    case 'track': track(batch, file); break;
    case 'selfCheckout': selfCheckout(batch); break;
  }
  return batch.finish();
}

/** 收银台：2.4 米长的柜台（顾客在 -Z、收银员在 +Z），前半段是传送带，中间扫码台，收银机的屏朝收银员，顾客屏朝外；一头立杆上挂号码灯箱。 */
function checkout(batch: ProductBatch): void {
  batch.box([-1.2, 0, -0.35], [1.2, 0.86, 0.35], MAIN);
  batch.box([-1.22, 0.86, -0.37], [1.22, 0.9, 0.37], LIGHT);
  // 传送带（略高出台面）和两头的挡板
  batch.box([-1.15, 0.9, -0.28], [0.15, 0.915, 0.22], DARK);
  batch.box([-1.15, 0.9, -0.3], [0.15, 0.95, -0.28], STEEL);
  // 扫码台：玻璃窗
  batch.box([0.25, 0.9, -0.2], [0.6, 0.905, 0.15], SCREEN);
  // 打包台（低一截）
  batch.box([0.7, 0.9, -0.33], [1.2, 0.92, 0.33], STEEL);
  // 收银机：立柱、屏（朝 +Z 的收银员）、顾客屏（朝 -Z）
  batch.box([0.62, 0.9, 0.18], [0.66, 1.2, 0.22], DARK);
  batch.box([0.48, 1.18, 0.18], [0.8, 1.4, 0.22], DARK);
  batch.box([0.5, 1.2, 0.222], [0.78, 1.38, 0.226], SCREEN);
  batch.box([0.5, 1.2, 0.174], [0.78, 1.38, 0.178], SCREEN);
  // 号码灯箱：立杆和两面的灯箱
  batch.tube([-1.15, 0.9, 0.3], [-1.15, 2.2, 0.3], 0.02, STEEL, 10);
  batch.box([-1.5, 2.2, 0.26], [-0.8, 2.46, 0.34], STEEL);
  for (const side of [1, -1] as const) {
    const z = 0.3 + side * 0.041, x0 = -1.48, x1 = -0.82;
    // 从这一面看左下、右下、右上、左上
    batch.quad(side > 0 ? [[x0, 2.22, z], [x1, 2.22, z], [x1, 2.44, z], [x0, 2.44, z]] : [[x1, 2.22, z], [x0, 2.22, z], [x0, 2.44, z], [x1, 2.44, z]], [0, 0, side], 0);
  }
}

/**
 * 购物车：车筐是金属丝（一根根细杆），后宽前窄（一辆的车头能插进另一辆的车尾，停在一起时顺着车身套成一串，每辆错开
 * 0.26 米左右），推手在 -Z 那头、是主色的塑料；车筐下面一层底盘，四个万向轮（前面两个收窄）。
 */
function cart(batch: ProductBatch): void {
  const zb = -0.42, zf = 0.45, wb = 0.27, wf = 0.21, y0 = 0.4, y1 = 0.86, bar = 0.004;
  // 车筐在 z 处的半宽：从后往前线性收窄
  const half = (z: number) => wb + ((wf - wb) * (z - zb)) / (zf - zb);
  // 底盘（下层的托盘，也是前窄）和四个轮子：轮子是横着的轴（沿 X）的圆柱，上面一根竖的叉
  batch.box([-0.2, 0.125, zb + 0.02], [0.2, 0.14, zf - 0.12], STEEL);
  for (const [x, z] of [[-0.22, zb + 0.05], [0.22, zb + 0.05], [-0.16, zf - 0.13], [0.16, zf - 0.13]] as const) {
    batch.tube([x - 0.012, 0.05, z], [x + 0.012, 0.05, z], 0.05, DARK, 12);
    batch.tube([x, 0.05, z], [x, 0.14, z], 0.008, STEEL, 6);
  }
  // 车筐：前后两面的竖杆，两侧的竖杆跟着收窄，底是一根根横杆
  for (let t = -1; t <= 1 + 1e-6; t += 0.17) {
    batch.box([t * wb - bar, y0, zb - bar], [t * wb + bar, y1, zb + bar], STEEL);
    batch.box([t * wf - bar, y0, zf - bar], [t * wf + bar, y1, zf + bar], STEEL);
  }
  for (let z = zb; z <= zf + 1e-6; z += 0.045) {
    const w = half(z);
    for (const x of [-w, w]) batch.box([x - bar, y0, z - bar], [x + bar, y1, z + bar], STEEL);
    batch.box([-w, y0 - bar, z - bar], [w, y0 + bar, z + bar], STEEL);
  }
  // 横杆：前后两面平的，两侧斜着收
  for (let y = y0; y <= y1 + 1e-6; y += 0.092) {
    batch.box([-wb, y - bar, zb - bar], [wb, y + bar, zb + bar], STEEL);
    batch.box([-wf, y - bar, zf - bar], [wf, y + bar, zf + bar], STEEL);
    for (const side of [-1, 1]) batch.tube([side * wb, y, zb], [side * wf, y, zf], bar, STEEL, 4);
  }
  // 车架：后面两根立柱从底盘到推手，前面两根斜撑从车筐底到底盘
  for (const side of [-1, 1]) {
    batch.box([side * wb - 0.008, 0.14, zb - 0.008], [side * wb + 0.008, y1 + 0.12, zb + 0.008], STEEL);
    batch.tube([side * wf, y0, zf], [side * 0.16, 0.14, zf - 0.13], 0.008, STEEL, 6);
  }
  batch.tube([-wb - 0.02, y1 + 0.13, zb - 0.04], [wb + 0.02, y1 + 0.13, zb - 0.04], 0.018, MAIN, 12);
}

/** 购物篮：主色的塑料篮，四壁是一条条横的板条（中间有缝），两边各一个提手。 */
function basket(batch: ProductBatch): void {
  const x0 = -0.22, x1 = 0.22, z0 = -0.15, z1 = 0.15, h = 0.24, t = 0.006;
  batch.box([x0, 0, z0], [x1, 0.012, z1], MAIN);
  for (let y = 0.012; y < h; y += 0.04) {
    const y1 = Math.min(h, y + 0.026);
    batch.box([x0, y, z0], [x1, y1, z0 + t], MAIN);
    batch.box([x0, y, z1 - t], [x1, y1, z1], MAIN);
    batch.box([x0, y, z0], [x0 + t, y1, z1], MAIN);
    batch.box([x1 - t, y, z0], [x1, y1, z1], MAIN);
  }
  // 四个角的立柱、一圈上沿
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as const) batch.box([x - 0.006, 0, z - 0.006], [x + 0.006, h, z + 0.006], MAIN);
  batch.box([x0, h - 0.015, z0], [x1, h, z0 + 0.012], MAIN);
  batch.box([x0, h - 0.015, z1 - 0.012], [x1, h, z1], MAIN);
  batch.box([x0, h - 0.015, z0], [x0 + 0.012, h, z1], MAIN);
  batch.box([x1 - 0.012, h - 0.015, z0], [x1, h, z1], MAIN);
  // 提手：两头立起来、中间一根横的
  for (const z of [z0 + 0.03, z1 - 0.03]) {
    batch.tube([x0 + 0.05, h, z], [x0 + 0.08, h + 0.12, z], 0.007, DARK, 6);
    batch.tube([x1 - 0.05, h, z], [x1 - 0.08, h + 0.12, z], 0.007, DARK, 6);
    batch.tube([x0 + 0.08, h + 0.12, z], [x1 - 0.08, h + 0.12, z], 0.01, MAIN, 8);
  }
}

/** 寄存柜：columns × rows 格的小门（主色），每格一个把手槽、一个绿色的指示灯；中间一格是操作屏。 */
function locker(batch: ProductBatch, columns: number, rows: number): void {
  const cw = 0.34, ch = 0.36, w = columns * cw, base = 0.1, h = base + rows * ch;
  batch.box([-w / 2 - 0.02, 0, -0.25], [w / 2 + 0.02, h + 0.06, 0.25], LIGHT);
  const middle = Math.floor(columns / 2), screenRow = Math.floor(rows / 2);
  for (let c = 0; c < columns; c++) {
    for (let r = 0; r < rows; r++) {
      const x0 = -w / 2 + c * cw + 0.008, x1 = x0 + cw - 0.016, y0 = base + r * ch + 0.008, y1 = y0 + ch - 0.016, z = 0.25;
      if (c === middle && r === screenRow) {
        batch.box([x0, y0, z], [x1, y1, z + 0.01], DARK);
        batch.box([x0 + 0.04, y0 + 0.08, z + 0.01], [x1 - 0.04, y1 - 0.06, z + 0.012], SCREEN);
        continue;
      }
      batch.box([x0, y0, z], [x1, y1, z + 0.012], MAIN);
      batch.box([x1 - 0.05, y0 + ch * 0.4, z + 0.012], [x1 - 0.03, y0 + ch * 0.6, z + 0.016], DARK);
      batch.box([x0 + 0.02, y1 - 0.03, z + 0.012], [x0 + 0.035, y1 - 0.015, z + 0.016], LED);
    }
  }
}

/**
 * 轨道射灯：一根方的轨道（顶面在原点），每个灯头是轨道下的转接块、一根短杆、一个朝着照的方向的圆筒灯身（后头收成一个钝的
 * 圆台），灯口一片发光的圆。
 */
function track(batch: ProductBatch, file: Fixture): void {
  const length = Math.max(0.2, file.length);
  batch.box([-length / 2, -RAIL, -RAIL / 2], [length / 2, 0, RAIL / 2], MAIN);
  for (const { position, direction } of trackLenses(file)) {
    const x = position[0];
    batch.box([x - 0.025, -RAIL - 0.025, -0.02], [x + 0.025, -RAIL, 0.02], MAIN);
    batch.tube([x, -RAIL - 0.025, 0], [x, -RAIL - HEAD_DROP, 0], 0.008, MAIN, 8);
    const center = [x, -RAIL - HEAD_DROP, 0];
    const front = position, back = center.map((c, k) => c - direction[k]! * HEAD_LENGTH / 2);
    batch.tube(back, front, HEAD_RADIUS, MAIN, 16);
    batch.tube(back, back.map((c, k) => c - direction[k]! * 0.02), HEAD_RADIUS, MAIN, 16, HEAD_RADIUS * 0.4);
    // 灯口：往外一点点、半径收到 0 的扁圆台，就是一片圆
    batch.tube(front.map((c, k) => c - direction[k]! * 0.004), front.map((c, k) => c + direction[k]! * 0.001), HEAD_RADIUS * 0.85, LAMP, 16, 0);
  }
}

/** 闸机：两根立柱（顶上一块深色的感应面板），中间一根摆臂。 */
function gate(batch: ProductBatch): void {
  for (const x of [-0.38, 0.38]) {
    batch.box([x - 0.06, 0, -0.25], [x + 0.06, 0.95, 0.25], MAIN);
    batch.box([x - 0.06, 0.95, -0.25], [x + 0.06, 0.97, 0.25], DARK);
  }
  batch.box([0.3, 0.94, -0.22], [0.32, 0.96, -0.12], LED);
  batch.tube([-0.32, 0.85, 0], [0.32, 0.85, 0], 0.015, STEEL, 10);
}

/**
 * 自助收银机的两格：触摸屏的界面（蓝色的标题栏、白底、"请扫描商品"、绿色的大按钮，整块发光）和指示灯柱上的号码牌（黑底白字，
 * 发光）。没有字体时只画色块。
 */
const SELF_CHECKOUT_TEXT = ['自助收银', '请扫描商品', '开始结账'] as const;

function selfCheckoutCells(number: string, font: TextFont | undefined): AtlasCell[] {
  const [title, prompt, button] = SELF_CHECKOUT_TEXT;
  return [{
    size: [400, 300], color: '#f4f6f8', roughness: 0.1, metalness: 0, emissive: 1.2,
    draw: ([x, y, w, h]: Cell) => {
      const shapes = [`<rect x="${x}" y="${y}" width="${w}" height="${h * 0.16}" fill="#1e64c8"/>`,
        `<rect x="${x + w * 0.2}" y="${y + h * 0.66}" width="${w * 0.6}" height="${h * 0.2}" rx="${h * 0.04}" fill="#2f9e44"/>`];
      if (font) {
        shapes.push(textPath(font, title, x + w / 2, y + h * 0.08, w * 0.5, h * 0.11, '#ffffff') ?? '');
        shapes.push(textPath(font, prompt, x + w / 2, y + h * 0.4, w * 0.7, h * 0.16, '#1d1d1f') ?? '');
        shapes.push(textPath(font, button, x + w / 2, y + h * 0.76, w * 0.45, h * 0.12, '#ffffff') ?? '');
      }
      return shapes.join('');
    },
  }, {
    size: [160, 120], color: '#1d1d1f', roughness: 0.3, metalness: 0, emissive: 2,
    draw: ([x, y, w, h]: Cell) => (font ? textPath(font, number, x + w / 2, y + h / 2, w * 0.6, h * 0.7, '#ffffff') : undefined),
  }];
}

/**
 * 自助收银机（顾客在 +Z）：左边是柜体，台面上平放的扫码玻璃、后面一个竖的扫码窗、右前角的刷卡器；柜体后沿一根立柱托着触摸屏
 * （界面是图集的第 0 格），屏下是出票口，吐出一截小票；右边低一截的称重台上是购物袋架——两根立杆、一根横杆、两根往前伸的挂臂，
 * 撑着一个打开的袋子；左后角一根指示灯柱，顶上绿灯，下面号码牌（第 1 格）。
 */
function selfCheckout(batch: ProductBatch): void {
  // 柜体和台面
  batch.box([-0.5, 0, -0.25], [0, 0.82, 0.2], MAIN);
  batch.box([-0.52, 0.82, -0.27], [0.02, 0.85, 0.22], LIGHT);
  // 扫码：平放的玻璃、后面竖的扫码窗
  batch.box([-0.42, 0.85, -0.05], [-0.1, 0.852, 0.15], SCREEN);
  batch.box([-0.42, 0.85, -0.2], [-0.1, 1.0, -0.12], DARK);
  batch.box([-0.4, 0.87, -0.12], [-0.12, 0.98, -0.118], SCREEN);
  // 刷卡器
  batch.box([-0.08, 0.85, 0.04], [-0.01, 0.93, 0.13], DARK);
  batch.box([-0.07, 0.88, 0.13], [-0.02, 0.92, 0.132], SCREEN);
  // 立柱、出票口（吐出一截小票）、触摸屏
  batch.tube([-0.26, 0.85, -0.23], [-0.26, 1.12, -0.23], 0.03, DARK, 12);
  batch.box([-0.37, 1.0, -0.25], [-0.15, 1.1, -0.17], DARK);
  batch.box([-0.31, 1.03, -0.17], [-0.21, 1.035, -0.165], DARK);
  batch.box([-0.3, 0.94, -0.166], [-0.22, 1.033, -0.164], PAPER);
  batch.box([-0.48, 1.12, -0.26], [-0.04, 1.43, -0.2], DARK);
  batch.quad([[-0.46, 1.14, -0.199], [-0.06, 1.14, -0.199], [-0.06, 1.41, -0.199], [-0.46, 1.41, -0.199]], [0, 0, 1], 0);
  // 指示灯柱：号码牌、顶上的绿灯
  batch.tube([-0.49, 1.43, -0.24], [-0.49, 1.9, -0.24], 0.014, STEEL, 8);
  batch.box([-0.56, 1.7, -0.26], [-0.42, 1.8, -0.22], DARK);
  batch.quad([[-0.55, 1.705, -0.219], [-0.43, 1.705, -0.219], [-0.43, 1.795, -0.219], [-0.55, 1.795, -0.219]], [0, 0, 1], 1);
  batch.tube([-0.49, 1.9, -0.24], [-0.49, 1.98, -0.24], 0.035, LED, 12);
  // 称重台
  batch.box([0.1, 0, -0.22], [0.53, 0.72, 0.18], MAIN);
  batch.box([0.08, 0.72, -0.24], [0.55, 0.74, 0.2], STEEL);
  // 购物袋架：立杆、横杆、往前伸的挂臂
  for (const x of [0.12, 0.51]) batch.tube([x, 0.74, -0.21], [x, 1.16, -0.21], 0.01, STEEL, 8);
  batch.tube([0.12, 1.16, -0.21], [0.51, 1.16, -0.21], 0.01, STEEL, 8);
  for (const x of [0.15, 0.48]) batch.tube([x, 1.14, -0.21], [x, 1.14, 0.13], 0.007, STEEL, 8);
  // 撑开的塑料袋：底和四壁（前壁矮一截，袋口往前耷拉），两只提手套在挂臂上
  const [bx0, bx1, bz0, bz1, by0, t] = [0.17, 0.46, -0.17, 0.1, 0.745, 0.002];
  const back = 1.06, front = 0.96;
  batch.box([bx0, by0, bz0], [bx1, by0 + t, bz1], PAPER);
  batch.box([bx0, by0, bz0], [bx1, back, bz0 + t], PAPER);
  batch.box([bx0, by0, bz1 - t], [bx1, front, bz1], PAPER);
  batch.box([bx0, by0, bz0], [bx0 + t, back, bz1], PAPER);
  batch.box([bx1 - t, by0, bz0], [bx1, back, bz1], PAPER);
  for (const x of [0.15, 0.48]) {
    const inner = x < 0.3 ? bx0 : bx1;
    // 提手：从袋壁顶上斜着挂到挂臂上，再从挂臂上垂下来
    batch.tube([inner, back, bz0 + 0.04], [x, 1.14, -0.1], 0.004, PAPER, 6);
    batch.tube([inner, front, bz1 - 0.04], [x, 1.14, 0.06], 0.004, PAPER, 6);
  }
}
