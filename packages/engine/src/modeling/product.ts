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
import type { ProductColors, ProductFile, ProductPattern, ProductShape, ProductSurface } from '../content/formats/productFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { textContours, type TextFont } from './textOutline.ts';

/** 定下来的设计：文件里没写的按种子挑好了。 */
export interface ProductDesign {
  readonly brand: string;
  readonly text: string | undefined;
  readonly colors: Required<ProductColors>;
  readonly pattern: ProductPattern;
  readonly surface: ProductSurface;
}

/** 生成的网格（一个材质槽）和标签展开的大小（毫米：贴图的 viewBox，u、v 是它的比例）。 */
export interface ProductMesh {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly labelSize: readonly [number, number];
}

/** 包装上常见的颜色（sRGB）：底色和强调色从这里挑。 */
const PALETTE = ['#d7262b', '#f6c40f', '#2f9e44', '#1e64c8', '#f4f2ec', '#1d1d1f', '#f08c00', '#f7a8c4', '#7048a8', '#1aa39a', '#7a4a2a', '#efe3c4', '#e8e8e8', '#0b7a3e'];
const PATTERNS: readonly ProductPattern[] = ['plain', 'band', 'stripes', 'split', 'wave', 'dots'];
/** 拼品牌名的字（常见的商标用字）。 */
const BRAND_CHARACTERS = '金龙鱼海天康乐福味美好鲜香农家旺佳丰园源山泉清真御品优百万华宝和顺禾田欢喜悦大小星光润洁雪绿新鸿盛';
const DEFAULT_SURFACE: Readonly<Record<ProductShape, ProductSurface>> = { box: 'paper', bottle: 'plastic', can: 'metal', jar: 'glass', tub: 'plastic', pouch: 'plastic' };
/** 各种材料的粗糙度和金属度（货架的图集按它画表面贴图）。 */
export const SURFACE_MATERIAL: Readonly<Record<ProductSurface, { readonly roughness: number; readonly metalness: number }>> = {
  paper: { roughness: 0.72, metalness: 0 }, plastic: { roughness: 0.32, metalness: 0 }, metal: { roughness: 0.3, metalness: 0.6 }, glass: { roughness: 0.08, metalness: 0 },
};
/** 旋转体绕一圈默认分几段（货架后排的商品给少一点）。 */
const RADIAL_SEGMENTS = 20;
/** 轮廓线上相邻两段的夹角超过这么多（弧度）就是硬边：顶点各用各的法线。 */
const CREASE = 0.5;

/** 文件里没写的按种子（加上第几个变体）挑好。变体只改文件里没写的：写了品牌、配色的文件每个变体都一样。 */
export function productDesign(file: ProductFile, variant = 0): ProductDesign {
  const random = seededRandom(hash32(file.seed ?? 1, variant));
  const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
  const background = file.colors?.background ?? pick(PALETTE);
  let accent = file.colors?.accent ?? pick(PALETTE);
  for (let tries = 0; !file.colors?.accent && contrast(accent, background) < 1.6 && tries < 8; tries++) accent = pick(PALETTE);
  const length = 2 + Math.floor(random() * 2);
  const brand = file.brand ?? Array.from({ length }, () => pick([...BRAND_CHARACTERS])).join('');
  return {
    brand,
    text: file.text,
    colors: { background, accent, text: file.colors?.text ?? '', cap: file.colors?.cap ?? pick(['#f4f2ec', '#d7262b', '#1e64c8', '#2f9e44', '#f6c40f', '#1d1d1f', accent]) },
    pattern: file.pattern ?? pick(PATTERNS),
    surface: file.surface ?? DEFAULT_SURFACE[file.shape],
  };
}

/** 检查尺寸；不对时报错（where 是报错的前缀）。 */
function checkSize(file: ProductFile, where: string): void {
  const [w, h, d] = file.size;
  if (!(w > 0 && h > 0)) throw new Error(`${where}: size needs a width and a height greater than 0`);
  if ((file.shape === 'box' || file.shape === 'pouch') && !(d > 0)) throw new Error(`${where}: a ${file.shape} needs a depth greater than 0`);
}

