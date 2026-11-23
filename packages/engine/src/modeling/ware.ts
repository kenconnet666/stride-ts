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
 * - 落下去堆起来的菜（food.dropped）：foodPieces 是每一块的形状，foodSpawn 是它们在菜面上方排好的位置，烘焙时 pipeline 用物理让
 *   它们落定（bakers/settle.ts 的 settleFood），停下的位姿交回 wareMesh 合进网格。块的颜色取菜面那块正方形四个角上的色块
 *   （圆的菜面用不到四个角）。
 */
import type { ProductFile, ProductFood } from '../content/formats/productFormat.ts';
import { hash32, randomRotation, seededRandom } from '../data/hash.ts';
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
/**
 * 器皿（盛了菜时加菜面）的网格；settled 是落定的菜块（food.dropped，ware.ts 的 foodPieces 里的第几块和它的位姿），给了就合进来——
 * 没给（物理还没跑，或者正拿它当碰撞体）时只有器皿和菜面。
 */
export function wareMesh(file: ProductFile, radial: number, settled?: readonly FoodPiecePose[]): ProductMesh {
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
  const parts = [{ vertices, indices: lathe.indices }, foodSurface(file, food, profile, radial, deform, [W, H, L, F])];
  if (settled && settled.length > 0) parts.push(settledPieces(file, settled, [W, H, L, F]));
  const merged = new Float32Array(parts.reduce((sum, part) => sum + part.vertices.length, 0));
  const indices = new Uint32Array(parts.reduce((sum, part) => sum + part.indices.length, 0));
  let vertexAt = 0, indexAt = 0;
  for (const part of parts) {
    merged.set(part.vertices, vertexAt);
    indices.set(part.indices.map((i) => i + vertexAt / 8), indexAt);
    vertexAt += part.vertices.length;
    indexAt += part.indices.length;
  }
  return { vertices: merged, indices, labelSize: [W, H] };
}

