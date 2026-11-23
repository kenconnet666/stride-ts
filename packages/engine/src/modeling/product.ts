/**
 * 商品包装的生成（`.product.json`，格式见 content/formats/productFormat.ts）：外形的网格、标签的矢量贴图（SVG）、材质。纯函数，
 * 编辑器后端烘焙（pipeline/src/bakers/productModel.ts）、货架摆货、测试都用它。
 *
 * - 瓶、罐、广口瓶、桶是旋转体：一条从底面中心沿着外壁到顶面中心的轮廓线绕 Y 转一圈。贴图的 u 是绕的角度（正面 +Z 在 u = 0.5），
 *   v 是沿轮廓线的长度，所以标签按真实的长度铺开、字不变形；轮廓线上属于盖子的那几段在贴图上是盖子的颜色。
 * - 纸盒是六个面展开成十字（左侧、正面、右侧、背面一排，顶和底在正面的上下）；袋是正反两面鼓起来、四边压平封口的格子网格，
 *   贴图左半是正面、右半是背面。
 * - 标签的 SVG 用毫米做单位（viewBox 和网格的展开一一对应，栅格化的尺寸按比例），字是字体轮廓的路径（evenodd 挖洞）。
 */
import type { MaterialFile } from '../content/formats/assetFormat.ts';
import { PRODUCE_SHAPES, WARE_SHAPES, type ProductColors, type ProductFile, type ProductMotif, type ProductPattern, type ProductShape, type ProductSurface } from '../content/formats/productFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { cross, finish, latheMesh, normalize, smoothNormals, sub, type ProductMesh, type ProfilePoint } from './lathe.ts';
import { shadeColor, svgNumber } from './svg.ts';
import { WARE_COBALT, WARE_GLAZE, wareMesh, wareSkin, type FoodPiecePose } from './ware.ts';
import { textContours, type TextFont } from './textOutline.ts';

export type { ProductMesh } from './lathe.ts';
export { svgNumber } from './svg.ts';

/** 定下来的设计：文件里没写的按种子挑好了。 */
export interface ProductDesign {
  readonly brand: string;
  readonly text: string | undefined;
  readonly colors: Required<ProductColors>;
  readonly pattern: ProductPattern;
  readonly surface: ProductSurface;
  /** 印得细不细、配料的小图、角标（见 ProductFile 的同名字段）。 */
  readonly detail: boolean;
  readonly motif: ProductMotif;
  readonly badge: string | undefined;
}

/** 包装上常见的颜色（sRGB）：底色和强调色从这里挑。 */
const PALETTE = ['#d7262b', '#f6c40f', '#2f9e44', '#1e64c8', '#f4f2ec', '#1d1d1f', '#f08c00', '#f7a8c4', '#7048a8', '#1aa39a', '#7a4a2a', '#efe3c4', '#e8e8e8', '#0b7a3e'];
const PATTERNS: readonly ProductPattern[] = ['plain', 'band', 'stripes', 'split', 'wave', 'dots'];
/** 没写时挑的配料小图（花生、玉米、芝麻这些说明是什么的，写在文件里）。 */
const MOTIFS: readonly ProductMotif[] = ['leaf', 'drop', 'wheat', 'sunflower', 'none'];
/** 镶边的颜色：金、白、米白。 */
const TRIMS = ['#e8c25a', '#ffffff', '#f4f2ec'];
/** 拼品牌名的字（常见的商标用字）。 */
const BRAND_CHARACTERS = '金龙鱼海天康乐福味美好鲜香农家旺佳丰园源山泉清真御品优百万华宝和顺禾田欢喜悦大小星光润洁雪绿新鸿盛';
const DEFAULT_SURFACE: Readonly<Record<ProductShape, ProductSurface>> = {
  box: 'paper', bottle: 'plastic', can: 'metal', jar: 'glass', tub: 'plastic', pouch: 'plastic', jug: 'plastic', round: 'skin', onion: 'skin', garlic: 'skin', nut: 'skin', tuber: 'skin', leaf: 'skin', bowl: 'ceramic', plate: 'ceramic',
};
/** 果蔬的表皮、纹路、顶上（洋葱、蒜头的颈）的颜色，按种子在附近变一点。 */
const PRODUCE_COLORS: Readonly<Record<string, readonly [background: string, accent: string, cap: string]>> = {
  round: ['#c8352a', '#e0603f', '#5a7a2e'], onion: ['#8e3550', '#c56e88', '#9a7a52'], garlic: ['#ece4d6', '#b99aa0', '#c9b48e'],
  nut: ['#a07a4e', '#6e4e2e', '#7d5a36'], tuber: ['#b8925e', '#8a6a3e', '#8a6a3e'],
  // 落叶：枯黄、褐色，斑和叶脉深一点
  leaf: ['#a8783a', '#6a4520', '#5a3a1a'],
};
/** 各种材料的粗糙度和金属度（货架的图集按它画表面贴图）。 */
export const SURFACE_MATERIAL: Readonly<Record<ProductSurface, { readonly roughness: number; readonly metalness: number }>> = {
  paper: { roughness: 0.72, metalness: 0 }, plastic: { roughness: 0.32, metalness: 0 }, metal: { roughness: 0.3, metalness: 0.6 }, glass: { roughness: 0.08, metalness: 0 }, skin: { roughness: 0.55, metalness: 0 }, ceramic: { roughness: 0.16, metalness: 0 },
};
/** 旋转体绕一圈默认分几段（货架后排的商品给少一点）。 */
const RADIAL_SEGMENTS = 20;

/** 文件里没写的按种子（加上第几个变体）挑好。变体只改文件里没写的：写了品牌、配色的文件每个变体都一样。 */
export function productDesign(file: ProductFile, variant = 0): ProductDesign {
  const random = seededRandom(hash32(file.seed ?? 1, variant));
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  if (isWare(file.shape)) {
    // 器皿：白釉青花（碗）或者素白（盘），没有品牌和字
    return {
      brand: '', text: undefined, pattern: file.pattern ?? (file.shape === 'bowl' ? 'floral' : 'plain'), surface: file.surface ?? 'ceramic',
      colors: { background: file.colors?.background ?? WARE_GLAZE, accent: file.colors?.accent ?? WARE_COBALT, text: '', cap: '', trim: '' }, ...UNPRINTED,
    };
  }
  if (isProduce(file.shape)) {
    // 果蔬：颜色在这一种的附近变一点（同一筐番茄有红有橙），没有品牌和字
    const [background, accent, cap] = PRODUCE_COLORS[file.shape]!.map((color) => jitter(color, random, 0.12));
    return {
      brand: '', text: undefined, pattern: 'plain', surface: file.surface ?? 'skin',
      colors: { background: file.colors?.background ?? background!, accent: file.colors?.accent ?? accent!, text: '', cap: file.colors?.cap ?? cap!, trim: '' }, ...UNPRINTED,
    };
  }
  const background = file.colors?.background ?? pick(PALETTE);
  let accent = file.colors?.accent ?? pick(PALETTE);
  for (let tries = 0; !file.colors?.accent && contrast(accent, background) < 1.6 && tries < 8; tries++) accent = pick(PALETTE);
  const length = 2 + Math.floor(random() * 2);
  const brand = file.brand ?? Array.from({ length }, () => pick(Array.from(BRAND_CHARACTERS))).join('');
  const cap = file.colors?.cap ?? pick(['#f4f2ec', '#d7262b', '#1e64c8', '#2f9e44', '#f6c40f', '#1d1d1f', accent]);
  const pattern = file.pattern ?? pick(PATTERNS);
  // 后加的几样排在最后挑：前面的（品牌、配色、图案）和加之前按同一个种子挑的一样
  const motif = file.motif ?? pick(MOTIFS), trim = file.colors?.trim ?? pick(TRIMS);
  return {
    brand,
    text: file.text,
    colors: { background, accent, text: file.colors?.text ?? '', cap, trim },
    pattern,
    surface: file.surface ?? DEFAULT_SURFACE[file.shape],
    detail: file.detail ?? true, motif, badge: file.badge || undefined,
  };
}

