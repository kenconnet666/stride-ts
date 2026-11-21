/**
 * 配光曲线（IES 文件，ANSI/IESNA LM-63）：灯具往各个方向发出的光有多强，筒灯的光斑、壁灯往上下的扇形、路灯朝一侧偏的光都靠它。
 * 点光、聚光引用它（Light 的 profile），着色时按光源到着色点的方向查表，乘在光的强度上（形状归一到最大值 1，亮度仍然由
 * Light.intensity 定）。参考 three.js 的 IESLoader（解析、按对称性展开）、Unreal 的 IES 光源配置文件。
 *
 * 方向的约定（C 型配光）：垂直角 0° 对着光源实体的本地 -Z（聚光照的方向；实体朝下摆就是 IES 里的"正下方"），180° 对着 +Z；
 * 水平角 0° 是本地 +X，往本地 +Y 转。
 *
 * 表按固定的格子重采样：垂直 0..180° 共 VERTICAL_SAMPLES 格，水平绕轴对称的灯是 1 格、否则一圈 HORIZONTAL_SAMPLES 格。着色器
 * 在局部光的存储缓冲里读它（lighting/LocalLights.ts），不占贴图。
 */
import { ResourceTable } from '../../engine/ResourceTable.ts';
import type { Branded } from '../../data/prop.ts';

export type LightProfileId = Branded<number, 'LightProfileId'>;

/** 垂直方向（0..180°）的格数。 */
export const VERTICAL_SAMPLES = 128;
/** 水平方向（一圈）的格数；绕轴对称的灯只有 1 格。 */
export const HORIZONTAL_SAMPLES = 32;

const profiles = new ResourceTable<LightProfile>();

/** 解析好的配光：values[h * vertical + v]，0..1。 */
export interface LightProfileTable {
  readonly vertical: number;
  readonly horizontal: number;
  readonly values: Float32Array;
  /** 原文件里最大的发光强度（坎德拉，乘过倍数）：只是信息，着色不用。 */
  readonly maxCandela: number;
}

export class LightProfile implements LightProfileTable {
  readonly id: LightProfileId;
  readonly name: string;
  readonly vertical: number;
  readonly horizontal: number;
  readonly values: Float32Array;
  readonly maxCandela: number;

  constructor(name: string, table: LightProfileTable) {
    this.name = name;
    this.vertical = table.vertical;
    this.horizontal = table.horizontal;
    this.values = table.values;
    this.maxCandela = table.maxCandela;
    this.id = profiles.add(this) as LightProfileId;
  }

  /** @internal Light 组件里存的 id 对应的配光。 */
  static byId(id: number): LightProfile | undefined {
    return id === 0 ? undefined : profiles.get(id);
  }
}