/** 落下去堆在菜面上的一块菜停下的位姿（器皿的本地坐标：圈足底面的中心是原点，+Y 朝上）；piece 是 foodPieces 里的第几块。 */
export interface FoodPiecePose {
  readonly piece: number;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

/**
 * 一块菜的形状（本地坐标，中心在原点）：三角形的顶点位置（每 9 个数一个三角形，逆时针朝外）、取色的色块（菜面贴图四个角上的：
 * 0、1、3 是主料的亮、暗、中，2 是配料）。
 */
export interface FoodPiece {
  readonly triangles: readonly number[];
  readonly swatch: number;
}

/** 菜一块的默认大小（米）：块的边长、丝的粗细、粒的长。 */
const PIECE_SIZE = { chunks: 0.02, strands: 0.004, beans: 0.009 } as const;

/** 落下去的那些菜块的形状（food.dropped 块，按种子；没盛菜、dropped 是 0、糊的时候是空的）。 */
export function foodPieces(file: ProductFile): FoodPiece[] {
  const food = file.food, pieces = food?.pieces ?? 'chunks';
  if (!food || pieces === 'smooth') return [];
  const count = Math.max(0, Math.round(food.dropped ?? 0)), size = food.pieceSize ?? PIECE_SIZE[pieces];
  const random = seededRandom(hash32(file.seed ?? 1, 4447));
  return Array.from({ length: count }, () => {
    const swatch = random() < 0.8 ? [0, 1, 3][Math.floor(random() * 3)]! : 2;
    if (pieces === 'beans') return { triangles: ellipsoid([size * 0.55, size * 0.42, size * 0.42].map((r) => r * (0.85 + random() * 0.3))), swatch };
    // 块是边长 size 上下的方块，丝是粗 size、长 10～16 倍的细条；八个角各自错开一点（不规则，切出来的样子）
    const half = pieces === 'chunks'
      ? [size * (0.4 + random() * 0.2), size * (0.3 + random() * 0.2), size * (0.4 + random() * 0.25)]
      : [size * (0.5 + random() * 0.2), size * (0.4 + random() * 0.1), size * (5 + random() * 3)];
    const jitter = pieces === 'chunks' ? 0.15 : 0.05;
    const corner = (i: number) => half.map((h, axis) => ((i >> axis) & 1 ? h : -h) * (1 + (random() - 0.5) * 2 * jitter));
    return { triangles: hexahedron(Array.from({ length: 8 }, (_, i) => corner(i))), swatch };
  });
}

/** 菜块落下去之前的位姿和第几批落（wave：一批落下去一会儿再放下一批，物理那边放的时候抬到已经落下的菜上方）。 */
export interface FoodSpawn {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly wave: number;
}

/**
 * 菜块落下去之前的位置：菜面上方、口沿以内排成一层格子（错开一点、随机转），一层放不下的分批落——一块块、一批批往下掉，不从高处
 * 一起砸下去（摞得太高的落下来太快，会弹出碗外）。顺序同 foodPieces。
 */
export function foodSpawn(file: ProductFile, pieces: readonly FoodPiece[]): FoodSpawn[] {
  if (!file.food || pieces.length === 0) return [];
  const { edgeY, edgeR, mound } = foodEdge(file, wareProfile(file), file.food);
  const random = seededRandom(hash32(file.seed ?? 1, 4451));
  // 格子的间距按最大的那块的外接球
  const extent = Math.max(...pieces.map(({ triangles }) => {
    let r = 0;
    for (let i = 0; i < triangles.length; i += 3) r = Math.max(r, Math.hypot(triangles[i]!, triangles[i + 1]!, triangles[i + 2]!));
    return r;
  }));
  // 只往中间那片落：靠边落下的会顺着碗壁弹出去
  const spacing = 2 * extent * 1.05, reach = edgeR * 0.65;
  const top = edgeY + mound * 1.3 + extent + 0.005;
  if (file.food.pieces === 'strands') return strandSpawn(pieces, reach, top, random);
  const spots: [number, number][] = [];
  for (let x = -reach; x <= reach; x += spacing) for (let z = -reach; z <= reach; z += spacing) if (Math.hypot(x, z) <= reach) spots.push([x, z]);
  if (spots.length === 0) spots.push([0, 0]);
  // 每批的格子整体挪一点：不总落在同几个点上、摞成一根柱子
  const offsets: [number, number][] = [];
  return pieces.map((_, i) => {
    const wave = Math.floor(i / spots.length);
    offsets[wave] ??= [(random() - 0.5) * spacing, (random() - 0.5) * spacing];
    const [x, z] = spots[i % spots.length]!, [ox, oz] = offsets[wave]!;
    const jitter = () => (random() - 0.5) * spacing * 0.3;
    return { position: [x + ox + jitter(), top, z + oz + jitter()] as const, rotation: randomRotation(random), wave };
  });
}

/**
 * 丝一把把地落：一批是平躺着、并排的一把（同一个朝向，随便朝哪；各自绕横轴斜不过 15°，并排的方向就是那根横轴，斜了也不碰），
 * 间隔是最粗那根的 2.5 倍，铺满中间那片；竖着落的会互相架住立起来，一根根落又太慢。
 */
function strandSpawn(pieces: readonly FoodPiece[], reach: number, top: number, random: () => number): FoodSpawn[] {
  // 丝的本地 x 是粗细方向：最粗那根的半宽
  const half = Math.max(...pieces.map(({ triangles }) => {
    let r = 0;
    for (let i = 0; i < triangles.length; i += 3) r = Math.max(r, Math.abs(triangles[i]!));
    return r;
  }));
  const gap = 5 * half, perWave = Math.max(1, Math.floor((2 * reach) / gap) + 1);
  const spawn: FoodSpawn[] = [];
  for (let wave = 0; spawn.length < pieces.length; wave++) {
    const yaw = random() * Math.PI, count = Math.min(perWave, pieces.length - spawn.length);
    // 绕竖直轴转 2·yaw 以后本地 x 轴的方向
    const ax = Math.cos(2 * yaw), az = -Math.sin(2 * yaw), shift = (random() - 0.5) * gap;
    for (let k = 0; k < count; k++) {
      const offset = (k - (count - 1) / 2) * gap + shift;
      spawn.push({ position: [ax * offset, top, az * offset], rotation: lyingRotation(yaw, (random() - 0.5) * (Math.PI / 6)), wave });
    }
  }
  return spawn;
}

/** 躺着的朝向（四元数 xyzw）：先绕本地 X 斜 tilt（弧度），再绕竖直轴转 2·yaw（yaw 是半角）。 */
function lyingRotation(yaw: number, tilt: number): [number, number, number, number] {
  // q = qy * qx
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(tilt / 2), sx = Math.sin(tilt / 2);
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

/** 菜面边上的高、半径（碗：贴着内壁在 level 的高度；盘：落在盘底上）和中间鼓起的高（米）。 */
function foodEdge(file: ProductFile, profile: WareProfile, food: ProductFood): { edgeY: number; edgeR: number; mound: number } {
  const h = file.size[1];
  const level = Math.min(1, Math.max(0, food.level ?? 0.7)), mound = Math.max(0, food.mound ?? 0.15) * h;
  const plate = file.shape === 'plate';
  const edgeY = plate ? profile.floorY + 0.001 : profile.floorY + level * (h - profile.floorY);
  // 缩进一点点，不和内壁的三角形打架
  const edgeR = plate ? profile.floor * 0.95 : profile.innerRadius(edgeY) * 0.985;
  return { edgeY, edgeR, mound };
}

/** 落定的菜块合成一个网格：按位姿摆好，面是平的（切块的棱），UV 落在各自的色块里（每个顶点挪一点，颜色有深浅）。 */
function settledPieces(file: ProductFile, settled: readonly FoodPiecePose[], [W, H, L, F]: readonly [number, number, number, number]): { vertices: Float32Array; indices: Uint32Array } {
  const pieces = foodPieces(file);
  // 转着落的长条偶尔把薄薄的菜面转穿、停在菜面底下：看不见，不要
  const below = foodEdge(file, wareProfile(file), file.food!).edgeY - 0.004;
  const builder = new MeshBuilder();
  const random = seededRandom(hash32(file.seed ?? 1, 4457));
  settled.forEach(({ piece: index, position, rotation }) => {
    const piece = pieces[index];
    if (!piece || position[1] < below) return;
    const [u0, v0, side] = swatchRect(piece.swatch, F, L);
    const at = (i: number) => {
      const p = rotate(rotation, [piece.triangles[i]!, piece.triangles[i + 1]!, piece.triangles[i + 2]!]);
      return [p[0] + position[0], p[1] + position[1], p[2] + position[2]];
    };
    for (let i = 0; i < piece.triangles.length; i += 9) {
      const a = at(i), b = at(i + 3), c = at(i + 6);
      const n = normalize(cross(sub(b, a), sub(c, a)));
      const uv = () => [(u0 + side * (0.15 + random() * 0.7)) / W, (v0 + side * (0.15 + random() * 0.7)) / H] as const;
      const [ua, va] = uv(), [ub, vb] = uv(), [uc, vc] = uv();
      builder.triangle(builder.vertex(a, n, ua, va), builder.vertex(b, n, ub, vb), builder.vertex(c, n, uc, vc), n);
    }
  });
  return { vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices) };
}

/** 色块在贴图上的位置（毫米：左上角 x、y 和边长）：菜面那块正方形的四个角，每个边长的十分之一。 */
function swatchRect(swatch: number, F: number, L: number): readonly [number, number, number] {
  const side = F * 0.1;
  return [swatch % 2 ? F - side : 0, L + (swatch >= 2 ? F - side : 0), side];
}

/** 六面体（8 个角，下标的第 0、1、2 位是 x、y、z 的正负）的 12 个三角形，逆时针朝外。 */
function hexahedron(corners: readonly number[][]): number[] {
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!].flatMap((i) => corners[i]!));
}

