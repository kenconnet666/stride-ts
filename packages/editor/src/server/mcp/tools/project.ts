/** 编辑器 MCP 服务的工具：工程：看工程、换工程。 */
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { json, type McpProjects } from '../shared.ts';

export function registerProjectTools(server: McpServer, projects: McpProjects): void {
  server.registerTool('project', {
    description: 'The stride-ts project this server edits: name, folders, how many assets of each kind, broken references, and the other projects of the repository (switch_project).',
    inputSchema: z.object({}),
  }, async () => {
    const counts: Record<string, number> = {};
    for (const asset of projects.current.database.list()) counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;
    const { project } = projects.current;
    return json({ name: project.manifest.name, root: project.root, content: project.contentDir, assets: counts, missingReferences: projects.current.database.missing(), otherProjects: await projects.list() });
  });

  server.registerTool('switch_project', {
    description: 'Switch this server to another stride-ts project of the repository (e.g. apps/open-world, or just open-world); every other tool then works on it. See project for the list.',
    inputSchema: z.object({ project: z.string().describe('project folder relative to the repository root, or its name') }),
  }, async ({ project }) => {
    const editor = await projects.switch(project);
    return json({ name: editor.project.manifest.name, root: editor.project.root, assets: editor.database.size });
  });
}
