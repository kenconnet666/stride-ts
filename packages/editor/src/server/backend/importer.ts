/**
 * 导入（编辑器的资源浏览器拖进来的文件、MCP 的 import_file、import_material）：源文件放进内容目录，旁边写上资源文件——音频是
 * 声音，图片和视频是贴图（位图旁边一份默认的导入设置），模型经导入器成模型、材质、贴图、骨架、动画，字体编成运行时字体，高斯泼溅
 * 转成 .splat，配光曲线、查找表原样放；一套扫描的材质合成一个材质。名字取文件名，重名的加数字。
 *
 * 写文件、刷新资源数据库、烘（源模型、贴图的导入设置）都经后端（ImportHost），排在后端的同一条队列里。
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { DEFAULT_IMAGE_IMPORT, DEFAULT_MODEL_IMPORT, isVideoEncoding, TEXTURE_EXTENSIONS, type ImageImportFile, type ModelImportFile, type ModelSourceFormat, type TextureEncoding } from '@stride-ts/engine/content-format';
import { parseCubeLut } from '@stride-ts/engine/color-lut';
import { parseIes } from '@stride-ts/engine/light-profile';
import type { StrideTools } from '@stride-ts/native/tools';
import { convertSplats, importFontFile, isFontFile, isSourceModel, SPLAT_SOURCE_EXTENSIONS } from '@stride-ts/pipeline';
import { materialSet, scannedMaterial, SRGB_ROLES, type MaterialCredit, type MaterialMapRole } from '../../shared/materialSet.ts';
import type { AssetKind, ImportResult } from '../../shared/protocol.ts';
import { assetFileName, type AssetDatabase } from './AssetDatabase.ts';
import { checkContentPath, writeAtomically } from './files.ts';
import { HttpError } from './http.ts';

/** 一套扫描的材质的选项：名字（默认按文件名认出的）、贴图铺多少米、贴图最大边长、来源和许可。 */
export interface MaterialSetOptions {
  readonly name?: string | undefined;
  readonly tileSize?: number | undefined;
  readonly maxSize?: number | undefined;
  readonly credit?: MaterialCredit | undefined;
}

/** 烘一次导入设置的结果：写了的文件，导入源模型时的警告和动画剪辑。 */
export interface ImportBaked {
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  readonly animations?: ImportResult['animations'];
}

/** 导入要用的后端的几样东西。 */
export interface ImportHost {
  readonly contentDir: string;
  readonly database: AssetDatabase;
  /** 原生的导入工具（第一次用时建）。 */
  tools(): Promise<StrideTools>;
  /** 排进后端的队列（和存盘、文件变化一个一个来）。 */
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  /** 这些文件（相对内容目录）变了：刷新数据库、通知前端。 */
  refresh(files: readonly string[]): Promise<void>;
  /** 照导入设置烘（源模型导入成模型、位图压成 KTX2）。 */
  bake(kind: 'modelImport' | 'imageImport', assetPath: string, settings: ModelImportFile | ImageImportFile): Promise<ImportBaked>;
}

export class Importer {
  readonly #host: ImportHost;

  constructor(host: ImportHost) {
    this.#host = host;
  }

