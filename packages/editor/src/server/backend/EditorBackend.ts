/**
 * 编辑器的后端：一个工程的清单、资源数据库和对前端的 HTTP 接口（约定见 ../protocol.ts）。它不自己开服务器、不自己监视
 * 文件：挂在开发服务器上（vite.ts），文件变化由宿主报进来（fileChanged）。
 *
 * 安全：接口能写工程里的文件，所以只认本机的同源页面——Host 必须是回环地址（挡住 DNS 重绑定），带 Origin 的必须和 Host
 * 一致，而且每个请求要带 EDITOR_HEADER（跨源的页面带自定义头会先发预检，这里不回 CORS 头，预检过不了）。
 */
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { checkWorldFile, placeInCells, worldCellPath, EXTENSIONS, isProceduralModel, parseProceduralModel, TEXTURE_EXTENSIONS, type BrushFile, type ImageImportFile, type ModelImportFile, type TextureEncoding, type SceneEntityFile, type SceneFile, type WorldFile, type WorldLayer } from '@stride-ts/engine/content-format';
import { createStrideTools, type StrideTools } from '@stride-ts/native/tools';
import { brushToPoly, importSourceModel } from '@stride-ts/pipeline';
import { isJsonAssetKind, type AssetKind } from '@stride-ts/engine/content-references';
import { type ImportResult, type AssetChanges, type AssetMove, type AssetRecord, type DeleteResult, type MoveRequest, type MoveResult } from '../../shared/protocol.ts';
import { AssetDatabase, assetFileName, assetKey } from './AssetDatabase.ts';
import { rewriteImageEncoding, rewriteReferences } from './rewrite.ts';
import { writeAssetTypes } from './assetTypes.ts';
import { installProjectExtension, loadProject, projectInfo, type Project } from './project.ts';
import { syncAssetPackages } from './assetPackages.ts';
import { generatedKinds, generatorFor, isGenerated, REBAKE_WITH } from './bakers.ts';
import { checkContentPath, contentHash, writeAtomically } from './files.ts';
import { handleEditorRequest, HttpError } from './http.ts';
import { Importer, type MaterialSetOptions } from './importer.ts';

/** 导出的成片、图像序列放在工程的这个文件夹里（不提交）。 */
export const EXPORTS_DIR = 'exports';
const EXPORT_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'png']);

/** 文件变化攒这么久（毫秒）一起处理：导入器、git 切分支一次会动很多文件。 */
const CHANGE_DELAY = 50;

/** 存下、改了以后后端要烘（导入）的资源：生成模型的（bakers.ts 的表）和源模型、贴图的导入设置。 */
/** 有主文件的种类（贴图、音频、源模型这几种附属文件不会是）。 */
type BakedKind = Exclude<AssetKind, 'image' | 'audio' | 'modelSource'>;
const isBakedKind = (kind: string): kind is BakedKind => isGenerated(kind) || kind === 'modelImport' || kind === 'imageImport';


export class EditorBackend {
  readonly project: Project;
  readonly database: AssetDatabase;
  readonly #publicDir: string;
  readonly #listeners = new Set<(changes: AssetChanges) => void>();
  #pending = new Set<string>();
  /** 原生的导入工具（第一次导入模型时建）。 */
  #tools: Promise<StrideTools> | undefined;
  readonly #importer: Importer;
  #timer: NodeJS.Timeout | undefined;
  /** 白盒、SDF 最近一次烘焙时的内容（`种类:路径` → JSON 文本）：文件监视报它变了时，内容一样（自己刚存、刚烘的）就不再烘。 */
  readonly #bakes = new Map<string, string>();
  /** 上一批变化处理到哪了：保存、下一批都排在它后面，数据库不会被两处同时改。 */
  #work: Promise<unknown> = Promise.resolve();

