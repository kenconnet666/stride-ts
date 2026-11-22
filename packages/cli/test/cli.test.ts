import { mkdtempSync } from 'node:fs';
import { socketText } from '../src/socketText.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { CallMessage } from '@stride-ts/engine/debug-protocol';
import { formatJson } from '../src/format.ts';
import { decodePng, diffImages, encodePng } from '../src/png.ts';
import { profileCallers, profileFromTrace, summarizeProfile, type TraceEvent } from '../src/profile.ts';

describe('PNG', () => {
  it('编码后解码得到同样的像素，比较能找出差的位置', () => {
    const width = 5, height = 3;
    const data = new Uint8Array(width * height * 4).map((_, i) => (i * 37) & 0xff);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const decoded = decodePng(encodePng({ width, height, data }));
    expect(decoded).toEqual({ width, height, data });

    const changed = new Uint8Array(data);
    changed[(1 * width + 3) * 4 + 1] = (changed[(1 * width + 3) * 4 + 1]! + 40) & 0xff;
    const diff = diffImages(decoded, { width, height, data: changed });
    expect(diff.max).toBe(40);
    expect(diff.over).toEqual({ '1': 1, '2': 1, '8': 1, '32': 1 });
    expect(diff.bounds).toEqual([3, 1, 1, 1]);
    // mean 是每个像素差最大的通道的平均，meanChannel 是所有通道的平均
    expect([diff.mean, diff.meanChannel]).toEqual([40 / 15, 40 / 45]);

    // 只比一块：统计按这一块的像素数算，块外的差不算
    const inside = diffImages(decoded, { width, height, data: changed }, { region: [3, 0, 2, 2] });
    expect([inside.max, inside.mean, inside.bounds]).toEqual([40, 10, [3, 1, 1, 1]]);
    const outside = diffImages(decoded, { width, height, data: changed }, { region: [0, 0, 3, 3] });
    expect([outside.max, outside.bounds]).toEqual([0, null]);
    expect(() => diffImages(decoded, decoded, { region: [4, 0, 2, 1] })).toThrow('outside the 5x3 image');
  });
});

describe('CPU 剖析的汇总', () => {
  it('自身时间按函数和类别、包含时间算到调用链上的每一层，callers 给出调用链；文件名去掉查询串', () => {
    // root → frame（js） → step（wasm）；采样：frame 1 次、step 2 次，每次 1 ms（时间差从第二个开始算）
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
        { id: 2, callFrame: { functionName: 'frame', url: 'http://x/index.js?t=123' }, children: [3] },
        { id: 3, callFrame: { functionName: 'step', url: 'wasm://wasm/core' } },
      ],
      samples: [2, 3, 3],
      timeDeltas: [0, 1000, 1000, 1000],
    };
    const summary = summarizeProfile(profile, 1) as { self: Record<string, number>; inclusive: Record<string, number>; selfByKind: Record<string, number> };
    expect(summary.self).toEqual({ 'step [wasm]': 2, 'frame [index.js]': 1 });
    expect(summary.selfByKind).toEqual({ wasm: 2, 'js index.js': 1 });
    expect(summary.inclusive['frame [index.js]']).toBe(3);
    expect(profileCallers(profile, /^step$/, 1)).toEqual({ 'frame [index.js] <- (root) []': 2 });
  });
});

