/**
 * 编辑器的后端：一个工程的清单、资源数据库和对前端的 HTTP 接口（约定见 ../protocol.ts）。它不自己开服务器、不自己监视
 * 文件：挂在开发服务器上（vite.ts），文件变化由宿主报进来（fileChanged）。
 *
 * 安全：接口能写工程里的文件，所以只认本机的同源页面——Host 必须是回环地址（挡住 DNS 重绑定），带 Origin 的必须和 Host
 * 一致，而且每个请求要带 EDITOR_HEADER（跨源的页面带自定义头会先发预检，这里不回 CORS 头，预检过不了）。
 */
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { checkWorldFile, placeInCells, worldCellPath, DEFAULT_IMAGE_IMPORT, DEFAULT_MODEL_IMPORT, EXTENSIONS, isProceduralModel, isVideoEncoding, parseProceduralModel, TEXTURE_EXTENSIONS, type BrushFile, type ImageImportFile, type ModelImportFile, type TextureEncoding, type ModelSourceFormat, type PolyMeshFile, type SdfFile, type SplineFile, type TreeFile, type BuildingFile, type TextModelFile, type SceneEntityFile, type SceneFile, type WorldFile, type WorldLayer } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { bakeBrushModel, bakePolyModel, bakeSdfModel, bakeSplineModel, bakeTextModel, bakeTreeModel, bakeBuildingModel, convertSplats, importFontFile, importSourceModel, isFontFile, isSourceModel, SPLAT_SOURCE_EXTENSIONS } from '@stride-ts/pipeline';
import { parseIes } from '@stride-ts/engine/light-profile';
import type { AssetKind } from '@stride-ts/engine/content-references';
import { EDITOR_API_PATH, type ImportResult, type AssetChanges, type AssetMove, type AssetRecord, type DeleteResult, type MoveRequest, type MoveResult } from '../protocol.ts';
import { AssetDatabase, assetFileName, assetKey } from './AssetDatabase.ts';
import { rewriteImageEncoding, rewriteReferences } from './rewrite.ts';
import { writeAssetTypes } from './assetTypes.ts';
import { loadProject, projectInfo, type Project } from './project.ts';

/** 导出的成片、图像序列放在工程的这个文件夹里（不提交）。 */
export const EXPORTS_DIR = 'exports';
const EXPORT_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'png']);

/** 每个接口请求都要带的头（值随意）。 */
export const EDITOR_HEADER = 'x-stride-editor';

/** 文件变化攒这么久（毫秒）一起处理：导入器、git 切分支一次会动很多文件。 */
const CHANGE_DELAY = 50;

/** 能经接口读写内容的种类：主文件是 JSON 的。 */
/** 能经接口读写的 JSON 资源。模型只有 JSON 写的那种（程序生成的形状，content/modelFile.ts）能，二进制的读、写都拒绝。 */
/** 编辑器后端烘成同名模型的资源种类（源头是 JSON，场景引用烘出的 .model）。 */
/** 编辑器后端照它烘出（导入）同名模型的资源：白盒、SDF、多边形网格、源模型的导入设置。 */
type BakedKind = 'brush' | 'sdf' | 'poly' | 'text' | 'spline' | 'tree' | 'building' | 'modelImport' | 'imageImport';
const isBakedKind = (kind: string): kind is BakedKind => kind === 'brush' || kind === 'sdf' || kind === 'poly' || kind === 'text' || kind === 'spline' || kind === 'tree' || kind === 'building' || kind === 'modelImport' || kind === 'imageImport';

