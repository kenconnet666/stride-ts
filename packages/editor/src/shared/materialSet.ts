/**
 * 扫描的材质（路线图 R4：采样数据的导入）：一组贴图（ambientCG、Poly Haven、Quixel、Substance 导出的那种）按文件名认出各是什么，
 * 合成一个材质。编辑器的资源浏览器拖进来一组图片、MCP 的 import_material 都走这里；后端（EditorBackend.importMaterialSet）把
 * 各张图导入成压缩的贴图，再写材质文件。
 *
 * 认文件名：去掉扩展名和分辨率（_1K、_2k、-4K），取最后一个 _ 或 - 后面的词（不分大小写）；共同的前缀当材质名。
 */
import type { MaterialFile, TextureSlot } from '@stride-ts/engine';

/** 一张贴图在材质里的用途。 */
export type MaterialMapRole = 'baseColor' | 'normalGl' | 'normalDx' | 'roughness' | 'glossiness' | 'metalness' | 'occlusion' | 'height' | 'opacity';

const ROLE_WORDS: Readonly<Record<string, MaterialMapRole>> = {
  color: 'baseColor', albedo: 'baseColor', basecolor: 'baseColor', base: 'baseColor', diff: 'baseColor', diffuse: 'baseColor', col: 'baseColor',
  normalgl: 'normalGl', norgl: 'normalGl', nor_gl: 'normalGl', normal: 'normalGl', nrm: 'normalGl', norm: 'normalGl',
  normaldx: 'normalDx', nordx: 'normalDx', nor_dx: 'normalDx',
  roughness: 'roughness', rough: 'roughness', rgh: 'roughness',
  glossiness: 'glossiness', gloss: 'glossiness',
  metalness: 'metalness', metallic: 'metalness', metal: 'metalness', mtl: 'metalness',
  ambientocclusion: 'occlusion', ao: 'occlusion', occlusion: 'occlusion',
  displacement: 'height', disp: 'height', height: 'height', bump: 'height',
  opacity: 'opacity', alpha: 'opacity', mask: 'opacity',
};

/** 数据贴图（法线、粗糙度……）按线性存，颜色贴图按 sRGB。 */
export const SRGB_ROLES: ReadonlySet<MaterialMapRole> = new Set(['baseColor']);

/** 认出的一张：文件名、用途、去掉用途和分辨率以后剩的前缀。 */
export interface MaterialMap {
  readonly fileName: string;
  readonly role: MaterialMapRole;
  readonly prefix: string;
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

/** 认一个文件名；不是图片、认不出用途时是 undefined。 */
export function classifyMap(fileName: string): MaterialMap | undefined {
  if (!IMAGE.test(fileName)) return undefined;
  const stem = fileName.replace(IMAGE, '').replace(/[_-]\d+k$/i, '');
  // nor_gl、nor_dx 带着下划线，先按两个词认
  for (const words of [2, 1]) {
    const parts = stem.split(/[_-]/);
    if (parts.length <= words) continue;
    const key = parts.slice(-words).join(words === 2 ? '_' : '').toLowerCase();
    const role = ROLE_WORDS[key];
    if (role) return { fileName, role, prefix: parts.slice(0, -words).join('_') };
  }
  return undefined;
}

/**
 * 一批文件是不是一套材质：至少有颜色贴图和另一张认得出的贴图，前缀都一样。是的话返回各张（每种用途一张）和材质名；
 * 认不出的文件不算进来（调用方按普通的图片导入）。
 */
export function materialSet(fileNames: readonly string[]): { readonly name: string; readonly maps: readonly MaterialMap[] } | undefined {
  const maps = fileNames.map(classifyMap).filter((map) => map !== undefined);
  const prefixes = new Set(maps.map((map) => map.prefix));
  if (prefixes.size !== 1 || !maps.some((map) => map.role === 'baseColor') || maps.length < 2) return undefined;
  const byRole = new Map(maps.map((map) => [map.role, map]));
  // 两种法线、粗糙度和光泽度都给了时各留一张（OpenGL 的法线、粗糙度），不导入用不上的贴图
  if (byRole.has('normalGl')) byRole.delete('normalDx');
  if (byRole.has('roughness')) byRole.delete('glossiness');
  const name = [...prefixes][0]!.replace(/[^A-Za-z0-9_-]+/g, '') || 'Scanned';
  return { name, maps: [...byRole.values()] };
}

/** 材质的来源和署名（可商用的免费许可也要记：CC0 不要求署名，照样写上从哪来的）。 */
export interface MaterialCredit {
  readonly source: string;
  readonly license: string;
  readonly author?: string | undefined;
}

/** 视差的最深处默认多深（米）：扫描的高度贴图都拉满了 0..1，看不出实际的深浅，按砖缝、石板的起伏给 1 厘米。 */
export const PARALLAX_DEPTH = 0.01;

/**
 * 按各用途的贴图（内容路径）写材质文件。tileSize 是贴图在世界里铺多大（米，扫描的材质一般标着，ambientCG 多是 1～2 米）：
 * 生成的模型（白盒、多边形）的 UV 是按米的世界坐标投影，所以 scale = 1 / tileSize；metalness 是金属度贴图的平均（我们没有单独的
 * 金属度贴图槽，金属度在一套扫描材质里几乎总是整片的 0 或 1）；parallax 是高度并进了法线贴图的 alpha 时视差的最深处（米：白盒、多边形的 UV 按米，
 * 贴图坐标的单位就是米）。
 */
export function scannedMaterial(name: string, textures: Partial<Record<MaterialMapRole, string>>, options: { readonly tileSize?: number; readonly metalness?: number; readonly credit?: MaterialCredit; readonly parallax?: number } = {}): MaterialFile {
  const scale = 1 / (options.tileSize ?? 1);
  const slot = (texture: string): TextureSlot => ({ texture, scale: [scale, scale], offset: [0, 0], filter: 'anisotropic' });
  const normal = textures.normalGl ?? textures.normalDx;
  const rough = textures.roughness ?? textures.glossiness;
  return {
    name,
    baseColor: [1, 1, 1, 1],
    ...(textures.baseColor ? { baseColorTexture: { ...slot(textures.baseColor), srgb: true } } : {}),
    metalness: options.metalness ?? 0,
    roughness: 1,
    ...(rough ? { glossinessTexture: { ...slot(rough), srgb: false, channel: 'r' as const, invert: textures.roughness !== undefined } } : {}),
    // DirectX 的法线贴图绿色通道朝下，翻过来
    // 高度在法线贴图的 alpha 里时开视差
    ...(normal ? { normalMap: { ...slot(normal), srgb: false, scaleAndBias: true, isXYNormal: false, invertY: normal === textures.normalDx, ...(options.parallax ? { parallax: { depth: options.parallax } } : {}) } } : {}),
    ...(textures.occlusion ? { ambientOcclusion: { value: 1, texture: { ...slot(textures.occlusion), srgb: false, channel: 'r' as const }, directLighting: 0 } } : {}),
    ...(options.credit ? { credit: { source: options.credit.source, license: options.credit.license, ...(options.credit.author ? { author: options.credit.author } : {}) } } : {}),
  };
}
