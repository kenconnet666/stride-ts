/**
 * 程序化建筑的生成（W5，文件格式见 content/formats/buildingFormat.ts）：体块一段段叠起来，每段的底面每条边是一面立面，每层按立面规则的
 * 图案切成构件、生成几何；顶上盖屋顶。结果是按材质槽分好的网格（同样条、树），pipeline 的 buildingModel.ts 写成模型。
 *
 * 立面的框架：从外面看，u 从左到右沿着边、v 往上、w 朝外。窗洞往里凹（w < 0），壁柱、腰线、阳台往外突（w > 0）。
 * UV 按米（u、v），材质按米铺贴图。
 */
import { checkBuilding, moduleChoices, parseFacadePattern, type BuildingFacade, type BuildingFile, type BuildingFootprint, type BuildingMass, type BuildingModule, type BuildingRoof, type FacadePatternItem } from '../content/formats/buildingFormat.ts';
import { MeshBuilder, slotMeshes, type SlotMesh } from './meshBuilder.ts';
import { triangulateFace } from './polyMesh.ts';
import { hash32 } from '../data/hash.ts';

type Vec2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

const WALL = 0, GLASS = 1, FRAME = 2, ROOF = 3;
/** 女儿墙的厚度（米）。 */
const PARAPET_THICKNESS = 0.25;
/** 窗框、竖梃、幕墙骨架突出多少（米）。 */
const FRAME_DEPTH = 0.06;

/** 一面立面：起点（从外面看的左下角）、沿边的方向、朝外的法线、长度。 */
interface Facade {
  readonly origin: Vec2;
  readonly along: Vec2;
  readonly out: Vec2;
  readonly length: number;
}

/** 生成建筑的网格，按材质槽分好。规则不对时报错（同 checkBuilding）。 */
export function buildingMeshes(file: BuildingFile, where = file.name): SlotMesh[] {
  checkBuilding(file, where);
  const slots = Math.max(file.materials.length, 1);
  const builders = Array.from({ length: Math.max(slots, ...usedSlots(file).map((s) => s + 1)) }, () => new MeshBuilder());
  let base = 0;
  let below: Vec2[] | undefined;
  file.masses.forEach((mass, m) => {
    const outline = massOutline(mass, below);
    const height = mass.floors * mass.floorHeight;
    base = mass.base ?? base;
    // 离地的一段（连廊、架空的楼）底下盖上
    if (base > 0 && mass.base !== undefined) cap(builders[WALL]!, outline, base, true);
    // 候选构件按种子、第几段体块、第几面立面挑
    facadesOf(outline).forEach((facade, i) => buildFacade(builders, file, mass, facade, base, hash32(hash32(file.seed ?? 1, m), i)));
    buildRoof(builders, mass.roof ?? { kind: 'flat' }, outline, base + height);
    base += height;
    below = outline;
  });
  return slotMeshes(builders);
}

/** 文件里用到的材质槽（构件、屋顶改用的），网格要有这么多个槽。 */
function usedSlots(file: BuildingFile): number[] {
  const slots = [WALL, GLASS, FRAME, ROOF];
  for (const module of Object.values(file.modules ?? {})) slots.push(module.slots?.wall ?? WALL, module.slots?.glass ?? GLASS, module.slots?.frame ?? FRAME, module.kind === 'panel' ? module.material ?? FRAME : FRAME);
  for (const mass of file.masses) slots.push(mass.roof?.material ?? ROOF);
  return slots;
}

/** 这一段的底面（逆时针，从上往下看：x 往右、z 往下时是顺时针——只要求方向一致，朝外的法线按面积的符号算）。 */
export function massOutline(mass: BuildingMass, below: readonly Vec2[] | undefined): Vec2[] {
  const footprint = mass.footprint;
  const outline = footprint ? footprintPoints(footprint) : below!.map((p) => [p[0], p[1]] as Vec2);
  return mass.inset ? insetPolygon(outline, mass.inset) : outline;
}

function footprintPoints(footprint: BuildingFootprint): Vec2[] {
  if (Array.isArray(footprint)) return footprint.map((p) => [p[0], p[1]] as Vec2);
  const shape = footprint as Exclude<BuildingFootprint, readonly (readonly [number, number])[]>;
  const [cx, cz] = shape.center ?? [0, 0];
  if ('rect' in shape) {
    const [w, d] = shape.rect;
    return [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];
  }
  const n = shape.segments ?? 24;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * shape.circle, cz + Math.sin(a) * shape.circle] as Vec2;
  });
}

