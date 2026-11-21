/**
 * 类型感知（`stride ts …`、`stride eval --check`）：起一个 TypeScript 7 的语言服务器（仓库里装的 `tsc --lsp --stdio`），按 LSP
 * 问悬停的类型、定义、引用、补全、诊断、工作区符号。agent 不开 IDE 也能拿到编辑器那样的类型信息。
 *
 * - 位置对外是 1 起的行、列（同编辑器、同 tsc 的报错），对 LSP 换成 0 起的。
 * - 每次调用 CLI 起一个服务器（加载工程要一两秒），用完关掉；文件按磁盘内容打开，eval 的代码放在引擎源码目录里一个不存在于磁盘
 *   的虚拟文件里（`evalScopeFile`），前面声明好页面 eval 的作用域（game、engine、pageHelpers 的帮手），所以类型和页面里一致。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

/** 仓库根目录（这个文件在 packages/cli/src 下）。 */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
/** eval 的虚拟文件放在引擎的源码目录里：引擎的 tsconfig 管它（DOM、WebGPU 的类型都在），相对导入引擎的模块。 */
const EVAL_FILE = path.join(REPO_ROOT, 'packages/engine/src/__stride_eval__.ts');

/** 文件里的一处：1 起的行、列。 */
export interface SourcePosition {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange extends SourcePosition {
  readonly endLine: number;
  readonly endColumn: number;
}

export interface Diagnostic extends SourceRange {
  readonly severity: 'error' | 'warning' | 'info' | 'hint';
  readonly code: string | number | undefined;
  readonly message: string;
}

export interface Completion {
  readonly name: string;
  readonly kind: string;
  /** 类型或签名（服务器给了才有）。 */
  readonly detail?: string;
}

export interface WorkspaceSymbol extends SourceRange {
  readonly name: string;
  readonly kind: string;
  readonly container?: string;
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspDiagnostic { range: LspRange; severity?: number; code?: string | number; message: string }

const SEVERITIES = ['error', 'warning', 'info', 'hint'] as const;
// LSP 的 CompletionItemKind、SymbolKind（下标从 1 起）
const COMPLETION_KINDS = ['', 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder', 'enumMember', 'constant', 'struct', 'event', 'operator', 'typeParameter'];
const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enumMember', 'struct', 'event', 'operator', 'typeParameter'];

/** 仓库里装的 TypeScript 7 的可执行文件（typescript 包自己的 getExePath 找平台包）。 */
async function typeScriptExe(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageDir = path.dirname(require.resolve('typescript/package.json'));
  // getExePath 不在包的 exports 里：按文件路径导入
  const { default: getExePath } = (await import(url.pathToFileURL(path.join(packageDir, 'lib/getExePath.js')).href)) as {
    default: (modules: { fs: typeof fs; module: unknown; path: typeof path; url: typeof url }) => string;
  };
  return getExePath({ fs, module: await import('node:module'), path, url });
}

/** eval 作用域里引擎的命名空间叫 __engine（和值 engine 分开）：给人看的类型里去掉它。 */
const tidy = (text: string) => text.replaceAll('__engine.', '');

const toUri = (file: string) => url.pathToFileURL(path.resolve(file)).href;
const fromUri = (uri: string) => path.relative(REPO_ROOT, url.fileURLToPath(uri)).replaceAll('\\', '/');

function toRange(uri: string, range: LspRange): SourceRange {
  return { file: fromUri(uri), line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1 };
}

/** 解析 `文件:行:列`（行、列 1 起；Windows 的盘符里的冒号不算）。 */
export function parseSourcePosition(text: string): SourcePosition {
  const match = /^(.*):(\d+):(\d+)$/.exec(text);
  if (!match) throw new Error(`expected <file>:<line>:<column>, got '${text}'`);
  return { file: path.resolve(match[1]!), line: Number(match[2]), column: Number(match[3]) };
}

/** 一个 TypeScript 语言服务器（`tsc --lsp --stdio`）的客户端。用完 close。 */
export class TypeScriptServer {
  readonly #process: ChildProcessWithoutNullStreams;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** 服务器推来的诊断（textDocument/publishDiagnostics），按文件。 */
  readonly #published = new Map<string, LspDiagnostic[]>();
  readonly #publishWaiters = new Map<string, (diagnostics: LspDiagnostic[]) => void>();
  readonly #versions = new Map<string, number>();

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#process = child;
    child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk));
    child.on('exit', (code) => {
      for (const { reject } of this.#pending.values()) reject(new Error(`the TypeScript language server exited (${code})`));
      this.#pending.clear();
    });
  }

