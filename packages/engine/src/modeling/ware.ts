/**
 * 熟食的器皿（商品的 bowl、plate 外形，格式见 content/formats/productFormat.ts）：网格和贴图。照用户拍的超市熟食柜：成排的青花碗、
 * 白色的方盘，里面盛着菜。
 *
 * - 网格：碗是旋转体——轮廓线从圈足底面的中心出发，经圈足、外壁到口沿，再沿内壁回到碗底的中心，有壁厚（lathe.ts 的 latheMesh）；
 *   方盘是同样的轮廓（矮、圈足大）按超椭圆压成圆角的方形。盛了菜时碗里加一块菜面：边上贴着内壁的那一圈在 level 的高度，往中间
 *   鼓起 mound，表面按菜的样子起伏（块的起伏大、丝和粒的细）。
 * - 贴图（SVG，毫米）：上面一段是轮廓线展开（同包装，v 从碗底中心沿内壁、口沿、外壁量到圈足底），画釉色和青花——碗心一朵
 *   六瓣花（沿圆周重复的花瓣在碗底就是放射的花）、内壁口沿一道边、外壁一圈缠枝花带、圈足两道线；下面一块正方形是菜面按俯视
 *   投影的贴图：底下汤汁的颜色，上面按种子撒的块、丝、粒。器皿和菜共用一个材质（瓷的釉面和油亮的菜都光滑）。
 */
import type { ProductFile, ProductFood } from '../content/formats/productFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { latheMesh, smoothNormals, type ProductMesh, type ProfilePoint } from './lathe.ts';
import { MeshBuilder } from './meshBuilder.ts';
import { svgNumber } from './svg.ts';

/** 釉的白和青花的钴蓝（没写颜色时）。 */
export const WARE_GLAZE = '#f5f5ef';
export const WARE_COBALT = '#23408e';

/** 器皿的轮廓线和上面几处的位置（从轮廓线的终点——内底中心——往回量的长度，米：贴图的 v 方向）。 */
interface WareProfile {
  readonly points: ProfilePoint[];
  /** 内底那一片（平的底）的半径。 */
  readonly floor: number;
  /** 内底中心、口沿内侧、口沿外侧、圈足外沿往回量的长度。 */
  readonly marks: { readonly floorEdge: number; readonly rimInner: number; readonly rimOuter: number; readonly foot: number; readonly total: number };
  /** 内壁上一点的半径（按高度，米），菜面的边贴着它。 */
  readonly innerRadius: (y: number) => number;
  /** 内底的高（米）。 */
  readonly floorY: number;
}

function wareProfile(file: ProductFile): WareProfile {
  const R = file.size[0] / 2, h = file.size[1];
  const plate = file.shape === 'plate';
  // 圈足：碗的小、盘的大；壁厚按口径
  const foot = (plate ? 0.72 : 0.44) * R, footH = (plate ? 0.1 : 0.07) * h;
  const t = Math.min(0.006, Math.max(0.002, 0.035 * R));
  const steps = 10;
  const curve = (s: number, inset: number) => {
    const a = (s * Math.PI) / 2;
    return { r: foot * 1.02 + (R - inset - foot * 1.02) * Math.sin(a), y: footH + inset + (h - footH - inset) * (1 - Math.cos(a)) };
  };
  const outer: ProfilePoint[] = [{ r: 0, y: footH * 0.5 }, { r: foot * 0.9, y: footH * 0.5 }, { r: foot * 0.93, y: 0 }, { r: foot, y: 0 }, { r: foot * 1.02, y: footH }];
  for (let i = 1; i <= steps; i++) outer.push(curve(i / steps, 0));
  const inner: ProfilePoint[] = [{ r: R - t, y: h }];
  for (let i = steps - 1; i >= 0; i--) inner.push(curve(i / steps, t));
  inner.push({ r: 0, y: footH + t });
  const points = [...outer, ...inner];
  // 往回量：从终点（内底中心）开始
  const lengthFrom = (index: number) => {
    let sum = 0;
    for (let i = points.length - 1; i > index; i--) sum += Math.hypot(points[i]!.r - points[i - 1]!.r, points[i]!.y - points[i - 1]!.y);
    return sum;
  };
  const rimOuterIndex = outer.length - 1, rimInnerIndex = outer.length;
  const innerCurve = inner.slice(0, -1).reverse();
  return {
    points,
    floor: foot * 1.02,
    marks: { floorEdge: lengthFrom(points.length - 2), rimInner: lengthFrom(rimInnerIndex), rimOuter: lengthFrom(rimOuterIndex), foot: lengthFrom(4), total: lengthFrom(0) },
    floorY: footH + t,
    innerRadius: (y) => {
      for (let i = 1; i < innerCurve.length; i++) {
        const a = innerCurve[i - 1]!, b = innerCurve[i]!;
        if (y <= b.y) return a.r + ((b.r - a.r) * (y - a.y)) / Math.max(b.y - a.y, 1e-9);
      }
      return innerCurve[innerCurve.length - 1]!.r;
    },
  };
}

