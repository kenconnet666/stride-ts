/**
 * 矢量地形（`.terrain.json`，Stride 没有，新加的）：地形不存高度图，存怎么生成它——程序化的底（分形噪声）、矢量的地物（多边形压平）、
 * 雕刻的笔画（参数），原生的求值器按需求出任意精度、任意范围的高度（stride-native 的 sn_terrain_*，双精度坐标，各机器上逐位相同）。
 * 文件很小、能比较、能合并，agent 和人都能直接改；渲染、碰撞、导航都从同一份描述求值。
 *
 * 坐标是地形实体的本地坐标（米，XZ 平面），高度沿 Y。
 */

/** 程序化的底：梯度噪声的分形。没写的用 TERRAIN_NOISE_DEFAULTS（同 @stride-ts/native 的 TerrainNoise）。 */
export interface TerrainNoiseFile {
  readonly seed?: number;
  /** 层数（0..16）：层越多细节越细，算得越慢。 */
  readonly octaves?: number;
  /** 最大的起伏的波长（米）。 */
  readonly scale?: number;
  /** 起伏的幅度（米）。 */
  readonly height?: number;
  /** 整体抬高（米）。 */
  readonly offset?: number;
  /** 每层频率乘多少。 */
  readonly lacunarity?: number;
  /** 每层幅度乘多少。 */
  readonly gain?: number;
  /** 0..1：混进多少山脊。 */
  readonly ridged?: number;
  /** 域扭曲的幅度（米）：山形不那么规整。 */
  readonly warp?: number;
  /** ≥ 0：按累积的坡度压低细节（陡处平滑、谷里留细节，像侵蚀过）。 */
  readonly erosion?: number;
  /** 冲沟（侵蚀的样子，逐点算、不模拟）；不写就没有。 */
  readonly gullies?: TerrainGulliesFile;
}

/**
 * 冲沟：沿下坡方向的条纹一层层分叉（细的从粗的两侧斜着分出去），坡缓的地方淡成谷底（valley 以下）、山顶（peak 以上）。
 * 只加在底上，地物、笔画压在它上面。没写的用 TERRAIN_GULLY_DEFAULTS。
 */
export interface TerrainGulliesFile {
  /** 深度（米）。 */
  readonly strength?: number;
  /** 最粗一层的间距（米）。 */
  readonly scale?: number;
  /** 层数（0..8），每层间距减半。 */
  readonly octaves?: number;
  /** > 0：细的冲沟要多陡才出现（越小越只长在陡处）。 */
  readonly detail?: number;
  /** 谷底的高度（米）。 */
  readonly valley?: number;
  /** 山顶的高度（米）。 */
  readonly peak?: number;
}

/** 矢量的地物：flatten 是多边形（[x, z]，米）里压到 height，边外 falloff 米内过渡（路基、广场、建筑的地基）。 */
export interface TerrainFeatureFile {
  readonly type: 'flatten';
  readonly name?: string;
  readonly points: readonly (readonly [number, number])[];
  readonly height: number;
  readonly falloff?: number;
  /** 0..1，默认 1。 */
  readonly strength?: number;
}

/** 雕刻的一笔（按顺序作用）：抬高、压低的 strength 是米，压平、磨平是 0..1。 */
export interface TerrainStrokeFile {
  readonly op: 'raise' | 'lower' | 'flatten' | 'smooth';
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly strength: number;
  /** 压平的目标高度（米）。 */
  readonly height?: number;
}

export interface TerrainFile {
  readonly name: string;
  readonly noise: TerrainNoiseFile;
  readonly features?: readonly TerrainFeatureFile[];
  readonly strokes?: readonly TerrainStrokeFile[];
  /** 材质的内容路径；没有时用默认材质。 */
  readonly material?: string | null;
  /** 自动的 UV：每隔这么多米贴图重复一次，默认 4。 */
  readonly uvScale?: number;
}

/** 底的默认值（同 @stride-ts/native 的 TERRAIN_NOISE_DEFAULTS，这里再写一份：格式文件不依赖原生模块）。 */
export const TERRAIN_NOISE_DEFAULTS: Readonly<Required<Omit<TerrainNoiseFile, 'gullies'>>> = {
  seed: 0, octaves: 6, scale: 1000, height: 200, offset: 0, lacunarity: 2, gain: 0.5, ridged: 0, warp: 0, erosion: 0,
};

/** 冲沟的默认值（同 @stride-ts/native 的 TERRAIN_GULLY_DEFAULTS）。 */
export const TERRAIN_GULLY_DEFAULTS: Readonly<Required<TerrainGulliesFile>> = { strength: 20, scale: 400, octaves: 4, detail: 1.5, valley: 0, peak: 300 };

const STROKE_OPS: readonly TerrainStrokeFile['op'][] = ['raise', 'lower', 'flatten', 'smooth'];

/** 检查读进来的地形文件的结构（数值的范围由原生的求值器查），不对时抛错，错误里带着位置；返回原对象。 */
export function checkTerrainFile(value: unknown, where: string): TerrainFile {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${where}: ${path} ${problem}`);
  };
  const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof value !== 'object' || value === null) fail('terrain', 'must be an object');
  const file = value as Record<string, unknown>;
  if (typeof file.name !== 'string') fail('name', 'must be a string');
  if (typeof file.noise !== 'object' || file.noise === null) fail('noise', 'must be an object');
  for (const [key, v] of Object.entries(file.noise as object)) {
    if (key === 'gullies') {
      if (typeof v !== 'object' || v === null) fail('noise.gullies', 'must be an object');
      for (const [g, gv] of Object.entries(v as object)) {
        if (!(g in TERRAIN_GULLY_DEFAULTS)) fail(`noise.gullies.${g}`, 'is not a gully parameter');
        if (!isNumber(gv)) fail(`noise.gullies.${g}`, 'must be a finite number');
      }
      continue;
    }
    if (!(key in TERRAIN_NOISE_DEFAULTS)) fail(`noise.${key}`, 'is not a noise parameter');
    if (!isNumber(v)) fail(`noise.${key}`, 'must be a finite number');
  }
  const list = (key: string): unknown[] => {
    const v = file[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(key, 'must be an array');
    return v as unknown[];
  };
  list('features').forEach((feature, i) => {
    const f = feature as Partial<TerrainFeatureFile>;
    if (f.type !== 'flatten') fail(`features[${i}].type`, "must be 'flatten'");
    if (!Array.isArray(f.points) || f.points.length < 3 || !f.points.every((p) => Array.isArray(p) && p.length === 2 && isNumber(p[0]) && isNumber(p[1]))) {
      fail(`features[${i}].points`, 'must be at least 3 [x, z] number pairs');
    }
    if (!isNumber(f.height)) fail(`features[${i}].height`, 'must be a finite number');
  });
  list('strokes').forEach((stroke, i) => {
    const s = stroke as Partial<TerrainStrokeFile>;
    if (!STROKE_OPS.includes(s.op!)) fail(`strokes[${i}].op`, `must be one of ${STROKE_OPS.join(', ')}`);
    for (const key of ['x', 'z', 'radius', 'strength'] as const) if (!isNumber(s[key])) fail(`strokes[${i}].${key}`, 'must be a finite number');
  });
  if (file.material !== undefined && file.material !== null && typeof file.material !== 'string') fail('material', 'must be a material path or null');
  if (file.uvScale !== undefined && !(isNumber(file.uvScale) && file.uvScale > 0)) fail('uvScale', 'must be a positive number');
  return value as TerrainFile;
}