/** 果蔬、器皿：没有印的东西。 */
const UNPRINTED = { detail: false, motif: 'none', badge: undefined } as const;

/** 标签上要排的字（品牌名、品类、角标）：烘焙时按它从字体里取子集。 */
export function productText(design: ProductDesign): string {
  return design.brand + (design.text ?? '') + (design.badge ?? '');
}

/** 检查尺寸；不对时报错（where 是报错的前缀）。 */
function checkSize(file: ProductFile, where: string): void {
  const [w, h, d] = file.size;
  if (!(w > 0 && h > 0)) throw new Error(`${where}: size needs a width and a height greater than 0`);
  if ((file.shape === 'box' || file.shape === 'pouch') && !(d > 0)) throw new Error(`${where}: a ${file.shape} needs a depth greater than 0`);
}

/**
 * 外形的网格；segments 是旋转体绕一圈分几段（默认 20，看不清的地方给少一点）。food 是器皿里落定的菜块（ware.ts 的 foodSpawn
 * 经物理跑完的位姿），没给时只有菜面。
 */
export function productMesh(file: ProductFile, where = file.name, segments = RADIAL_SEGMENTS, food?: readonly FoodPiecePose[]): ProductMesh {
  checkSize(file, where);
  if (file.shape === 'box') return boxMesh(file.size);
  if (file.shape === 'pouch') return pouchMesh(file.size);
  const radial = Math.max(3, Math.round(segments));
  if (isWare(file.shape)) return wareMesh(file, radial * 2, food);
  if (file.shape === 'leaf') return leafMesh(file);
  if (isProduce(file.shape)) return produceMesh(file, radial);
  if (file.shape === 'jug') return jugMesh(file, radial);
  return latheMesh(latheProfile(file.shape, file.size[0] / 2, file.size[1]), radial);
}

/** 是不是熟食的器皿（碗、盘：釉面，纹样和盛的菜画在贴图上，modeling/ware.ts）。 */
export function isWare(shape: ProductShape): boolean {
  return WARE_SHAPES.includes(shape);
}

/** 是不是散装的果蔬干货（没有标签，表皮按种子出）。 */
export function isProduce(shape: ProductShape): boolean {
  return PRODUCE_SHAPES.includes(shape);
}

/**
 * 果蔬：旋转体的轮廓（单位大小）按尺寸拉成椭球那样，再按种类起伏：蒜头一瓣瓣（沿圆周的余弦）、核桃坑坑洼洼、土豆疙疙瘩瘩
 * （按位置的哈希噪声），所以法线最后按起伏后的面重算（位置相同的顶点焊在一起取平均）。
 */
function produceMesh(file: ProductFile, radial: number): ProductMesh {
  const [w, h, d] = file.size, rx = w / 2, rz = (d > 0 ? d : w) / 2;
  // 绕一圈分得少（小东西）时，轮廓线也分得少一半
  const profile = produceProfile(file.shape, radial < 12 ? 0.5 : 1);
  const seed = file.seed ?? 1;
  const bump = (u: number, t: number, cells: number, amount: number) => {
    // 两层格子噪声：圆周上按 u 首尾相接
    const value = (scale: number, salt: number) => {
      const x = u * scale, y = t * scale * 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const at = (i: number, j: number) => hash32(hash32(seed + salt, ((x0 + i) % scale + scale) % scale), y0 + j) / 4294967296;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sy) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sy;
    };
    return amount * (value(cells, 1) * 0.65 + value(cells * 2, 2) * 0.35 - 0.5);
  };
  const lobes = 6 + (seed % 4);
  const deform = (u: number, t: number): number => {
    // t 是从底到顶（0..1）；两头收拢的地方起伏小
    const fade = Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
    switch (file.shape) {
      case 'garlic': return 1 + 0.09 * Math.abs(Math.cos(lobes * Math.PI * u)) * fade - 0.04 * fade;
      case 'nut': return 1 + bump(u, t, 9, 0.22) * fade;
      case 'tuber': return 1 + bump(u, t, 4, 0.2) * fade;
      case 'round': return 1 + bump(u, t, 5, 0.03) * fade;
      default: return 1;
    }
  };
  const mesh = latheMesh(profile.map((p) => ({ ...p, y: p.y * h })), radial, (x, y, z, u) => {
    const t = y / h, k = deform(u, t);
    return [x * rx * k, y, z * rz * k];
  });
  return { ...mesh, labelSize: [Math.PI * (rx + rz) * 1000, labelHeight(profile, h, Math.max(rx, rz)) * 1000] };
}

/**
 * 落叶：躺平的一片叶子，长沿 Z、宽沿 X，两边和两头往上卷（size 是宽、卷起的高、长）。轮廓两头尖、中间宽，正反两面（隔 0.4 毫米），
 * 贴图按叶面平铺（u 横、v 竖，叶脉画在 u = 0.5 那条线上）。
 */
function leafMesh(file: ProductFile): ProductMesh {
  const [w, h] = file.size, d = leafLength(file);
  const thickness = Math.min(0.0004, h * 0.5), curl = h - thickness;
  const along = 12, across = 6, builder = new MeshBuilder();
  // 叶的中脉在 s（−1..1，从叶柄到叶尖），横向是 t（−1..1）；轮廓两头尖、偏叶柄那头宽一点（按最宽处归一到 w）
  const outline = (s: number) => Math.sin((Math.PI * (s + 1)) / 2) ** 0.7 * (1 - 0.12 * s);
  const widest = Math.max(...Array.from({ length: 201 }, (_, i) => outline(-1 + i / 100)));
  const point = (s: number, t: number, top: boolean): number[] => {
    // 两边比两头卷得高：叶缘中间那点最高，正好是 curl
    const lift = (0.6 * t * t + 0.4 * s * s) / 0.6;
    return [(t * (w / 2) * outline(s)) / widest, Math.min(1, lift) * curl + (top ? thickness : 0), (s * d) / 2];
  };
  for (const top of [true, false]) {
    const grid: number[][] = [];
    for (let i = 0; i <= along; i++) {
      const s = -1 + (2 * i) / along;
      grid.push(Array.from({ length: across + 1 }, (_, j) => {
        const t = -1 + (2 * j) / across, p = point(s, t, top);
        return builder.vertex(p, [0, top ? 1 : -1, 0], p[0]! / w + 0.5, p[2]! / d + 0.5);
      }));
    }
    for (let i = 0; i < along; i++) {
      for (let j = 0; j < across; j++) builder.quad(grid[i]![j]!, grid[i]![j + 1]!, grid[i + 1]![j + 1]!, grid[i + 1]![j]!, [0, top ? 1 : -1, 0]);
    }
  }
  smoothNormals(builder);
  return finish(builder, [w * 1000, d * 1000]);
}

/** 果蔬轮廓线的长（米，按最大的半径估）：贴图 v 方向的长度。 */
function labelHeight(profile: readonly ProfilePoint[], h: number, r: number): number {
  let length = 0;
  for (let i = 1; i < profile.length; i++) length += Math.hypot((profile[i]!.r - profile[i - 1]!.r) * r, (profile[i]!.y - profile[i - 1]!.y) * h);
  return length;
}