/** 方盘的超椭圆：圆周上 u 处的半径倍数，按宽、深压成圆角的方形（n 越大越方）。 */
function plateDeform(file: ProductFile): ((x: number, y: number, z: number) => readonly [number, number, number]) | undefined {
  if (file.shape !== 'plate') return undefined;
  const rx = 1, rz = (file.size[2] > 0 ? file.size[2] : file.size[0]) / file.size[0];
  const n = 5;
  return (x, y, z) => {
    const r = Math.hypot(x, z);
    if (r < 1e-9) return [x, y, z];
    const c = x / r, s = z / r;
    const k = 1 / (Math.abs(c) ** n + Math.abs(s) ** n) ** (1 / n);
    return [x * k * rx, y, z * k * rz];
  };
}

/** 菜面的贴图那块（正方形，毫米）的边长：内口径。 */
const foodSide = (file: ProductFile) => file.size[0] * 1000;

/** 器皿的网格（见文件开头）：贴图的上面一段是轮廓线展开，盛了菜时下面接菜面的那一块。 */
export function wareMesh(file: ProductFile, radial: number): ProductMesh {
  const profile = wareProfile(file);
  const deform = plateDeform(file);
  const lathe = latheMesh(profile.points, radial, deform ? (x, y, z) => deform(x, y, z) : undefined);
  const [W, L] = lathe.labelSize;
  const food = file.food;
  if (!food) return lathe;
  const F = foodSide(file), H = L + F;
  // 轮廓线那段的 v 压到 0..L/H
  const vertices = Float32Array.from(lathe.vertices);
  for (let i = 0; i < vertices.length; i += 8) vertices[i + 7] = vertices[i + 7]! * (L / H);
  const surface = foodSurface(file, food, profile, radial, deform, [W, H, L, F]);
  const merged = new Float32Array(vertices.length + surface.vertices.length);
  merged.set(vertices);
  merged.set(surface.vertices, vertices.length);
  const offset = vertices.length / 8;
  const indices = new Uint32Array(lathe.indices.length + surface.indices.length);
  indices.set(lathe.indices);
  indices.set(surface.indices.map((i) => i + offset), lathe.indices.length);
  return { vertices: merged, indices, labelSize: [W, H] };
}

