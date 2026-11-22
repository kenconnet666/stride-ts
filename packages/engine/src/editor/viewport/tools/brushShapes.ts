/**
 * 视口里编辑关卡白盒（.brush.json）的纯函数部分：笔刷的有向包围盒、射线点到哪个笔刷的哪个面、在面外侧贴着加一个方块、拖面上的
 * 手柄改尺寸（对面不动）。视口工具 BrushEditTool 调这些，画线框和手柄、处理鼠标；编辑器存文件，后端重新烘模型。
 *
 * 坐标都是模型的本地坐标（笔刷的 position 那一套）；视口把世界里的射线换进来。面按 轴 * 2 + (正向 ? 1 : 0) 编号：0 是 -X、
 * 1 是 +X、2 是 -Y、3 是 +Y、4 是 -Z、5 是 +Z（笔刷自己的轴，跟着它的 rotation 转）。
 */
import type { BrushFile, BrushShapeFile } from '../../../content/formats/assetFormat';

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

/** 笔刷的有向包围盒：中心、朝向、半边长（本地坐标）。方块就是它自己；挤出、圆柱、球取外包的盒子。 */
export interface BrushBox {
  readonly center: Vec3;
  readonly rotation: Quat;
  readonly half: Vec3;
}

const IDENTITY: Quat = [0, 0, 0, 1];
/** 拖手柄时尺寸最小留多少（米），不让笔刷翻过去。 */
const MIN_SIZE = 0.01;

/** 四元数转向量（q · v · q⁻¹）。 */
export function rotate([qx, qy, qz, qw]: Quat, [x, y, z]: Vec3): [number, number, number] {
  const cx = qy * z - qz * y, cy = qz * x - qx * z, cz = qx * y - qy * x;
  return [x + 2 * (qw * cx + qy * cz - qz * cy), y + 2 * (qw * cy + qz * cx - qx * cz), z + 2 * (qw * cz + qx * cy - qy * cx)];
}

const inverse = ([x, y, z, w]: Quat): Quat => [-x, -y, -z, w];

export function brushBox(shape: BrushShapeFile): BrushBox {
  const rotation = shape.rotation ?? IDENTITY;
  const [px, py, pz] = shape.position;
  switch (shape.kind) {
    case 'box':
      return { center: shape.position, rotation, half: [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2] };
    case 'prism': {
      const xs = shape.points.map((p) => p[0]), zs = shape.points.map((p) => p[1]);
      const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
      // 挤出从 position 往上：中心在高的一半；底面的点相对 position，跟着笔刷转
      const offset = rotate(rotation, [(minX + maxX) / 2, shape.height / 2, (minZ + maxZ) / 2]);
      return { center: [px + offset[0], py + offset[1], pz + offset[2]], rotation, half: [(maxX - minX) / 2, shape.height / 2, (maxZ - minZ) / 2] };
    }
    case 'cylinder': {
      const r = Math.max(shape.radius, shape.topRadius ?? shape.radius);
      return { center: shape.position, rotation, half: [r, shape.height / 2, r] };
    }
    case 'sphere':
      return { center: shape.position, rotation, half: [shape.radius, shape.radius, shape.radius] };
  }
}

/** 面的中心和朝外的法线（本地坐标）。 */
export function faceCenter(box: BrushBox, face: number): { readonly center: Vec3; readonly normal: Vec3 } {
  const axis = face >> 1, sign = face & 1 ? 1 : -1;
  const local: [number, number, number] = [0, 0, 0];
  local[axis] = sign;
  const normal = rotate(box.rotation, local);
  const d = box.half[axis]!;
  return { center: [box.center[0] + normal[0] * d, box.center[1] + normal[1] * d, box.center[2] + normal[2] * d], normal };
}

/** 射线点到的一个笔刷：第几个、从哪个面进去、多远（按 direction 的长度量）。 */
export interface BrushHit {
  readonly index: number;
  readonly face: number;
  readonly distance: number;
}

/** 射线（本地坐标）点到的最近的笔刷和面；都没点到时是 undefined。 */
export function pickBrushFace(file: BrushFile, origin: Vec3, direction: Vec3): BrushHit | undefined {
  return brushHits(file, origin, direction)[0];
}

/**
 * 射线穿过的所有笔刷，由近到远（相机在笔刷里面时距离是 0）。挖空的房间里减掉的笔刷在外墙后面：视口里在同一处再点一下，
 * 选中的换成下一个（clickBrush）。
 */
export function brushHits(file: BrushFile, origin: Vec3, direction: Vec3): BrushHit[] {
  return boxHits(file.brushes.map(brushBox), origin, direction);
}

/** 射线穿过的有向盒子（下标是在 boxes 里的位置），由近到远；白盒的笔刷、SDF 的形状（sdfShapes.ts）都按它点选。 */
export function boxHits(boxes: readonly BrushBox[], origin: Vec3, direction: Vec3): BrushHit[] {
  const hits: BrushHit[] = [];
  boxes.forEach((box, index) => {
    const back = inverse(box.rotation);
    // 射线换进盒子的坐标（盒子的中心在原点、轴对齐）
    const o = rotate(back, [origin[0] - box.center[0], origin[1] - box.center[1], origin[2] - box.center[2]]);
    const d = rotate(back, direction);
    let near = -Infinity, far = Infinity, face = -1;
    for (let axis = 0; axis < 3; axis++) {
      const h = box.half[axis]!;
      if (Math.abs(d[axis]!) < 1e-12) {
        if (Math.abs(o[axis]!) > h) return;
        continue;
      }
      let t0 = (-h - o[axis]!) / d[axis]!, t1 = (h - o[axis]!) / d[axis]!;
      // 从负的一面进还是正的一面进
      let entering = axis * 2;
      if (t0 > t1) {
        [t0, t1] = [t1, t0];
        entering = axis * 2 + 1;
      }
      if (t0 > near) {
        near = t0;
        face = entering;
      }
      far = Math.min(far, t1);
      if (near > far) return;
    }
    if (far < 0 || face < 0) return;
    hits.push({ index, face, distance: Math.max(near, 0) });
  });
  return hits.sort((x, y) => x.distance - y.distance);
}

