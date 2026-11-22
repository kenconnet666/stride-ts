/**
 * 视口里编辑 SDF 模型（.sdf.json）的纯函数部分：形状的有向包围盒（画线框、点选）、按操纵器的平移、旋转、缩放改形状、加一个新形状。
 * 视口工具 SdfEditTool 调这些；编辑器存文件，后端重新烘模型。
 *
 * 坐标都是模型的本地坐标（形状的 position 那一套）。缩放按形状自己的轴：方块、椭球按轴改尺寸；圆柱、胶囊、圆台这些轴是 Y 的，
 * Y 改高、X 和 Z 改半径；球、圆环按变得最多的那个轴。
 */
import type { SdfFile, SdfShapeFile } from '../../../content/formats/assetFormat';
import { Quaternion, Vector3 } from '../../../data/vectors';
import type { GizmoChange } from '../TransformGizmo';
import { rotate, type BrushBox } from './brushShapes';

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

const IDENTITY: Quat = [0, 0, 0, 1];
/** 尺寸最小留多少（米）：缩得太小烘不出东西。 */
const MIN_SIZE = 0.005;

const round = (value: number) => Math.round(value * 10000) / 10000;
const roundVec = (v: readonly number[]) => v.map(round) as [number, number, number];

/** 形状的有向包围盒（本地坐标，中心在 position）。 */
export function sdfShapeBox(shape: SdfShapeFile): BrushBox {
  const rotation = shape.rotation ?? IDENTITY;
  const box = (x: number, y: number, z: number): BrushBox => ({ center: shape.position, rotation, half: [x, y, z] });
  switch (shape.kind) {
    case 'sphere': return box(shape.radius, shape.radius, shape.radius);
    case 'box': return box(shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2);
    case 'capsule': return box(shape.radius, shape.height / 2 + shape.radius, shape.radius);
    case 'cylinder': return box(shape.radius, shape.height / 2, shape.radius);
    case 'torus': return box(shape.ringRadius + shape.tubeRadius, shape.tubeRadius, shape.ringRadius + shape.tubeRadius);
    case 'ellipsoid': return box(shape.radii[0], shape.radii[1], shape.radii[2]);
    case 'cone': {
      const r = Math.max(shape.bottomRadius, shape.topRadius ?? 0);
      return box(r, shape.height / 2, r);
    }
    case 'roundCone': {
      const r = Math.max(shape.bottomRadius, shape.topRadius);
      return box(r, shape.height / 2 + r, r);
    }
    // 中心到角是到边的 2/√3 倍
    case 'hexPrism': return box(shape.radius * 1.1547, shape.height / 2, shape.radius * 1.1547);
  }
}

/** 按形状自己的轴缩放（factor 是 x、y、z 三个方向各乘多少）。 */
export function scaleSdfShape(shape: SdfShapeFile, factor: Vec3): SdfShapeFile {
  const [fx, fy, fz] = factor.map((f) => Math.max(f, 1e-3)) as [number, number, number];
  const size = (value: number, f: number) => round(Math.max(value * f, MIN_SIZE));
  // 变得最多的那个（球、圆环这些没有方向的按它）；横向（X、Z）里变得最多的
  const strongest = (...values: number[]) => values.reduce((best, f) => (Math.abs(Math.log(f)) > Math.abs(Math.log(best)) ? f : best), 1);
  const across = strongest(fx, fz), any = strongest(fx, fy, fz);
  switch (shape.kind) {
    case 'sphere': return { ...shape, radius: size(shape.radius, any) };
    case 'box': {
      const next = { ...shape, size: [size(shape.size[0], fx), size(shape.size[1], fy), size(shape.size[2], fz)] as [number, number, number] };
      return shape.cornerRadius === undefined ? next : { ...next, cornerRadius: round(Math.min(shape.cornerRadius, Math.min(...next.size) / 2)) };
    }
    case 'capsule': return { ...shape, height: size(shape.height, fy), radius: size(shape.radius, across) };
    case 'cylinder': return { ...shape, height: size(shape.height, fy), radius: size(shape.radius, across) };
    case 'torus': return { ...shape, ringRadius: size(shape.ringRadius, across), tubeRadius: size(shape.tubeRadius, fy === 1 ? across : fy) };
    case 'ellipsoid': return { ...shape, radii: [size(shape.radii[0], fx), size(shape.radii[1], fy), size(shape.radii[2], fz)] };
    case 'cone': return { ...shape, height: size(shape.height, fy), bottomRadius: size(shape.bottomRadius, across), ...(shape.topRadius === undefined ? {} : { topRadius: round(shape.topRadius * across) }) };
    case 'roundCone': {
      const height = size(shape.height, fy), bottomRadius = size(shape.bottomRadius, across), topRadius = size(shape.topRadius, across);
      // 半径差要小于高（不然一个球吞掉另一个）：高不够时按比例收两个半径
      const fit = Math.abs(bottomRadius - topRadius) >= height ? (height * 0.95) / Math.abs(bottomRadius - topRadius) : 1;
      return { ...shape, height, bottomRadius: round(bottomRadius * fit), topRadius: round(topRadius * fit) };
    }
    case 'hexPrism': return { ...shape, height: size(shape.height, fy), radius: size(shape.radius, across) };
  }
}

