/**
 * 程序化建筑（`.building.json`，W5，Stride 没有）：文件存形状文法（矢量的规则），编辑器后端照规则生成同名的模型
 * （modeling/building.ts 生成、pipeline 的 buildingModel.ts 写模型），场景照常引用模型；改了规则马上重新生成、视口热重载。
 *
 * 思路同 CityEngine 的 CGA、虚幻 PCG 的 Shape Grammar，按我们的规模简化成三层：
 * - 体块（masses）从下往上叠：每段一个底面（多边形、矩形、圆，或者在下面一段的基础上往里缩 inset）、几层、层高、用哪条立面
 *   规则、顶上盖什么屋顶（平顶加女儿墙、穹顶、尖顶）。底面的每条边是一面立面。写了 base 的一段从那个高度起（不叠在上一段上）：
 *   并排的双塔、塔之间半空的连廊；离地的一段底下也盖上。
 * - 立面规则（facades）按楼层（底层、顶层、其余）给一个图案：`Pillar [Window Window]* Pillar`——构件的名字从左到右（从外面看），
 *   带 `*` 的项重复到铺满，方括号把几个构件当一组重复；铺不满、铺多了的那一点按比例拉宽、压窄所有构件。一个位置可以写几个候选
 *   `Window|Balcony`：按文件的 seed 和"第几段体块、第几面立面、第几列"挑一个（同一列上下一致，像真楼那样成竖条；多写几遍同一个
 *   就是加它的权重），宽度按第一个候选排，列始终对齐。
 * - 构件（modules）是一块"一层高、width 宽"的立面：墙、窗（洞口、凹进去的窗台和窗洞、玻璃、窗框和竖梃，可选的阳台）、
 *   突出的壁柱、整片的玻璃幕墙、贴在墙上突出来的一块板（招牌、灯带：用自发光的材质槽）。
 *
 * 坐标是米，地面在 y = 0，底面的点是 [x, z]（顺时针、逆时针都行）。材质槽默认 0 墙、1 玻璃、2 窗框、3 屋顶，构件和屋顶可以改用
 * 别的槽（招牌、彩色的墙）。
 */

/** 底面：多边形的点 [x, z]，矩形（宽 x、深 z，中心在 center），圆（多边形近似，segments 条边）。 */
export type BuildingFootprint =
  | readonly (readonly [number, number])[]
  | { readonly rect: readonly [number, number]; readonly center?: readonly [number, number] }
  | { readonly circle: number; readonly segments?: number; readonly center?: readonly [number, number] };

/** 屋顶：平顶（女儿墙高 parapet 米）、穹顶（高 height，默认是底面的半径）、尖顶（高 height）。material 是材质槽。 */
export type BuildingRoof =
  | { readonly kind: 'flat'; readonly parapet?: number; readonly material?: number }
  | { readonly kind: 'dome'; readonly height?: number; readonly rings?: number; readonly material?: number }
  | { readonly kind: 'pyramid'; readonly height: number; readonly material?: number };

/** 一段体块。 */
export interface BuildingMass {
  /** 底面；不写时用下面那一段的底面往里缩 inset 米（第一段必须写）。 */
  readonly footprint?: BuildingFootprint;
  readonly inset?: number;
  /** 这一段的底离地多高（米）；不写时叠在上一段的顶上（第一段是 0）。 */
  readonly base?: number;
  readonly floors: number;
  /** 层高（米）。 */
  readonly floorHeight: number;
  /** 立面规则的名字；不写是整面的墙。 */
  readonly facade?: string;
  /** 顶上的屋顶，默认平顶（没有女儿墙）。上面还有一段时露出来的部分就是露台。 */
  readonly roof?: BuildingRoof;
}

/** 立面规则：每层用第一条 where 对得上的（ground 是这一段的第一层，top 是最后一层，不写是哪层都行）。 */
export interface BuildingFacade {
  readonly floors: readonly {
    readonly where?: 'ground' | 'top';
    /** 构件的图案，见文件开头的说明。 */
    readonly pattern: string;
    /** 这层底下一圈突出的腰线：高、突出多少（米）。 */
    readonly ledge?: { readonly height: number; readonly depth: number };
  }[];
}