/** 点一下选哪个笔刷：射线穿过的最近的那个；它已经选中时换成射线上的下一个（转一圈回到最近的）；没点到是 undefined。 */
export function clickBrush(file: BrushFile, origin: Vec3, direction: Vec3, selection: number | undefined): number | undefined {
  const hits = brushHits(file, origin, direction);
  const at = hits.findIndex((hit) => hit.index === selection);
  return at < 0 ? hits[0]?.index : hits[(at + 1) % hits.length]!.index;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const roundVec = (v: readonly number[]) => v.map(round) as [number, number, number];

/**
 * 在第 index 个笔刷的 face 面外侧贴着加一个方块：大小和那个笔刷的包围盒一样、朝向一样、同一个材质槽，运算是加。返回新的白盒和
 * 新方块的下标（编辑器选中它，接着拖手柄改大小）。
 */
export function addBoxOnFace(file: BrushFile, index: number, face: number): { readonly brush: BrushFile; readonly index: number } {
  const shape = file.brushes[index]!, box = brushBox(shape);
  const axis = face >> 1;
  const { normal } = faceCenter(box, face);
  const step = 2 * box.half[axis]!;
  const added: BrushShapeFile = {
    kind: 'box', operation: 'add',
    position: roundVec([box.center[0] + normal[0] * step, box.center[1] + normal[1] * step, box.center[2] + normal[2] * step]),
    size: roundVec([2 * box.half[0], 2 * box.half[1], 2 * box.half[2]]),
    ...(shape.rotation ? { rotation: shape.rotation } : {}),
    ...(shape.material !== undefined ? { material: shape.material } : {}),
  };
  return { brush: { ...file, brushes: [...file.brushes, added] }, index: file.brushes.length };
}

/**
 * 把第 index 个笔刷的 face 面往外推 delta 米（负的往里），对面不动：方块改那一边的边长；圆柱的上下面改高、侧面改半径；球改
 * 半径（中心挪半个 delta）；挤出的多边形的上下面改高、侧面按对面那条边缩放底面的点。从拖之前的白盒（start）算。
 */
export function resizeBrushFace(start: BrushFile, index: number, face: number, delta: number): BrushFile {
  const shape = start.brushes[index]!, box = brushBox(shape);
  const axis = face >> 1, sign = face & 1 ? 1 : -1;
  const { normal } = faceCenter(box, face);
  // 中心沿着法线挪 delta / 2，对面才不动
  const shift = (amount: number) => roundVec([shape.position[0] + normal[0] * amount, shape.position[1] + normal[1] * amount, shape.position[2] + normal[2] * amount]);
  let next: BrushShapeFile;
  switch (shape.kind) {
    case 'box': {
      const size = [...shape.size] as [number, number, number];
      const grown = Math.max(MIN_SIZE, size[axis]! + delta);
      const used = grown - size[axis]!;
      size[axis] = round(grown);
      next = { ...shape, size, position: shift(used / 2) };
      break;
    }
    case 'sphere': {
      const radius = Math.max(MIN_SIZE / 2, shape.radius + delta / 2);
      next = { ...shape, radius: round(radius), position: shift(radius - shape.radius) };
      break;
    }
    case 'cylinder': {
      if (axis === 1) {
        const height = Math.max(MIN_SIZE, shape.height + delta);
        next = { ...shape, height: round(height), position: shift((height - shape.height) / 2) };
      } else {
        const radius = Math.max(MIN_SIZE / 2, shape.radius + delta / 2), grown = radius - shape.radius;
        next = { ...shape, radius: round(radius), ...(shape.topRadius !== undefined ? { topRadius: round(Math.max(0, shape.topRadius + grown)) } : {}), position: shift(grown) };
      }
      break;
    }
    case 'prism': {
      if (axis === 1) {
        const height = Math.max(MIN_SIZE, shape.height + delta), grown = height - shape.height;
        // 往上拉只改高；往下拉底面跟着挪（position 是底面）
        next = { ...shape, height: round(height), position: sign > 0 ? shape.position : shift(grown) };
      } else {
        // 侧面：底面的点沿这个轴按对面那条边缩放（axis 0 是 x、2 是 z，对应点的第 0、1 个数）
        const k = axis === 0 ? 0 : 1;
        const values = shape.points.map((p) => p[k]!);
        const min = Math.min(...values), max = Math.max(...values), width = max - min;
        const anchor = sign > 0 ? min : max, target = Math.max(MIN_SIZE, width + delta), scale = width > 0 ? target / width : 1;
        const points = shape.points.map((p) => {
          const moved = [p[0], p[1]] as [number, number];
          moved[k] = round(anchor + (p[k]! - anchor) * scale);
          return moved;
        });
        next = { ...shape, points };
      }
      break;
    }
  }
  return { ...start, brushes: start.brushes.map((b, i) => (i === index ? next : b)) };
}

/** 删掉第 index 个笔刷；只剩一个时抛错（白盒至少一个笔刷）。 */
export function deleteBrush(file: BrushFile, index: number): BrushFile {
  if (file.brushes.length <= 1) throw new Error('a greybox needs at least one brush');
  return { ...file, brushes: file.brushes.filter((_, i) => i !== index) };
}
