/**
 * 扫描场景的代理网格（`.splatedit.json` 的 `proxy`）：高斯泼溅没有面，碰撞、投阴影、进光追、天空遮挡都要一个简化的网格。做法是
 * 体素化加抽面：不透明的泼溅在自己 1σ 的椭球里按格子的间距撒点，每个点把泼溅的不透明度记进所在的格子；一格攒够 density 就算
 * 实心，再闭运算补墙上的小洞、去掉小块的碎片（飘着的噪点），最后用 Surface Nets（Gibson 1998 的 SurfaceNets，Lysenko 的写法：
 * 对偶网格上每个跨表面的小方块放一个点，相邻实心、空心的两格之间连一个四边形）抽出封闭的网格。墙这种薄的东西抽出来是两面的
 * 一片（实心的格子至少一层），碰撞、阴影都够用。烘焙那边（pipeline 的 bakers/splatEditModel.ts）再按误差简化。
 */
import type { SplatSource } from './splatFile.ts';
import { rotationMatrix } from './splatAlign.ts';

export interface SplatProxyOptions {
  /** 格子的边长（米），默认 0.1；扫描太大时自动放大，格子数不超过 MAX_CELLS。 */
  readonly cell?: number;
  /** 不透明度低于它的泼溅不算，默认 0.3。 */
  readonly minOpacity?: number;
  /** 一格攒到多少不透明度算实心，默认 1.5（一个全不透明的泼溅不够，两个叠着才算：一个孤零零的不当墙）。 */
  readonly density?: number;
  /** 连着的实心格子少于它的一块去掉（飘着的噪点），默认 8。 */
  readonly minIsland?: number;
}

/** 代理网格：位置（xyz，泼溅自己的坐标）、三角形（逆时针是外面），和实际用的格子边长。 */
export interface SplatProxyMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly cell: number;
}

/** 格子数的上限（256³）：再多内存、时间都划不来，格子放大。 */
const MAX_CELLS = 1 << 24;
/** 一个泼溅每根轴上最多撒几个点（太大的泼溅——远处的天、墙——只要盖住，不用每格都撒）。 */
const MAX_SAMPLES = 24;

