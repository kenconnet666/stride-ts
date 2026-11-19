/**
 * 编辑器的后端：一个工程的清单、资源数据库和对前端的 HTTP 接口（约定见 ../protocol.ts）。它不自己开服务器、不自己监视
 * 文件：挂在开发服务器上（vite.ts），文件变化由宿主报进来（fileChanged）。
 *
 * 安全：接口能写工程里的文件，所以只认本机的同源页面——Host 必须是回环地址（挡住 DNS 重绑定），带 Origin 的必须和 Host
 * 一致，而且每个请求要带 EDITOR_HEADER（跨源的页面带自定义头会先发预检，这里不回 CORS 头，预检过不了）。
 */
import { mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { AssetKind } from '@stride-ts/engine/content-references';
import { EDITOR_API_PATH, type AssetChanges, type AssetMove, type AssetRecord, type DeleteResult, type MoveRequest, type MoveResult } from '../protocol.ts';
import { AssetDatabase, assetFileName, assetKey } from './AssetDatabase.ts';
import { rewriteReferences } from './rewrite.ts';
import { writeAssetTypes } from './assetTypes.ts';
import { loadProject, projectInfo, type Project } from './project.ts';

/** 每个接口请求都要带的头（值随意）。 */
export const EDITOR_HEADER = 'x-stride-editor';

/** 文件变化攒这么久（毫秒）一起处理：导入器、git 切分支一次会动很多文件。 */
const CHANGE_DELAY = 50;

/** 能经接口读写内容的种类：主文件是 JSON 的。 */
const JSON_KINDS: ReadonlySet<string> = new Set(['material', 'scene', 'prefab', 'spriteSheet', 'skybox', 'font', 'texture', 'gameSettings', 'ui', 'sound']);

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
  #timer: NodeJS.Timeout | undefined;
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
    await backend.#writeAssetTypes();
    return backend;
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
  async readAsset(kind: AssetKind, assetPath: string): Promise<unknown> {
    const file = this.#jsonFile(kind, assetPath);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `no ${kind} asset ${assetPath}`);
      throw error;
    }
  }

  /**
   * 保存一个 JSON 资源（新建或者覆盖）：先写到旁边的临时文件再改名，读的人不会读到写了一半的；然后更新数据库、通知前端。
   * 格式同导入器写的（缩进 1 格），文件的差别只在改了的地方。
   */
  async saveAsset(kind: AssetKind, assetPath: string, content: unknown): Promise<AssetRecord> {
    const file = this.#jsonFile(kind, assetPath);
    if (content === null || typeof content !== 'object') throw new HttpError(400, `the content of a ${kind} asset must be a JSON object`);
    return this.#enqueue(async () => {
      await writeAtomically(file, JSON.stringify(content, null, 1));
      await this.#refresh([this.#relative(file)]);
      return this.database.get(kind, assetPath)!;
    });
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

  /** 跟着这个资源一起挪、一起删的资源：声音和它同名的音频文件。 */
  #companions(record: AssetRecord): AssetRecord[] {
    const audio = record.kind === 'sound' ? this.database.get('audio', record.path) : undefined;
    return audio ? [audio] : [];
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
    if (route === 'GET /asset' || route === 'PUT /asset' || route === 'DELETE /asset') {
      const kind = url.searchParams.get('kind'), assetPath = url.searchParams.get('path');
      if (!kind || !assetPath) throw new HttpError(400, 'kind and path are required');
      if (request.method === 'GET') return this.readAsset(kind as AssetKind, assetPath);
      if (request.method === 'DELETE') return this.deleteAsset(kind as AssetKind, assetPath, { force: url.searchParams.get('force') === '1' });
      return this.saveAsset(kind as AssetKind, assetPath, await readJson(request));
    }
    throw new HttpError(404, `no route ${route}`);
  }

  /** 一个 JSON 资源的主文件（绝对路径）；种类不对、路径想跑出内容目录时报错。 */
  #jsonFile(kind: AssetKind, assetPath: string): string {
    if (!JSON_KINDS.has(kind)) throw new HttpError(400, `${kind} assets cannot be read or saved through the editor API (not a JSON asset)`);
    return path.join(this.project.contentDir, assetFileName(kind as Exclude<AssetKind, 'image' | 'audio'>, checkContentPath(assetPath)));
  }

  #relative(file: string): string {
    return path.relative(this.project.contentDir, file).split(path.sep).join('/');
  }

  async #refresh(files: readonly string[]): Promise<void> {
    const changes = await this.database.refresh(files);
    if (changes.changed.length + changes.removed.length === 0) return;
    await this.#writeAssetTypes();
    for (const listener of this.#listeners) listener(changes);
  }

  #writeAssetTypes(): Promise<boolean> {
    return writeAssetTypes(this.project.assetTypesFile, this.database.list(), this.project.manifest.content);
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

/** 先写到旁边的临时文件再改名：读的人（开发服务器、游戏页面）不会读到写了一半的。 */
async function writeAtomically(file: string, content: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await readBody(request));
  } catch (error) {
    throw new HttpError(400, `the request body is not JSON: ${(error as Error).message}`);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