/** 有向面积（x、z 平面上，>0 是按 x 到 z 的方向逆时针）。 */
function signedArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i]!, [x1, z1] = points[(i + 1) % points.length]!;
    area += x0 * z1 - x1 * z0;
  }
  return area / 2;
}

/** 多边形每条边往里挪 distance 米（相邻两条挪过的边求交，同斜接）。凸的、不太尖的多边形用；挪没了的边不处理。 */
export function insetPolygon(points: readonly Vec2[], distance: number): Vec2[] {
  const sign = signedArea(points) > 0 ? 1 : -1;
  const n = points.length;
  // 每条边的朝内法线
  const inward = points.map((p, i) => {
    const q = points[(i + 1) % n]!;
    const dx = q[0] - p[0], dz = q[1] - p[1], length = Math.hypot(dx, dz) || 1;
    return [(-dz / length) * sign, (dx / length) * sign] as Vec2;
  });
  return points.map((p, i) => {
    const a = inward[(i + n - 1) % n]!, b = inward[i]!;
    // 两条边的法线的角平分线方向，长度让它到两条边的距离都是 distance
    const mx = a[0] + b[0], mz = a[1] + b[1];
    const dot = mx * a[0] + mz * a[1];
    const scale = Math.abs(dot) < 1e-9 ? 0 : distance / dot;
    return [p[0] + mx * scale, p[1] + mz * scale] as Vec2;
  });
}

/** 底面的每条边一面立面：从外面看，u 从左到右（所以沿着边反着走）。 */
function facadesOf(outline: readonly Vec2[]): Facade[] {
  const sign = signedArea(outline) > 0 ? 1 : -1;
  const n = outline.length;
  const facades: Facade[] = [];
  for (let i = 0; i < n; i++) {
    const p = outline[i]!, q = outline[(i + 1) % n]!;
    const dx = q[0] - p[0], dz = q[1] - p[1], length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const out: Vec2 = [(dz / length) * sign, (-dx / length) * sign];
    facades.push({ origin: q, along: [-dx / length, -dz / length], out, length });
  }
  return facades;
}

/** 立面框架里的一点：沿边 u、离地 v（已经加上这段的底）、朝外 w。 */
function at(f: Facade, u: number, v: number, w: number): Vec3 {
  return [f.origin[0] + f.along[0] * u + f.out[0] * w, v, f.origin[1] + f.along[1] * u + f.out[1] * w];
}

/** 一层的构件在立面上铺开：每个位置从哪到哪（u）；module 是位置（可能是几个候选 `A|B`，宽度按第一个算）。 */
export function layoutFloor(items: readonly FacadePatternItem[], modules: Readonly<Record<string, BuildingModule>>, length: number): { module: string; u0: number; u1: number }[] {
  const widthOf = (names: readonly string[]) => names.reduce((sum, name) => sum + modules[moduleChoices(name)[0]!]!.width, 0);
  const fixed = items.filter((item) => !item.repeat).reduce((sum, item) => sum + widthOf(item.modules), 0);
  const repeats = items.filter((item) => item.repeat);
  // 剩下的地方平分给各个重复项，每项重复几次取最接近的整数（至少一次，除非一点地方都没有）
  const share = repeats.length > 0 ? Math.max(length - fixed, 0) / repeats.length : 0;
  const counts = new Map(repeats.map((item) => [item, share <= 0 ? 0 : Math.max(1, Math.round(share / widthOf(item.modules)))]));
  const names = items.flatMap((item) => Array.from({ length: item.repeat ? counts.get(item)! : 1 }, () => item.modules).flat());
  const natural = widthOf(names);
  if (natural <= 0) return [];
  const scale = length / natural;
  let u = 0;
  return names.map((module) => {
    const u0 = u;
    u += modules[moduleChoices(module)[0]!]!.width * scale;
    return { module, u0, u1: u };
  });
}

function floorRule(facade: BuildingFacade, floor: number, floors: number): BuildingFacade['floors'][number] | undefined {
  return facade.floors.find((rule) => rule.where === undefined || (rule.where === 'ground' && floor === 0) || (rule.where === 'top' && floor === floors - 1));
}