/** 菜面：中心一个点加 RINGS 圈，边上贴着内壁在 level 的高度，往中间鼓起，按菜的样子起伏。 */
function foodSurface(file: ProductFile, food: ProductFood, profile: WareProfile, radial: number, deform: ((x: number, y: number, z: number) => readonly [number, number, number]) | undefined, [W, H, L, F]: readonly [number, number, number, number]): { vertices: Float32Array; indices: Uint32Array } {
  const h = file.size[1];
  const RINGS = 18;
  const level = Math.min(1, Math.max(0, food.level ?? 0.7)), mound = Math.max(0, food.mound ?? 0.15) * h;
  // 碗：菜面的边贴着内壁在 level 的高度（缩进一点点，不和内壁的三角形打架）；盘：菜堆在中间、边落在盘底上，露出一圈盘沿
  const plate = file.shape === 'plate';
  const edgeY = plate ? profile.floorY + 0.001 : profile.floorY + level * (h - profile.floorY);
  const edgeR = plate ? profile.floor * 0.95 : profile.innerRadius(edgeY) * 0.985;
  const pieces = food.pieces ?? 'chunks';
  // 起伏：按鼓起的高度算，块的一坨坨最大，丝和粒细碎
  const [amount, cells] = pieces === 'chunks' ? [1.1, 6] : pieces === 'strands' ? [0.45, 12] : pieces === 'beans' ? [0.35, 18] : [0.05, 3];
  const seed = file.seed ?? 1;
  const noise = (x: number, z: number) => {
    const value = (scale: number, salt: number) => {
      const px = (x / edgeR + 1) * scale, pz = (z / edgeR + 1) * scale, x0 = Math.floor(px), z0 = Math.floor(pz), fx = px - x0, fz = pz - z0;
      const at = (i: number, j: number) => hash32(hash32(seed + salt, x0 + i), z0 + j) / 4294967296;
      const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
      return (at(0, 0) * (1 - sx) + at(1, 0) * sx) * (1 - sz) + (at(0, 1) * (1 - sx) + at(1, 1) * sx) * sz;
    };
    return value(cells, 11) * 0.7 + value(cells * 2, 12) * 0.3 - 0.5;
  };
  const builder = new MeshBuilder();
  const vertex = (rho: number, angle: number) => {
    const x = rho * edgeR * Math.sin(angle), z = rho * edgeR * Math.cos(angle);
    const dome = 1 - rho * rho;
    const y = edgeY + mound * dome ** 0.7 + noise(x, z) * (mound + 0.03 * h) * amount * dome;
    const [px, py, pz] = deform ? deform(x, Math.max(y, profile.floorY + 0.001), z) : [x, Math.max(y, profile.floorY + 0.001), z];
    // 贴图：俯视投影进下面那块正方形（菜面的直径对着边长的 edgeR / 半口径）
    const u = ((x / (file.size[0] / 2)) * 0.5 + 0.5) * (F / W), v = (L + ((z / (file.size[0] / 2)) * 0.5 + 0.5) * F) / H;
    return builder.vertex([px, py, pz], [0, 1, 0], u, v);
  };
  const center = vertex(0, 0);
  let previous: number[] = [];
  for (let ring = 1; ring <= RINGS; ring++) {
    const rho = ring / RINGS;
    const current = Array.from({ length: radial + 1 }, (_, k) => vertex(rho, (k / radial - 0.5) * 2 * Math.PI));
    for (let k = 0; k < radial; k++) {
      if (ring === 1) builder.triangle(center, current[k]!, current[k + 1]!, [0, 1, 0]);
      else builder.quad(previous[k]!, current[k]!, current[k + 1]!, previous[k + 1]!, [0, 1, 0]);
    }
    previous = current;
  }
  smoothNormals(builder);
  return { vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices) };
}

/**
 * 器皿的贴图（SVG 的图形，毫米，不带外面的 svg 标签）：釉色、青花（floral 时）、盛的菜。glaze、cobalt 是釉和纹样的颜色。
 */