const JSON_KINDS: ReadonlySet<string> = new Set(['material', 'scene', 'prefab', 'spriteSheet', 'skybox', 'font', 'texture', 'gameSettings', 'ui', 'sound', 'model', 'timeline', 'brush', 'sdf', 'poly', 'text', 'modelImport', 'imageImport', 'world', 'terrain', 'spline', 'tree', 'building', 'scatter', 'city', 'water']);

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class EditorBackend {
  readonly project: Project;
  readonly database: AssetDatabase;
  readonly #publicDir: string;
  readonly #listeners = new Set<(changes: AssetChanges) => void>();
  #pending = new Set<string>();
  /** 原生的导入工具（第一次导入模型时建）。 */
  #tools: Promise<StrideTools> | undefined;
  #timer: NodeJS.Timeout | undefined;
  /** 白盒、SDF 最近一次烘焙时的内容（`种类:路径` → JSON 文本）：文件监视报它变了时，内容一样（自己刚存、刚烘的）就不再烘。 */
  readonly #bakes = new Map<string, string>();
  /** 上一批变化处理到哪了：保存、下一批都排在它后面，数据库不会被两处同时改。 */
  #work: Promise<unknown> = Promise.resolve();

  private constructor(project: Project, publicDir: string) {
    this.project = project;
    this.database = new AssetDatabase(project.contentDir);
    this.#publicDir = publicDir;
  }

  /** 打开工程：读清单、扫内容目录、生成资源句柄。publicDir 是开发服务器的静态目录。 */
  static async open(root: string, publicDir: string): Promise<EditorBackend> {
    const backend = new EditorBackend(await loadProject(root), publicDir);
    await backend.database.scan();
    await backend.#bakeStale();
    await backend.#writeAssetTypes();
    return backend;
  }

  /**
   * 开着的时候没看到的改动（开发服务器停着时 agent 直接写了文件、git 切了分支）：生成模型的资源（白盒、SDF、多边形、3D 文字、
   * 样条、树）打开工程时和上次烘的内容比（按内容的哈希，记在工程的 node_modules/.cache 里；文件的修改时间在新检出的工作树里
   * 靠不住），变了的补烘。没记过的：模型不在才烘，在就当它是对的、记下来。导入（源模型、贴图）慢，照旧等文件改了再导入。
   */
  async #bakeStale(): Promise<void> {
    this.#bakeHashes = await readFile(this.#bakeCacheFile, 'utf8').then((text) => JSON.parse(text) as Record<string, string>, () => ({}));
    const baked: string[] = [];
    for (const record of this.database.list()) {
      const kind = record.kind;
      if (!isBakedKind(kind) || kind === 'modelImport' || kind === 'imageImport') continue;
      const key = `${kind}:${record.path}`;
      try {
        const content: unknown = JSON.parse(await readFile(path.join(this.project.contentDir, assetFileName(kind, record.path)), 'utf8'));
        const hash = contentHash(content), known = this.#bakeHashes[key];
        if (known === hash) continue;
        if (known === undefined && existsSync(path.join(this.project.contentDir, record.path + EXTENSIONS.model))) {
          this.#bakeHashes[key] = hash;
          continue;
        }
        baked.push(...(await this.#bake(kind, record.path, content)).files);
      } catch (error) {
        console.warn(`[stride-editor] ${kind} ${record.path}: ${(error as Error).message}; its model is left as it was`);
      }
    }
    if (baked.length > 0) {
      console.info(`[stride-editor] baked ${baked.length} model(s) whose sources changed while the editor was closed`);
      await this.database.refresh(baked);
    }
    await this.#saveBakeHashes();
  }

  /** 上次烘的内容的哈希（`种类:路径` → 哈希），存在 #bakeCacheFile。 */
  #bakeHashes: Record<string, string> = {};

  get #bakeCacheFile(): string {
    return path.join(this.project.root, 'node_modules', '.cache', 'stride-editor', 'bakes.json');
  }

  /** 记下这次烘的内容（不重复烘同样的内容；下次打开工程时比较）。 */
  #recordBake(key: string, content: unknown): void {
    this.#bakes.set(key, JSON.stringify(content));
    this.#bakeHashes[key] = contentHash(content);
    void this.#saveBakeHashes();
  }

  async #saveBakeHashes(): Promise<void> {
    await mkdir(path.dirname(this.#bakeCacheFile), { recursive: true });
    await writeFile(this.#bakeCacheFile, JSON.stringify(this.#bakeHashes));
  }

  /** 资源变了以后调（参数是这一批里变了的资源）；返回取消登记的函数。 */
  onAssetsChanged(listener: (changes: AssetChanges) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 宿主的文件监视报：这个文件（绝对路径）加了、改了或者删了。内容目录以外的不管。 */
  fileChanged(file: string): void {
    const relative = path.relative(this.project.contentDir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return;
    this.#pending.add(relative.split(path.sep).join('/'));
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      const files = [...this.#pending];
      this.#pending = new Set();
      void this.#enqueue(() => this.#refresh(files));
    }, CHANGE_DELAY);
  }

  /** 等报进来的文件变化都处理完（测试和命令行用）。 */
  async settled(): Promise<void> {
    while (this.#timer !== undefined) await new Promise((resolve) => setTimeout(resolve, CHANGE_DELAY));
    await this.#work;
  }

  /** 读一个 JSON 资源的内容。 */
  /**
   * 解码一张贴图（内容路径）成 RGBA8 的像素：MCP 切精灵表用。读浏览器能解的那个文件（png、jpg、webp；压成 KTX2 的贴图用旁边的
   * 源图片），没有时报错。
   */
  async decodeImage(assetPath: string): Promise<{ width: number; height: number; data: Uint8Array }> {
    const record = this.database.get('image', checkContentPath(assetPath));
    const file = record?.files.find((name) => /\.(png|jpe?g|webp)$/i.test(name));
    if (!file) throw new HttpError(404, `no png, jpg or webp image at ${assetPath}`);
    const tools = await (this.#tools ??= createStrideTools());
    const image = await tools.decodeImage(await readFile(path.join(this.project.contentDir, file)));
    return { width: image.width, height: image.height, data: image.pixels };
  }

  /**
   * 新建一个世界（`.world.json`，content/formats/worldFormat.ts）：格子边长、图层，常驻场景（天空、太阳、全局的设置）可选；还没有格子。
   * 已经有了报 409。
   */
  async createWorld(assetPath: string, { cellSize = 256, layers = [{ name: 'default', loadRadius: 512 }], persistent }: { readonly cellSize?: number; readonly layers?: readonly WorldLayer[]; readonly persistent?: string } = {}): Promise<AssetRecord> {
    const world: WorldFile = { name: assetPath.slice(assetPath.lastIndexOf('/') + 1), cellSize, ...(persistent ? { persistent } : {}), layers: [...layers], cells: {} };
    return this.saveAsset('world', assetPath, world, { create: true });
  }

  /**
   * 往世界里放实体（编辑器的"在哪都能放东西"、agent 的 place_in_world）：根实体的 position 是世界坐标，按落在哪个格子分进那个
   * 格子的场景（没有就建），位置换成相对格子原点的，子实体跟着根走；世界的索引加上新格子。实体没有 id 时给一个。返回每个实体
   * 放进了哪个格子的场景。
   */
  async placeInWorld(worldPath: string, layer: string, entities: readonly SceneEntityFile[]): Promise<{ readonly entity: string; readonly name: string; readonly cell: readonly [number, number]; readonly scene: string }[]> {
    const world = checkWorldFile(await this.readAsset('world', worldPath), worldPath);
    if (!world.layers.some((l) => l.name === layer)) throw new HttpError(400, `world ${worldPath} has no layer '${layer}' (layers: ${world.layers.map((l) => l.name).join(', ')})`);
    const ids = new Map<string, string>();
    const withIds = entities.map((entity) => {
      const id = entity.id || crypto.randomUUID();
      ids.set(entity.id, id);
      return { ...entity, id, parent: entity.parent === null ? null : (ids.get(entity.parent) ?? entity.parent) };
    });
    let placements;
    try {
      placements = placeInCells(world, withIds);
    } catch (error) {
      throw new HttpError(400, `${worldPath}: ${(error as Error).message}`);
    }
    const placed: { entity: string; name: string; cell: readonly [number, number]; scene: string }[] = [];
    const cells = { ...world.cells };
    const listed = new Set((cells[layer] ?? []).map(([x, z]) => `${x}_${z}`));
    for (const { x, z, entities: cellEntities } of placements) {
      const scenePath = worldCellPath(worldPath, layer, x, z);
      const existing = this.database.get('scene', scenePath) ? (await this.readAsset('scene', scenePath)) as SceneFile : { name: `${x}_${z}`, entities: [] };
      await this.saveAsset('scene', scenePath, { ...existing, entities: [...existing.entities, ...cellEntities] });
      if (!listed.has(`${x}_${z}`)) {
        listed.add(`${x}_${z}`);
        cells[layer] = [...(cells[layer] ?? []), [x, z]];
      }
      for (const entity of cellEntities) placed.push({ entity: entity.id, name: entity.name, cell: [x, z], scene: scenePath });
    }
    if (cells !== world.cells) await this.saveAsset('world', worldPath, { ...world, cells });
    return placed;
  }

  async readAsset(kind: AssetKind, assetPath: string): Promise<unknown> {
    const file = this.#jsonFile(kind, assetPath);
    try {
      const bytes = await readFile(file);
      if (kind === 'model' && !isProceduralModel(bytes)) throw new HttpError(400, `model ${assetPath} is a binary model (imported); only JSON models (procedural shapes) can be read and saved`);
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `no ${kind} asset ${assetPath}`);
      throw error;
    }
  }

  /**
   * 保存一个 JSON 资源（新建或者覆盖；create 时只新建，已经有了报 409）：先写到旁边的临时文件再改名，读的人不会读到写了一半的；
   * 然后更新数据库、通知前端。格式同导入器写的（缩进 1 格），文件的差别只在改了的地方。模型要是合法的 JSON 模型。
   */
  async saveAsset(kind: AssetKind, assetPath: string, content: unknown, { create = false }: { readonly create?: boolean } = {}): Promise<AssetRecord> {
    const file = this.#jsonFile(kind, assetPath);
    if (content === null || typeof content !== 'object') throw new HttpError(400, `the content of a ${kind} asset must be a JSON object`);
    if (kind === 'model') {
      try {
        parseProceduralModel(new TextEncoder().encode(JSON.stringify(content)), assetPath);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    }
    if (kind === 'world') {
      try {
        checkWorldFile(content, assetPath);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
    }
    return this.#enqueue(async () => {
      if (create && this.database.get(kind, assetPath)) throw new HttpError(409, `${kind} ${assetPath} already exists`);
      // 白盒、SDF、导入设置先烘：形状、设置不对时报错、什么也不写（不留一个烘不出模型的源文件）
      const baked = isBakedKind(kind) ? await this.#bake(kind, assetPath, content).catch((error: unknown) => {
        throw new HttpError(400, (error as Error).message);
      }) : undefined;
      await writeAtomically(file, JSON.stringify(content, null, 1));
      await this.#refresh([this.#relative(file), ...(baked?.files ?? [])]);
      return this.database.get(kind, assetPath)!;
    });
  }

  /**
   * 高斯泼溅（3DGS 的 .ply，标准的或 SuperSplat 的压缩格式；Niantic 的 .spz；PlayCanvas 的 .sog）转成运行时的 .splat 放进 folder（只留转好的：.ply 动辄上百 MB）；
   * 认不出时什么也不写。
   */
  async #importSplats(folder: string, base: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    let converted: Uint8Array;
    try {
      converted = (await convertSplats(await (this.#tools ??= createStrideTools()), bytes, fileName)).bytes;
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return this.#enqueue(async () => {
      let assetPath = '';
      for (let n = 1; ; n++) {
        assetPath = `${folder ? `${folder}/` : ''}${base}${n === 1 ? '' : n}`;
        if (!this.database.get('splats', assetPath)) break;
      }
      const file = path.join(this.project.contentDir, assetFileName('splats', assetPath));
      await writeAtomically(file, converted);
      await this.#refresh([this.#relative(file)]);
      return { asset: this.database.get('splats', assetPath)!, warnings: [] };
    });
  }

  /** 配光曲线（IES 文件）原样放进 folder；先解析一遍，格式不对时什么也不写。 */
  async #importLightProfile(folder: string, base: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    try {
      parseIes(new TextDecoder().decode(bytes), fileName);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    return this.#enqueue(async () => {
      let assetPath = '';
      for (let n = 1; ; n++) {
        assetPath = `${folder ? `${folder}/` : ''}${base}${n === 1 ? '' : n}`;
        if (!this.database.get('lightProfile', assetPath)) break;
      }
      const file = path.join(this.project.contentDir, assetFileName('lightProfile', assetPath));
      await writeAtomically(file, bytes);
      await this.#refresh([this.#relative(file)]);
      return { asset: this.database.get('lightProfile', assetPath)!, warnings: [] };
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
    if (extension === '.ies') return this.#importLightProfile(folder, base, fileName, bytes);
    if (SPLAT_SOURCE_EXTENSIONS.includes(extension)) return this.#importSplats(folder, base, fileName, bytes);
    const audio = ({ '.mp3': 'mp3', '.ogg': 'ogg', '.wav': 'wav', '.flac': 'flac', '.aac': 'aac' } as const)[extension as '.mp3'];
    // 视频（mp4、webm）同图片一样是贴图：材质、精灵的贴图槽直接用它，放起来是视频贴图
    const image = ({ '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.svg': 'svg', '.webp': 'webp', '.mp4': 'mp4', '.webm': 'webm' } as const)[extension as '.png'];
    if (!audio && !image) {
      throw new HttpError(400, `cannot import ${fileName}: only audio (mp3, ogg, wav, flac, aac), images (png, jpg, webp, svg), videos (mp4, webm), models (glb, gltf, fbx, obj), fonts (ttf, otf, ttc), IES light profiles and Gaussian splats (ply) can be imported`);
    }
    const kind: AssetKind = audio ? 'sound' : 'texture';
    return this.#enqueue(async () => {
      let assetPath = '';
      for (let n = 1; ; n++) {
        assetPath = `${folder ? `${folder}/` : ''}${base}${n === 1 ? '' : n}`;
        if (!this.database.get(kind, assetPath) && !this.database.get(audio ? 'audio' : 'image', assetPath)) break;
      }
      const source = path.join(this.project.contentDir, audio ? `${assetPath}.${audio}` : assetPath + TEXTURE_EXTENSIONS[image!]);
      const main = path.join(this.project.contentDir, assetFileName(kind as 'sound', assetPath));
      await writeAtomically(source, bytes);
      await writeAtomically(main, JSON.stringify(audio
        ? { name: path.basename(assetPath), encoding: audio, streamFromDisk: false, spatialized: false }
        : { texture: assetPath, encoding: image }, null, 1));
      // 位图旁边写一份默认的导入设置（不压缩）：属性面板里改了就压成 KTX2
      // image 的类型是从扩展名表里按 '.png' 取的（只剩 'png'），这里按真正的几种比
      const bitmap = image as ImageImportFile['source'] | 'svg' | undefined;
      const settings = bitmap && bitmap !== 'svg' && !isVideoEncoding(bitmap as TextureEncoding) ? path.join(this.project.contentDir, assetFileName('imageImport', assetPath)) : undefined;
      if (settings) await writeAtomically(settings, JSON.stringify({ source: bitmap as ImageImportFile['source'], ...DEFAULT_IMAGE_IMPORT } satisfies ImageImportFile, null, 1));
      await this.#refresh([this.#relative(source), this.#relative(main), ...(settings ? [this.#relative(settings)] : [])]);
      return { asset: this.database.get(kind, assetPath)!, warnings: [] };
    });
  }

  /**
   * 导入源模型：源文件放进 folder（`<名字>.<格式>`），旁边写一份默认的导入设置（`<名字>.import.json`），照设置导入成同名的
   * 模型（连材质、贴图、骨架、动画；#bake）。名字不和已有的模型、导入设置重复。导入不了时什么也不留。
   */
  #importModel(folder: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    return this.#enqueue(async () => {
      const source = path.extname(fileName).slice(1).toLowerCase() as ModelSourceFormat;
      const base = fileName.slice(0, fileName.length - path.extname(fileName).length).replace(/[^A-Za-z0-9_-]+/g, '') || 'Imported';
      let assetPath = '';
      for (let n = 1; ; n++) {
        assetPath = `${folder ? `${folder}/` : ''}${base}${n === 1 ? '' : n}`;
        if (!this.database.get('model', assetPath) && !this.database.get('modelImport', assetPath)) break;
      }
      const settings: ModelImportFile = { source, ...DEFAULT_MODEL_IMPORT };
      const sourceFile = `${assetPath}.${source}`;
      await writeAtomically(path.join(this.project.contentDir, sourceFile), bytes);
      let baked: Baked;
      try {
        baked = await this.#bake('modelImport', assetPath, settings);
      } catch (error) {
        await rm(path.join(this.project.contentDir, sourceFile), { force: true });
        throw new HttpError(400, (error as Error).message);
      }
      const main = assetFileName('modelImport', assetPath);
      await writeAtomically(path.join(this.project.contentDir, main), JSON.stringify(settings, null, 1));
      await this.#refresh([sourceFile, main, ...baked.files]);
      const animations = baked.animations ?? [];
      return { asset: this.database.get('model', assetPath)!, warnings: [...baked.warnings], ...(animations.length > 0 ? { animations } : {}) };
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
    const tools = await (this.#tools ??= createStrideTools());
    return this.#enqueue(async () => {
      const base = fileName.slice(0, fileName.length - path.extname(fileName).length).replace(/[^A-Za-z0-9_-]+/g, '') || 'Imported';
      let name = base;
      for (let n = 2; this.database.get(kind, folder ? `${folder}/${name}` : name); n++) name = `${base}${n}`;
      let converted;
      try {
        converted = await convert(tools, name);
      } catch (error) {
        throw new HttpError(400, (error as Error).message);
      }
      for (const file of converted.files) await writeAtomically(path.join(this.project.contentDir, file.path), file.content);
      await this.#refresh(converted.files.map((file) => file.path));
      const animations = converted.animations ?? [];
      return { asset: this.database.get(kind, converted.asset)!, warnings: [...converted.warnings], ...(animations.length > 0 ? { animations } : {}) };
    });
  }

  /** 关掉后端时调：放掉原生的导入工具（导入过模型、字体时才有）。 */
  async close(): Promise<void> {
    (await this.#tools)?.shutdown();
    this.#tools = undefined;
  }

  /**
   * 移动、改名资源：引用它们的文件里的路径先改写成新的，再挪文件（字体连着字形块，声音连着同名的音频文件）。资源之间按
   * 路径引用（用户 2026-11-20 定），所以编辑器以外挪了文件，引用会断（数据库的 missing 报出来）。
   */
  async moveAssets(request: MoveRequest): Promise<MoveResult> {
    return this.#enqueue(async () => {
      const moves = this.#expandMoves(request);
      const changes = new Map(moves.map(({ kind, from, to }) => [assetKey(kind, from), to]));
      // 引用了挪走的资源的：按现在的位置改写（它自己也要挪的话，下面跟着挪）
      const referrers = new Map<string, AssetRecord>();
      for (const { kind, from } of moves) for (const record of this.database.referrers(kind, from)) referrers.set(assetKey(record.kind, record.path), record);
      const touched: string[] = [];
      const rewritten: AssetRecord[] = [];
      for (const record of referrers.values()) {
        const main = record.files[0];
        if (record.error !== undefined || main === undefined) continue;
        const file = path.join(this.project.contentDir, main);
        const content = await rewriteReferences(record.kind, file, changes);
        if (content === undefined) continue;
        await writeAtomically(file, content);
        touched.push(main);
        rewritten.push(record);
      }
      for (const { kind, from, to } of moves) {
        for (const file of this.database.get(kind, from)!.files) {
          const target = to + file.slice(from.length);
          await mkdir(path.dirname(path.join(this.project.contentDir, target)), { recursive: true });
          await rename(path.join(this.project.contentDir, file), path.join(this.project.contentDir, target));
          touched.push(file, target);
        }
      }
      await this.#removeEmptyFolders(touched);
      await this.#refresh(touched);
      // 改写过的资源自己也挪了的，报它的新位置
      const current = ({ kind, path }: AssetRecord) => this.database.get(kind, changes.get(assetKey(kind, path)) ?? path)!;
      return { moved: moves.map(({ kind, to }) => this.database.get(kind, to)!), rewritten: rewritten.map(current) };
    });
  }

  /** 删掉一个资源的文件（声音连着它的音频文件）。还有别的资源引用它时不删，除非 force。 */
  async deleteAsset(kind: AssetKind, assetPath: string, { force = false } = {}): Promise<DeleteResult> {
    return this.#enqueue(async () => {
      const record = this.database.get(kind, checkContentPath(assetPath));
      if (!record) throw new HttpError(404, `no ${kind} asset ${assetPath}`);
      const removing = [record, ...this.#companions(record)];
      const removed = new Set(removing.map((asset) => assetKey(asset.kind, asset.path)));
      const broken = removing.flatMap((asset) => this.database.referrers(asset.kind, asset.path)).filter((asset) => !removed.has(assetKey(asset.kind, asset.path)));
      if (broken.length > 0 && !force) {
        throw new HttpError(409, `${kind} ${assetPath} is referenced by ${broken.map((asset) => `${asset.kind} ${asset.path}`).join(', ')} (pass force to delete it anyway)`);
      }
      const files = removing.flatMap((asset) => asset.files);
      for (const file of files) await rm(path.join(this.project.contentDir, file), { force: true });
      await this.#removeEmptyFolders(files);
      await this.#refresh(files);
      return { removed: removing.map(({ kind, path }) => ({ kind, path })), broken: broken.map((asset) => this.database.get(asset.kind, asset.path) ?? asset) };
    });
  }

  /** 把请求展开成一个个资源的挪法并检查：要挪的都在，新路径合法、没被占，同一处不挪进两个。 */
  #expandMoves(request: MoveRequest): AssetMove[] {
    let moves: AssetMove[];
    if ('folder' in request) {
      const from = checkContentPath(request.folder), to = checkContentPath(request.to);
      if (to === from || to.startsWith(`${from}/`)) throw new HttpError(400, `cannot move the folder ${from} into itself (${to})`);
      moves = this.database.list().filter((asset) => asset.path.startsWith(`${from}/`)).map((asset) => ({ kind: asset.kind, from: asset.path, to: to + asset.path.slice(from.length) }));
      if (moves.length === 0) throw new HttpError(404, `no assets under ${from}`);
    } else {
      moves = request.assets.map(({ kind, from, to }) => ({ kind, from: checkContentPath(from), to: checkContentPath(to) }));
    }
    // 声音和它同名的音频文件一起挪（声音的文件里不写音频的路径）
    const keys = new Set(moves.map(({ kind, from }) => assetKey(kind, from)));
    for (const move of [...moves]) {
      const record = this.database.get(move.kind, move.from);
      if (!record) throw new HttpError(404, `no ${move.kind} asset ${move.from}`);
      for (const companion of this.#companions(record)) {
        if (!keys.has(assetKey(companion.kind, companion.path))) moves.push({ kind: companion.kind, from: companion.path, to: move.to });
      }
    }
    const targets = new Set<string>();
    for (const { kind, from, to } of moves) {
      const key = assetKey(kind, to);
      if (targets.has(key)) throw new HttpError(400, `two assets would move to ${kind} ${to}`);
      targets.add(key);
      // 已经有的不让占，哪怕它在这一批里也要挪走：文件是一个个改名的，互换会盖掉
      if (from !== to && this.database.get(kind, to)) throw new HttpError(409, `${kind} ${to} already exists`);
    }
    return moves.filter(({ from, to }) => from !== to);
  }

  /** 挪走、删掉文件以后，它们所在的文件夹空了的删掉（往上一直到内容目录，内容目录本身留着）。 */
  async #removeEmptyFolders(files: readonly string[]): Promise<void> {
    const folders = new Set(files.map((file) => path.posix.dirname(file)).filter((folder) => folder !== '.'));
    // 深的先删：删了子文件夹，父文件夹才可能空
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
      for (let current = folder; current !== '.'; current = path.posix.dirname(current)) {
        const absolute = path.join(this.project.contentDir, current);
        if ((await readdir(absolute).catch(() => [''])).length > 0) break;
        await rmdir(absolute);
      }
    }
  }

  /** 跟着这个资源一起挪、一起删的资源：声音和它同名的音频文件，白盒、SDF 和它们烘出的模型。 */
  /**
   * 和这个资源同名、跟着它挪、删的资源：声音的音频文件；白盒、SDF、多边形网格、导入设置烘出的模型，导入设置的源文件；反过来
   * 烘出的模型也带着它的源（不然挪了模型，源还会往原来的地方烘）。
   */
  #companions(record: AssetRecord): AssetRecord[] {
    const same = (...kinds: AssetKind[]) => kinds.map((kind) => this.database.get(kind, record.path)).filter((found) => found !== undefined);
    if (record.kind === 'sound') return same('audio');
    if (record.kind === 'imageImport') return same('image');
    if (record.kind === 'image') return same('imageImport');
    if (record.kind === 'modelImport') return same('model', 'modelSource');
    if (isBakedKind(record.kind)) return same('model');
    if (record.kind === 'model') return same('brush', 'sdf', 'poly', 'text', 'spline', 'tree', 'building', 'modelImport', 'modelSource');
    return [];
  }

  /** HTTP 接口；不是编辑器接口的请求交给 next。 */
  handle(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== EDITOR_API_PATH && !url.pathname.startsWith(`${EDITOR_API_PATH}/`)) return next();
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    this.#route(request, url).then((body) => reply(200, body), (error: unknown) => {
      reply(error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
    });
  }

  async #route(request: IncomingMessage, url: URL): Promise<unknown> {
    if (!trusted(request)) throw new HttpError(403, `forbidden: the editor API only answers same-origin pages on this machine that send the ${EDITOR_HEADER} header`);
    const route = `${request.method} ${url.pathname.slice(EDITOR_API_PATH.length)}`;
    if (route === 'GET /project') return projectInfo(this.project, this.#publicDir);
    if (route === 'GET /assets') {
      await this.#work;
      return this.database.list();
    }
    if (route === 'POST /move') return this.moveAssets(await readJson(request) as MoveRequest);
    if (route === 'POST /world/place') {
      const { world, layer, entities } = await readJson(request) as { world: string; layer: string; entities: SceneEntityFile[] };
      return this.placeInWorld(world, layer, entities);
    }
    if (route === 'POST /import') {
      const folder = url.searchParams.get('folder') ?? '', name = url.searchParams.get('name');
      if (!name) throw new HttpError(400, 'name (the dropped file name) is required');
      return this.importFile(folder, name, await readBytes(request));
    }
    if (route === 'PUT /image') {
      const assetPath = url.searchParams.get('path');
      if (!assetPath) throw new HttpError(400, 'path (the content path of the image, without extension) is required');
      return this.saveImage(assetPath, await readBytes(request));
    }
    if (route === 'POST /export') {
      const name = url.searchParams.get('name');
      if (!name) throw new HttpError(400, 'name (the file name under exports/) is required');
      return this.saveExport(name, await readBytes(request));
    }
    if (route === 'GET /asset' || route === 'PUT /asset' || route === 'DELETE /asset') {
      const kind = url.searchParams.get('kind'), assetPath = url.searchParams.get('path');
      if (!kind || !assetPath) throw new HttpError(400, 'kind and path are required');
      if (request.method === 'GET') return this.readAsset(kind as AssetKind, assetPath);
      if (request.method === 'DELETE') return this.deleteAsset(kind as AssetKind, assetPath, { force: url.searchParams.get('force') === '1' });
      return this.saveAsset(kind as AssetKind, assetPath, await readJson(request), { create: url.searchParams.get('create') === '1' });
    }
    throw new HttpError(404, `no route ${route}`);
  }

  /**
   * 写一张 png 图片（建新的或者覆盖）：在模型上画贴图时每一笔画完存遮罩。内容要是 png（看文件头）。返回图片资源的记录。
   */
  async saveImage(assetPath: string, bytes: Uint8Array): Promise<AssetRecord> {
    checkContentPath(assetPath);
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) throw new HttpError(400, `${assetPath}: the body is not a PNG file`);
    return this.#enqueue(async () => {
      const file = path.join(this.project.contentDir, assetPath + TEXTURE_EXTENSIONS.png);
      await writeAtomically(file, bytes);
      await this.#refresh([this.#relative(file)]);
      return this.database.get('image', assetPath)!;
    });
  }

  /**
   * 存一个导出的文件（成片、图像序列的一帧，见引擎的 offline/renderCommand.ts）到工程的 EXPORTS_DIR 下；name 是那里的相对路径
   * （可以带子文件夹），扩展名只能是 EXPORT_EXTENSIONS 里的。返回工程里的相对路径。导出的文件不是资源，不进内容目录。
   */
  async saveExport(name: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const extension = path.extname(name).slice(1).toLowerCase();
    if (!EXPORT_EXTENSIONS.has(extension)) throw new HttpError(400, `exports must be ${[...EXPORT_EXTENSIONS].join(', ')} files, got '${name}'`);
    const file = path.join(this.project.root, EXPORTS_DIR, checkContentPath(name));
    await writeAtomically(file, bytes);
    return { path: path.relative(this.project.root, file).split(path.sep).join('/'), bytes: bytes.length };
  }

  /** 一个 JSON 资源的主文件（绝对路径）；种类不对、路径想跑出内容目录时报错。 */
  #jsonFile(kind: AssetKind, assetPath: string): string {
    if (!JSON_KINDS.has(kind)) throw new HttpError(400, `${kind} assets cannot be read or saved through the editor API (not a JSON asset)`);
    return path.join(this.project.contentDir, assetFileName(kind as Exclude<AssetKind, 'image' | 'audio' | 'modelSource'>, checkContentPath(assetPath)));
  }

  #relative(file: string): string {
    return path.relative(this.project.contentDir, file).split(path.sep).join('/');
  }

  async #refresh(files: readonly string[]): Promise<void> {
    const changes = await this.database.refresh(files);
    if (changes.changed.length + changes.removed.length === 0) return;
    await this.#writeAssetTypes();
    for (const listener of this.#listeners) listener(changes);
    // 别处（agent 直接改文件、git 切分支）改了的白盒、SDF：重新烘它的模型
    const baked: string[] = [];
    for (const record of changes.changed) {
      const kind = record.kind;
      if (!isBakedKind(kind)) continue;
      try {
        const text = await readFile(path.join(this.project.contentDir, assetFileName(kind, record.path)), 'utf8');
        if (JSON.stringify(JSON.parse(text)) === this.#bakes.get(`${kind}:${record.path}`)) continue;
        baked.push(...(await this.#bake(kind, record.path, JSON.parse(text))).files);
      } catch (error) {
        console.warn(`[stride-editor] ${kind} ${record.path}: ${(error as Error).message}; its model is left as it was`);
      }
    }
    if (baked.length > 0) await this.#refresh(baked);
  }

  /**
   * 把白盒、SDF、多边形网格烘成同名的模型（pipeline 的 bakeBrushModel、bakeSdfModel、bakePolyModel），或者照导入设置把旁边的
   * 源模型导入成同名的模型（importSourceModel：连材质、贴图、骨架、动画；已经有的材质文件不动，导入以后可能改过）。写好文件，
   * 返回它们的相对路径（还没刷新数据库）和导入的警告、动画。形状、设置不对时报错。
   */
  async #bake(kind: BakedKind, assetPath: string, content: unknown): Promise<Baked> {
    const tools = await (this.#tools ??= createStrideTools());
    const where = `${kind} ${assetPath}`;
    if (kind === 'imageImport') return this.#encodeImage(assetPath, content as ImageImportFile);
    if (kind === 'modelImport') {
      const settings = content as ModelImportFile;
      const fileName = `${path.basename(assetPath)}.${settings.source}`;
      const bytes = await readFile(path.join(this.project.contentDir, `${assetPath}.${settings.source}`)).catch(() => {
        throw new Error(`${where}: the source file ${assetPath}.${settings.source} is missing`);
      });
      const folder = assetPath.includes('/') ? assetPath.slice(0, assetPath.lastIndexOf('/')) : '';
      const { files, warnings, animations } = await importSourceModel(tools, bytes, { fileName, folder, name: path.basename(assetPath), settings });
      const written: string[] = [];
      for (const file of files) {
        const target = path.join(this.project.contentDir, file.path);
        if (file.path.endsWith(EXTENSIONS.material) && existsSync(target)) continue;
        await writeAtomically(target, file.content);
        written.push(file.path);
      }
      this.#recordBake(`${kind}:${assetPath}`, content);
      return { files: written, warnings, animations };
    }
    const bytes = kind === 'brush' ? await bakeBrushModel(tools, content as BrushFile, where)
      : kind === 'sdf' ? await bakeSdfModel(tools, content as SdfFile, where)
      : kind === 'text' ? await bakeTextModel(tools, content as TextModelFile, (file) => readFile(path.join(this.project.contentDir, file)), where)
      : kind === 'spline' ? bakeSplineModel(tools, content as SplineFile, where)
      : kind === 'tree' ? bakeTreeModel(tools, content as TreeFile, where)
      : kind === 'building' ? bakeBuildingModel(tools, content as BuildingFile, where)
      : bakePolyModel(tools, content as PolyMeshFile, where);
    this.#recordBake(`${kind}:${assetPath}`, content);
    // 没有几何的（河道样条）：不写模型
    if (!bytes) return { files: [], warnings: [] };
    const model = assetPath + EXTENSIONS.model;
    await writeAtomically(path.join(this.project.contentDir, model), bytes);
    return { files: [model], warnings: [] };
  }

  /**
   * 照贴图的导入设置压缩：compress 不是 none 时解码源图片、按 maxSize 等比缩小（宽高补到 4 的倍数）、编成 Basis 的 KTX2 写在
   * 旁边；none 时删掉 KTX2。然后引用这张贴图的 JSON 文件改成读新的编码。返回写了、删了的文件。
   */
  async #encodeImage(assetPath: string, settings: ImageImportFile): Promise<Baked> {
    const where = `imageImport ${assetPath}`;
    if (!['png', 'jpeg', 'webp'].includes(settings.source)) throw new Error(`${where}: source must be png, jpeg or webp`);
    const ktx2 = assetPath + TEXTURE_EXTENSIONS.ktx2;
    const files: string[] = [ktx2];
    let encoding: TextureEncoding = settings.source;
    if (settings.compress === 'none') {
      await rm(path.join(this.project.contentDir, ktx2), { force: true });
    } else {
      const tools = await (this.#tools ??= createStrideTools());
      const bytes = await readFile(path.join(this.project.contentDir, assetPath + TEXTURE_EXTENSIONS[settings.source])).catch(() => {
        throw new Error(`${where}: the source image ${assetPath}${TEXTURE_EXTENSIONS[settings.source]} is missing`);
      });
      const image = await tools.decodeImage(bytes);
      const longest = Math.max(image.width, image.height);
      const fit = settings.maxSize > 0 && longest > settings.maxSize ? settings.maxSize / longest : 1;
      // 块压缩要整块：宽高补到 4 的倍数（同 Stride 的 TextureHelper.FindBestTextureSize）
      const width = Math.max(4, Math.ceil((image.width * fit) / 4) * 4), height = Math.max(4, Math.ceil((image.height * fit) / 4) * 4);
      const pixels = width === image.width && height === image.height ? image.pixels : await tools.resizeImage(image.pixels, image.width, image.height, width, height);
      await writeAtomically(path.join(this.project.contentDir, ktx2), await tools.encodeBasis(pixels, width, height, { mode: settings.compress, srgb: settings.srgb, mipmaps: settings.mipmaps }));
      encoding = 'ktx2';
    }
    for (const record of this.database.referrers('image', assetPath)) {
      const main = record.files[0];
      if (main === undefined) continue;
      const file = path.join(this.project.contentDir, main);
      const content = await rewriteImageEncoding(record.kind, file, assetPath, encoding);
      if (content === undefined) continue;
      await writeAtomically(file, content);
      files.push(main);
    }
    this.#recordBake(`imageImport:${assetPath}`, settings);
    return { files, warnings: [] };
  }

  #writeAssetTypes(): Promise<boolean> {
    return writeAssetTypes(this.project.assetTypesFile, this.database.list(), this.project.manifest.content, this.project.contentDir);
  }

  /** 排在前面的活后面做；前面的出错不影响后面的。 */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#work.then(work, work);
    this.#work = run.catch(() => undefined);
    return run;
  }
}