function buildFacade(builders: MeshBuilder[], file: BuildingFile, mass: BuildingMass, f: Facade, base: number, seed: number): void {
  const modules = file.modules ?? {};
  const facade = mass.facade !== undefined ? file.facades?.[mass.facade] : undefined;
  const h = mass.floorHeight;
  for (let floor = 0; floor < mass.floors; floor++) {
    const v0 = base + floor * h;
    const rule = facade && floorRule(facade, floor, mass.floors);
    if (!rule) {
      panel(builders[WALL]!, f, 0, f.length, v0, v0 + h, 0);
      continue;
    }
    // 候选按图案、第几列挑：同样图案的楼层同一列上下一致
    let ruleSeed = seed;
    for (let k = 0; k < rule.pattern.length; k++) ruleSeed = hash32(ruleSeed, rule.pattern.charCodeAt(k));
    layoutFloor(parseFacadePattern(rule.pattern), modules, f.length).forEach(({ module, u0, u1 }, column) => {
      const choices = moduleChoices(module);
      const name = choices.length === 1 ? choices[0]! : choices[hash32(ruleSeed, column) % choices.length]!;
      buildModule(builders, modules[name]!, f, u0, u1, v0, v0 + h);
    });
    if (rule.ledge) {
      // 腰线两头多伸出突出的长度，转角处两面的腰线接上
      const { height, depth } = rule.ledge;
      box(builders[WALL]!, f, -depth, f.length + depth, v0, v0 + height, 0, depth);
    }
  }
}

function buildModule(builders: MeshBuilder[], module: BuildingModule, f: Facade, u0: number, u1: number, v0: number, v1: number): void {
  const wall = builders[module.slots?.wall ?? WALL]!, glass = builders[module.slots?.glass ?? GLASS]!, frame = builders[module.slots?.frame ?? FRAME]!;
  switch (module.kind) {
    case 'wall':
      panel(wall, f, u0, u1, v0, v1, 0);
      return;
    case 'pillar':
      panel(wall, f, u0, u1, v0, v1, 0);
      box(wall, f, u0, u1, v0, v1, 0, module.depth);
      return;
    case 'curtain': {
      const bar = module.frame ?? 0.08;
      panel(glass, f, u0, u1, v0, v1, 0);
      // 骨架：左边一根竖的（右边那根是下一块的左边）、底下一根横的（楼板的位置）
      box(frame, f, u0, u0 + bar, v0, v1, 0, FRAME_DEPTH);
      box(frame, f, u0 + bar, u1, v0, v0 + bar, 0, FRAME_DEPTH);
      return;
    }
    case 'panel': {
      // 墙上突出来的一块板（招牌、灯带）
      const margin = Math.min(module.margin ?? 0.1, (u1 - u0) * 0.45);
      const sill = Math.min(module.sill ?? 0.2, (v1 - v0) * 0.8), head = Math.min(module.head ?? 0.2, (v1 - v0 - sill) * 0.8);
      panel(wall, f, u0, u1, v0, v1, 0);
      box(builders[module.material ?? FRAME]!, f, u0 + margin, u1 - margin, v0 + sill, v1 - head, 0, module.depth ?? 0.15);
      return;
    }
    case 'window': {
      const margin = Math.min(module.margin ?? 0.3, (u1 - u0) * 0.45);
      const sill = Math.min(module.sill ?? 0.9, (v1 - v0) * 0.8), head = Math.min(module.head ?? 0.5, (v1 - v0 - sill) * 0.5);
      const a = u0 + margin, b = u1 - margin, s = v0 + sill, t = v1 - head;
      const depth = module.depth ?? 0.15, bar = module.frame ?? 0.06;
      // 洞口四周的墙
      panel(wall, f, u0, a, v0, v1, 0);
      panel(wall, f, b, u1, v0, v1, 0);
      if (sill > 0) panel(wall, f, a, b, v0, s, 0);
      panel(wall, f, a, b, t, v1, 0);
      // 凹进去的窗洞：两边、窗台、窗顶
      reveal(wall, f, a, b, s, t, depth);
      panel(glass, f, a, b, s, t, -depth);
      if (bar > 0) {
        const w0 = -depth, w1 = -depth + FRAME_DEPTH;
        box(frame, f, a, a + bar, s, t, w0, w1);
        box(frame, f, b - bar, b, s, t, w0, w1);
        box(frame, f, a + bar, b - bar, s, s + bar, w0, w1);
        box(frame, f, a + bar, b - bar, t - bar, t, w0, w1);
        const mullions = module.mullions ?? 0;
        for (let k = 1; k <= mullions; k++) {
          const c = a + ((b - a) * k) / (mullions + 1);
          box(frame, f, c - bar / 2, c + bar / 2, s + bar, t - bar, w0, w1);
        }
      }
      if (module.balcony) {
        const { depth: out, railing = 1 } = module.balcony;
        const slab = 0.15;
        box(wall, f, u0 + 0.05, u1 - 0.05, v0, v0 + slab, 0, out);
        // 栏板：外面一面玻璃，顶上一根扶手
        panel(glass, f, u0 + 0.05, u1 - 0.05, v0 + slab, v0 + slab + railing, out - 0.02);
        box(frame, f, u0 + 0.05, u1 - 0.05, v0 + slab + railing - 0.05, v0 + slab + railing, out - 0.06, out);
      }
      return;
    }
  }
}