/** 把 IES 文件（文本）解析、按对称性展开、重采样成固定的格子、归一。格式不对时报错（带 where）。 */
export function parseIes(text: string, where = 'IES'): LightProfileTable {
  const lines = text.split(/\r?\n/);
  let line = 0;
  // 头：IESNA:LM-63 和 [关键字] 行，直到 TILT=
  while (line < lines.length && !/^\s*TILT\s*=/i.test(lines[line]!)) line++;
  if (line === lines.length) throw new Error(`${where}: no TILT= line (not an IES file)`);
  const tilt = lines[line++]!.split('=')[1]!.trim().toUpperCase();
  // 后面全是数，按空白和逗号切开挨个读
  const numbers = lines.slice(line).join(' ').split(/[\s,]+/).filter((token) => token !== '').map(Number);
  let at = 0;
  const next = (what: string) => {
    if (at >= numbers.length || !Number.isFinite(numbers[at])) throw new Error(`${where}: expected a number for ${what}`);
    return numbers[at++]!;
  };
  if (tilt === 'INCLUDE') {
    // 灯和灯具的几何关系、角度数、角度、系数：倾斜数据（灯倾斜时光通量的变化）不用，跳过
    next('tilt geometry');
    const count = next('tilt angle count');
    at += count * 2;
  } else if (tilt !== 'NONE') {
    throw new Error(`${where}: TILT=${tilt} (tilt data in a separate file) is not supported`);
  }
  next('lamp count');
  next('lumens per lamp');
  const multiplier = next('candela multiplier');
  const verticalCount = next('vertical angle count');
  const horizontalCount = next('horizontal angle count');
  const photometricType = next('photometric type');
  for (let i = 0; i < 4; i++) next('units and luminous size');
  for (let i = 0; i < 3; i++) next('ballast factor, future use and input watts');
  if (photometricType !== 1) throw new Error(`${where}: only type C photometry is supported (got type ${photometricType === 2 ? 'B' : photometricType === 3 ? 'A' : photometricType})`);
  if (!(verticalCount >= 2) || !(horizontalCount >= 1)) throw new Error(`${where}: needs at least 2 vertical and 1 horizontal angle`);
  const verticalAngles = Array.from({ length: verticalCount }, () => next('vertical angle'));
  const horizontalAngles = Array.from({ length: horizontalCount }, () => next('horizontal angle'));
  const candela = Array.from({ length: horizontalCount }, () => Array.from({ length: verticalCount }, () => next('candela value') * multiplier));

  const lastHorizontal = horizontalAngles[horizontalCount - 1]!;
  const horizontal = horizontalCount === 1 || lastHorizontal === 0 ? 1 : HORIZONTAL_SAMPLES;
  const values = new Float32Array(VERTICAL_SAMPLES * horizontal);
  for (let h = 0; h < horizontal; h++) {
    const phi = foldHorizontal((h * 360) / horizontal, lastHorizontal);
    for (let v = 0; v < VERTICAL_SAMPLES; v++) {
      const theta = (v * 180) / (VERTICAL_SAMPLES - 1);
      values[h * VERTICAL_SAMPLES + v] = sample(candela, verticalAngles, horizontalAngles, theta, phi);
    }
  }
  let max = 0;
  for (const value of values) max = Math.max(max, value);
  if (max > 0) for (let i = 0; i < values.length; i++) values[i]! /= max;
  return { vertical: VERTICAL_SAMPLES, horizontal, values, maxCandela: Math.max(0, ...candela.flat()) };
}

/**
 * 水平角按测量覆盖的范围折回去（LM-63 的对称约定）：只量到 90° 是四个象限对称，180° 是左右对称，360° 是完整的一圈。
 */
function foldHorizontal(phi: number, last: number): number {
  if (last >= 360 || last <= 0) return phi;
  if (last <= 90) {
    const half = phi % 180;
    return half > 90 ? 180 - half : half;
  }
  return phi > 180 ? 360 - phi : phi;
}

/** 测量的格子上按双线性插值取一个方向（垂直角在测量范围外是 0：灯不往那边发光）。 */
function sample(candela: readonly (readonly number[])[], verticals: readonly number[], horizontals: readonly number[], theta: number, phi: number): number {
  if (theta < verticals[0]! - 1e-6 || theta > verticals[verticals.length - 1]! + 1e-6) return 0;
  const [v0, v1, tv] = bracket(verticals, theta);
  const [h0, h1, th] = bracket(horizontals, phi);
  const at = (h: number, v: number) => candela[h]![v]!;
  const low = at(h0, v0) + (at(h1, v0) - at(h0, v0)) * th;
  const high = at(h0, v1) + (at(h1, v1) - at(h0, v1)) * th;
  return low + (high - low) * tv;
}

/** 升序的角度表里 x 落在哪两格之间、比例多少（表外夹到两端）。 */
function bracket(angles: readonly number[], x: number): [number, number, number] {
  if (angles.length === 1 || x <= angles[0]!) return [0, 0, 0];
  const last = angles.length - 1;
  if (x >= angles[last]!) return [last, last, 0];
  let i = 0;
  while (angles[i + 1]! < x) i++;
  const span = angles[i + 1]! - angles[i]!;
  return [i, i + 1, span > 0 ? (x - angles[i]!) / span : 0];
}