export function wareSkin(file: ProductFile, [W, H]: readonly [number, number], glaze: string, cobalt: string, floral: boolean, variant: number): string {
  const profile = wareProfile(file);
  const scale = 1000;
  const { floorEdge, rimInner, rimOuter, foot, total } = profile.marks;
  const L = total * scale;
  const shapes: string[] = [`<rect width="${svgNumber(W)}" height="${svgNumber(H)}" fill="${glaze}"/>`];
  const line = (y: number, width: number) => `<rect y="${svgNumber(y - width / 2)}" width="${svgNumber(W)}" height="${svgNumber(width)}" fill="${cobalt}"/>`;
  if (floral) {
    const unit = Math.max(2, (rimOuter - rimInner) * scale * 0.4);
    // 碗心一朵：圆周上重复 6 个花瓣（碗底一圈就是放射的花），外面一道圈
    const petalTop = floorEdge * scale * 0.15, petalBottom = floorEdge * scale * 0.75;
    for (let k = 0; k < 6; k++) {
      const cx = ((k + 0.5) / 6) * W;
      shapes.push(`<ellipse cx="${svgNumber(cx)}" cy="${svgNumber((petalTop + petalBottom) / 2)}" rx="${svgNumber(W / 6 * 0.32)}" ry="${svgNumber((petalBottom - petalTop) / 2)}" fill="${cobalt}" opacity="0.85"/>`);
    }
    shapes.push(line(floorEdge * scale * 0.05, unit * 0.6), line(floorEdge * scale * 0.95, unit * 0.5));
    // 内壁口沿下一道边：两条线夹一排小点
    const innerBand = rimInner * scale - unit * 5;
    shapes.push(line(innerBand, unit * 0.4), line(rimInner * scale - unit * 1.2, unit * 0.4));
    const dots = Math.round(W / (unit * 4));
    for (let k = 0; k < dots; k++) shapes.push(`<circle cx="${svgNumber(((k + 0.5) / dots) * W)}" cy="${svgNumber(innerBand + unit * 1.9)}" r="${svgNumber(unit * 0.7)}" fill="${cobalt}"/>`);
    // 口沿一圈蓝
    shapes.push(`<rect y="${svgNumber(rimInner * scale - unit * 0.6)}" width="${svgNumber(W)}" height="${svgNumber((rimOuter - rimInner) * scale + unit * 1.2)}" fill="${cobalt}"/>`);
    // 外壁的缠枝花带：上下两条线之间一条波浪的藤，波峰波谷各一朵花，叶子挂在藤上
    const bandTop = rimOuter * scale + unit * 2.5, bandBottom = rimOuter * scale + (foot - rimOuter) * scale * 0.62;
    shapes.push(line(bandTop - unit, unit * 0.5), line(bandBottom + unit, unit * 0.5));
    const bandHeight = bandBottom - bandTop, mid = (bandTop + bandBottom) / 2;
    const waves = Math.max(3, Math.round(W / (bandHeight * 2.2)));
    let vine = `M0 ${svgNumber(mid)}`;
    const random = seededRandom(hash32(file.seed ?? 1, variant * 31 + 5));
    const flowers: string[] = [];
    for (let k = 0; k < waves; k++) {
      const x0 = (k / waves) * W, x1 = ((k + 1) / waves) * W, crest = mid + (k % 2 ? 1 : -1) * bandHeight * 0.3;
      vine += `Q${svgNumber((x0 + x1) / 2)} ${svgNumber(crest + (crest - mid))} ${svgNumber(x1)} ${svgNumber(mid)}`;
      // 花：一个圆心加五个花瓣
      const fx = (x0 + x1) / 2, fy = mid - (crest - mid) * 0.9, petal = bandHeight * 0.16;
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * 2 * Math.PI + random();
        flowers.push(`<ellipse cx="${svgNumber(fx + Math.cos(a) * petal)}" cy="${svgNumber(fy + Math.sin(a) * petal)}" rx="${svgNumber(petal * 0.75)}" ry="${svgNumber(petal * 0.45)}" transform="rotate(${svgNumber((a * 180) / Math.PI)} ${svgNumber(fx + Math.cos(a) * petal)} ${svgNumber(fy + Math.sin(a) * petal)})" fill="${cobalt}"/>`);
      }
      flowers.push(`<circle cx="${svgNumber(fx)}" cy="${svgNumber(fy)}" r="${svgNumber(petal * 0.45)}" fill="${glaze}"/>`);
      // 两片叶子
      for (const side of [-1, 1]) {
        const lx = fx + side * bandHeight * 0.42, ly = mid + (crest - mid) * 0.35;
        flowers.push(`<ellipse cx="${svgNumber(lx)}" cy="${svgNumber(ly)}" rx="${svgNumber(bandHeight * 0.16)}" ry="${svgNumber(bandHeight * 0.06)}" transform="rotate(${side * 35} ${svgNumber(lx)} ${svgNumber(ly)})" fill="${cobalt}" opacity="0.9"/>`);
      }
    }
    shapes.push(`<path d="${vine}" fill="none" stroke="${cobalt}" stroke-width="${svgNumber(unit * 0.5)}"/>`, ...flowers);
    // 圈足两道线
    shapes.push(line(foot * scale - unit * 0.5, unit * 0.45), line(foot * scale + unit * 1.5, unit * 0.45));
  }
  if (file.food) shapes.push(foodSkin(file, file.food, [W, H], L, variant));
  return `<g>${shapes.join('')}</g>`;
}