/** 立面的构件：一层高、width 宽（米，铺的时候按比例拉伸）。slots 改用别的材质槽（默认墙 0、玻璃 1、窗框 2）。 */
export type BuildingModule = (
  | { readonly kind: 'wall' }
  | {
    readonly kind: 'window';
    /** 窗台离地、窗顶离层顶、两边离构件边的距离（米）；门就是 sill 为 0。 */
    readonly sill?: number;
    readonly head?: number;
    readonly margin?: number;
    /** 窗洞凹进去多深、窗框多宽（米），竖梃几根。 */
    readonly depth?: number;
    readonly frame?: number;
    readonly mullions?: number;
    /** 阳台：伸出去多深、栏板多高（米）。 */
    readonly balcony?: { readonly depth: number; readonly railing?: number };
  }
  | { readonly kind: 'pillar'; readonly depth: number }
  | { readonly kind: 'curtain'; readonly frame?: number }
  | {
    readonly kind: 'panel';
    /** 板离构件的两边、离地、离层顶的距离（米），突出多少（米），用哪个材质槽（默认窗框的槽；招牌、灯带用自发光的材质）。 */
    readonly margin?: number;
    readonly sill?: number;
    readonly head?: number;
    readonly depth?: number;
    readonly material?: number;
  }
) & { readonly width: number; readonly slots?: { readonly wall?: number; readonly glass?: number; readonly frame?: number } };

export interface BuildingFile {
  readonly name: string;
  /** 材质槽，默认的意思见文件开头。 */
  readonly materials: readonly (string | null)[];
  /** 随机种子：图案里的候选（`A|B`）按它挑，换一个数是同一种楼的另一栋。默认 1。 */
  readonly seed?: number;
  readonly masses: readonly BuildingMass[];
  readonly facades?: Readonly<Record<string, BuildingFacade>>;
  readonly modules?: Readonly<Record<string, BuildingModule>>;
}

/** 默认的四个材质槽：墙、玻璃、窗框、屋顶。 */
export const BUILDING_SLOTS = 4;
/** 最多几个材质槽。 */
export const BUILDING_MAX_SLOTS = 8;

/** 图案里的一项：一个或一组位置（每个位置是一个构件名，或者几个候选 `A|B`），repeat 是带 `*` 的（重复到铺满）。 */
export interface FacadePatternItem {
  readonly modules: readonly string[];
  readonly repeat: boolean;
}

/** 一个位置的候选构件（`A|B` → [A, B]；只有一个时就是它）。 */
export function moduleChoices(slot: string): string[] {
  return slot.split('|');
}

/** 解析图案：`A B* [C D|E]* F`。语法不对时报错（说清楚哪里）。 */
export function parseFacadePattern(pattern: string): FacadePatternItem[] {
  const items: FacadePatternItem[] = [];
  const re = /\s*(?:\[([^\[\]]*)\]|([A-Za-z_][\w-]*(?:\|[A-Za-z_][\w-]*)*))(\*?)/y;
  let at = 0;
  while (at < pattern.length) {
    if (/^\s*$/.test(pattern.slice(at))) break;
    re.lastIndex = at;
    const match = re.exec(pattern);
    if (!match) throw new Error(`pattern '${pattern}': unexpected '${pattern.slice(at).trim()}' (expected a module name or [group], each optionally followed by *)`);
    const modules = match[1] !== undefined ? match[1].trim().split(/\s+/).filter(Boolean) : [match[2]!];
    if (modules.length === 0) throw new Error(`pattern '${pattern}': empty group []`);
    for (const name of modules) if (!/^[A-Za-z_][\w-]*(?:\|[A-Za-z_][\w-]*)*$/.test(name)) throw new Error(`pattern '${pattern}': '${name}' is not a module name (or A|B choices)`);
    items.push({ modules, repeat: match[3] === '*' });
    at = re.lastIndex;
  }
  if (items.length === 0) throw new Error(`pattern '${pattern}' is empty`);
  return items;
}

