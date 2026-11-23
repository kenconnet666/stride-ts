/**
 * 编辑器后端的 HTTP 接口（约定见 shared/protocol.ts，前端的封装是 client/EditorClient.ts）：只答本机同源、带 EDITOR_HEADER 的
 * 请求；路由是一张表（`方法 路径` → 处理函数），出错按 HttpError 的状态码回 `{ error }`。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SceneEntityFile } from '@stride-ts/engine/content-format';
import type { MaterialCredit } from '../../shared/materialSet.ts';
import { EDITOR_API_PATH, type AssetKind, type MoveRequest } from '../../shared/protocol.ts';
import type { EditorBackend } from './EditorBackend.ts';

/** 每个接口请求都要带的头（值随意）。 */
export const EDITOR_HEADER = 'x-stride-editor';

/** 带状态码的错误：参数不对 400、没有 404、不许 403……其余的错是 500。 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Route = (backend: EditorBackend, request: IncomingMessage, url: URL) => Promise<unknown>;

/** 必填的查询参数；没有时 400，消息说它是什么。 */
function param(url: URL, name: string, meaning: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new HttpError(400, `${name} (${meaning}) is required`);
  return value;
}

/** 资源的 kind、path 查询参数。 */
function assetParams(url: URL): { kind: AssetKind; path: string } {
  const kind = url.searchParams.get('kind'), path = url.searchParams.get('path');
  if (!kind || !path) throw new HttpError(400, 'kind and path are required');
  return { kind: kind as AssetKind, path };
}

const ROUTES: Readonly<Record<string, Route>> = {
  'GET /project': async (backend) => backend.info(),
  'GET /assets': (backend) => backend.listAssets(),
  'POST /move': async (backend, request) => backend.moveAssets(await readJson(request) as MoveRequest),
  'POST /world/place': async (backend, request) => {
    const { world, layer, entities } = await readJson(request) as { world: string; layer: string; entities: SceneEntityFile[] };
    return backend.placeInWorld(world, layer, entities);
  },
  'POST /brush/to-poly': async (backend, request) => {
    const { path, target } = await readJson(request) as { path?: string; target?: string };
    if (!path) throw new HttpError(400, 'path (the content path of the greybox) is required');
    return backend.exportBrushToPoly(path, target);
  },
  'POST /import-material': async (backend, request) => {
    // 一套扫描的材质：JSON 里各个文件是 base64
    const body = await readJson(request) as { folder?: string; files: { name: string; base64: string }[]; name?: string; tileSize?: number; maxSize?: number; parallaxDepth?: number; credit?: MaterialCredit };
    if (!Array.isArray(body.files)) throw new HttpError(400, 'files ([{ name, base64 }]) is required');
    return backend.importMaterialSet(body.folder ?? '', body.files.map((file) => ({ name: file.name, bytes: Buffer.from(file.base64, 'base64') })), body);
  },
  'POST /import': async (backend, request, url) => backend.importFile(url.searchParams.get('folder') ?? '', param(url, 'name', 'the dropped file name'), await readBytes(request)),
  'PUT /image': async (backend, request, url) => backend.saveImage(param(url, 'path', 'the content path of the image, without extension'), await readBytes(request)),
  'POST /export': async (backend, request, url) => backend.saveExport(param(url, 'name', 'the file name under exports/'), await readBytes(request)),
  'GET /asset': async (backend, _request, url) => {
    const { kind, path } = assetParams(url);
    return backend.readAsset(kind, path);
  },
  'PUT /asset': async (backend, request, url) => {
    const { kind, path } = assetParams(url);
    return backend.saveAsset(kind, path, await readJson(request), { create: url.searchParams.get('create') === '1' });
  },
  'DELETE /asset': async (backend, _request, url) => {
    const { kind, path } = assetParams(url);
    return backend.deleteAsset(kind, path, { force: url.searchParams.get('force') === '1' });
  },
};

/** 编辑器接口的请求按路由表答；不是编辑器接口的交给 next。 */
export function handleEditorRequest(backend: EditorBackend, request: IncomingMessage, response: ServerResponse, next: () => void): void {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== EDITOR_API_PATH && !url.pathname.startsWith(`${EDITOR_API_PATH}/`)) return next();
  const reply = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  route(backend, request, url).then((body) => reply(200, body), (error: unknown) => {
    reply(error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
  });
}

async function route(backend: EditorBackend, request: IncomingMessage, url: URL): Promise<unknown> {
  if (!trusted(request)) throw new HttpError(403, `forbidden: the editor API only answers same-origin pages on this machine that send the ${EDITOR_HEADER} header`);
  const key = `${request.method} ${url.pathname.slice(EDITOR_API_PATH.length)}`;
  const handler = ROUTES[key];
  if (!handler) throw new HttpError(404, `no route ${key}`);
  return handler(backend, request, url);
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

async function readJson(request: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readBytes(request)).toString('utf8'));
  } catch (error) {
    throw new HttpError(400, `the request body is not JSON: ${(error as Error).message}`);
  }
}

function readBytes(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