/** 椭球（半轴 radii）：经纬 8×5 的三角形，逆时针朝外。 */
function ellipsoid(radii: readonly number[]): number[] {
  const around = 8, rings = 5;
  const point = (ring: number, k: number) => {
    const phi = (ring / rings) * Math.PI, theta = (k / around) * 2 * Math.PI;
    return [radii[0]! * Math.sin(phi) * Math.cos(theta), radii[1]! * Math.cos(phi), radii[2]! * Math.sin(phi) * Math.sin(theta)];
  };
  const triangles: number[] = [];
  for (let ring = 0; ring < rings; ring++) {
    for (let k = 0; k < around; k++) {
      const a = point(ring, k), b = point(ring, k + 1), c = point(ring + 1, k), d = point(ring + 1, k + 1);
      if (ring > 0) triangles.push(...a, ...b, ...c);
      if (ring < rings - 1) triangles.push(...b, ...d, ...c);
    }
  }
  return triangles;
}

/** 四元数（xyzw）转一个向量。 */
function rotate(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2]! - z * v[1]!), ty = 2 * (z * v[0]! - x * v[2]!), tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)];
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const normalize = (v: readonly number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

/** 菜面：中心一个点加 RINGS 圈，边上贴着内壁在 level 的高度，往中间鼓起，按菜的样子起伏。 */
function foodSurface(file: ProductFile, food: ProductFood, profile: WareProfile, radial: number, deform: ((x: number, y: number, z: number) => readonly [number, number, number]) | undefined, [W, H, L, F]: readonly [number, number, number, number]): { vertices: Float32Array; indices: Uint32Array } {
  const h = file.size[1];
  const RINGS = 18;
  // 碗：菜面的边贴着内壁在 level 的高度；盘：菜堆在中间、边落在盘底上，露出一圈盘沿
  const { edgeY, edgeR, mound } = foodEdge(file, profile, food);
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
  // 落下去的菜块取色的四个色块（正方形的四个角，圆的菜面用不到）：主料亮、暗、配料、主料，每块横着几道深浅
  if ((food.dropped ?? 0) > 0) {
    [shade(main, 1.12), shade(main, 0.82), accent, main].forEach((color, swatch) => {
      const [x, y, side] = swatchRect(swatch, F, L);
      for (let k = 0; k < 4; k++) shapes.push(`<rect x="${svgNumber(x)}" y="${svgNumber(y + (k * side) / 4)}" width="${svgNumber(side)}" height="${svgNumber(side / 4 + 0.01)}" fill="${shade(color, 0.92 + (k % 2) * 0.12)}"/>`);
    });
  }
  return shapes.join('');
}

/** 颜色乘一个亮度（sRGB 的 #rrggbb）。 */
function shade(hex: string, factor: number): string {
  const v = parseInt(hex.slice(1, 7), 16);
  const channel = (c: number) => Math.max(0, Math.min(255, Math.round(c * factor))).toString(16).padStart(2, '0');
  return `#${channel((v >> 16) & 255)}${channel((v >> 8) & 255)}${channel(v & 255)}`;
}