  /** 起服务器、握手（工作区是仓库根目录）。 */
  static async start(): Promise<TypeScriptServer> {
    const child = spawn(await typeScriptExe(), ['--lsp', '--stdio'], { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const server = new TypeScriptServer(child);
    await server.#request('initialize', {
      processId: process.pid,
      rootUri: toUri(REPO_ROOT),
      workspaceFolders: [{ uri: toUri(REPO_ROOT), name: 'stride-ts' }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { labelDetailsSupport: true } },
          publishDiagnostics: {},
          diagnostic: {},
          definition: {},
          references: {},
        },
        workspace: { symbol: {}, configuration: true, workspaceFolders: true },
      },
    });
    server.#notify('initialized', {});
    return server;
  }

  close(): void {
    this.#request('shutdown', null).then(() => this.#notify('exit', null), () => undefined).finally(() => setTimeout(() => this.#process.kill(), 200));
  }

  /** 打开（或换掉内容）一个文件；不给内容时读磁盘。 */
  open(file: string, text = fs.readFileSync(file, 'utf8')): void {
    const uri = toUri(file);
    const version = (this.#versions.get(uri) ?? 0) + 1;
    this.#versions.set(uri, version);
    if (version === 1) this.#notify('textDocument/didOpen', { textDocument: { uri, languageId: file.endsWith('x') ? 'typescriptreact' : 'typescript', version, text } });
    else this.#notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  /** 悬停：那里的类型和文档（纯文本）；没有时是 undefined。 */
  async hover(at: SourcePosition): Promise<string | undefined> {
    const result = (await this.#request('textDocument/hover', this.#at(at))) as { contents: string | { value: string } | { value: string }[] } | null;
    if (!result) return undefined;
    const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
    // markdown 的代码块围栏去掉，签名和文档之间留一个换行
    return tidy(contents.map((part) => (typeof part === 'string' ? part : part.value)).join('\n').replace(/```\w*\n?/g, '\n')).replace(/\n{2,}/g, '\n').trim();
  }

  async definition(at: SourcePosition): Promise<SourceRange[]> {
    return this.#locations(await this.#request('textDocument/definition', this.#at(at)));
  }

  async references(at: SourcePosition): Promise<SourceRange[]> {
    return this.#locations(await this.#request('textDocument/references', { ...this.#at(at), context: { includeDeclaration: true } }));
  }

  /** 补全：那里能写的名字、种类，带类型（逐个 resolve 拿 detail，最多 resolveLimit 个）。 */
  async completion(at: SourcePosition, resolveLimit = 200): Promise<Completion[]> {
    const result = (await this.#request('textDocument/completion', this.#at(at))) as { items: CompletionItem[] } | CompletionItem[] | null;
    const items = (Array.isArray(result) ? result : (result?.items ?? [])).filter((item) => item.kind !== 14);
    items.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    return Promise.all(items.map(async (item, index) => {
      const resolved = item.detail === undefined && index < resolveLimit ? ((await this.#request('completionItem/resolve', item)) as CompletionItem) : item;
      return { name: item.label, kind: COMPLETION_KINDS[item.kind ?? 0] ?? String(item.kind), ...(resolved.detail ? { detail: tidy(resolved.detail) } : {}) };
    }));
  }

  /** 一个文件的诊断（语法和类型）：先按 LSP 的拉取问，服务器不支持时等它推来。 */
  async diagnostics(file: string): Promise<Diagnostic[]> {
    const uri = toUri(file);
    let items: LspDiagnostic[];
    try {
      const report = (await this.#request('textDocument/diagnostic', { textDocument: { uri } })) as { items?: LspDiagnostic[] };
      items = report.items ?? [];
    } catch {
      items = this.#published.get(uri) ?? (await new Promise<LspDiagnostic[]>((resolve) => this.#publishWaiters.set(uri, resolve)));
    }
    return items.map((item) => ({ ...toRange(uri, item.range), severity: SEVERITIES[(item.severity ?? 1) - 1] ?? 'error', code: item.code, message: item.message }));
  }

  /** 工作区的符号（按名字模糊匹配）；只在已经打开过文件的工程里找。 */
  async symbols(query: string): Promise<WorkspaceSymbol[]> {
    const result = ((await this.#request('workspace/symbol', { query })) ?? []) as { name: string; kind: number; containerName?: string; location: LspLocation }[];
    return result.map((symbol) => ({
      name: symbol.name, kind: SYMBOL_KINDS[symbol.kind] ?? String(symbol.kind), ...(symbol.containerName ? { container: symbol.containerName } : {}),
      ...toRange(symbol.location.uri, symbol.location.range),
    }));
  }

  #at(at: SourcePosition) {
    return { textDocument: { uri: toUri(at.file) }, position: { line: at.line - 1, character: at.column - 1 } };
  }

  #locations(result: unknown): SourceRange[] {
    if (!result) return [];
    const list = (Array.isArray(result) ? result : [result]) as (LspLocation | { targetUri: string; targetSelectionRange: LspRange })[];
    return list.map((location) => ('targetUri' in location ? toRange(location.targetUri, location.targetSelectionRange) : toRange(location.uri, location.range)));
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    this.#send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  #notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.#process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.#process.stdin.write(body);
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
      if (this.#buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')) as {
        id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string };
      };
      this.#buffer = this.#buffer.subarray(headerEnd + 4 + length);
      this.#handle(message);
    }
  }

  #handle(message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }): void {
    if (message.method === undefined) {
      const pending = this.#pending.get(message.id!);
      if (!pending) return;
      this.#pending.delete(message.id!);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.#published.set(uri, diagnostics);
      this.#publishWaiters.get(uri)?.(diagnostics);
      this.#publishWaiters.delete(uri);
    }
    // 服务器发来的请求（取配置、登记能力、进度）：都给个空的答复，免得它等
    if (message.id !== undefined) this.#send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? ((message.params as { items: unknown[] }).items ?? []).map(() => null) : null });
  }
}

interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  sortText?: string;
}

/**
 * eval 的代码放进一个虚拟文件：前面声明页面 eval 的作用域（同 debug/commands.ts 的 evaluate：game、engine、pageHelpers 的帮手），
 * 代码当异步函数体（表达式、语句、顶层 await、return 都合法）。返回文件路径、内容和代码从第几行开始（1 起）。
 */
export function evalScopeFile(code: string, helperNames: readonly string[]): { file: string; text: string; firstLine: number } {
  const preamble = [
    "import type * as __engine from './index';",
    "import type { PageHelpers as __PageHelpers } from './debug/pageHelpers';",
    'declare const game: __engine.Game;',
    'declare const engine: typeof __engine;',
    // 样例的入口把引擎挂在全局的 strideEngine 上（同 engine）
    'declare const strideEngine: typeof __engine;',
    'declare const __helpers: __PageHelpers;',
    ...helperNames.map((name) => `declare const ${name}: __PageHelpers['${name}'];`),
    'export async function __strideEval() {',
  ];
  return { file: EVAL_FILE, text: `${preamble.join('\n')}\n${code}\n}\n`, firstLine: preamble.length + 1 };
}

/** pageHelpers 的帮手名字（问服务器 `__helpers.` 后面能写什么）。 */
export async function helperNames(server: TypeScriptServer): Promise<string[]> {
  const probe = evalScopeFile('__helpers.', []);
  server.open(probe.file, probe.text);
  const items = await server.completion({ file: probe.file, line: probe.firstLine, column: '__helpers.'.length + 1 }, 0);
  return items.filter((item) => item.kind === 'property' || item.kind === 'field' || item.kind === 'method' || item.kind === 'function' || item.kind === 'variable').map((item) => item.name);
}

/** 打开 eval 的虚拟文件，返回把虚拟文件里的行换回代码里的行的函数。 */
export async function openEvalScope(server: TypeScriptServer, code: string): Promise<{ file: string; firstLine: number }> {
  const scope = evalScopeFile(code, await helperNames(server));
  server.open(scope.file, scope.text);
  return { file: scope.file, firstLine: scope.firstLine };
}

/** eval 的代码的诊断，行号换成代码里的（1 起）；虚拟文件前言里的（不该有）也报，行号是负的。 */
export async function checkEval(server: TypeScriptServer, code: string): Promise<Diagnostic[]> {
  const { file, firstLine } = await openEvalScope(server, code);
  const diagnostics = await server.diagnostics(file);
  return diagnostics.map((diagnostic) => ({ ...diagnostic, file: '<eval>', line: diagnostic.line - firstLine + 1, endLine: diagnostic.endLine - firstLine + 1 }));
}

/** `stride ts` 的子命令和用法（帮助里列出）。 */
export const TS_USAGE = `ts hover <file:line:col>           type and docs at that place (like hovering in an editor)
  ts def <file:line:col>             where the symbol there is defined
  ts refs <file:line:col>            every reference to it
  ts complete <file:line:col> [--limit 100]   what can be written there, with types
  ts check <file>...                 type errors and warnings of these files (exit code 1 on errors)
  ts symbols <query> [--in <file>]   symbols across the projects (opened from --in, default the engine's index)
  ts type <expression>               type of an expression in eval scope (game, engine, entity(), named(), ...)
  ts members <expression>            properties and methods of an expression in eval scope, with types`;

/** 跑 `stride ts <子命令> …`：起服务器、问完关掉。 */
export async function runTypeQuery(sub: string | undefined, args: readonly string[], options: { readonly limit?: string | undefined; readonly in?: string | undefined }): Promise<unknown> {
  if (!sub) throw new Error(`expected a subcommand:\n  ${TS_USAGE}`);
  const server = await TypeScriptServer.start();
  try {
    const at = () => {
      const position = parseSourcePosition(args[0] ?? '');
      server.open(position.file);
      return position;
    };
    const expression = () => {
      const text = args.join(' ').trim();
      if (!text) throw new Error(`stride ts ${sub} needs an expression`);
      return text;
    };
    switch (sub) {
      case 'hover':
        return { type: (await server.hover(at())) ?? null };
      case 'def':
        return server.definition(at());
      case 'refs':
        return server.references(at());
      case 'complete':
        return (await server.completion(at())).slice(0, Number(options.limit ?? 100));
      case 'check': {
        if (args.length === 0) throw new Error('stride ts check needs files');
        const results: Record<string, Diagnostic[]> = {};
        for (const file of args) {
          server.open(path.resolve(file));
          results[file] = await server.diagnostics(path.resolve(file));
        }
        if (Object.values(results).some((list) => list.some((diagnostic) => diagnostic.severity === 'error'))) process.exitCode = 1;
        return results;
      }
      case 'symbols': {
        server.open(path.resolve(options.in ?? path.join(REPO_ROOT, 'packages/engine/src/index.ts')));
        return (await server.symbols(args[0] ?? '')).slice(0, Number(options.limit ?? 100));
      }
      case 'type': {
        // 值放进一个变量，悬停在变量上：整个表达式的类型（不只是最后一个名字的）
        const scope = await openEvalScope(server, `const __value = (${expression()});`);
        const hover = await server.hover({ file: scope.file, line: scope.firstLine, column: 7 });
        return { type: hover?.replace(/^const __value: /, '') ?? null };
      }
      case 'members': {
        const line = `(${expression()}).`;
        const scope = await openEvalScope(server, line);
        return (await server.completion({ file: scope.file, line: scope.firstLine, column: line.length + 1 })).slice(0, Number(options.limit ?? 200));
      }
      default:
        throw new Error(`unknown subcommand '${sub}':\n  ${TS_USAGE}`);
    }
  } finally {
    server.close();
  }
}