describe('Tracing 录的 CPU 采样', () => {
  it('Profile 和几块 ProfileChunk 拼成一个 Profile：节点按 parent 连成 children，取主线程上的那个', () => {
    const chunk = (pid: number, id: string, nodes: object[], samples: number[], timeDeltas: number[]): TraceEvent =>
      ({ name: 'ProfileChunk', ph: 'P', pid, tid: 99, id, args: { data: { cpuProfile: { nodes, samples }, timeDeltas } } }) as TraceEvent;
    const events: TraceEvent[] = [
      { name: 'thread_name', ph: 'M', pid: 1, tid: 10, args: { name: 'CrRendererMain' } },
      { name: 'thread_name', ph: 'M', pid: 1, tid: 11, args: { name: 'DedicatedWorker thread' } },
      { name: 'Profile', ph: 'P', pid: 1, tid: 10, id: '0x1' },
      { name: 'Profile', ph: 'P', pid: 1, tid: 11, id: '0x2' },
      chunk(1, '0x1', [{ id: 1, callFrame: { functionName: '(root)' } }, { id: 2, parent: 1, callFrame: { functionName: 'update', url: 'http://x/game.ts' } }], [2, 2], [0, 100]),
      chunk(1, '0x1', [{ id: 3, parent: 2, callFrame: { functionName: 'step', url: 'wasm://wasm/abc' } }], [3], [100]),
      // 工作线程上的采样更多，但不是主线程
      chunk(1, '0x2', [{ id: 1, callFrame: { functionName: '(root)' } }], [1, 1, 1, 1, 1], [0, 1, 1, 1, 1]),
    ];
    const profile = profileFromTrace(events);
    expect(profile.samples).toEqual([2, 2, 3]);
    expect(profile.timeDeltas).toEqual([0, 100, 100]);
    expect(profile.nodes).toEqual([
      { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
      { id: 2, callFrame: { functionName: 'update', url: 'http://x/game.ts' }, children: [3] },
      { id: 3, callFrame: { functionName: 'step', url: 'wasm://wasm/abc' }, children: [] },
    ]);
    expect(() => profileFromTrace([])).toThrow(/no CPU profile/);
  });
});

describe('formatJson', () => {
  it('简单值的数组和小对象放一行，嵌套的对象缩进', () => {
    expect(formatJson({ position: { x: 1, y: 2 }, world: Array.from({ length: 16 }, (_, i) => i), name: 'a' })).toBe(
      '{\n  "position": {"x": 1, "y": 2},\n  "world": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],\n  "name": "a"\n}');
    expect(formatJson([])).toBe('[]');
    expect(formatJson(null)).toBe('null');
  });
});

describe('调试中枢', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let page: WebSocket;
  let hubModule: typeof import('../src/hub.ts');
  let clientModule: typeof import('../src/client.ts');
  let stateModule: typeof import('../src/state.ts');

  beforeAll(async () => {
    // 登记文件写到临时目录（state.ts 在导入时读这个环境变量）
    process.env['STRIDE_STATE_DIR'] = mkdtempSync(path.join(tmpdir(), 'stride-cli-test-'));
    [hubModule, clientModule, stateModule] = await Promise.all([import('../src/hub.ts'), import('../src/client.ts'), import('../src/state.ts')]);
    const handlers: ((request: IncomingMessage, response: ServerResponse, next: () => void) => void)[] = [];
    server = createServer((request, response) => {
      const handler = handlers[0];
      if (handler) handler(request, response, () => response.writeHead(404).end());
    });
    new hubModule.DebugHub('test app').attach(server, (handler) => handlers.push(handler));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://localhost:${(server.address() as { port: number }).port}`;

    // 假装是页面：同源连上来，回答 echo 命令，发一条日志
    page = new WebSocket(`${url.replace('http', 'ws')}/__stride/ws`, { origin: url });
    await new Promise((resolve) => page.once('open', resolve));
    page.send(JSON.stringify({ type: 'hello', url: `${url}/`, title: 'test page' }));
    page.on('message', (data) => {
      const call = JSON.parse(socketText(data)) as CallMessage;
      page.send(JSON.stringify(call.command === 'echo' ? { type: 'result', id: call.id, ok: true, value: call.args } : { type: 'result', id: call.id, ok: false, error: `unknown ${call.command}` }));
    });
    page.send(JSON.stringify({ type: 'logs', entries: [{ time: 1, level: 'warn', source: 'console', message: 'hello from the page' }] }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(() => {
    page.close();
    server.close();
  });

  it('登记在本机，CLI 找到它，调用转给页面，页面的错误原样带回', async () => {
    expect(stateModule.listHubs().map((h) => h.url)).toEqual([url]);
    const client = await clientModule.HubClient.find();
    expect((await client.pages()).map((p) => p.title)).toEqual(['test page']);
    expect(await client.call('echo', { a: [1, 2] })).toEqual({ a: [1, 2] });
    await expect(client.call('nope')).rejects.toThrow('unknown nope');
  });

  it('日志按序号续读，可以按页面筛', async () => {
    const client = await clientModule.HubClient.find('test app');
    const messages: string[] = [];
    for await (const entry of client.logs()) messages.push(entry.message);
    expect(messages).toEqual([expect.stringContaining('page 1 connected'), 'hello from the page']);
    const after: string[] = [];
    for await (const entry of client.logs({ since: 1 })) after.push(entry.message);
    expect(after).toEqual(['hello from the page']);
  });

  it('没有令牌、或者是浏览器发来的请求（带 Origin）都拒绝；别的源的页面连不上', async () => {
    expect((await fetch(`${url}/__stride/api/pages`)).status).toBe(403);
    const token = stateModule.listHubs()[0]!.token;
    expect((await fetch(`${url}/__stride/api/pages`, { headers: { 'x-stride-token': token, origin: 'https://evil.example' } })).status).toBe(403);
    const stranger = new WebSocket(`${url.replace('http', 'ws')}/__stride/ws`, { origin: 'https://evil.example' });
    const error = await new Promise<Error>((resolve) => stranger.once('error', resolve));
    expect(error.message).toContain('403');
  });
});