/** 检查建筑文件（编辑器保存、后端生成之前）。where 是报错里的位置。 */
export function checkBuilding(file: BuildingFile, where = file.name): BuildingFile {
  const fail = (path: string, message: string): never => {
    throw new Error(`${where}: ${path} ${message}`);
  };
  const slots = file.materials?.length ?? 0;
  if (!Array.isArray(file.materials) || slots > BUILDING_MAX_SLOTS) fail('materials', `needs at most ${BUILDING_MAX_SLOTS} material slots`);
  const slot = (value: number | undefined, path: string) => {
    if (value !== undefined && !(Number.isInteger(value) && value >= 0 && value < BUILDING_MAX_SLOTS)) fail(path, `must be a material slot 0..${BUILDING_MAX_SLOTS - 1}`);
  };
  const positive = (value: number | undefined, path: string, optional = true) => {
    if (value === undefined ? !optional : !(value > 0)) fail(path, 'must be positive');
  };
  const notNegative = (value: number | undefined, path: string) => {
    if (value !== undefined && !(value >= 0)) fail(path, 'must not be negative');
  };
  if (!Array.isArray(file.masses) || file.masses.length === 0) fail('masses', 'needs at least one mass');
  if (file.seed !== undefined && !Number.isInteger(file.seed)) fail('seed', 'must be a whole number');
  const modules = file.modules ?? {};
  for (const [name, module] of Object.entries(modules)) {
    const at = `modules.${name}`;
    positive(module.width, `${at}.width`, false);
    slot(module.slots?.wall, `${at}.slots.wall`);
    slot(module.slots?.glass, `${at}.slots.glass`);
    slot(module.slots?.frame, `${at}.slots.frame`);
    if (module.kind === 'window') {
      for (const key of ['sill', 'head', 'margin', 'depth', 'frame'] as const) notNegative(module[key], `${at}.${key}`);
      if (module.mullions !== undefined && !(Number.isInteger(module.mullions) && module.mullions >= 0)) fail(`${at}.mullions`, 'must be a whole number');
      if (2 * (module.margin ?? 0.3) >= module.width) fail(`${at}.margin`, 'leaves no room for the opening');
      if (module.balcony) {
        positive(module.balcony.depth, `${at}.balcony.depth`, false);
        notNegative(module.balcony.railing, `${at}.balcony.railing`);
      }
    } else if (module.kind === 'pillar') positive(module.depth, `${at}.depth`, false);
    else if (module.kind === 'curtain') notNegative(module.frame, `${at}.frame`);
    else if (module.kind === 'panel') {
      for (const key of ['margin', 'sill', 'head', 'depth'] as const) notNegative(module[key], `${at}.${key}`);
      slot(module.material, `${at}.material`);
    } else if (module.kind !== 'wall') fail(`${at}.kind`, "must be 'wall', 'window', 'pillar', 'curtain' or 'panel'");
  }
  for (const [name, facade] of Object.entries(file.facades ?? {})) {
    if (!Array.isArray(facade.floors) || facade.floors.length === 0) fail(`facades.${name}.floors`, 'needs at least one floor rule');
    facade.floors.forEach((floor, k) => {
      const at = `facades.${name}.floors[${k}]`;
      if (floor.where !== undefined && floor.where !== 'ground' && floor.where !== 'top') fail(`${at}.where`, "must be 'ground' or 'top'");
      let items: FacadePatternItem[] = [];
      try {
        items = parseFacadePattern(floor.pattern);
      } catch (error) {
        fail(`${at}.pattern`, (error as Error).message);
      }
      for (const item of items) for (const slot of item.modules) for (const module of moduleChoices(slot)) if (!(module in modules)) fail(`${at}.pattern`, `uses the module '${module}', which is not in modules`);
      if (floor.ledge) {
        positive(floor.ledge.height, `${at}.ledge.height`, false);
        positive(floor.ledge.depth, `${at}.ledge.depth`, false);
      }
    });
  }
  file.masses.forEach((mass, i) => {
    const at = `masses[${i}]`;
    if (!(Number.isInteger(mass.floors) && mass.floors >= 1)) fail(`${at}.floors`, 'must be a whole number ≥ 1');
    positive(mass.floorHeight, `${at}.floorHeight`, false);
    notNegative(mass.inset, `${at}.inset`);
    notNegative(mass.base, `${at}.base`);
    if (mass.facade !== undefined && !(mass.facade in (file.facades ?? {}))) fail(`${at}.facade`, `'${mass.facade}' is not in facades`);
    const footprint = mass.footprint;
    if (footprint === undefined) {
      if (i === 0) fail(`${at}.footprint`, 'is needed on the first mass');
    } else if (Array.isArray(footprint)) {
      if (footprint.length < 3 || footprint.some((p) => !(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail(`${at}.footprint`, 'needs at least 3 points [x, z]');
    } else if ('rect' in footprint) {
      if (!(footprint.rect[0] > 0 && footprint.rect[1] > 0)) fail(`${at}.footprint.rect`, 'needs a positive width and depth');
    } else if ('circle' in footprint) {
      positive(footprint.circle, `${at}.footprint.circle`, false);
      if (footprint.segments !== undefined && !(Number.isInteger(footprint.segments) && footprint.segments >= 3)) fail(`${at}.footprint.segments`, 'must be a whole number ≥ 3');
    } else fail(`${at}.footprint`, 'must be a list of points, { rect } or { circle }');
    const roof = mass.roof;
    if (roof) {
      slot(roof.material, `${at}.roof.material`);
      if (roof.kind === 'flat') notNegative(roof.parapet, `${at}.roof.parapet`);
      else if (roof.kind === 'dome') {
        positive(roof.height, `${at}.roof.height`);
        if (roof.rings !== undefined && !(Number.isInteger(roof.rings) && roof.rings >= 1)) fail(`${at}.roof.rings`, 'must be a whole number ≥ 1');
      } else if (roof.kind === 'pyramid') positive(roof.height, `${at}.roof.height`, false);
      else fail(`${at}.roof.kind`, "must be 'flat', 'dome' or 'pyramid'");
    }
  });
  return file;
}
