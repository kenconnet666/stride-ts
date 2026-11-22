/**
 * 水体（`.water.json`，W6，Stride 没有）：湖（岸线多边形）或海（一直铺到远处），文件存参数（矢量的），Water 组件挂在实体上，
 * 实体的位置就是水面（本地 y = 0 的平面，岸线是本地的 [x, z]）；画法见 water/Water.ts。
 */

export interface WaterFile {
  readonly name: string;
  /** 湖的岸线（本地的 [x, z]，水只在里面）；不写是海。岸线不用贴着地形画：比地面低的那部分自然被地形挡住。 */
  readonly outline?: readonly (readonly [number, number])[];
  /** 水面从相机往外铺多远（米），默认 6000。 */
  readonly extent?: number;
  /** 深处的颜色（线性 rgb），默认偏绿的深蓝。 */
  readonly color?: readonly [number, number, number];
  /** 清澈度：光在水里走多少米剩 1/e，默认 4（清的湖 10 以上、浑的河 1 以下）。 */
  readonly clarity?: number;
  /**
   * 波浪：高（米，大约是最大的浪的波高）、波长（米，最长的那组）、方向（度，0 是本地 +X、逆时针转）、快慢（倍数）、尖（0..1，
   * 浪尖往一起挤的程度）。默认 0.3 米、12 米、0°、1、0.5。
   */
  readonly waves?: { readonly height?: number; readonly length?: number; readonly direction?: number; readonly speed?: number; readonly choppiness?: number };
  /** 泡沫：岸边多宽（米，按水深），默认 1。 */
  readonly foam?: { readonly shore?: number };
}

/** 岸线最多几个点（着色器里一个常量数组）。 */
export const WATER_MAX_OUTLINE = 64;

/** 检查水体文件（编辑器保存、加载之前）。where 是报错里的位置。 */
export function checkWater(file: WaterFile, where = file.name): WaterFile {
  const fail = (path: string, message: string): never => {
    throw new Error(`${where}: ${path} ${message}`);
  };
  if (file.outline !== undefined) {
    if (!Array.isArray(file.outline) || file.outline.length < 3 || file.outline.some((p) => !(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) fail('outline', 'needs at least 3 points [x, z]');
    if (file.outline.length > WATER_MAX_OUTLINE) fail('outline', `has at most ${WATER_MAX_OUTLINE} points`);
  }
  if (file.extent !== undefined && !(file.extent > 0)) fail('extent', 'must be positive');
  if (file.color !== undefined && !(Array.isArray(file.color) && file.color.length === 3 && file.color.every((c) => c >= 0))) fail('color', 'must be [r, g, b] (linear, not negative)');
  if (file.clarity !== undefined && !(file.clarity > 0)) fail('clarity', 'must be positive');
  const waves = file.waves;
  if (waves) {
    if (waves.height !== undefined && !(waves.height >= 0)) fail('waves.height', 'must not be negative');
    if (waves.length !== undefined && !(waves.length > 0)) fail('waves.length', 'must be positive');
    if (waves.speed !== undefined && !(waves.speed >= 0)) fail('waves.speed', 'must not be negative');
    if (waves.choppiness !== undefined && !(waves.choppiness >= 0 && waves.choppiness <= 1)) fail('waves.choppiness', 'must be in 0..1');
  }
  if (file.foam?.shore !== undefined && !(file.foam.shore >= 0)) fail('foam.shore', 'must not be negative');
  return file;
}
