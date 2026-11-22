/**
 * 调色的查找表（LUT）：.cube 文件（Adobe 的 Cube LUT 规范 1.0，DaVinci Resolve、Premiere、Photoshop、OCIO 都能导出），场景的
 * `postEffects.colorGrading.lut` 引用它，色调映射之后按显示空间（sRGB 编码后的 0..1）的颜色查三维表（rendering/postfx/ToneMap.ts）。
 * 表是采样数据，编辑器只导入、不做创作工具（调色在 colorGrading 的参数里调）。
 *
 * 格式：文本，`#` 起是注释；关键字 TITLE、LUT_3D_SIZE N（2..256）、DOMAIN_MIN、DOMAIN_MAX（默认 0 和 1）；之后 N³ 行
 * "r g b"，红变得最快、蓝最慢——正好是三维贴图的 x、y、z。一维表（LUT_1D_SIZE）不支持。
 */

/** 解析好的三维表。 */
export interface ColorLut {
  /** 资源的内容路径（报错、比较用）。 */
  readonly path: string;
  readonly size: number;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  /** size³ 个 RGBA（A 是 1），红最快、蓝最慢。 */
  readonly rgba: Float32Array;
}

/** 加载过的表，按内容路径（ContentManager.loadColorLut 登记；后处理按场景设置里的路径取，同 LightProfile 的全局表）。 */
const loaded = new Map<string, ColorLut>();

export function registerColorLut(lut: ColorLut): ColorLut {
  loaded.set(lut.path, lut);
  return lut;
}

/** 加载过的表；没加载（还在加载、路径写错）时是 undefined。 */
export function colorLutAt(path: string): ColorLut | undefined {
  return loaded.get(path);
}

/** 解析 .cube 的文本；where 用在报错里。 */
export function parseCubeLut(text: string, path: string, where = path): ColorLut {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  let rgba: Float32Array | undefined;
  let count = 0;
  const triple = (parts: string[], line: number): [number, number, number] => {
    const values = parts.slice(0, 3).map(Number);
    if (parts.length < 3 || values.some((v) => !Number.isFinite(v))) throw new Error(`${where}:${line}: expected three numbers, got "${parts.join(' ')}"`);
    return values as [number, number, number];
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.replace(/#.*$/, '').trim();
    if (trimmed === '') continue;
    const parts = trimmed.split(/\s+/);
    const keyword = parts[0]!;
    if (/^[A-Z_]/.test(keyword)) {
      if (keyword === 'LUT_3D_SIZE') {
        size = Number(parts[1]);
        if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error(`${where}:${i + 1}: LUT_3D_SIZE must be an integer from 2 to 256, got ${parts[1]}`);
        rgba = new Float32Array(size ** 3 * 4);
      } else if (keyword === 'LUT_1D_SIZE') {
        throw new Error(`${where}:${i + 1}: 1D LUTs are not supported, export a 3D LUT (LUT_3D_SIZE)`);
      } else if (keyword === 'DOMAIN_MIN') {
        domainMin = triple(parts.slice(1), i + 1);
      } else if (keyword === 'DOMAIN_MAX') {
        domainMax = triple(parts.slice(1), i + 1);
      }
      // TITLE 和别的工具自己加的关键字不管
      continue;
    }
    if (!rgba) throw new Error(`${where}:${i + 1}: table data before LUT_3D_SIZE`);
    if (count >= size ** 3) throw new Error(`${where}:${i + 1}: more than ${size}³ = ${size ** 3} table entries`);
    rgba.set([...triple(parts, i + 1), 1], count * 4);
    count++;
  }
  if (!rgba) throw new Error(`${where}: no LUT_3D_SIZE`);
  if (count !== size ** 3) throw new Error(`${where}: expected ${size}³ = ${size ** 3} table entries, got ${count}`);
  if (domainMin.some((v, k) => v >= domainMax[k]!)) throw new Error(`${where}: DOMAIN_MIN must be below DOMAIN_MAX`);
  return { path, size, domainMin, domainMax, rgba };
}
