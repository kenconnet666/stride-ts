import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { SceneFile } from '@stride-ts/engine/content-format';
import { createProject } from '../src/server/template.ts';

const CLI = path.resolve(import.meta.dirname, '../src/server/cli.ts');

/** 用 stdio 起 `stride-editor mcp`，按行收发 JSON-RPC。 */
class McpProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #waiting = new Map<number, (message: { result?: any; error?: unknown }) => void>();
  #buffer = '';
  #id = 0;

  constructor(project: string) {
    // vitest 给 worker 设的 NODE_OPTIONS 不要传给子进程
    this.#child = spawn(process.execPath, [CLI, 'mcp', project], { env: { ...process.env, NODE_OPTIONS: '' } });
    this.#child.on('exit', (code) => code && process.stderr.write(`stride-editor mcp exited with ${code}
`));
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

describe('编辑器的 MCP 服务', () => {
  let repo: string;
  let project: string;
  let mcp: McpProcess;

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'stride-mcp-'));
    // 模板要在仓库里建（找 pnpm-workspace.yaml、引擎的原生版本）
    await writeFile(path.join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
    await mkdir(path.join(repo, 'apps'), { recursive: true });
    await mkdir(path.join(repo, 'packages', 'engine'), { recursive: true });
    await writeFile(path.join(repo, 'packages', 'engine', 'package.json'), JSON.stringify({ dependencies: { '@stride-ts/native': '^0.29.0' } }));
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n/apps/*/public/content/\n');
    project = (await createProject(path.join(repo, 'apps', 'game'))).root;
    mcp = new McpProcess(project);
    await mcp.start();
  }, 30_000);

  afterAll(async () => {
    await mcp?.stop();
    await rm(repo, { recursive: true, force: true });
  });

  test('列出工具；读工程和资源；建材质；场景的修改照字段描述检查，过了才存', async () => {
    const tools = (await mcp.rpc('tools/list', {})).result.tools.map((tool: { name: string }) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['project', 'list_assets', 'read_asset', 'write_asset', 'delete_asset', 'move_asset', 'import_file', 'edit_scene', 'field_schemas', 'screenshot', 'render', 'game_command']));
    expect((await mcp.call('project', {})).value.assets).toMatchObject({ scene: 1 });

    const material = { name: 'Red', baseColor: [1, 0, 0, 1], metalness: 0, roughness: 0.5 };
    expect((await mcp.call('write_asset', { kind: 'material', path: 'Materials/Red', content: material, create: true })).value).toEqual({ kind: 'material', path: 'Materials/Red' });
    expect((await mcp.call('write_asset', { kind: 'material', path: 'Materials/Red', content: material, create: true })).error).toBe(true);

    const scene = (await mcp.call('read_asset', { kind: 'scene', path: 'MainScene' })).value as SceneFile;
    const sun = scene.entities.find((entity) => entity.name === 'Sun')!;
    const bad = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'set', entity: sun.id, path: ['components', 'light', 'intensity'], value: 'bright' }] });
    expect(bad.error).toBe(true);
    expect(bad.value).toMatch(/intensity: expected a number/);

    const cube = { id: 'cube-1', name: 'Cube', parent: null, position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: { model: { model: 'Models/Cube', materials: ['Materials/Red'] } } };
    const added = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'add', entities: [{ entity: cube, index: scene.entities.length }] }] });
    expect(added.value).toMatchObject({ changed: [{ id: 'cube-1', name: 'Cube' }], removed: [], issues: [] });
    const saved = JSON.parse(await readFile(path.join(project, 'public/content/MainScene.scene.json'), 'utf8')) as SceneFile;
    expect(saved.entities.at(-1)).toMatchObject({ name: 'Cube', components: { model: { materials: ['Materials/Red'] } } });

    const removed = await mcp.call('edit_scene', { kind: 'scene', path: 'MainScene', edits: [{ type: 'remove', entities: ['cube-1'] }] });
    expect(removed.value).toMatchObject({ changed: [], removed: [{ id: 'cube-1', name: 'Cube' }] });

    const decal = (await mcp.call('field_schemas', { of: 'components', name: 'decal' })).value;
    expect(decal).toMatchObject({ title: 'Decal', type: 'object' });
    expect((await mcp.call('field_schemas', { of: 'components', name: 'nope' })).error).toBe(true);
  }, 60_000);
});
