/**
 * 扫描场景的编辑（SplatEditTool）用的纯函数：裁剪框、删掉的框换成线框和点选用的盒子，操纵器的改动换到框上，加框、删框，
 * 刷选时一笔里的球按间距接上。坐标都是源泼溅自己的坐标。
 */
import type { SplatEditBox, SplatEditFile, SplatEditSphere } from '../../../content/formats/splatEditFormat';
import type { SplatNode } from '../../../content/splatFile';
import { Quaternion } from '../../../data/vectors';
import type { GizmoChange } from '../TransformGizmo';
import { rotate, type BrushBox } from './brushShapes';

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

/** 框在哪一组：裁剪框（只留里面的）、删掉的框。 */
export type SplatBoxList = 'keep' | 'remove';
/** 选中的框。 */
export interface SplatBoxSelection {
  readonly list: SplatBoxList;
  readonly index: number;
}

const IDENTITY: Quat = [0, 0, 0, 1];
/** 框的边长最小留多少（米）。 */
const MIN_SIZE = 0.01;
/** 刷选时一笔里相邻的球隔多远（半径的倍数）：再近就不加了，刷得连成一片又不太密。 */
const STROKE_SPACING = 0.5;
/** 一笔里相邻两点隔得比半径的这么多倍还远时不在中间补球。 */
const STROKE_JUMP = 4;

/** 两组框按次序排成一串（先裁剪框、后删掉的框），点选、画线框用。 */
export function splatBoxes(file: SplatEditFile): { readonly box: BrushBox; readonly selection: SplatBoxSelection }[] {
  const boxes = (list: SplatBoxList) => (file[list] ?? []).map((box, index) => ({ box: { center: box.center, rotation: box.rotation ?? IDENTITY, half: [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2] as Vec3 }, selection: { list, index } }));
  return [...boxes('keep'), ...boxes('remove')];
}

/** 选中的框（没有时 undefined）。 */
export function selectedBox(file: SplatEditFile, selection: SplatBoxSelection | undefined): SplatEditBox | undefined {
  return selection ? file[selection.list]?.[selection.index] : undefined;
}

/**
 * 操纵器拖了选中的框：移动（世界里的位移换进泼溅的坐标，除以实体的统一缩放）、旋转（换进泼溅的坐标系，乘在框原来的旋转前面）、
 * 改大小（按框自己的轴乘，最小 1 厘米）。toLocal 是世界到泼溅坐标的旋转（实体旋转的逆）。
 */
export function applySplatBoxChange(file: SplatEditFile, selection: SplatBoxSelection, change: GizmoChange, toLocal: Quat, uniform: number): SplatEditFile {
  const box = selectedBox(file, selection);
  if (!box) throw new Error(`no ${selection.list} box ${selection.index}`);
  let next: SplatEditBox;
  if (change.type === 'translate') {
    const local = rotate(toLocal, [change.delta.x, change.delta.y, change.delta.z]);
    next = { ...box, center: round3([box.center[0] + local[0] / uniform, box.center[1] + local[1] / uniform, box.center[2] + local[2] / uniform]) };
  } else if (change.type === 'rotate') {
    const q = new Quaternion(...toLocal);
    const local = q.clone().multiply(change.rotation).multiply(q.clone().invert());
    const result = local.multiply(new Quaternion(...(box.rotation ?? IDENTITY))).normalize();
    next = { ...box, rotation: [result.x, result.y, result.z, result.w].map((v) => Math.round(v * 1e6) / 1e6) as [number, number, number, number] };
  } else {
    next = { ...box, size: round3([Math.max(MIN_SIZE, box.size[0] * change.factor.x), Math.max(MIN_SIZE, box.size[1] * change.factor.y), Math.max(MIN_SIZE, box.size[2] * change.factor.z)]) };
  }
  return { ...file, [selection.list]: (file[selection.list] ?? []).map((b, i) => (i === selection.index ? next : b)) };
}

/**
 * 加一个框，返回新文件和它的选中。裁剪框默认盖住扫描的主体（bounds：见 splatExtent，再往里收就是裁掉边上）；删掉的框放在 at
 * （编辑相机前面看着的地方），边长 size（米，泼溅坐标里的）。
 */