/** 果蔬的轮廓线（半径是最粗处的倍数，高是 0..1），从底面中心到顶。洋葱、蒜头的顶上收成一截颈（盖子的颜色）。detail 乘弧线的分段数。 */
function produceProfile(shape: ProductShape, detail = 1): ProfilePoint[] {
  const arc = (from: number, to: number, steps: number, squash = 1, top = 1) => Array.from({ length: steps + 1 }, (_, i) => {
    const phi = from + ((to - from) * i) / steps;
    return { r: Math.sin(phi), y: (top * (1 - Math.cos(phi))) / 2 * squash };
  });
  switch (shape) {
    case 'onion':
      return [...arc(0, Math.PI * 0.82, Math.round(10 * detail), 1, 0.9).map((p) => ({ ...p, y: p.y })), { r: 0.14, y: 0.9, cap: true }, { r: 0.05, y: 1, cap: true }, { r: 0, y: 1, cap: true }];
    case 'garlic':
      return [{ r: 0, y: 0 }, { r: 0.55, y: 0.02 }, ...arc(Math.PI * 0.25, Math.PI * 0.8, Math.round(8 * detail), 1, 0.92).map((p) => ({ r: p.r, y: p.y })), { r: 0.16, y: 0.88, cap: true }, { r: 0.07, y: 1, cap: true }, { r: 0, y: 1, cap: true }];
    default:
      return arc(0, Math.PI, Math.round(12 * detail));
  }
}

/** 摆在货架上占的地方（米）：宽、高、深（瓶罐的深是直径）。 */
export function productFootprint(file: ProductFile): readonly [number, number, number] {
  const [w, h, d] = file.size;
  if (file.shape === 'jug') return [w, h, jugDepth(file)];
  if (file.shape === 'leaf') return [w, h, leafLength(file)];
  return [w, h, file.shape === 'box' || file.shape === 'pouch' || ((isProduce(file.shape) || file.shape === 'plate') && d > 0) ? d : w];
}

/** 落叶的长（米）：没写时是宽的 1.6。 */
function leafLength(file: ProductFile): number {
  return file.size[2] > 0 ? file.size[2] : file.size[0] * 1.6;
}

/** 方桶的厚度（米）：没写时是宽的 0.62（5 升的油桶大约 17 × 10.5 厘米）。 */
function jugDepth(file: ProductFile): number {
  return file.size[2] > 0 ? file.size[2] : file.size[0] * 0.62;
}

/** 方桶的肩从多高开始收、收到瓶颈的多高（高的比例）；桶身横截面的圆角（超椭圆的次数，越大越方）。 */
const JUG_SHOULDER = [0.7, 0.86] as const;
const JUG_SQUARENESS = 5;
/** 瓶颈的半径（宽的一半的比例）。 */
const JUG_NECK = 0.26;

/**
 * 方桶：旋转体的轮廓（同瓶，桶身更高、瓶颈更细）绕一圈后变形——桶身的横截面是圆角方（超椭圆，宽 × 厚），往上到瓶颈渐渐变回圆、
 * 圆心挪到前面（瓶口偏前）；后面一个提手：从瓶颈后面拱起、落到背面的肩上的一根椭圆截面的弯管（拱下面是空的，手伸得进去），
 * 贴图取瓶身底色那一片（透光的桶，提手也透）。
 */
function jugMesh(file: ProductFile, radial: number): ProductMesh {
  const [w, h] = file.size, R = w / 2, b = jugDepth(file) / 2;
  const profile = latheProfile('jug', R, h);
  const [from, to] = JUG_SHOULDER.map((t) => t * h) as [number, number], forward = b * 0.45, power = 2 / JUG_SQUARENESS;
  const body = latheMesh(profile, radial, (x, y, z) => {
    // 往瓶颈变了多少：按肩收窄了多少算（按高算的话肩的上半截还很粗时已经快变成偏前的圆，前面会鼓出桶身）
    const r = Math.hypot(x, z), t = y <= from ? 0 : y >= to ? 1 : smoothstep(R, R * JUG_NECK, r);
    if (r < 1e-9) return [0, y, forward * t];
    const s = x / r, c = z / r;
    const bx = Math.sign(s) * Math.abs(s) ** power * r, bz = Math.sign(c) * Math.abs(c) ** power * r * (b / R);
    // 往瓶颈去的圆在厚度方向也从桶的厚度慢慢放开：肩上的前后不鼓出桶身
    const k = b / R + (1 - b / R) * t;
    return [bx + (x - bx) * t, y, bz + (z * k + forward * t - bz) * t];
  });

  // 提手：二次贝塞尔，从瓶颈后面（埋在瓶颈里）拱到背面的肩下面（埋在桶身里）；截面横着宽（握的地方）
  const p0 = [0, h * 0.85, forward - R * 0.12], control = [0, h * 1.02, -b * 1.05], p1 = [0, h * 0.62, -b * 0.75];
  const rx = R * 0.14, rn = R * 0.1, steps = 14, around = 10;
  const capLength = capLengthOf(profile);
  const u = 0.02, v = Math.min(1, (capLength + 0.012) / (body.labelSize[1] / 1000));
  const builder = new MeshBuilder();
  const rings: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, q = 1 - t;
    const point = [0, 1, 2].map((k) => q * q * p0[k]! + 2 * q * t * control[k]! + t * t * p1[k]!);
    const tangent = normalize([0, 1, 2].map((k) => 2 * q * (control[k]! - p0[k]!) + 2 * t * (p1[k]! - control[k]!)));
    // 弯管在 YZ 平面里：横的方向是 X，平面里的法线是 X × 切线
    const inPlane = normalize(cross([1, 0, 0], tangent));
    rings.push(Array.from({ length: around + 1 }, (_, k) => {
      const angle = (k / around) * 2 * Math.PI, cos = Math.cos(angle), sin = Math.sin(angle);
      const position = [0, 1, 2].map((j) => point[j]! + (j === 0 ? cos * rx : 0) + inPlane[j]! * sin * rn);
      const normal = normalize([0, 1, 2].map((j) => (j === 0 ? cos / rx : 0) + (inPlane[j]! * sin) / rn));
      return builder.vertex(position, normal, u, v);
    }));
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < around; k++) {
      const a = rings[i]![k]!, n = builder.vertices.slice(a * 8 + 3, a * 8 + 6);
      builder.quad(a, rings[i]![k + 1]!, rings[i + 1]![k + 1]!, rings[i + 1]![k]!, n);
    }
  }
  const handle = finish(builder, body.labelSize), offset = body.vertices.length / 8;
  const vertices = new Float32Array(body.vertices.length + handle.vertices.length);
  vertices.set(body.vertices);
  vertices.set(handle.vertices, body.vertices.length);
  const indices = new Uint32Array(body.indices.length + handle.indices.length);
  indices.set(body.indices);
  indices.set(handle.indices.map((i) => i + offset), body.indices.length);
  return { vertices, indices, labelSize: body.labelSize };
}

/** 轮廓线上盖子那几段（从顶往下）的长（米）：贴图最上面这么长是盖子的颜色。 */
function capLengthOf(profile: readonly ProfilePoint[]): number {
  let length = 0;
  for (let s = profile.length - 1; s > 0 && profile[s]!.cap; s--) length += Math.hypot(profile[s]!.r - profile[s - 1]!.r, profile[s]!.y - profile[s - 1]!.y);
  return length;
}

