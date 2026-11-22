/**
 * 编辑器 MCP 服务的一个最小客户端（测试、工程里的搭建脚本用）：用 stdio 起 `stride-editor mcp <工程>`，按行收发 JSON-RPC，
 * 调工具拿回第一块文本（是 JSON 就解析好）。agent 工具（Claude Code 这类）自己带 MCP 客户端，用不着它。
 *
 *   const mcp = new McpProcess('apps/campsite');
 *   await mcp.start();
 *   const { value } = await mcp.call('list_library', {});
 *   await mcp.stop();
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve(import.meta.dirname, '../cli.ts');

/** 用 stdio 起 `stride-editor mcp`，按行收发 JSON-RPC。 */
export class McpProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #waiting = new Map<number, (message: { result?: any; error?: unknown }) => void>();
  #buffer = '';
  #id = 0;

  constructor(project: string) {
    // vitest 给 worker 设的 NODE_OPTIONS 不要传给子进程
    this.#child = spawn(process.execPath, [CLI, 'mcp', project], { env: { ...process.env, NODE_OPTIONS: '' } });
    this.#child.on('exit', (code) => code && process.stderr.write(`stride-editor mcp exited with ${code}\n`));
    this.#child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.#child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString();
      for (let end = this.#buffer.indexOf('\n'); end >= 0; end = this.#buffer.indexOf('\n')) {
        const line = this.#buffer.slice(0, end).trim();
        this.#buffer = this.#buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: number; result?: any; error?: unknown };
        if (message.id !== undefined) this.#waiting.get(message.id)?.(message);
      }
    });
  }

  rpc(method: string, params: object): Promise<{ result?: any; error?: unknown }> {
    const id = ++this.#id;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async start(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  /** 调一个工具：返回第一块文本（JSON 的话解析好）和是不是出错了。 */
  async call(name: string, args: object): Promise<{ error: boolean; value: any }> {
    const { result } = await this.rpc('tools/call', { name, arguments: args });
    const text = result.content[0].text as string;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // 出错时是一句话
    }
    return { error: result.isError === true, value };
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#child.on('exit', () => resolve());
      this.#child.stdin.end();
    });
  }
}