export function addSplatBox(file: SplatEditFile, list: SplatBoxList, bounds: { readonly min: Vec3; readonly max: Vec3 }, at: Vec3, size: number): { readonly file: SplatEditFile; readonly selection: SplatBoxSelection } {
  const box: SplatEditBox = list === 'keep'
    ? { center: round3([0, 1, 2].map((k) => (bounds.min[k]! + bounds.max[k]!) / 2) as unknown as Vec3), size: round3([0, 1, 2].map((k) => Math.max(MIN_SIZE, bounds.max[k]! - bounds.min[k]!)) as unknown as Vec3) }
    : { center: round3(at), size: round3([size, size, size]) };
  const boxes = [...(file[list] ?? []), box];
  return { file: { ...file, [list]: boxes }, selection: { list, index: boxes.length - 1 } };
}

/**
 * 扫描的主体有多大：细节层次的叶子节点的中心按泼溅数加权，每个轴取 1% 到 99% 之间，再往外放出叶子的半边长的中位数。扫描的
 * 包围盒常被远处几个飘着的点撑得很大（PlayCanvas 的酒店扫描 50 米），按它放的裁剪框什么也裁不掉。
 */
export function splatExtent(nodes: readonly SplatNode[]): { readonly min: Vec3; readonly max: Vec3 } {
  const leaves = nodes.filter((node) => node.childCount === 0 && node.count > 0);
  if (leaves.length === 0) return { min: [-1, -1, -1], max: [1, 1, 1] };
  const total = leaves.reduce((sum, node) => sum + node.count, 0);
  const halves = leaves.map((node) => Math.max(...[0, 1, 2].map((k) => (node.max[k]! - node.min[k]!) / 2))).sort((a, b) => a - b);
  const pad = halves[Math.floor(halves.length / 2)]!;
  const range = (k: number) => {
    const sorted = leaves.map((node) => ({ at: (node.min[k]! + node.max[k]!) / 2, count: node.count })).sort((a, b) => a.at - b.at);
    const pick = (fraction: number) => {
      let seen = 0;
      for (const { at, count } of sorted) if ((seen += count) >= fraction * total) return at;
      return sorted[sorted.length - 1]!.at;
    };
    return [pick(0.01) - pad, pick(0.99) + pad] as const;
  };
  const [x, y, z] = [range(0), range(1), range(2)];
  return { min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] };
}

/** 删掉选中的框。 */
export function deleteSplatBox(file: SplatEditFile, selection: SplatBoxSelection): SplatEditFile {
  const boxes = (file[selection.list] ?? []).filter((_, i) => i !== selection.index);
  const { [selection.list]: _, ...rest } = file;
  return boxes.length > 0 ? { ...rest, [selection.list]: boxes } : rest;
}

/**
 * 刷选的一笔往前走到 point（泼溅坐标）：离这一笔上一个球不到半径的 STROKE_SPACING 倍时不加；远了就沿着中间按间距补上几个，
 * 鼠标挪得快也连成一道。跳得比半径的 STROKE_JUMP 倍还远（光标从近处的东西滑到后面的墙上）时不补：中间是空中，补了只是一串
 * 白占的球。返回加了球的文件和这一笔最后一个球心（没加时原样）。
 */
export function extendStroke(file: SplatEditFile, last: Vec3 | undefined, point: Vec3, radius: number): { readonly file: SplatEditFile; readonly last: Vec3 } {
  const spacing = radius * STROKE_SPACING;
  const added: SplatEditSphere[] = [];
  if (!last) added.push({ center: round3(point), radius });
  else {
    const gap = Math.hypot(point[0] - last[0], point[1] - last[1], point[2] - last[2]);
    if (gap < spacing) return { file, last };
    const steps = gap > radius * STROKE_JUMP ? 1 : Math.ceil(gap / spacing);
    for (let k = 1; k <= steps; k++) added.push({ center: round3([0, 1, 2].map((i) => last[i]! + ((point[i]! - last[i]!) * k) / steps) as unknown as Vec3), radius });
  }
  return { file: { ...file, erase: [...(file.erase ?? []), ...added] }, last: added[added.length - 1]!.center };
}

/** 文件里存到 0.1 毫米（文本短、可比较）。 */
function round3(v: Vec3): [number, number, number] {
  return [Math.round(v[0] * 1e4) / 1e4, Math.round(v[1] * 1e4) / 1e4, Math.round(v[2] * 1e4) / 1e4];
}