/** 立面上 w 处的一块平面（朝外）。 */
function panel(builder: MeshBuilder, f: Facade, u0: number, u1: number, v0: number, v1: number, w: number): void {
  if (u1 - u0 < 1e-6 || v1 - v0 < 1e-6) return;
  const normal: Vec3 = [f.out[0], 0, f.out[1]];
  const corner = (u: number, v: number) => builder.vertex(at(f, u, v, w), normal, u, -v);
  builder.quad(corner(u0, v0), corner(u1, v0), corner(u1, v1), corner(u0, v1), normal);
}

/** 窗洞凹进去的四个面（两边、窗台、窗顶），从 w = 0 到 w = −depth，朝着洞口里面。 */
function reveal(builder: MeshBuilder, f: Facade, a: number, b: number, s: number, t: number, depth: number): void {
  if (depth <= 0) return;
  const along: Vec3 = [f.along[0], 0, f.along[1]], back: Vec3 = [-f.along[0], 0, -f.along[1]];
  side(builder, f, a, s, t, 0, -depth, along);
  side(builder, f, b, s, t, 0, -depth, back);
  flat(builder, f, a, b, s, 0, -depth, [0, 1, 0]);
  flat(builder, f, a, b, t, 0, -depth, [0, -1, 0]);
}

/** u 处一面竖着的面（v0..v1、w0..w1），法线 normal。 */
function side(builder: MeshBuilder, f: Facade, u: number, v0: number, v1: number, w0: number, w1: number, normal: Vec3): void {
  const corner = (v: number, w: number) => builder.vertex(at(f, u, v, w), normal, w, -v);
  builder.quad(corner(v0, w0), corner(v0, w1), corner(v1, w1), corner(v1, w0), normal);
}

/** v 处一面水平的面（u0..u1、w0..w1），法线 normal。 */
function flat(builder: MeshBuilder, f: Facade, u0: number, u1: number, v: number, w0: number, w1: number, normal: Vec3): void {
  const corner = (u: number, w: number) => builder.vertex(at(f, u, v, w), normal, u, w);
  builder.quad(corner(u0, w0), corner(u1, w0), corner(u1, w1), corner(u0, w1), normal);
}

/** 立面上突出的一块（u0..u1、v0..v1、w0..w1）：前、两侧、上、下五个面（背面贴着墙，不要）。 */
function box(builder: MeshBuilder, f: Facade, u0: number, u1: number, v0: number, v1: number, w0: number, w1: number): void {
  if (u1 - u0 < 1e-6 || v1 - v0 < 1e-6 || w1 - w0 < 1e-6) return;
  panel(builder, f, u0, u1, v0, v1, w1);
  side(builder, f, u0, v0, v1, w0, w1, [-f.along[0], 0, -f.along[1]]);
  side(builder, f, u1, v0, v1, w0, w1, [f.along[0], 0, f.along[1]]);
  flat(builder, f, u0, u1, v1, w0, w1, [0, 1, 0]);
  flat(builder, f, u0, u1, v0, w0, w1, [0, -1, 0]);
}