/** 外形的网格；segments 是旋转体绕一圈分几段（默认 20，看不清的地方给少一点）。 */
export function productMesh(file: ProductFile, where = file.name, segments = RADIAL_SEGMENTS): ProductMesh {
  checkSize(file, where);
  if (file.shape === 'box') return boxMesh(file.size);
  if (file.shape === 'pouch') return pouchMesh(file.size);
  return latheMesh(latheProfile(file.shape, file.size[0] / 2, file.size[1]), Math.max(3, Math.round(segments)));
}

/** 摆在货架上占的地方（米）：宽、高、深（瓶罐的深是直径）。 */
export function productFootprint(file: ProductFile): readonly [number, number, number] {
  const [w, h, d] = file.size;
  return [w, h, file.shape === 'box' || file.shape === 'pouch' ? d : w];
}

/** 轮廓线上的一点：半径、高（米），这一点往下的那一段是不是盖子。 */
interface ProfilePoint {
  readonly r: number;
  readonly y: number;
  readonly cap?: boolean;
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

/**
 * 旋转体的网格：每一段轮廓线绕一圈是一圈四边形；u 是角度（正面 +Z 在 0.5），v 是从顶面中心沿轮廓线往下量的长度（贴图的上面
 * 对着包装的上面）。硬边两边的顶点分开、各用各段的法线，软的地方取两段的平均。
 */
function latheMesh(profile: readonly ProfilePoint[], radial: number): ProductMesh {
  const segments = profile.length - 1;
  const lengths = profile.slice(1).map((p, i) => Math.hypot(p.r - profile[i]!.r, p.y - profile[i]!.y));
  const total = lengths.reduce((sum, l) => sum + l, 0);
  // 每段朝外的法线（轮廓线的切线转 90°：往上走的外壁朝外）
  const normals = profile.slice(1).map((p, i) => {
    const dr = p.r - profile[i]!.r, dy = p.y - profile[i]!.y, l = Math.hypot(dr, dy) || 1;
    return [dy / l, -dr / l] as const;
  });
  const pointNormal = (segment: number, end: 0 | 1): readonly [number, number] => {
    const own = normals[segment]!, otherIndex = segment + (end === 0 ? -1 : 1), other = normals[otherIndex];
    if (!other || Math.acos(Math.min(1, own[0] * other[0] + own[1] * other[1])) > CREASE) return own;
    const r = own[0] + other[0], y = own[1] + other[1], l = Math.hypot(r, y) || 1;
    return [r / l, y / l];
  };
  const builder = new MeshBuilder();
  let below = total;
  for (let s = 0; s < segments; s++) {
    const a = profile[s]!, b = profile[s + 1]!;
    const above = below - lengths[s]!;
    if (lengths[s]! < 1e-9) continue;
    const ring = (point: ProfilePoint, end: 0 | 1, v: number) => Array.from({ length: radial + 1 }, (_, k) => {
      const u = k / radial, angle = (u - 0.5) * 2 * Math.PI;
      const [nr, ny] = pointNormal(s, end);
      // 角度 0 对着 +Z（u = 0.5），往 +X 转
      const sin = Math.sin(angle), cos = Math.cos(angle);
      return builder.vertex([point.r * sin, point.y, point.r * cos], [nr * sin, ny, nr * cos], u, v / total);
    });
    const lower = ring(a, 0, below), upper = ring(b, 1, above);
    for (let k = 0; k < radial; k++) {
      const mid = (k + 0.5) / radial, angle = (mid - 0.5) * 2 * Math.PI;
      const [nr, ny] = normals[s]!;
      builder.quad(lower[k]!, lower[k + 1]!, upper[k + 1]!, upper[k]!, [nr * Math.sin(angle), ny, nr * Math.cos(angle)]);
    }
    below = above;
  }
  // 标签展开：宽是最粗处的周长，高是轮廓线的长度
  const circumference = 2 * Math.PI * Math.max(...profile.map((p) => p.r));
  return finish(builder, [circumference * 1000, total * 1000]);
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

function finish(builder: MeshBuilder, labelSize: readonly [number, number]): ProductMesh {
  return { vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices), labelSize };
}

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
  const [w, h, d] = file.size.map((v) => v * 1000) as [number, number, number];
  const parts: string[] = [`<rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="${design.colors.background}"/>`];
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
    let capLength = 0;
    for (let s = profile.length - 1; s > 0 && profile[s]!.cap; s--) capLength += Math.hypot(profile[s]!.r - profile[s - 1]!.r, profile[s]!.y - profile[s - 1]!.y) * 1000;
    if (capLength > 0) parts.push(`<rect width="${svgNumber(W)}" height="${svgNumber(capLength)}" fill="${design.colors.cap}"/>`);
    // 瓶的肩、颈不放字：字放在瓶身的直段（离底 3% 到 60% 高）
    const straight = file.shape === 'bottle' ? [0.03, 0.6] : file.shape === 'can' ? [0.08, 0.9] : file.shape === 'jar' ? [0.06, 0.76] : [0.1, 0.84];
    const bottom = H - (straight[0]! * h + file.size[0] * 1000 * 0.46), top = H - (straight[1]! * h + file.size[0] * 1000 * 0.46);
    body = [0, capLength, W, H - capLength];
    // 正面在 u = 0.5（周长的一半处）；看得见的大约是周长的三分之一
    areas = [{ cx: W / 2, cy: (top + bottom) / 2, width: W * 0.26, height: (bottom - top) * 0.8 }, { cx: 0, cy: (top + bottom) / 2, width: W * 0.24, height: (bottom - top) * 0.5, scale: 0.6 }, { cx: W, cy: (top + bottom) / 2, width: W * 0.24, height: (bottom - top) * 0.5, scale: 0.6 }];
  }
  parts.push(...patternShapes(design, body));
  if (font) for (const area of areas) parts.push(...textBlock(design, font, area));
  return parts.join('');
}

