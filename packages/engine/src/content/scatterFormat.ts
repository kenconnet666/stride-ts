/**
 * 程序化摆放（`.scatter.json`，W4，Stride 没有）：在地形上按规则撒模型——树、灌木、石头。文件只存规则和种子（矢量的），不存
 * 一个个实例：实例按相机附近的格子现撒（terrain/Scatter.ts），同样的规则、种子在任何机器上撒出同样的位置；只有手摆的东西才
 * 逐个放进场景。挂在地形实体上（Scatter 组件），坐标是地形的本地坐标。
 *
 * 每一层：按 density 的抖动网格出候选点（网格对齐地形的原点，不随流式的格子变），按坡度、高度、成片的噪声、离路和地物的距离
 * 筛掉一部分，剩下的随机转一下、缩放、可选地顺着坡倾斜。层撒的是模型（每个实例一个实体，树、石头），或者草（grass：每片草叶
 * 一个三角形，一个格子的草合成一个网格，密的也撒得起）。
 */

/** 一层摆放的规则。范围都是 [最小, 最大]。 */
export interface ScatterLayerFile {
  readonly name: string;
  /** 撒的模型（内容路径）；撒草（grass）时不写。 */
  readonly model?: string;
  /**
   * 撒草：每个点一片草叶（一个三角形），高 height、根部宽 width（米，乘缩放），梢往随机的方向歪 lean 个叶高；一个格子的草合成
   * 一个网格。材质用 material（一般两面画、风的模式是 grass）。
   */
  readonly grass?: { readonly height: number; readonly width: number; readonly lean?: number };
  /** 草的材质（内容路径）。 */
  readonly material?: string;
  /** 这一层的格子边长（米），默认用文件的 cellSize；草的格子小一点（16），一格一个网格。 */
  readonly cellSize?: number;
  /** 每公顷（100 × 100 米）最多几个：候选点的网格间距是 √(10000 / density) 米。 */
  readonly density: number;
  /** 地面的坡度在这个范围（度）里才撒，默认 [0, 90]。 */
  readonly slope?: readonly [number, number];
  /** 地面的高度在这个范围（地形本地的米）里才撒，默认不限。 */
  readonly height?: readonly [number, number];
  /** 成片：按 scale 米大小的噪声斑块撒，coverage 是盖住多少面积（0..1）；不写是到处撒。 */
  readonly clump?: { readonly scale: number; readonly coverage: number };
  /** 离地形贴着的样条（路、铁路）的路面边多少米以内不撒，默认 3；也不撒在压平的地物（广场）里。 */
  readonly avoidPaths?: number;
  /** 缩放的范围，默认 [0.8, 1.2]。 */
  readonly scale?: readonly [number, number];
  /** 顺着坡倾斜多少（0 是竖直，树；1 是贴着坡，石头），默认 0。 */
  readonly alignToSlope?: number;
  /** 往地里埋多深（米，按缩放后算），默认 0。 */
  readonly sink?: number;
  /** 离相机多远以内才撒（米），默认 400。 */
  readonly viewDistance?: number;
  /**
   * 远处的细节层次，按 distance 从近到远：格子中心离相机超过 distance 时换成 model（简化的树：同一个种子、少长最细的一层），
   * 只留 keep（0..1）的点（远处的草稀一点；留下的是近处那些点的一部分，不跳）。没写 model 的沿用上一层的。impostor 是 true 时
   * 换成近一层模型的远处卡片（rendering/mesh/Impostors.ts：运行时烘的转向相机的四边形；烘好之前用近一层的模型），不能和 model 同写。
   */
  readonly lods?: readonly { readonly distance: number; readonly model?: string; readonly keep?: number; readonly impostor?: boolean }[];
  /** 投不投阴影，默认模型投、草不投。 */
  readonly castShadows?: boolean;
}

export interface ScatterFile {
  readonly name: string;
  /** 随机种子：换一个就是另一种撒法。 */
  readonly seed?: number;
  /** 流式的格子边长（米），默认 64：相机附近的格子撒好，走远了拿掉。 */
  readonly cellSize?: number;
  readonly layers: readonly ScatterLayerFile[];
}

/** 检查摆放文件，不对时抛错（错误里带着位置）；返回原对象。 */
export function checkScatterFile(value: unknown, where: string): ScatterFile {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${where}: ${path} ${problem}`);
  };
  if (typeof value !== 'object' || value === null) fail('scatter', 'must be an object');
  const file = value as ScatterFile;
  if (!Array.isArray(file.layers)) fail('layers', 'must be a list');
  const range = (v: unknown, path: string) => {
    if (v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v[0] <= v[1])) fail(path, 'must be [min, max]');
  };
  if (file.cellSize !== undefined && !(file.cellSize > 0)) fail('cellSize', 'must be positive');
  file.layers.forEach((layer, i) => {
    const at = `layers[${i}]`;
    if (layer.grass === undefined && (typeof layer.model !== 'string' || layer.model === '')) fail(`${at}.model`, 'must be a model path (or give grass)');
    if (layer.grass !== undefined && !(layer.grass.height > 0 && layer.grass.width > 0)) fail(`${at}.grass`, 'needs a positive height and width');
    if (layer.cellSize !== undefined && !(layer.cellSize > 0)) fail(`${at}.cellSize`, 'must be positive');
    if (!(typeof layer.density === 'number' && layer.density > 0)) fail(`${at}.density`, 'must be positive (per hectare)');
    range(layer.slope, `${at}.slope`);
    range(layer.height, `${at}.height`);
    range(layer.scale, `${at}.scale`);
    if (layer.clump !== undefined && !(layer.clump.scale > 0 && layer.clump.coverage >= 0 && layer.clump.coverage <= 1)) fail(`${at}.clump`, 'needs scale > 0 and coverage in 0..1');
    if (layer.viewDistance !== undefined && !(layer.viewDistance > 0)) fail(`${at}.viewDistance`, 'must be positive');
    layer.lods?.forEach((lod, k) => {
      if (!(lod.distance > 0) || (k > 0 && !(lod.distance > layer.lods![k - 1]!.distance))) fail(`${at}.lods[${k}].distance`, 'must be positive and increasing');
      if (lod.keep !== undefined && !(lod.keep > 0 && lod.keep <= 1)) fail(`${at}.lods[${k}].keep`, 'must be in (0, 1]');
      if (lod.impostor && (lod.model !== undefined || layer.grass !== undefined)) fail(`${at}.lods[${k}].impostor`, "is the nearer level's model as a card: not with a model of its own or on a grass layer");
    });
  });
  return file;
}