export function splatProxyMesh(source: SplatSource, options: SplatProxyOptions = {}): SplatProxyMesh {
  const minOpacity = options.minOpacity ?? 0.3, density = options.density ?? 1.5, minIsland = options.minIsland ?? 8;
  const opaque: number[] = [];
  for (let i = 0; i < source.count; i++) if (source.colors[i * 4 + 3]! >= minOpacity) opaque.push(i);
  if (opaque.length === 0) return { positions: new Float32Array(0), indices: new Uint32Array(0), cell: options.cell ?? 0.1 };

  // 范围是主体的（每根轴 0.5% 到 99.5%），远处零星的几个不撑大格子
  const min = [0, 0, 0], max = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const values = Float32Array.from(opaque, (i) => source.positions[i * 3 + k]!).sort();
    min[k] = values[Math.floor((values.length - 1) * 0.005)]!;
    max[k] = values[Math.ceil((values.length - 1) * 0.995)]!;
  }
  let cell = options.cell ?? 0.1;
  const span = [0, 1, 2].map((k) => Math.max(max[k]! - min[k]!, cell));
  const cells = span[0]! * span[1]! * span[2]! / cell ** 3;
  if (cells > MAX_CELLS) cell *= Math.cbrt(cells / MAX_CELLS);
  const [nx, ny, nz] = span.map((s) => Math.ceil(s / cell) + 1) as [number, number, number];
  const origin = min;

  // 每个泼溅在自己 1σ 的椭球里按不大于格子的间距撒点，点所在的格子记上它的不透明度
  const weight = new Float32Array(nx * ny * nz);
  const n = [1, 1, 1];
  for (const i of opaque) {
    const opacity = source.colors[i * 4 + 3]!;
    const s = [source.scales[i * 3]!, source.scales[i * 3 + 1]!, source.scales[i * 3 + 2]!];
    for (let k = 0; k < 3; k++) n[k] = Math.min(MAX_SAMPLES, Math.max(1, Math.ceil((2 * s[k]!) / cell)));
    const cx = source.positions[i * 3]!, cy = source.positions[i * 3 + 1]!, cz = source.positions[i * 3 + 2]!;
    if (n[0] === 1 && n[1] === 1 && n[2] === 1) {
      deposit(cx, cy, cz, opacity);
      continue;
    }
    const q = [source.rotations[i * 4]!, source.rotations[i * 4 + 1]!, source.rotations[i * 4 + 2]!, source.rotations[i * 4 + 3]!];
    const length = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) || 1;
    const r = rotationMatrix([q[0]! / length, q[1]! / length, q[2]! / length, q[3]! / length]);
    for (let a = 0; a < n[0]!; a++) {
      const u = n[0] === 1 ? 0 : (2 * a + 1) / n[0]! - 1;
      for (let b = 0; b < n[1]!; b++) {
        const v = n[1] === 1 ? 0 : (2 * b + 1) / n[1]! - 1;
        for (let c = 0; c < n[2]!; c++) {
          const w = n[2] === 1 ? 0 : (2 * c + 1) / n[2]! - 1;
          if (u * u + v * v + w * w > 1) continue;
          const x = u * s[0]!, y = v * s[1]!, z = w * s[2]!;
          deposit(cx + r[0]! * x + r[1]! * y + r[2]! * z, cy + r[3]! * x + r[4]! * y + r[5]! * z, cz + r[6]! * x + r[7]! * y + r[8]! * z, opacity);
        }
      }
    }
  }
  function deposit(x: number, y: number, z: number, value: number): void {
    const gx = Math.floor((x - origin[0]!) / cell + 0.5), gy = Math.floor((y - origin[1]!) / cell + 0.5), gz = Math.floor((z - origin[2]!) / cell + 0.5);
    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) return;
    weight[(gz * ny + gy) * nx + gx]! += value;
  }

  let solid: Uint8Array = new Uint8Array(weight.length);
  for (let i = 0; i < weight.length; i++) solid[i] = weight[i]! >= density ? 1 : 0;
  // 闭运算（先胀一格再缩一格）：补上墙上、地上一两格的小洞
  solid = erode(dilate(solid, nx, ny, nz), nx, ny, nz);
  removeIslands(solid, nx, ny, nz, minIsland);
  const { positions, indices } = surfaceNets(solid, nx, ny, nz);
  // 格子的坐标换回泼溅的坐标：第 g 格的中心在 origin + g·cell
  for (let v = 0; v < positions.length; v += 3) for (let k = 0; k < 3; k++) positions[v + k] = origin[k]! + positions[v + k]! * cell;
  return { positions, indices, cell };
}

const NEIGHBORS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** 六邻域膨胀：自己或相邻的一格实心就实心。 */
function dilate(solid: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = solid.slice();
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = (z * ny + y) * nx + x;
    if (solid[i]) continue;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && solid[(Z * ny + Y) * nx + X]) {
        out[i] = 1;
        break;
      }
    }
  }
  return out;
}

/** 六邻域腐蚀：相邻的有一格空（格子外面不算空：贴着边的不被啃掉）就空。 */
function erode(solid: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const out = solid.slice();
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = (z * ny + y) * nx + x;
    if (!solid[i]) continue;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const X = x + dx, Y = y + dy, Z = z + dz;
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && !solid[(Z * ny + Y) * nx + X]) {
        out[i] = 0;
        break;
      }
    }
  }
  return out;
}