function buildRoof(builders: MeshBuilder[], roof: BuildingRoof, outline: readonly Vec2[], top: number): void {
  const builder = builders[roof.material ?? ROOF]!;
  const center = centroid(outline);
  switch (roof.kind) {
    case 'flat': {
      cap(builder, outline, top);
      const parapet = roof.parapet ?? 0;
      if (parapet > 0) {
        for (const f of facadesOf(outline)) {
          // 外面、里面、顶上；外面那面用墙的材质（和下面的墙接上）
          panel(builders[WALL]!, f, 0, f.length, top, top + parapet, 0);
          box(builder, f, -PARAPET_THICKNESS, f.length + PARAPET_THICKNESS, top, top + parapet, -PARAPET_THICKNESS, 0);
        }
      }
      return;
    }
    case 'pyramid': {
      const apex: Vec3 = [center[0], top + roof.height, center[1]];
      for (let i = 0; i < outline.length; i++) {
        const p = outline[i]!, q = outline[(i + 1) % outline.length]!;
        const a: Vec3 = [p[0], top, p[1]], b: Vec3 = [q[0], top, q[1]];
        const normal = outward(faceNormal(a, b, apex), [(p[0] + q[0]) / 2 - center[0], 0, (p[1] + q[1]) / 2 - center[1]]);
        const ia = builder.vertex(a, normal, 0, 0), ib = builder.vertex(b, normal, Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
        const ic = builder.vertex(apex, normal, 0, roof.height);
        builder.triangle(ia, ib, ic, normal);
      }
      return;
    }
    case 'dome': {
      // 穹顶顺着底面的形状收到顶：第 k 圈是底面往中心缩到 cos θ、升到 height · sin θ（圆的底面就是半个椭球）
      const radius = Math.max(...outline.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1])));
      const height = roof.height ?? radius, rings = roof.rings ?? 8;
      const ring = (k: number) => {
        const theta = (k / rings) * (Math.PI / 2), c = Math.cos(theta), s = Math.sin(theta);
        return outline.map((p) => {
          const dx = p[0] - center[0], dz = p[1] - center[1], r = Math.hypot(dx, dz) || 1;
          // 椭球的法线：水平分量 cos θ / r（r 是这个方向的半径）、竖直分量 sin θ / height
          const nx = (c / r) * (dx / r), nz = (c / r) * (dz / r), ny = s / height;
          const length = Math.hypot(nx, ny, nz) || 1;
          return builder.vertex([center[0] + dx * c, top + height * s, center[1] + dz * c], [nx / length, ny / length, nz / length], (Math.atan2(dz, dx) / Math.PI) * radius * 1.5, height * s);
        });
      };
      let lower = ring(0);
      for (let k = 1; k <= rings; k++) {
        const upper = ring(k);
        for (let i = 0; i < outline.length; i++) {
          const j = (i + 1) % outline.length;
          const p = outline[i]!, q = outline[j]!;
          const theta = ((k - 0.5) / rings) * (Math.PI / 2);
          const normal: Vec3 = [((p[0] + q[0]) / 2 - center[0]) * Math.cos(theta), Math.sin(theta) * radius, ((p[1] + q[1]) / 2 - center[1]) * Math.cos(theta)];
          builder.quad(lower[i]!, lower[j]!, upper[j]!, upper[i]!, normal);
        }
        lower = upper;
      }
      return;
    }
  }
}

/** 水平的盖子（耳切三角化），朝上；down 时朝下（离地的一段的底）。 */
function cap(builder: MeshBuilder, outline: readonly Vec2[], y: number, down = false): void {
  const normal: Vec3 = down ? [0, -1, 0] : [0, 1, 0];
  const points = outline.map((p) => [p[0], y, p[1]] as [number, number, number]);
  const indices = points.map((p) => builder.vertex(p, normal, p[0], p[2]));
  const triangles = triangulateFace(points, points.map((_, i) => i));
  for (let k = 0; k < triangles.length; k += 3) builder.triangle(indices[triangles[k]!]!, indices[triangles[k + 1]!]!, indices[triangles[k + 2]!]!, normal);
}

function centroid(points: readonly Vec2[]): Vec2 {
  let x = 0, z = 0;
  for (const p of points) {
    x += p[0];
    z += p[1];
  }
  return [x / points.length, z / points.length];
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  const length = Math.hypot(...n) || 1;
  return [n[0] / length, n[1] / length, n[2] / length];
}

/** 法线朝着 hint 那边（朝外）。 */
function outward(n: Vec3, hint: Vec3): Vec3 {
  return n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] >= 0 ? n : [-n[0], -n[1], -n[2]];
}