/** 本机的同源页面发的、带着 EDITOR_HEADER 的请求。 */
function trusted(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (!host || request.headers[EDITOR_HEADER] === undefined) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
    if (request.headers.origin !== undefined && new URL(request.headers.origin).host !== host) return false;
  } catch {
    return false;
  }
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** 内容路径（相对内容目录、正斜杠、不带扩展名）不能是空的，不能跑出内容目录。 */
function checkContentPath(assetPath: string): string {
  if (typeof assetPath !== 'string' || assetPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') || /[\\:]/.test(assetPath)) {
    throw new HttpError(400, `'${assetPath}' is not a content path`);
  }
  return assetPath;
}

let atomicWrites = 0;

/**
 * 先写到旁边的临时文件再改名：读的人（开发服务器、游戏页面）不会读到写了一半的。临时文件每次一个名字（同一个文件连着写时
 * 不互相盖），改名没成就删掉它，不留在内容目录里。
 */
async function writeAtomically(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${++atomicWrites}.tmp`;
  await writeFile(temporary, content);
  try {
    await renameRetrying(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Windows 上目标文件正被别的进程打开着（开发服务器在读它烘模型、监视文件的、杀毒）时改名报 EPERM、EBUSY：等一下再试。 */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request));
  } catch (error) {
    throw new HttpError(400, `the request body is not JSON: ${(error as Error).message}`);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  return (await readBytes(request)).toString('utf8');
}

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** 烘一次的结果：写了的文件（相对内容目录），导入源模型时的警告和动画剪辑。 */
interface Baked {
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  readonly animations?: ImportResult['animations'];
}

/** 资源内容的哈希（解析过的 JSON 重新序列化：空白、换行不算改了）。 */
function contentHash(content: unknown): string {
  return createHash('sha1').update(JSON.stringify(content)).digest('hex');
}