/** 去掉六邻域连着的实心格子少于 minCells 的块（就地改）。 */
function removeIslands(solid: Uint8Array, nx: number, ny: number, nz: number, minCells: number): void {
  if (minCells <= 1) return;
  const label = new Int32Array(solid.length).fill(-1);
  const stack: number[] = [], members: number[] = [];
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || label[start] !== -1) continue;
    members.length = 0;
    stack.push(start);
    label[start] = start;
    while (stack.length > 0) {
      const i = stack.pop()!;
      members.push(i);
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      for (const [dx, dy, dz] of NEIGHBORS) {
        const X = x + dx, Y = y + dy, Z = z + dz;
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
        const j = (Z * ny + Y) * nx + X;
        if (solid[j] && label[j] === -1) {
          label[j] = start;
          stack.push(j);
        }
      }
    }
    if (members.length < minCells) for (const i of members) solid[i] = 0;
  }
}

/**
 * Surface Nets：格子的中心是采样点，对偶网格的小方块（8 个相邻格子中心围成）里实心、空心都有的放一个顶点（跨表面的那几条边中点
 * 的平均）；相邻两格一实一空时，围着它们连线的 4 个小方块的顶点连成四边形，朝向空的一边。格子外面当空心，网格是封闭的。坐标是
 * 格子的下标。
 */
function surfaceNets(solid: Uint8Array, nx: number, ny: number, nz: number): { positions: Float32Array; indices: Uint32Array } {
  const at = (x: number, y: number, z: number) => (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz ? solid[(z * ny + y) * nx + x]! : 0);
  // 小方块 (x, y, z) 的角是格子 (x..x+1, y..y+1, z..z+1)，x 从 -1 到 nx-1
  const cx = nx + 1, cy = ny + 1;
  const vertexOf = new Int32Array(cx * cy * (nz + 1)).fill(-1);
  const cube = (x: number, y: number, z: number) => ((z + 1) * cy + (y + 1)) * cx + (x + 1);
  const positions: number[] = [];
  const corner = new Uint8Array(8);
  for (let z = -1; z < nz; z++) for (let y = -1; y < ny; y++) for (let x = -1; x < nx; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      corner[c] = at(x + (c & 1), y + ((c >> 1) & 1), z + ((c >> 2) & 1));
      mask |= corner[c]! << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, crossings = 0;
    for (let c = 0; c < 8; c++) {
      for (const bit of [1, 2, 4]) {
        if (c & bit) continue;
        const d = c | bit;
        if (corner[c] === corner[d]) continue;
        // 跨表面的边：中点
        sx += (c & 1) + (d & 1);
        sy += ((c >> 1) & 1) + ((d >> 1) & 1);
        sz += ((c >> 2) & 1) + ((d >> 2) & 1);
        crossings += 2;
      }
    }
    vertexOf[cube(x, y, z)] = positions.length / 3;
    positions.push(x + sx / crossings, y + sy / crossings, z + sz / crossings);
  }
  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) indices.push(a, d, c, a, c, b);
    else indices.push(a, b, c, a, c, d);
  };
  // 每对一实一空的相邻格子（沿 x、y、z）：连线周围的 4 个小方块，按右手定则绕着轴走一圈（法线朝 +轴），实心在 +轴那边时反过来
  for (let z = -1; z < nz; z++) for (let y = -1; y < ny; y++) for (let x = -1; x < nx; x++) {
    const here = at(x, y, z);
    if (y >= 0 && z >= 0 && here !== at(x + 1, y, z)) {
      quad(vertexOf[cube(x, y - 1, z - 1)]!, vertexOf[cube(x, y, z - 1)]!, vertexOf[cube(x, y, z)]!, vertexOf[cube(x, y - 1, z)]!, !here);
    }
    if (x >= 0 && z >= 0 && here !== at(x, y + 1, z)) {
      quad(vertexOf[cube(x - 1, y, z - 1)]!, vertexOf[cube(x - 1, y, z)]!, vertexOf[cube(x, y, z)]!, vertexOf[cube(x, y, z - 1)]!, !here);
    }
    if (x >= 0 && y >= 0 && here !== at(x, y, z + 1)) {
      quad(vertexOf[cube(x - 1, y - 1, z)]!, vertexOf[cube(x, y - 1, z)]!, vertexOf[cube(x, y, z)]!, vertexOf[cube(x - 1, y, z)]!, !here);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}
