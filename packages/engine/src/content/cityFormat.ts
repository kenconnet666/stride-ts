/**
 * 城市（`.city.json`，W5，Stride 没有）：沿着路网摆楼的规则和种子。文件不存一栋栋楼的位置，运行时（和编辑器里）由
 * modeling/city.ts 照规则算出沿街的地块、挑楼，City 组件挂在一个实体上，楼是它的子实体；同样的文件、同样的路摆出同样的城。
 *
 * 摆法（沿街排，照 CityEngine 的"沿街地块"和 Parish & Müller 的思路简化）：沿每条路的两边从头走到尾，每一步按权重随机挑一栋楼，
 * 楼的正面（模型本地的 +Z）朝着路、离路边 setback 米，宽度方向（模型本地的 X）顺着路；和路（这个城的所有路）、已经摆下的楼
 * 碰到的不摆、往前挪一点再试，摆下了就往前走楼的宽度加 gap。坐标是 City 组件所在实体的本地坐标，路的样条用同一套坐标
 * （同地形贴样条）。楼放在地块四个角的地面里最低的那个高度上（坡上的那边埋进地里一点）。
 */

export interface CityBuildingRule {
  /** 楼的模型（一般是 .building.json 生成的同名模型）。 */
  readonly model: string;
  /** 挑中的权重，默认 1。 */
  readonly weight?: number;
}

export interface CityFile {
  readonly name: string;
  readonly seed?: number;
  /** 沿着哪些路摆（样条资源；路网的每条路径两边都摆）。 */
  readonly roads: readonly string[];
  readonly buildings: readonly CityBuildingRule[];
  /** 楼离路边多远（米，人行道），默认 3。 */
  readonly setback?: number;
  /** 相邻两栋楼的空隙（米），默认 2。 */
  readonly gap?: number;
  /** 只在这个多边形（[x, z]）里摆；不写是沿着整个路网。 */
  readonly area?: readonly (readonly [number, number])[];
}

/** 检查城市文件（编辑器保存、加载之前）。where 是报错里的位置。 */
export function checkCity(file: CityFile, where = file.name): CityFile {
  const fail = (path: string, message: string): never => {
    throw new Error(`${where}: ${path} ${message}`);
  };
  if (!Array.isArray(file.roads) || file.roads.length === 0 || file.roads.some((road) => typeof road !== 'string' || road === '')) fail('roads', 'needs at least one spline path');
  if (!Array.isArray(file.buildings) || file.buildings.length === 0) fail('buildings', 'needs at least one building');
  file.buildings.forEach((rule, i) => {
    if (typeof rule.model !== 'string' || rule.model === '') fail(`buildings[${i}].model`, 'must be a model path');
    if (rule.weight !== undefined && !(rule.weight > 0)) fail(`buildings[${i}].weight`, 'must be positive');
  });
  if (file.setback !== undefined && !(file.setback >= 0)) fail('setback', 'must not be negative');
  if (file.gap !== undefined && !(file.gap >= 0)) fail('gap', 'must not be negative');
  if (file.seed !== undefined && !Number.isInteger(file.seed)) fail('seed', 'must be a whole number');
  if (file.area !== undefined && (!Array.isArray(file.area) || file.area.length < 3 || file.area.some((p) => !(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))))) fail('area', 'needs at least 3 points [x, z]');
  return file;
}