function smoothstep(from: number, to: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** 旋转体的轮廓线：从底面中心出发，沿外壁到顶面中心。 */
function latheProfile(shape: ProductShape, r: number, h: number): ProfilePoint[] {
  switch (shape) {
    case 'bottle': {
      // 瓶身到 60% 高，肩部收到瓶颈，盖子占最上面 10%
      const shoulder = Array.from({ length: 6 }, (_, i) => {
        const t = (i + 1) / 6;
        return { r: r * (0.38 + 0.62 * Math.cos((t * Math.PI) / 2)), y: h * (0.6 + 0.24 * Math.sin((t * Math.PI) / 2)) };
      });
      return [{ r: 0, y: 0 }, { r: r * 0.92, y: 0 }, { r, y: h * 0.03 }, { r, y: h * 0.6 }, ...shoulder, { r: r * 0.38, y: h * 0.88 },
        { r: r * 0.44, y: h * 0.88, cap: true }, { r: r * 0.44, y: h, cap: true }, { r: 0, y: h, cap: true }];
    }
    case 'jug': {
      // 桶身到 70% 高，肩收到细的瓶颈（86%），盖子到顶；横截面和瓶口的偏移在 jugMesh 里变形
      const [from, to] = JUG_SHOULDER;
      const shoulder = Array.from({ length: 6 }, (_, i) => {
        const t = (i + 1) / 6;
        return { r: r * (JUG_NECK + (1 - JUG_NECK) * Math.cos((t * Math.PI) / 2)), y: h * (from + (to - from) * Math.sin((t * Math.PI) / 2)) };
      });
      return [{ r: 0, y: 0 }, { r: r * 0.9, y: 0 }, { r, y: h * 0.03 }, { r, y: h * from }, ...shoulder,
        { r: r * 0.32, y: h * to, cap: true }, { r: r * 0.32, y: h, cap: true }, { r: 0, y: h, cap: true }];
    }
    case 'can':
      return [{ r: 0, y: 0 }, { r: r * 0.86, y: 0 }, { r, y: h * 0.06 }, { r, y: h * 0.92 }, { r: r * 0.86, y: h * 0.98, cap: true }, { r: r * 0.86, y: h, cap: true }, { r: 0, y: h * 0.99, cap: true }];
    case 'jar':
      return [{ r: 0, y: 0 }, { r: r * 0.94, y: 0 }, { r, y: h * 0.04 }, { r, y: h * 0.78 }, { r: r * 0.9, y: h * 0.82 },
        { r: r * 0.96, y: h * 0.82, cap: true }, { r: r * 0.96, y: h, cap: true }, { r: 0, y: h, cap: true }];
    case 'tub':
      return [{ r: 0, y: 0 }, { r: r * 0.8, y: 0 }, { r: r * 0.98, y: h * 0.86 }, { r, y: h * 0.86, cap: true }, { r, y: h, cap: true }, { r: 0, y: h, cap: true }];
    default:
      throw new Error(`${shape} is not a turned shape`);
  }
}

/** 纸盒：六个面展开成十字（毫米）：一排是左侧、正面、右侧、背面，顶在正面上面、底在正面下面。 */
function boxMesh([w, h, d]: readonly [number, number, number]): ProductMesh {
  const W = 2 * w + 2 * d, H = h + 2 * d;
  const builder = new MeshBuilder();
  // 一个面：四个角（逆时针看着它），贴图上的矩形（左、上、宽、高，米）
  const face = (corners: readonly (readonly number[])[], normal: readonly number[], [x, y, fw, fh]: readonly [number, number, number, number]) => {
    const uv = [[x, y + fh], [x + fw, y + fh], [x + fw, y], [x, y]];
    const ids = corners.map((corner, i) => builder.vertex(corner, normal, uv[i]![0]! / W, uv[i]![1]! / H));
    builder.quad(ids[0]!, ids[1]!, ids[2]!, ids[3]!, normal);
  };
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  // 每个面的四个角：左下、右下、右上、左上（从外面看）
  face([[x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]], [0, 0, 1], [d, d, w, h]);
  face([[x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]], [1, 0, 0], [d + w, d, d, h]);
  face([[x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]], [0, 0, -1], [2 * d + w, d, w, h]);
  face([[x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]], [-1, 0, 0], [0, d, d, h]);
  face([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], [d, 0, w, d]);
  face([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], [0, -1, 0], [d, d + h, w, d]);
  return finish(builder, [W * 1000, H * 1000]);
}

/** 枕形的袋：正反两面按格子鼓起来（中间最厚 d/2），四边是压平的封口；上下各留一条锯齿封口的平边。贴图左半正面、右半背面。 */
function pouchMesh([w, h, d]: readonly [number, number, number]): ProductMesh {
  const columns = 10, rows = 14, seal = Math.min(0.08 * h, 0.012);
  const builder = new MeshBuilder();
  for (const side of [1, -1] as const) {
    const at = (i: number, j: number) => {
      const fx = i / columns, fy = j / rows, y = fy * h;
      // 封口的平边上不鼓；中间按正弦鼓起
      const inside = Math.max(0, Math.min(1, (y - seal) / (h - 2 * seal)));
      const bulge = (d / 2) * Math.sqrt(Math.sin(Math.PI * fx) * Math.sin(Math.PI * inside));
      return [(fx - 0.5) * w * side, y, bulge * side];
    };
    const ids: number[][] = [];
    for (let j = 0; j <= rows; j++) {
      ids.push([]);
      for (let i = 0; i <= columns; i++) {
        const p = at(i, j);
        // 法线用相邻点的差（格子够密）
        const dx = sub(at(Math.min(i + 1, columns), j), at(Math.max(i - 1, 0), j)), dy = sub(at(i, Math.min(j + 1, rows)), at(i, Math.max(j - 1, 0)));
        // 背面的 x 是反着走的（从背面看同样从左到右）：叉积自然朝 -Z
        ids[j]!.push(builder.vertex(p, normalize(cross(dx, dy)), (side > 0 ? 0 : 0.5) + (i / columns) * 0.5, 1 - j / rows));
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) builder.quad(ids[j]![i]!, ids[j]![i + 1]!, ids[j + 1]![i + 1]!, ids[j + 1]![i]!, [0, 0, side]);
    }
  }
  return finish(builder, [2 * w * 1000, h * 1000]);
}

/** 按面重算法线：位置相同的顶点（贴图接缝、轮廓的段与段之间各有一份）一起取相邻三角形法线的面积加权平均。 */
/** 标签上画字的地方（毫米，SVG 的坐标：y 往下）：中心、可用的宽高。 */
interface TextArea {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  /** 背面那块小一点。 */
  readonly scale?: number;
}

/**
 * 标签的 SVG（毫米做单位，宽高同 productMesh 的 labelSize）：底色、图案、盖子那几段的颜色，正面画品牌名和品类，背面小一号；
 * font 没有时不画字。
 */
export function productLabelSvg(file: ProductFile, labelSize: readonly [number, number], font: TextFont | undefined, variant = 0): string {
  const [W, H] = labelSize;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNumber(W)} ${svgNumber(H)}" width="${svgNumber(W)}" height="${svgNumber(H)}">${productLabelShapes(file, labelSize, font, variant)}</svg>`;
}

/** 标签里的图形（不带外面的 svg 标签，坐标同 productLabelSvg）：货架把它们嵌进图集的一格。 */
export function productLabelShapes(file: ProductFile, labelSize: readonly [number, number], font: TextFont | undefined, variant = 0): string {
  const design = productDesign(file, variant);
  const [W, H] = labelSize;
  const background = `<rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="${design.colors.background}"/>`;
  if (isWare(file.shape)) return wareSkin(file, labelSize, design.colors.background, design.colors.accent, design.pattern === 'floral', variant);
  const wear = isProduce(file.shape) ? 0 : Math.min(1, Math.max(0, file.wear ?? 0.5));
  return background + labelPrint(file, design, labelSize, font, variant) + (wear > 0 ? labelWear(labelSize, wear, seededRandom(hash32(hash32(file.seed ?? 1, variant), 131))) : '');
}

/**
 * 包装旧了的样子（只画在颜色上）：整张褪一点色（一层很淡的白）、几块手印似的灰（深一点的椭圆斑，边上糊开）、上下边上几道擦痕
 * （细的浅色短线）。amount 是 ProductFile.wear。
 */