/**
 * 按操纵器拖出的变化改第 index 个形状。change 是世界里的（操纵器的），toLocal 是世界到模型本地的旋转、uniform 是模型的统一缩放
 * （平移的长度按它换算）；缩放的 factor 按形状自己的轴（操纵器放在形状上、朝向是形状的朝向）。
 */
export function applySdfChange(file: SdfFile, index: number, change: GizmoChange, toLocal: Quat, uniform: number): SdfFile {
  const shape = file.shapes[index];
  if (!shape) throw new Error(`no SDF shape ${index}`);
  let next: SdfShapeFile;
  if (change.type === 'translate') {
    const local = rotate(toLocal, [change.delta.x, change.delta.y, change.delta.z]);
    next = { ...shape, position: roundVec(shape.position.map((value, k) => value + local[k]! / uniform)) };
  } else if (change.type === 'rotate') {
    // 世界里的旋转换进模型的坐标系：local = toLocal · change · toLocal⁻¹，再乘在形状原来的旋转前面
    const q = new Quaternion(...toLocal);
    const local = q.clone().multiply(change.rotation).multiply(q.clone().invert());
    const result = local.multiply(new Quaternion(...(shape.rotation ?? IDENTITY))).normalize();
    next = { ...shape, rotation: [result.x, result.y, result.z, result.w].map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number, number] };
  } else {
    next = scaleSdfShape(shape, [change.factor.x, change.factor.y, change.factor.z]);
  }
  return { ...file, shapes: file.shapes.map((s, i) => (i === index ? next : s)) };
}

/** 新形状的默认尺寸（米，同新建 SDF 资源的那一套大小）。 */
const NEW_SHAPES: { readonly [K in SdfShapeFile['kind']]: Omit<Extract<SdfShapeFile, { kind: K }>, 'operation' | 'position'> } = {
  sphere: { kind: 'sphere', radius: 0.3 },
  box: { kind: 'box', size: [0.5, 0.5, 0.5], cornerRadius: 0.05 },
  capsule: { kind: 'capsule', height: 0.5, radius: 0.15 },
  cylinder: { kind: 'cylinder', height: 0.5, radius: 0.25, edgeRadius: 0.03 },
  torus: { kind: 'torus', ringRadius: 0.3, tubeRadius: 0.08 },
  ellipsoid: { kind: 'ellipsoid', radii: [0.35, 0.2, 0.25] },
  cone: { kind: 'cone', height: 0.5, bottomRadius: 0.25, topRadius: 0 },
  roundCone: { kind: 'roundCone', height: 0.5, bottomRadius: 0.2, topRadius: 0.08 },
  hexPrism: { kind: 'hexPrism', height: 0.3, radius: 0.2 },
};

/**
 * 加一个 kind 形状：放在 near（选中的那个形状）的旁边（+X 挪出它的包围盒），没有就放在原点；运算是加，融合 0.05 米。返回新文件
 * 和新形状的下标。
 */
export function addSdfShape(file: SdfFile, kind: SdfShapeFile['kind'], near?: number): { readonly sdf: SdfFile; readonly index: number } {
  const neighbour = near === undefined ? undefined : file.shapes[near];
  const step = neighbour ? sdfShapeBox(neighbour).half[0] + 0.3 : 0.6;
  const position: [number, number, number] = neighbour ? roundVec([neighbour.position[0] + step, neighbour.position[1], neighbour.position[2]]) : [0, 0, 0];
  // 那儿已经有形状了（接连加了几个）：接着往 +X 挪，不叠在一起
  const taken = (p: Vec3) => file.shapes.some((shape) => Math.hypot(shape.position[0] - p[0], shape.position[1] - p[1], shape.position[2] - p[2]) < 0.05);
  for (let guard = 0; taken(position) && guard < 100; guard++) position[0] = round(position[0] + Math.max(step, 0.3));
  const shape = { ...NEW_SHAPES[kind], operation: 'add', smoothness: 0.05, position, ...(neighbour?.material !== undefined ? { material: neighbour.material } : {}) } as SdfShapeFile;
  return { sdf: { ...file, shapes: [...file.shapes, shape] }, index: file.shapes.length };
}

/** 删掉第 index 个形状；只剩一个时报错（模型至少要一个形状）。 */
export function deleteSdfShape(file: SdfFile, index: number): SdfFile {
  if (file.shapes.length <= 1) throw new Error('an SDF model needs at least one shape');
  return { ...file, shapes: file.shapes.filter((_, i) => i !== index) };
}

/** 世界的点在形状上的位置换算要的：形状中心在模型本地的点（给操纵器放的位置用）。 */
export function sdfShapeCenter(shape: SdfShapeFile): Vector3 {
  return new Vector3(...shape.position);
}
