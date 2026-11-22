/** 编辑器 MCP 服务的工具：开着的页面（要开发服务器起着、浏览器里开着游戏或编辑器）：让编辑器打开文档、截图、出片、页面命令。 */
import type { McpServer } from '@modelcontextprotocol/server';
import { HubClient } from '@stride-ts/cli/client';
import * as z from 'zod';
import { json, type McpProjects } from '../shared.ts';

export function registerPageTools(server: McpServer, projects: McpProjects): void {
  const hub = () => HubClient.find(projects.current.project.manifest.name);

  server.registerTool('open_in_editor', {
    description: 'Open a scene or a prefab in the editor UI the user has open (needs the project\'s dev server and the editor page open in a browser); the open document is saved first if it was changed.',
    inputSchema: z.object({
      path: z.string().describe('content path of the scene or prefab, without extension'),
      kind: z.enum(['scene', 'prefab']).optional().describe('default scene'),
    }),
  }, async ({ path: assetPath, kind }) => json(await (await hub()).call('editor-open', { path: assetPath, kind: kind ?? 'scene' })));

  server.registerTool('screenshot', {
    description: 'A PNG of the running game page (needs the project\'s dev server and the game or the editor open in a browser).',
    inputSchema: z.object({}),
  }, async () => {
    const { png, width, height } = await (await hub()).call('screenshot') as { png: string; width: number; height: number };
    return { content: [{ type: 'image' as const, data: png, mimeType: 'image/png' }, { type: 'text' as const, text: `${width}x${height}` }] };
  });

  server.registerTool('render', {
    description: 'Offline render the running game (or, from the editor page, a hidden play-mode page) to an MP4 (H.264 + AAC) or a PNG sequence in the exports folder of the project: '
      + 'fixed time step, sub-frame antialiasing and motion blur, the sounds played mixed in. Give a timeline entity to render a cutscene from its start (its length is the duration).',
    inputSchema: z.object({
      name: z.string().optional().describe('file name without extension (default "render")'),
      preset: z.enum(['landscape1080', 'vertical1080', 'square1080', 'landscape4k']).optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      fps: z.number().positive().optional(),
      timeline: z.string().optional().describe('entity with a TimelinePlayer script'),
      seconds: z.number().positive().optional(),
      samples: z.number().int().positive().optional().describe('sub-frames per frame (default 8)'),
      shutter: z.number().min(0).max(1).optional().describe('fraction of the frame interval the shutter is open (default 0.5)'),
      format: z.enum(['mp4', 'png']).optional(),
      pathTracing: z.boolean().optional().describe('path trace the diffuse indirect light per pixel (accumulated over the sub-frames: give more samples, e.g. 32)'),
    }),
  }, async (args) => json(await (await hub()).call('render', args, { timeout: 30 * 60_000 })));

  server.registerTool('game_command', {
    description: 'Call a debug command on the running game page (the commands of the `stride` CLI: status, entities, inspect, set, eval, perf, ...; "commands" lists them).',
    inputSchema: z.object({ command: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  }, async ({ command, args }) => json(await (await hub()).call(command, args ?? {})));
}