  /** folder 下名字是 base（重名时 base2、base3……）、这几种资源都还没有的内容路径。 */
  #freePath(folder: string, base: string, kinds: readonly AssetKind[]): string {
    for (let n = 1; ; n++) {
      const assetPath = `${folder ? `${folder}/` : ''}${base}${n === 1 ? '' : n}`;
      if (kinds.every((kind) => !this.#host.database.get(kind, assetPath))) return assetPath;
    }
  }

  #relative(file: string): string {
    return path.relative(this.#host.contentDir, file).split(path.sep).join('/');
  }

  /**
   * 高斯泼溅（3DGS 的 .ply，标准的或 SuperSplat 的压缩格式；Niantic 的 .spz；PlayCanvas 的 .sog）转成运行时的 .splat 放进 folder（只留转好的：.ply 动辄上百 MB）；
   * 认不出时什么也不写。
   */
  async #importSplats(folder: string, base: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    let converted: Uint8Array;
    try {
      converted = (await convertSplats(await this.#host.tools(), bytes, fileName)).bytes;
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return this.#host.enqueue(async () => {
      const assetPath = this.#freePath(folder, base, ['splats']);
      const file = path.join(this.#host.contentDir, assetFileName('splats', assetPath));
      await writeAtomically(file, converted);
      await this.#host.refresh([this.#relative(file)]);
      return { asset: this.#host.database.get('splats', assetPath)!, warnings: [] };
    });
  }

  /**
   * 原样放进 folder 的文本资源（配光曲线 .ies、调色的查找表 .cube）：先用 validate 解析一遍，格式不对时什么也不写。
   */
  async #importAsIs(kind: 'lightProfile' | 'lut', validate: (text: string) => unknown, folder: string, base: string, bytes: Uint8Array): Promise<ImportResult> {
    try {
      validate(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return this.#host.enqueue(async () => {
      const assetPath = this.#freePath(folder, base, [kind]);
      const file = path.join(this.#host.contentDir, assetFileName(kind, assetPath));
      await writeAtomically(file, bytes);
      await this.#host.refresh([this.#relative(file)]);
      return { asset: this.#host.database.get(kind, assetPath)!, warnings: [] };
    });
  }

  /**
   * 导入一个拖进来的文件（编辑器的资源浏览器）：源文件原样放进 folder，旁边写上它的资源文件——音频（mp3、ogg、wav、flac、aac）
   * 是声音（.sound.json，不流式、不空间化，属性面板里再改），图片（png、jpg、svg）是单独引用的贴图（.texture.json）；模型
   * （glb、gltf、fbx、obj）经导入器（pipeline 的 importSourceModel，原生的场景导入）成模型、材质、贴图；字体（ttf、otf、ttc）
   * 编成运行时字体（pipeline 的 importFontFile，字形轮廓按码位分块）。名字取文件名，重名的加数字。返回新资源和导入时的警告。
   */
  async importFile(folder: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    if (folder !== '') checkContentPath(folder);
    if (isSourceModel(fileName)) return this.#importModel(folder, fileName, bytes);
    if (isFontFile(fileName)) {
      return this.#importConverted('font', folder, fileName, async (tools, name) => {
        const { font, files } = await importFontFile(tools, bytes, { fileName, folder, name });
        return { asset: font, files, warnings: [] };
      });
    }
    const extension = path.extname(fileName).toLowerCase();
    const base = path.basename(fileName, path.extname(fileName)).replace(/[^A-Za-z0-9_-]+/g, '') || 'Imported';
    if (extension === '.ies') return this.#importAsIs('lightProfile', (text) => parseIes(text, fileName), folder, base, bytes);
    if (extension === '.cube') return this.#importAsIs('lut', (text) => parseCubeLut(text, base, fileName), folder, base, bytes);
    if (SPLAT_SOURCE_EXTENSIONS.includes(extension)) return this.#importSplats(folder, base, fileName, bytes);
    const audio = ({ '.mp3': 'mp3', '.ogg': 'ogg', '.wav': 'wav', '.flac': 'flac', '.aac': 'aac' } as const)[extension as '.mp3'];
    // 视频（mp4、webm）同图片一样是贴图：材质、精灵的贴图槽直接用它，放起来是视频贴图
    const image = ({ '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.svg': 'svg', '.webp': 'webp', '.mp4': 'mp4', '.webm': 'webm' } as const)[extension as '.png'];
    if (!audio && !image) {
      throw new HttpError(400, `cannot import ${fileName}: only audio (mp3, ogg, wav, flac, aac), images (png, jpg, webp, svg), videos (mp4, webm), models (glb, gltf, fbx, obj), fonts (ttf, otf, ttc), IES light profiles, color LUTs (cube) and Gaussian splats (ply) can be imported`);
    }
    const kind: AssetKind = audio ? 'sound' : 'texture';
    return this.#host.enqueue(async () => {
      const assetPath = this.#freePath(folder, base, [kind, audio ? 'audio' : 'image']);
      const source = path.join(this.#host.contentDir, audio ? `${assetPath}.${audio}` : assetPath + TEXTURE_EXTENSIONS[image!]);
      const main = path.join(this.#host.contentDir, assetFileName(kind as 'sound', assetPath));
      await writeAtomically(source, bytes);
      await writeAtomically(main, JSON.stringify(audio
        ? { name: path.basename(assetPath), encoding: audio, streamFromDisk: false, spatialized: false }
        : { texture: assetPath, encoding: image }, null, 1));
      // 位图旁边写一份默认的导入设置（不压缩）：属性面板里改了就压成 KTX2
      // image 的类型是从扩展名表里按 '.png' 取的（只剩 'png'），这里按真正的几种比
      const bitmap = image as ImageImportFile['source'] | 'svg' | undefined;
      const settings = bitmap && bitmap !== 'svg' && !isVideoEncoding(bitmap as TextureEncoding) ? path.join(this.#host.contentDir, assetFileName('imageImport', assetPath)) : undefined;
      if (settings) await writeAtomically(settings, JSON.stringify({ source: bitmap as ImageImportFile['source'], ...DEFAULT_IMAGE_IMPORT } satisfies ImageImportFile, null, 1));
      await this.#host.refresh([this.#relative(source), this.#relative(main), ...(settings ? [this.#relative(settings)] : [])]);
      return { asset: this.#host.database.get(kind, assetPath)!, warnings: [] };
    });
  }

  /**
   * 导入一套扫描的材质（materialSet.ts）：各张贴图放进 `<folder>/<name>/`（`<name>_<用途>.<扩展名>`，旁边有同名的贴图资源，节点图用），导入设置是压成 UASTC 的
   * KTX2、带 mipmap、长边最多 maxSize（颜色贴图按 sRGB，其余线性），当场几张一起压好；金属度贴图取平均当金属度；再写
   * `<folder>/<name>.material.json`。高度、不透明度贴图还没有槽，跳过并警告。名字和已有的材质重复时加数字。
   */
  importMaterialSet(folder: string, files: readonly { readonly name: string; readonly bytes: Uint8Array }[], options: MaterialSetOptions = {}): Promise<ImportResult> {
    if (folder !== '') checkContentPath(folder);
    const set = materialSet(files.map((file) => file.name));
    if (!set) throw new HttpError(400, `not a material set: need a color map and at least one more map with the same prefix (got ${files.map((file) => file.name).join(', ')})`);
    return this.#host.enqueue(async () => {
      const base = (options.name ?? set.name).replace(/[^A-Za-z0-9_-]+/g, '') || 'Scanned';
      let name = base;
      for (let n = 2; this.#host.database.get('material', folder ? `${folder}/${name}` : name); n++) name = `${base}${n}`;
      const dir = folder ? `${folder}/${name}` : name;
      const warnings: string[] = [];
      const textures: Partial<Record<MaterialMapRole, string>> = {};
      const written: string[] = [];
      const encodes: { readonly assetPath: string; readonly settings: ImageImportFile }[] = [];
      let metalness: number | undefined;
      for (const map of set.maps) {
        const file = files.find((candidate) => candidate.name === map.fileName)!;
        if (map.role === 'height' || map.role === 'opacity') {
          warnings.push(`${map.fileName}: ${map.role} maps have no material slot yet, skipped`);
          continue;
        }
        const extension = path.extname(map.fileName).toLowerCase();
        const source = ({ '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' } as const)[extension as '.png'];
        if (map.role === 'metalness') {
          const tools = await this.#host.tools();
          const image = await tools.decodeImage(file.bytes);
          let sum = 0;
          for (let i = 0; i < image.pixels.length; i += 4) sum += image.pixels[i]!;
          metalness = Math.round((sum / (image.pixels.length / 4) / 255) * 100) / 100;
          if (metalness > 0.1 && metalness < 0.9) warnings.push(`${map.fileName}: the metalness map is not uniform (average ${metalness}); a single metalness value is used`);
          continue;
        }
        const assetPath = `${dir}/${name}_${map.role}`;
        await writeAtomically(path.join(this.#host.contentDir, assetPath + TEXTURE_EXTENSIONS[source]), file.bytes);
        const settings: ImageImportFile = { source, compress: 'uastc', mipmaps: true, maxSize: options.maxSize ?? 2048, srgb: SRGB_ROLES.has(map.role) };
        const settingsFile = assetFileName('imageImport', assetPath);
        await writeAtomically(path.join(this.#host.contentDir, settingsFile), JSON.stringify(settings, null, 1));
        // 同名的贴图资源：材质节点图的贴图、三平面投影节点引用的是它（材质的固定槽直接引用图片）
        const textureFile = assetFileName('texture', assetPath);
        await writeAtomically(path.join(this.#host.contentDir, textureFile), JSON.stringify({ texture: assetPath, srgb: settings.srgb }, null, 1));
        written.push(this.#relative(path.join(this.#host.contentDir, assetPath + TEXTURE_EXTENSIONS[source])), settingsFile, textureFile);
        encodes.push({ assetPath, settings });
        textures[map.role] = assetPath;
      }
      // 几张贴图一起压：每张是原生任务系统上的一个任务（Basis 的编码单线程，一张 1K 带 mipmap 二三十秒），并行时三张差不多一张的时间
      for (const baked of await Promise.all(encodes.map(({ assetPath, settings }) => this.#host.bake('imageImport', assetPath, settings)))) written.push(...baked.files);
      const material = scannedMaterial(name, textures, { ...(options.tileSize !== undefined ? { tileSize: options.tileSize } : {}), ...(metalness !== undefined ? { metalness } : {}), ...(options.credit ? { credit: options.credit } : {}) });
      const main = assetFileName('material', folder ? `${folder}/${name}` : name);
      await writeAtomically(path.join(this.#host.contentDir, main), JSON.stringify(material, null, 1));
      await this.#host.refresh([...written, main]);
      return { asset: this.#host.database.get('material', folder ? `${folder}/${name}` : name)!, warnings };
    });
  }

  /**
   * 导入源模型：源文件放进 folder（`<名字>.<格式>`），旁边写一份默认的导入设置（`<名字>.import.json`），照设置导入成同名的
   * 模型（连材质、贴图、骨架、动画；#bake）。名字不和已有的模型、导入设置重复。导入不了时什么也不留。
   */
  #importModel(folder: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    return this.#host.enqueue(async () => {
      const source = path.extname(fileName).slice(1).toLowerCase() as ModelSourceFormat;
      const base = fileName.slice(0, fileName.length - path.extname(fileName).length).replace(/[^A-Za-z0-9_-]+/g, '') || 'Imported';
      const assetPath = this.#freePath(folder, base, ['model', 'modelImport']);
      const settings: ModelImportFile = { source, ...DEFAULT_MODEL_IMPORT };
      const sourceFile = `${assetPath}.${source}`;
      await writeAtomically(path.join(this.#host.contentDir, sourceFile), bytes);
      let baked: ImportBaked;
      try {
        baked = await this.#host.bake('modelImport', assetPath, settings);
      } catch (error) {
        await rm(path.join(this.#host.contentDir, sourceFile), { force: true });
        throw new HttpError(400, (error as Error).message);
      }
      const main = assetFileName('modelImport', assetPath);
      await writeAtomically(path.join(this.#host.contentDir, main), JSON.stringify(settings, null, 1));
      await this.#host.refresh([sourceFile, main, ...baked.files]);
      const animations = baked.animations ?? [];
      return { asset: this.#host.database.get('model', assetPath)!, warnings: [...baked.warnings], ...(animations.length > 0 ? { animations } : {}) };
    });
  }

  /**
   * 要转换的文件（字体）：convert 用原生的导入工具在内存里做好资源的全部文件，名字不和已有的同类资源重复，一起写进内容目录。
   */
  async #importConverted(
    kind: AssetKind,
    folder: string,
    fileName: string,
    convert: (tools: StrideTools, name: string) => Promise<{
      readonly asset: string; readonly files: readonly { readonly path: string; readonly content: Uint8Array | string }[]; readonly warnings: readonly string[];
      readonly animations?: ImportResult['animations'];
    }>,
  ): Promise<ImportResult> {
    const tools = await this.#host.tools();
    return this.#host.enqueue(async () => {
      const base = fileName.slice(0, fileName.length - path.extname(fileName).length).replace(/[^A-Za-z0-9_-]+/g, '') || 'Imported';
      let name = base;
      for (let n = 2; this.#host.database.get(kind, folder ? `${folder}/${name}` : name); n++) name = `${base}${n}`;
      let converted;
      try {
        converted = await convert(tools, name);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      for (const file of converted.files) await writeAtomically(path.join(this.#host.contentDir, file.path), file.content);
      await this.#host.refresh(converted.files.map((file) => file.path));
      const animations = converted.animations ?? [];
      return { asset: this.#host.database.get(kind, converted.asset)!, warnings: [...converted.warnings], ...(animations.length > 0 ? { animations } : {}) };
    });
  }
}
