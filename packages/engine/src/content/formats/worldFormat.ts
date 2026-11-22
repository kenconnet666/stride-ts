/**
 * 世界（`.world.json`，Stride 没有，新加的）：大世界在 XZ 平面上切成同样大的格子，每个格子的内容是一个普通的场景文件，运行时按
 * 流式源（相机、带 StreamingSource 的实体）的距离加载和卸载（world/WorldStreaming.ts）。
 *
 * - 一个格子一个文件：`<世界的内容路径>/<图层>/<x>_<z>.scene.json`，实体的位置相对格子的原点（场景的 offset 是格子的原点），
 *   所以格子里的数离原点都不远；多人改世界时各改各的格子，不冲突。
 * - 图层按内容类别分加载半径（地形、建筑远处就要看到，小物件近了才要）；同一个格子在每个图层各有一个文件。
 * - 常驻的场景（persistent：天空、太阳、天气、全局的设置）一直在，格子的场景挂在它下面。
 * - cells 是有内容的格子的索引（没列的格子是空的，不去读），编辑器往格子里放东西时更新它。
 */
import type { SceneEntityFile } from './sceneFormat.ts';

/** 世界的一个图层：一类内容和它的加载半径。 */
export interface WorldLayer {
  /** 图层名（也是格子文件所在的目录名），只用字母、数字、`-`、`_`。 */
  readonly name: string;
  /** 流式源到格子（XZ 上的方块）的距离不超过它（米）就加载；超过它的 1.25 倍才卸载（免得在边上来回加载）。 */
  readonly loadRadius: number;
}

export interface WorldFile {
  readonly name: string;
  /** 格子的边长（米）。 */
  readonly cellSize: number;
  /** 常驻场景的内容路径；没有时用一个空的场景当根。 */
  readonly persistent?: string;
  readonly layers: readonly WorldLayer[];
  /** 每个图层有内容的格子（格子坐标 [x, z]：格子覆盖 [x·边长, (x+1)·边长) × [z·边长, (z+1)·边长)）。 */
  readonly cells: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}

const LAYER_NAME = /^[A-Za-z0-9_-]+$/;

/** 格子在一个图层里的键（`x_z`，也是文件名）。 */
export const cellKey = (x: number, z: number): string => `${x}_${z}`;

/** 格子场景的内容路径（不带扩展名）。 */
export const worldCellPath = (worldPath: string, layer: string, x: number, z: number): string => `${worldPath}/${layer}/${cellKey(x, z)}`;

/** 格子的原点（格子场景的 offset）。 */
export const cellOrigin = (world: Pick<WorldFile, 'cellSize'>, x: number, z: number): [number, number, number] => [x * world.cellSize, 0, z * world.cellSize];

/** 世界坐标 (x, z) 在哪个格子里。 */
export const cellAt = (world: Pick<WorldFile, 'cellSize'>, x: number, z: number): [number, number] => [Math.floor(x / world.cellSize), Math.floor(z / world.cellSize)];

/** XZ 上一点到格子（方块）的距离：在格子里是 0。 */
export function distanceToCell(world: Pick<WorldFile, 'cellSize'>, x: number, z: number, cellX: number, cellZ: number): number {
  const size = world.cellSize;
  const dx = Math.max(cellX * size - x, 0, x - (cellX + 1) * size);
  const dz = Math.max(cellZ * size - z, 0, z - (cellZ + 1) * size);
  return Math.hypot(dx, dz);
}

/** 检查读进来的世界文件（公共边界：编辑器、agent 写的文件），不对时报错（带 where）。 */
export function checkWorldFile(file: unknown, where: string): WorldFile {
  const world = file as WorldFile;
  if (typeof world !== 'object' || world === null) throw new Error(`${where}: a world file is a JSON object`);
  if (!(world.cellSize > 0)) throw new Error(`${where}: cellSize must be a positive number of meters`);
  if (!Array.isArray(world.layers) || world.layers.length === 0) throw new Error(`${where}: a world needs at least one layer`);
  const names = new Set<string>();
  for (const layer of world.layers) {
    if (!LAYER_NAME.test(layer.name ?? '')) throw new Error(`${where}: layer name '${layer.name}' may only use letters, digits, '-' and '_'`);
    if (names.has(layer.name)) throw new Error(`${where}: layer '${layer.name}' is listed twice`);
    if (!(layer.loadRadius > 0)) throw new Error(`${where}: layer '${layer.name}' needs a positive loadRadius`);
    names.add(layer.name);
  }
  for (const [layer, cells] of Object.entries(world.cells ?? {})) {
    if (!names.has(layer)) throw new Error(`${where}: cells listed for unknown layer '${layer}'`);
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isInteger)) throw new Error(`${where}: cell ${JSON.stringify(cell)} in layer '${layer}' is not [x, z] integers`);
    }
  }
  return { ...world, cells: world.cells ?? {} };
}

/** 放进一个格子的实体：格子坐标、格子的原点和换成格子里的坐标的实体。 */
export interface CellPlacement {
  readonly x: number;
  readonly z: number;
  readonly entities: SceneEntityFile[];
}

/**
 * 按世界坐标把实体分到格子里（编辑器、agent 往世界里放东西）：根实体（parent 是 null）的 position 是世界坐标，按它落在哪个格子
 * 分，位置换成相对格子原点的；子实体跟着它的根走（本地坐标不动）。父实体排在子实体前面（同场景文件）。
 */
export function placeInCells(world: Pick<WorldFile, 'cellSize'>, entities: readonly SceneEntityFile[]): CellPlacement[] {
  const cells = new Map<string, CellPlacement>();
  const cellOf = new Map<string, CellPlacement>();
  for (const entity of entities) {
    let cell: CellPlacement | undefined;
    let placed = entity;
    if (entity.parent === null) {
      const [x, z] = cellAt(world, entity.position[0], entity.position[2]);
      const key = cellKey(x, z);
      cell = cells.get(key) ?? { x, z, entities: [] };
      cells.set(key, cell);
      const [ox, oy, oz] = cellOrigin(world, x, z);
      placed = { ...entity, position: [entity.position[0] - ox, entity.position[1] - oy, entity.position[2] - oz] };
    } else {
      cell = cellOf.get(entity.parent);
      if (!cell) throw new Error(`entity ${entity.id}: its parent ${entity.parent} must come before it in the list`);
    }
    cellOf.set(entity.id, cell);
    cell.entities.push(placed);
  }
  return [...cells.values()];
}