/** 菜面那块（y 从 L 起的正方形，边长是口径）：汤汁的底色，上面按种子撒块、丝、粒。 */
function foodSkin(file: ProductFile, food: ProductFood, [W, H]: readonly [number, number], L: number, variant: number): string {
  const F = foodSide(file);
  const random = seededRandom(hash32(hash32(file.seed ?? 1, variant), 913));
  const main = food.color, accent = food.accent ?? shade(main, 0.6), sauce = food.sauce ?? shade(main, 0.55);
  const pick = () => (random() < 0.8 ? shade(main, 0.8 + random() * 0.4) : shade(accent, 0.85 + random() * 0.3));
  const at = () => [random() * F, L + random() * F] as const;
  const shapes: string[] = [`<rect y="${svgNumber(L)}" width="${svgNumber(Math.min(W, F))}" height="${svgNumber(H - L)}" fill="${sauce}"/>`];
  const pieces = food.pieces ?? 'chunks';
  if (pieces === 'chunks') {
    for (let i = 0; i < 90; i++) {
      const [x, y] = at(), w = F * (0.06 + random() * 0.08), d = w * (0.6 + random() * 0.5);
      shapes.push(`<rect x="${svgNumber(x - w / 2)}" y="${svgNumber(y - d / 2)}" width="${svgNumber(w)}" height="${svgNumber(d)}" rx="${svgNumber(d * 0.3)}" transform="rotate(${svgNumber(random() * 180)} ${svgNumber(x)} ${svgNumber(y)})" fill="${pick()}" stroke="${sauce}" stroke-width="${svgNumber(F * 0.004)}"/>`);
    }
    for (let i = 0; i < 24; i++) {
      const [x, y] = at(), w = F * (0.08 + random() * 0.1);
      shapes.push(`<rect x="${svgNumber(x - w / 2)}" y="${svgNumber(y - F * 0.006)}" width="${svgNumber(w)}" height="${svgNumber(F * 0.012)}" transform="rotate(${svgNumber(random() * 180)} ${svgNumber(x)} ${svgNumber(y)})" fill="${shade(accent, 1)}"/>`);
    }
  } else if (pieces === 'strands') {
    for (let i = 0; i < 520; i++) {
      const [x, y] = at(), w = F * (0.1 + random() * 0.18);
      shapes.push(`<rect x="${svgNumber(x - w / 2)}" y="${svgNumber(y - F * 0.005)}" width="${svgNumber(w)}" height="${svgNumber(F * (0.007 + random() * 0.006))}" transform="rotate(${svgNumber(random() * 180)} ${svgNumber(x)} ${svgNumber(y)})" fill="${pick()}"/>`);
    }
  } else if (pieces === 'beans') {
    for (let i = 0; i < 900; i++) {
      const [x, y] = at(), r = F * (0.018 + random() * 0.01);
      shapes.push(`<ellipse cx="${svgNumber(x)}" cy="${svgNumber(y)}" rx="${svgNumber(r)}" ry="${svgNumber(r * 0.75)}" transform="rotate(${svgNumber(random() * 180)} ${svgNumber(x)} ${svgNumber(y)})" fill="${pick()}"/>`);
    }
  } else {
    shapes.push(`<rect y="${svgNumber(L)}" width="${svgNumber(Math.min(W, F))}" height="${svgNumber(F)}" fill="${main}"/>`);
    for (let i = 0; i < 14; i++) {
      const [x, y] = at(), r = F * (0.05 + random() * 0.08);
      shapes.push(`<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${svgNumber(r)}" fill="${shade(main, 0.9 + random() * 0.2)}" opacity="0.6"/>`);
    }
    for (let i = 0; i < 8; i++) {
      const [x, y] = at();
      shapes.push(`<circle cx="${svgNumber(x)}" cy="${svgNumber(y)}" r="${svgNumber(F * 0.015)}" fill="${accent}"/>`);
    }
  }
  return shapes.join('');
}

/** 颜色乘一个亮度（sRGB 的 #rrggbb）。 */
function shade(hex: string, factor: number): string {
  const v = parseInt(hex.slice(1, 7), 16);
  const channel = (c: number) => Math.max(0, Math.min(255, Math.round(c * factor))).toString(16).padStart(2, '0');
  return `#${channel((v >> 16) & 255)}${channel((v >> 8) & 255)}${channel(v & 255)}`;
}