function labelWear([W, H]: readonly [number, number], amount: number, random: () => number): string {
  const shapes = [`<rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="#ffffff" opacity="${svgNumber(amount * (0.02 + random() * 0.05))}"/>`];
  const smudges = Math.round(amount * (1 + random() * 4));
  for (let i = 0; i < smudges; i++) {
    const cx = random() * W, cy = random() * H, r = Math.min(W, H) * (0.04 + random() * 0.08);
    shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber(cy)}" rx="${svgNumber(r * 1.3)}" ry="${svgNumber(r)}" fill="#4a4036" opacity="${svgNumber(amount * (0.05 + random() * 0.08))}"/>`);
  }
  const scuffs = Math.round(amount * (2 + random() * 6));
  for (let i = 0; i < scuffs; i++) {
    const x = random() * W, y = random() < 0.5 ? random() * H * 0.15 : H * (0.85 + random() * 0.15), length = W * (0.01 + random() * 0.04);
    shapes.push(`<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(length)}" height="${svgNumber(0.3 + random() * 0.4)}" fill="#ffffff" opacity="${svgNumber(amount * (0.25 + random() * 0.3))}" transform="rotate(${Math.round((random() - 0.5) * 30)} ${svgNumber(x)} ${svgNumber(y)})"/>`);
  }
  return `<g>${shapes.join('')}</g>`;
}

/** 瓶身透多少光（ProductFile.transmission，限在 0..1）：只有包装算，果蔬、器皿是 0。 */
export function productTransmission(file: ProductFile): number {
  return isProduce(file.shape) || isWare(file.shape) ? 0 : Math.min(1, Math.max(0, file.transmission ?? 0));
}

/**
 * 表面贴图里这个商品的那一格（坐标同 productLabelSvg；R 透射、G 粗糙度、B 金属度）：color 是底色那片（瓶身）的颜色，R 是透射的
 * 比例；print 盖在上面，是印上去的图形（盖子、图案、字）用一个滤镜涂成 R 为 0 的同一个颜色——按它们的轮廓不透光（半透明的印刷
 * 按它的不透明度少透一些）；不透光的商品没有 print。defs 是滤镜（同样材料的商品共用一个，放进 svg 的 defs）。
 */
export function productSurface(file: ProductFile, labelSize: readonly [number, number], font: TextFont | undefined, variant = 0): { readonly color: string; readonly print: string; readonly defs: string } {
  const design = productDesign(file, variant);
  const { roughness, metalness } = SURFACE_MATERIAL[design.surface];
  const g = Math.round(roughness * 255), b = Math.round(metalness * 255), transmission = productTransmission(file);
  if (transmission === 0) return { color: `rgb(0,${g},${b})`, print: '', defs: '' };
  const id = `print-${g}-${b}`;
  return {
    color: `rgb(${Math.round(transmission * 255)},${g},${b})`,
    print: `<g filter="url(#${id})">${labelPrint(file, design, labelSize, font, variant)}</g>`,
    defs: `<filter id="${id}" color-interpolation-filters="sRGB"><feFlood flood-color="rgb(0,${g},${b})"/><feComposite in2="SourceAlpha" operator="in"/></filter>`,
  };
}

/** 整张表面贴图（透光的包装单独烘时，材质的 `<texture>.surface`）。 */
export function productSurfaceSvg(file: ProductFile, labelSize: readonly [number, number], font: TextFont | undefined, variant = 0): string {
  const [W, H] = labelSize, { color, print, defs } = productSurface(file, labelSize, font, variant);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgNumber(W)} ${svgNumber(H)}" width="${svgNumber(W)}" height="${svgNumber(H)}"><defs>${defs}</defs><rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="${color}"/>${print}</svg>`;
}

/** 标签上底色以外的图形：果蔬的表皮纹路；包装的盖子、底纹、字。 */
function labelPrint(file: ProductFile, design: ProductDesign, labelSize: readonly [number, number], font: TextFont | undefined, variant: number): string {
  const [W, H] = labelSize;
  const [w, h, d] = file.size.map((v) => v * 1000) as [number, number, number];
  const parts: string[] = [];
  if (isProduce(file.shape)) return produceSkin(file, design, labelSize, variant);
  // 图案画在哪：旋转体是盖子以下的整圈，纸盒是中间那一排，袋是整张
  let body: readonly [number, number, number, number] = [0, 0, W, H];
  let areas: TextArea[];
  if (file.shape === 'box') {
    body = [0, d, W, h];
    areas = [{ cx: d + w / 2, cy: d + h / 2, width: w * 0.86, height: h * 0.8 }, { cx: 2 * d + 1.5 * w, cy: d + h / 2, width: w * 0.8, height: h * 0.6, scale: 0.6 }];
  } else if (file.shape === 'pouch') {
    areas = [{ cx: W / 4, cy: H * 0.46, width: W / 2 * 0.84, height: H * 0.7 }, { cx: W * 0.75, cy: H * 0.46, width: W / 2 * 0.8, height: H * 0.5, scale: 0.6 }];
  } else {
    // 旋转体：轮廓线上盖子那几段从 v = 0 往下（贴图的上面），先算出盖子占多长
    const profile = latheProfile(file.shape, file.size[0] / 2, file.size[1]);
    const capLength = capLengthOf(profile) * 1000;
    if (capLength > 0) parts.push(`<rect width="${svgNumber(W)}" height="${svgNumber(capLength)}" fill="${design.colors.cap}"/>`);
    // 不透光的玻璃罐：标签以外露出来的是隔着玻璃看见的里面的酱（底色当它的颜色）；玻璃瓶里是酱油、醋这种匀的，不画
    if (design.surface === 'glass' && productTransmission(file) === 0 && file.shape === 'jar') {
      parts.push(contentsShapes(design.colors.background, [0, capLength, W, H - capLength], seededRandom(hash32(hash32(file.seed ?? 1, variant), 97))));
    }
    // 瓶的肩、颈不放字：字放在瓶身的直段（离底 3% 到 60% 高）
    const straight = file.shape === 'bottle' ? [0.03, 0.6] : file.shape === 'jug' ? [0.05, 0.66] : file.shape === 'can' ? [0.08, 0.9] : file.shape === 'jar' ? [0.06, 0.76] : [0.1, 0.84];
    const bottom = H - (straight[0]! * h + file.size[0] * 1000 * 0.46), top = H - (straight[1]! * h + file.size[0] * 1000 * 0.46);
    body = [0, capLength, W, H - capLength];
    // 正面在 u = 0.5（周长的一半处）；看得见的大约是周长的三分之一
    areas = [{ cx: W / 2, cy: (top + bottom) / 2, width: W * 0.26, height: (bottom - top) * 0.8 }, { cx: 0, cy: (top + bottom) / 2, width: W * 0.24, height: (bottom - top) * 0.5, scale: 0.6 }, { cx: W, cy: (top + bottom) / 2, width: W * 0.24, height: (bottom - top) * 0.5, scale: 0.6 }];
  }
  parts.push(...patternShapes(design, body));
  if (font) for (const area of areas) parts.push(...textBlock(design, font, area));
  if (design.detail) parts.push(...labelDetails(design, font, areas[0]!, seededRandom(hash32(hash32(file.seed ?? 1, variant), 91))));
  return parts.join('');
}

/**
 * 果蔬的表皮：洋葱、蒜头是顺着从顶到底的细纹（贴图的竖线）加顶上一截颈的颜色，核桃、土豆是深浅的斑，圆的（番茄、橙子）
 * 是顶上一小圈深色（蒂）。按种子和变体摆。
 */