/** 底纹（画在 body 那块里）。 */
function patternShapes(design: ProductDesign, [x, y, w, h]: readonly [number, number, number, number]): string[] {
  const accent = design.colors.accent;
  switch (design.pattern) {
    case 'plain':
      return [];
    case 'band':
      return [`<rect x="${svgNumber(x)}" y="${svgNumber(y + h * 0.3)}" width="${svgNumber(w)}" height="${svgNumber(h * 0.36)}" fill="${accent}"/>`];
    case 'split':
      return [`<rect x="${svgNumber(x)}" y="${svgNumber(y + h * 0.62)}" width="${svgNumber(w)}" height="${svgNumber(h * 0.38)}" fill="${accent}"/>`];
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
  const under = design.pattern === 'band' ? design.colors.accent : design.colors.background;
  const ink = design.colors.text || (luminance(under) > 0.45 ? '#1d1d1f' : '#ffffff');
  const shapes: string[] = [];
  const brandHeight = area.height * (design.text ? 0.5 : 0.7) * scale;
  const brand = textPath(font, design.brand, area.cx, area.cy - (design.text ? area.height * 0.12 * scale : 0), area.width * scale, brandHeight, ink);
  if (brand) shapes.push(brand);
  if (design.text) {
    const pillWidth = area.width * 0.7 * scale, pillHeight = area.height * 0.24 * scale, cy = area.cy + area.height * 0.26 * scale;
    shapes.push(`<rect x="${svgNumber(area.cx - pillWidth / 2)}" y="${svgNumber(cy - pillHeight / 2)}" width="${svgNumber(pillWidth)}" height="${svgNumber(pillHeight)}" rx="${svgNumber(pillHeight / 2)}" fill="${ink}"/>`);
    const text = textPath(font, design.text, area.cx, cy, pillWidth * 0.84, pillHeight * 0.7, ink === '#ffffff' ? under : '#ffffff');
    if (text) shapes.push(text);
  }
  return shapes;
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

/** 包装的材质：标签贴图（path 是贴图的内容路径，svg）加这类材料的粗糙度、金属度。 */
export function productMaterial(file: ProductFile, texture: string, pixels: readonly [number, number], variant = 0): MaterialFile {
  const { surface } = productDesign(file, variant);
  return {
    name: file.name,
    baseColor: [1, 1, 1, 1],
    baseColorTexture: { texture, encoding: 'svg', size: pixels, srgb: true, filter: 'anisotropic', scale: [1, 1], offset: [0, 0] },
    ...SURFACE_MATERIAL[surface],
  };
}

/** SVG 里的数：留一位小数（毫米），去掉尾巴。 */
export const svgNumber = (value: number): string => String(Math.round(value * 10) / 10);

function luminance(hex: string): number {
  const v = parseInt(hex.slice(1, 7), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((v >> 16) & 255) + 0.7152 * channel((v >> 8) & 255) + 0.0722 * channel(v & 255);
}

/** 两个颜色的对比度（WCAG 的算法，1 到 21）。 */
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (v: readonly number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