  private constructor(project: Project, publicDir: string) {
    this.project = project;
    this.database = new AssetDatabase(project.contentDir);
    this.#publicDir = publicDir;
    this.#importer = new Importer({
      contentDir: project.contentDir,
      database: this.database,
      tools: () => (this.#tools ??= createStrideTools()),
      enqueue: (work) => this.#enqueue(work),
      refresh: (files) => this.#refresh(files),
      bake: (kind, assetPath, settings) => this.#bake(kind, assetPath, settings),
    });
  }

  /** 打开工程：读清单、同步依赖的资源包（assetPackages.ts）、扫内容目录、生成资源句柄。publicDir 是开发服务器的静态目录。 */
  static async open(root: string, publicDir: string): Promise<EditorBackend> {
    const project = await loadProject(root);
    await installProjectExtension(project);
    await syncAssetPackages(project.root, project.contentDir);
    const backend = new EditorBackend(project, publicDir);
    await backend.database.scan();
    await backend.#bakeStale();
    await backend.#writeAssetTypes();
    return backend;
  }

  /**
   * 开着的时候没看到的改动（开发服务器停着时 agent 直接写了文件、git 切了分支）：生成模型的资源（白盒、SDF、多边形、3D 文字、
   * 样条、树）打开工程时和上次烘的内容比（按内容的哈希，记在工程的 node_modules/.cache 里；文件的修改时间在新检出的工作树里
   * 靠不住），变了的、生成的模型不在的补烘。没记过的：模型不在才烘，在就当它是对的、记下来。导入（源模型、贴图）慢，照旧等文件改了再导入。
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
        // 生成的模型不在（包装、货架这类生成的大文件不进 git，新检出里没有）：源文件没变也要烘
        const exists = existsSync(path.join(this.project.contentDir, record.path + EXTENSIONS.model));
        if (known === hash && exists) continue;
        if (known === undefined && exists) {
          this.#bakeHashes[key] = hash;
          continue;
        }
        baked.push(...(await this.#bake(kind, record.path, content)).files);
      } catch (error) {
        console.warn(`[stride-editor] ${kind} ${record.path}: ${(error as Error).message}; its model is left as it was`);
      }
    }
    if (baked.length > 0) {
      console.info(`[stride-editor] baked ${baked.length} file(s) whose sources changed while the editor was closed or are missing`);
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
   * 白盒 brushPath 导出成可编辑的多边形网格（pipeline 的 brushToPoly），存成新的 `.poly.json`（照常烘出同名的模型）：target 没给时
   * 是白盒旁边的 `<名字>Poly`，有了往后加数字。白盒本身不动；返回新的多边形网格的路径和面数。
   */
  async exportBrushToPoly(brushPath: string, target?: string): Promise<{ readonly path: string; readonly vertexCount: number; readonly faceCount: number }> {
    const brush = await this.readAsset('brush', brushPath) as BrushFile;
    const taken = (candidate: string) => this.database.get('poly', candidate) !== undefined || this.database.get('model', candidate) !== undefined;
    let polyPath = target ?? `${brushPath}Poly`;
    for (let n = 2; target === undefined && taken(polyPath); n++) polyPath = `${brushPath}Poly${n}`;
    const tools = await (this.#tools ??= createStrideTools());
    const mesh = await brushToPoly(tools, brush, path.posix.basename(polyPath), `brush ${brushPath}`).catch((error: unknown) => {
      throw new HttpError(400, (error as Error).message);
    });
    await this.saveAsset('poly', polyPath, mesh, { create: true });
    return { path: polyPath, vertexCount: mesh.vertices.length, faceCount: mesh.faces.length };
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

  /** 导入一个拖进来的文件（见 importer.ts 的 Importer.importFile）。 */
  importFile(folder: string, fileName: string, bytes: Uint8Array): Promise<ImportResult> {
    return this.#importer.importFile(folder, fileName, bytes);
  }

  /** 导入一套扫描的材质（见 Importer.importMaterialSet）。 */
  importMaterialSet(folder: string, files: readonly { readonly name: string; readonly bytes: Uint8Array }[], options: MaterialSetOptions = {}): Promise<ImportResult> {
    return this.#importer.importMaterialSet(folder, files, options);
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
    const generator = generatorFor(record.kind);
    if (generator) {
      return generator.outputs.map(([kind, suffix]) => this.database.get(kind, record.path + suffix)).filter((found) => found !== undefined);
    }
    if (record.kind === 'model') return same(...generatedKinds(), 'modelImport', 'modelSource');
    return [];
  }

  /** HTTP 接口（路由表在 http.ts）；不是编辑器接口的请求交给 next。 */
  handle(request: IncomingMessage, response: ServerResponse, next: () => void): void {
    handleEditorRequest(this, request, response, next);
  }

  /** 工程的信息（GET /project）。 */
  info(): ReturnType<typeof projectInfo> {
    return projectInfo(this.project, this.#publicDir);
  }

  /** 所有资源（GET /assets）：等手上的活做完再列。 */
  async listAssets(): Promise<AssetRecord[]> {
    await this.#work;
    return this.database.list();
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
    if (!isJsonAssetKind(kind)) throw new HttpError(400, `${kind} assets cannot be read or saved through the editor API (not a JSON asset)`);
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
    // 用着改了的资源的生成资源（货架、堆放用着商品）：跟着重新生成
    const users = new Map(changes.changed.flatMap((record) => {
      const dependents = REBAKE_WITH[record.kind];
      return dependents ? this.database.referrers(record.kind, record.path).filter((user) => (dependents as readonly string[]).includes(user.kind)) : [];
    }).map((record) => [`${record.kind}:${record.path}`, record] as const));
    for (const { kind, path: user } of users.values()) {
      // REBAKE_WITH 里列的都是有主文件、会烘的种类
      const bakedKind = kind as BakedKind;
      try {
        const text = await readFile(path.join(this.project.contentDir, assetFileName(bakedKind, user)), 'utf8');
        baked.push(...(await this.#bake(bakedKind, user, JSON.parse(text))).files);
      } catch (error) {
        console.warn(`[stride-editor] ${kind} ${user}: ${(error as Error).message}; its model is left as it was`);
      }
    }
    if (baked.length > 0) await this.#refresh(baked);
  }

  /**
   * 照 bakers.ts 的表把生成模型的资源烘成同名的模型（和附带的图集、材质），或者照导入设置把旁边的源模型导入成同名的模型（importSourceModel：连材质、贴图、骨架、动画；已经有的材质文件不动，导入以后可能改过）。写好文件，
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
    const read = (file: string) => readFile(path.join(this.project.contentDir, file));
    const generator = generatorFor(kind);
    if (!generator) throw new Error(`${where}: no baker for asset kind '${kind}'`);
    const files = await generator.bake({ tools, read }, content, assetPath, where);
    for (const file of files) await writeAtomically(path.join(this.project.contentDir, file.path), file.bytes);
    this.#recordBake(`${kind}:${assetPath}`, content);
    return { files: files.map((file) => file.path), warnings: [] };
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

/** 烘一次的结果：写了的文件（相对内容目录），导入源模型时的警告和动画剪辑。 */
interface Baked {
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  readonly animations?: ImportResult['animations'];
}