function produceSkin(file: ProductFile, design: ProductDesign, [W, H]: readonly [number, number], variant: number): string {
  const random = seededRandom(hash32(hash32(file.seed ?? 1, variant), 77));
  const shapes: string[] = [];
  const { accent, cap } = design.colors;
  if (file.shape === 'leaf') {
    // 中脉在 u = 0.5，侧脉斜着往叶尖去；几块深一点的斑、叶缘一圈焦边
    shapes.push(`<path d="M${svgNumber(W / 2)} 0L${svgNumber(W / 2)} ${svgNumber(H)}" stroke="${accent}" stroke-width="${svgNumber(W * 0.025)}"/>`);
    for (let k = 1; k < 8; k++) {
      const y = (H * k) / 8;
      for (const side of [-1, 1]) shapes.push(`<path d="M${svgNumber(W / 2)} ${svgNumber(y)}L${svgNumber(W / 2 + side * W * 0.42)} ${svgNumber(y + H * 0.1)}" stroke="${accent}" stroke-width="${svgNumber(W * 0.012)}" opacity="0.7"/>`);
    }
    for (let i = 0; i < 10; i++) {
      shapes.push(`<circle cx="${svgNumber(random() * W)}" cy="${svgNumber(random() * H)}" r="${svgNumber((0.02 + random() * 0.06) * W)}" fill="${cap}" opacity="${svgNumber(0.3 + random() * 0.4)}"/>`);
    }
    shapes.push(`<ellipse cx="${svgNumber(W / 2)}" cy="${svgNumber(H / 2)}" rx="${svgNumber(W * 0.46)}" ry="${svgNumber(H * 0.47)}" fill="none" stroke="${cap}" stroke-width="${svgNumber(W * 0.05)}" opacity="0.6"/>`);
  } else if (file.shape === 'onion' || file.shape === 'garlic') {
    for (let i = 0; i < 28; i++) {
      const x = random() * W, width = 0.3 + random() * 1.2;
      shapes.push(`<rect x="${svgNumber(x)}" y="0" width="${svgNumber(width)}" height="${svgNumber(H)}" fill="${accent}" opacity="${svgNumber(0.25 + random() * 0.5)}"/>`);
    }
    shapes.push(`<rect width="${svgNumber(W)}" height="${svgNumber(H * 0.1)}" fill="${cap}"/>`);
  } else if (file.shape === 'nut' || file.shape === 'tuber') {
    for (let i = 0; i < 60; i++) {
      shapes.push(`<circle cx="${svgNumber(random() * W)}" cy="${svgNumber(random() * H)}" r="${svgNumber(0.4 + random() * 2)}" fill="${accent}" opacity="${svgNumber(0.2 + random() * 0.4)}"/>`);
    }
  } else {
    shapes.push(`<rect width="${svgNumber(W)}" height="${svgNumber(H * 0.05)}" fill="${cap}"/>`);
    shapes.push(`<rect y="${svgNumber(H * 0.05)}" width="${svgNumber(W)}" height="${svgNumber(H * 0.25)}" fill="${accent}" opacity="0.35"/>`);
  }
  return `<g>${shapes.join('')}</g>`;
}

/**
 * 隔着玻璃看见的里面的东西（玻璃罐里的辣椒酱、豆瓣、腐乳）：color 是它的颜色，画在 [x, y, w, h] 那块里——最上面一层浮着的
 * 红油（亮一些、偏红），下面是酱，撒满辣椒碎（亮红）、芝麻（米黄）、豆瓣和深色的渣；标签的图案再盖在上面。
 */
function contentsShapes(color: string, [x, y, w, h]: readonly [number, number, number, number], random: () => number): string {
  const shapes = [`<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(w)}" height="${svgNumber(h * 0.12)}" fill="${shadeColor(color, 1.6)}" opacity="0.7"/>`];
  // 辣椒碎是两三毫米的片：货架合并的图集每毫米只有几个像素，再小就糊成一片底色
  const count = Math.min(500, Math.round((w * h) / 40));
  for (let i = 0; i < count; i++) {
    const pick = random(), cx = x + random() * w, cy = y + h * 0.1 + random() * h * 0.9, r = 0.8 + random() * 1.2;
    const fill = pick < 0.5 ? shadeColor(color, 2.4 + random() * 0.8) : pick < 0.65 ? '#e6d7a8' : pick < 0.85 ? shadeColor(color, 0.45) : shadeColor(color, 1.6);
    shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber(cy)}" rx="${svgNumber(r * 1.5)}" ry="${svgNumber(r)}" transform="rotate(${Math.round(random() * 180)} ${svgNumber(cx)} ${svgNumber(cy)})" fill="${fill}" opacity="${svgNumber(0.75 + random() * 0.25)}"/>`);
  }
  return `<g>${shapes.join('')}</g>`;
}

/** 底纹（画在 body 那块里）。 */
function patternShapes(design: ProductDesign, [x, y, w, h]: readonly [number, number, number, number]): string[] {
  const accent = design.colors.accent;
  switch (design.pattern) {
    // 青花画在器皿的贴图上（ware.ts），包装的标签不用
    case 'plain':
    case 'floral':
      return [];
    case 'band':
      return [`<rect x="${svgNumber(x)}" y="${svgNumber(y + h * 0.3)}" width="${svgNumber(w)}" height="${svgNumber(h * 0.36)}" fill="${accent}"/>`, ...bandFinish(design, x, w, y + h * 0.3, h * 0.36)];
    case 'split':
      return [`<rect x="${svgNumber(x)}" y="${svgNumber(y + h * 0.62)}" width="${svgNumber(w)}" height="${svgNumber(h * 0.38)}" fill="${accent}"/>`, ...bandFinish(design, x, w, y + h * 0.62, h * 0.38)];
    case 'stripes': {
      const step = Math.max(h, 1) / 6, shapes: string[] = [];
      for (let k = -6; k * step < w + h; k++) shapes.push(`<path d="M${svgNumber(x + k * step)} ${svgNumber(y + h)}L${svgNumber(x + k * step + step * 0.45)} ${svgNumber(y + h)}L${svgNumber(x + k * step + step * 0.45 + h)} ${svgNumber(y)}L${svgNumber(x + k * step + h)} ${svgNumber(y)}Z" fill="${accent}" opacity="0.55"/>`);
      return [`<g>${shapes.join('')}</g>`];
    }
    case 'wave': {
      const top = y + h * 0.58, amplitude = h * 0.06, waves = Math.max(2, Math.round(w / Math.max(h, 1) * 2));
      let path = `M${svgNumber(x)} ${svgNumber(y + h)}L${svgNumber(x)} ${svgNumber(top)}`;
      for (let k = 0; k < waves; k++) {
        const x0 = x + (k / waves) * w, x1 = x + ((k + 1) / waves) * w;
        path += `Q${svgNumber((x0 + x1) / 2)} ${svgNumber(top + (k % 2 ? amplitude : -amplitude) * 2)} ${svgNumber(x1)} ${svgNumber(top)}`;
      }
      return [`<path d="${path}L${svgNumber(x + w)} ${svgNumber(y + h)}Z" fill="${accent}"/>`];
    }
    case 'dots': {
      const step = Math.max(h, 1) / 7, radius = step * 0.18, shapes: string[] = [];
      for (let row = 0; (row + 0.5) * step < h; row++) {
        for (let col = 0; (col + 0.5) * step < w; col++) shapes.push(`<circle cx="${svgNumber(x + (col + 0.5 + (row % 2) * 0.5) * step)}" cy="${svgNumber(y + (row + 0.5) * step)}" r="${svgNumber(radius)}"/>`);
      }
      return [`<g fill="${accent}" opacity="0.7">${shapes.join('')}</g>`];
    }
  }
}

/** 一块字：品牌名（大）和品类（小，在一个圆角的底上）。字的颜色：文件写了就用，没写的按底色挑黑或白。 */
function textBlock(design: ProductDesign, font: TextFont, area: TextArea): string[] {
  const scale = area.scale ?? 1;
  const under = inkUnder(design), ink = inkOn(design);
  const shapes: string[] = [];
  const brandHeight = area.height * (design.text ? 0.5 : 0.7) * scale;
  // 正面印了配料的小图时，品牌名收窄给两边让位
  const brandWidth = area.width * scale * (hasMotifs(design, area) ? 0.62 : 1);
  const brand = textPath(font, design.brand, area.cx, area.cy - (design.text ? area.height * 0.12 * scale : 0), brandWidth, brandHeight, ink);
  if (brand) shapes.push(brand);
  if (design.text) {
    const pillWidth = area.width * 0.7 * scale, pillHeight = area.height * 0.24 * scale, cy = area.cy + area.height * 0.26 * scale;
    shapes.push(`<rect x="${svgNumber(area.cx - pillWidth / 2)}" y="${svgNumber(cy - pillHeight / 2)}" width="${svgNumber(pillWidth)}" height="${svgNumber(pillHeight)}" rx="${svgNumber(pillHeight / 2)}" fill="${ink}"/>`);
    const text = textPath(font, design.text, area.cx, cy, pillWidth * 0.84, pillHeight * 0.7, ink === '#ffffff' ? under : '#ffffff');
    if (text) shapes.push(text);
  }
  return shapes;
}

/** 字压在哪个颜色上（横带的字压在色带上）。 */
function inkUnder(design: ProductDesign): string {
  return design.pattern === 'band' ? design.colors.accent : design.colors.background;
}

/** 字的颜色：文件写了就用，没写的按压着的颜色挑黑或白。 */
function inkOn(design: ProductDesign): string {
  return design.colors.text || (luminance(inkUnder(design)) > 0.45 ? '#1d1d1f' : '#ffffff');
}

/** 这块字的两边画不画配料的小图（只画在正面那块）。 */
function hasMotifs(design: ProductDesign, area: TextArea): boolean {
  return design.detail && design.motif !== 'none' && (area.scale ?? 1) === 1;
}

/** 色带的镶边和明暗（印得细时）：上下两道镶边色的细线，色带上沿一道亮、下半截暗一点，像印出来的渐变。 */
function bandFinish(design: ProductDesign, x: number, w: number, top: number, height: number): string[] {
  if (!design.detail) return [];
  const rect = (y: number, h: number, fill: string, opacity = 1) => `<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(w)}" height="${svgNumber(h)}" fill="${fill}"${opacity < 1 ? ` opacity="${svgNumber(opacity)}"` : ''}/>`;
  const line = Math.max(0.4, height * 0.035);
  return [
    rect(top + height * 0.06, height * 0.16, '#ffffff', 0.14),
    rect(top + height * 0.6, height * 0.4, '#000000', 0.12),
    rect(top - line / 2, line, design.colors.trim),
    rect(top + height - line / 2, line, design.colors.trim),
  ];
}

/**
 * 印得细的标签在正面那块字的周围加的：顶上一枚徽标（镶边色的圆章、品牌的头一个字），品牌名两边配料的小图（白圆底），药丸下面
 * 几行看不清的细字（灰的短横），右下的角标（星形，"5L"）。没有字体时徽标和角标不写字。
 */
function labelDetails(design: ProductDesign, font: TextFont | undefined, area: TextArea, random: () => number): string[] {
  const { cx, cy, width, height } = area;
  const trim = design.colors.trim, under = inkUnder(design), ink = inkOn(design);
  const out: string[] = [];
  const circle = (x: number, y: number, r: number, fill: string, extra = '') => `<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${svgNumber(r)}" fill="${fill}"${extra}/>`;
  // 徽标：骑在这块的上沿
  const r = Math.min(width * 0.12, height * 0.16), ey = cy - height * 0.5 + r * 0.3;
  out.push(circle(cx, ey, r, trim), circle(cx, ey, r * 0.84, under), circle(cx, ey, r * 0.7, 'none', ` stroke="${trim}" stroke-width="${svgNumber(r * 0.06)}"`));
  const initial = Array.from(design.brand)[0];
  if (font && initial) {
    const glyph = textPath(font, initial, cx, ey, r * 0.95, r * 0.95, trim);
    if (glyph) out.push(glyph);
  }
  // 配料的小图：品牌名两边
  if (hasMotifs(design, area)) {
    const size = Math.min(width * 0.22, height * 0.36), my = cy - (design.text ? height * 0.12 : 0);
    for (const side of [-1, 1]) {
      const mx = cx + side * width * 0.4;
      out.push(circle(mx, my, size * 0.62, '#ffffff', ` stroke="${trim}" stroke-width="${svgNumber(size * 0.05)}"`), motifShapes(design.motif, mx, my, size));
    }
  }
  // 细字：几行长短不一的短横
  const rowHeight = height * 0.022;
  for (let row = 0; row < 3; row++) {
    const y = cy + height * (0.43 + row * 0.04), left = cx - width * 0.26, right = cx + width * 0.26;
    let words = '';
    for (let x = left + random() * width * 0.02; x < right;) {
      const w = Math.min(right - x, width * (0.015 + random() * 0.05));
      words += `M${svgNumber(x)} ${svgNumber(y)}h${svgNumber(w)}v${svgNumber(rowHeight)}h${svgNumber(-w)}Z`;
      x += w + width * 0.012;
    }
    out.push(`<path d="${words}" fill="${ink}" opacity="0.5"/>`);
  }
  // 角标：右下的星形
  if (design.badge) {
    const br = Math.min(width * 0.13, height * 0.17), bx = cx + width * 0.4, by = cy + height * 0.36;
    const points = Array.from({ length: 28 }, (_, k) => {
      const angle = (k / 28) * 2 * Math.PI, radius = k % 2 ? br * 0.84 : br;
      return `${svgNumber(bx + Math.cos(angle) * radius)} ${svgNumber(by + Math.sin(angle) * radius)}`;
    });
    out.push(`<path d="M${points.join('L')}Z" fill="#f6c40f" stroke="#d7262b" stroke-width="${svgNumber(br * 0.04)}"/>`);
    const text = font ? textPath(font, design.badge, bx, by, br * 1.3, br * 0.8, '#d7262b') : undefined;
    if (text) out.push(text);
  }
  return out;
}

/** 配料的小图（矢量，画在中心 (x, y)、大小 size 的方块里）。 */
function motifShapes(motif: ProductMotif, x: number, y: number, size: number): string {
  const s = size / 2, n = svgNumber;
  // rotate 是绕 pivot（默认椭圆自己的中心）转的角度
  const ellipse = (ex: number, ey: number, rx: number, ry: number, fill: string, rotate = 0, extra = '', pivot = [ex, ey]) =>
    `<ellipse cx="${n(ex)}" cy="${n(ey)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}"${rotate ? ` transform="rotate(${n(rotate)} ${n(pivot[0]!)} ${n(pivot[1]!)})"` : ''}${extra}/>`;
  switch (motif) {
    case 'none':
      return '';
    case 'leaf':
      return `<path d="M${n(x)} ${n(y - s * 0.85)}Q${n(x + s * 0.8)} ${n(y)} ${n(x)} ${n(y + s * 0.85)}Q${n(x - s * 0.8)} ${n(y)} ${n(x)} ${n(y - s * 0.85)}Z" fill="#3d9a3a"/>`
        + `<path d="M${n(x)} ${n(y - s * 0.7)}L${n(x)} ${n(y + s * 0.85)}" stroke="#a8d88a" stroke-width="${n(s * 0.06)}"/>`;
    case 'drop':
      return `<path d="M${n(x)} ${n(y - s * 0.85)}C${n(x + s * 0.2)} ${n(y - s * 0.4)} ${n(x + s * 0.6)} ${n(y)} ${n(x + s * 0.6)} ${n(y + s * 0.3)}A${n(s * 0.6)} ${n(s * 0.6)} 0 0 1 ${n(x - s * 0.6)} ${n(y + s * 0.3)}C${n(x - s * 0.6)} ${n(y)} ${n(x - s * 0.2)} ${n(y - s * 0.4)} ${n(x)} ${n(y - s * 0.85)}Z" fill="#f2b400"/>`
        + ellipse(x - s * 0.22, y + s * 0.15, s * 0.1, s * 0.2, '#ffffff', 20, ' opacity="0.7"');
    case 'peanut':
      return ellipse(x, y - s * 0.32, s * 0.38, s * 0.42, '#c9955a') + ellipse(x, y + s * 0.34, s * 0.42, s * 0.44, '#c9955a') + ellipse(x, y + s * 0.02, s * 0.3, s * 0.2, '#c9955a')
        + Array.from({ length: 6 }, (_, k) => `<circle cx="${n(x + (k % 2 ? 0.15 : -0.15) * s)}" cy="${n(y + (-0.5 + k * 0.2) * s)}" r="${n(s * 0.045)}" fill="#8a5a2a"/>`).join('');
    case 'corn': {
      let kernels = '';
      for (let row = 0; row < 6; row++) for (let col = -1; col <= 1; col++) kernels += `<circle cx="${n(x + col * s * 0.16)}" cy="${n(y + (-0.55 + row * 0.2) * s)}" r="${n(s * 0.075)}" fill="#e0a800"/>`;
      return ellipse(x, y - s * 0.05, s * 0.32, s * 0.75, '#f6d030') + kernels
        + `<path d="M${n(x)} ${n(y + s * 0.85)}Q${n(x - s * 0.7)} ${n(y + s * 0.2)} ${n(x - s * 0.45)} ${n(y - s * 0.6)}Q${n(x - s * 0.3)} ${n(y + s * 0.2)} ${n(x)} ${n(y + s * 0.85)}Z" fill="#4c9a2a"/>`
        + `<path d="M${n(x)} ${n(y + s * 0.85)}Q${n(x + s * 0.7)} ${n(y + s * 0.2)} ${n(x + s * 0.45)} ${n(y - s * 0.6)}Q${n(x + s * 0.3)} ${n(y + s * 0.2)} ${n(x)} ${n(y + s * 0.85)}Z" fill="#5aae34"/>`;
    }
    case 'sunflower':
      return Array.from({ length: 12 }, (_, k) => ellipse(x, y - s * 0.55, s * 0.16, s * 0.34, '#f6c40f', k * 30, '', [x, y])).join('')
        + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(s * 0.36)}" fill="#6a3e1a"/>`;
    case 'wheat': {
      let grains = `<path d="M${n(x)} ${n(y + s * 0.9)}L${n(x)} ${n(y - s * 0.8)}" stroke="#b8862e" stroke-width="${n(s * 0.07)}"/>`;
      for (let k = 0; k < 5; k++) {
        const gy = y - s * 0.65 + k * s * 0.28;
        grains += ellipse(x - s * 0.16, gy, s * 0.11, s * 0.2, '#d9a440', -30) + ellipse(x + s * 0.16, gy, s * 0.11, s * 0.2, '#d9a440', 30);
      }
      return grains + ellipse(x, y - s * 0.85, s * 0.1, s * 0.18, '#d9a440');
    }
    case 'sesame':
      return Array.from({ length: 9 }, (_, k) => ellipse(x + ((k % 3) - 1) * s * 0.36, y + (Math.floor(k / 3) - 1) * s * 0.42, s * 0.1, s * 0.18, k % 2 ? '#2a2420' : '#c9a86a', (k * 37) % 60 - 30)).join('');
  }
}

/** 一行字的路径（导出给货架的价签用）：按字体排版、缩放到放进 width × height、居中在 (cx, cy)；一个轮廓都没有时是 undefined。 */
export function textPath(font: TextFont, text: string, cx: number, cy: number, width: number, height: number, color: string): string | undefined {
  const contours = textContours(font, text, { size: 1 });
  if (contours.length === 0) return undefined;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { points } of contours) {
    for (const [x, y] of points) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const size = Math.min(width / Math.max(maxX - minX, 1e-6), height / Math.max(maxY - minY, 1e-6));
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  // 文字的 y 往上，SVG 的往下
  const d = contours.map(({ points }) => `M${points.map(([x, y]) => `${svgNumber(cx + (x - ox) * size)} ${svgNumber(cy - (y - oy) * size)}`).join('L')}Z`).join('');
  return `<path d="${d}" fill="${color}" fill-rule="evenodd"/>`;
}

/** 栅格化的尺寸（像素）：长边 longest，另一边按比例，都补到 4 的倍数。 */
export function labelPixels(labelSize: readonly [number, number], longest = 512): [number, number] {
  const scale = longest / Math.max(labelSize[0], labelSize[1]);
  return [Math.max(4, Math.round((labelSize[0] * scale) / 4) * 4), Math.max(4, Math.round((labelSize[1] * scale) / 4) * 4)];
}

/**
 * 包装的材质：标签贴图（path 是贴图的内容路径，svg）加这类材料的粗糙度、金属度。瓶身透光（productTransmission 大于 0）时改用
 * 表面贴图 `<texture>.surface`（productSurfaceShapes：R 透射、G 粗糙度、B 金属度），加上透射。
 */
export function productMaterial(file: ProductFile, texture: string, pixels: readonly [number, number], variant = 0): MaterialFile {
  const { surface } = productDesign(file, variant);
  const slot = { encoding: 'svg', size: pixels, filter: 'anisotropic', scale: [1, 1], offset: [0, 0] } as const;
  const base = { name: file.name, baseColor: [1, 1, 1, 1], baseColorTexture: { texture, srgb: true, ...slot } } as const;
  if (productTransmission(file) === 0) return { ...base, ...SURFACE_MATERIAL[surface] };
  return {
    ...base,
    metalness: 1,
    glossinessTexture: { texture: `${texture}.surface`, srgb: false, channel: 'g', invert: true, metalnessChannel: 'b', transmissionChannel: 'r', ...slot },
    transmission: PACKAGE_TRANSMISSION,
  };
}

/**
 * 透光的瓶身：比例 1（乘表面贴图的 R）、塑料的折射率，按实心的算（里面装满了油、饮料）——厚度是瓶身的一部分，背景折得不多。
 * 颜色是标签的底色（透射乘基础色），不另加吸收。
 */
export const PACKAGE_TRANSMISSION = { factor: 1, ior: 1.45, thickness: 0.02 } as const;

function luminance(hex: string): number {
  const v = parseInt(hex.slice(1, 7), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((v >> 16) & 255) + 0.7152 * channel((v >> 8) & 255) + 0.0722 * channel(v & 255);
}

/** 颜色在附近随机变一点（亮度整体变 ±amount，每个通道再各自变一半）：同一种果蔬一筐里有深有浅。 */
function jitter(hex: string, random: () => number, amount: number): string {
  const v = parseInt(hex.slice(1, 7), 16), bright = 1 + (random() - 0.5) * 2 * amount;
  const channel = (c: number) => Math.max(0, Math.min(255, Math.round(c * bright * (1 + (random() - 0.5) * amount)))).toString(16).padStart(2, '0');
  return `#${channel((v >> 16) & 255)}${channel((v >> 8) & 255)}${channel(v & 255)}`;
}

/** 两个颜色的对比度（WCAG 的算法，1 到 21）。 */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
