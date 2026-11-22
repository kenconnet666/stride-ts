/**
 * 编辑器的 MCP 服务（路线图 F1）：agent 工具不点界面也能做编辑器里人能做的事。`stride-editor mcp [工程目录]` 用 stdio 起服务，
 * 在自己的进程里开一个 EditorBackend（不用开发服务器）：资源的读写、新建、删除、移动、导入，场景和预制体的修改（场景文档的
 * SceneEdit，照字段描述检查），字段描述的 JSON Schema。开发服务器开着时，它的监视器看到文件变了，编辑器和游戏页面照常热重载；
 * 截图、页面命令经开发服务器的调试中枢（stride CLI 的那个）。
 *
 * 工具的名字、参数和编辑器的 HTTP 接口（protocol.ts）、`stride` CLI 的命令一一对应；新的创作功能同时加界面和这里的工具。
 */
import { McpServer } from '@modelcontextprotocol/server';
import type { McpProjects } from './shared.ts';
import { registerAssetsTools } from './tools/assets.ts';
import { registerMediaTools } from './tools/media.ts';
import { registerModelingTools } from './tools/modeling.ts';
import { registerPageTools } from './tools/page.ts';
import { registerProjectTools } from './tools/project.ts';
import { registerSceneTools } from './tools/scene.ts';

export type { McpProjects } from './shared.ts';

/** 编辑器的 MCP 服务：工具按领域分在 tools/ 下（工程、资源、建模、二维和声音、场景和世界、开着的页面）。 */
export function createEditorMcpServer(projects: McpProjects): McpServer {
  const server = new McpServer({ name: 'stride-editor', version: '0.2.0' });
  for (const register of [registerProjectTools, registerAssetsTools, registerModelingTools, registerMediaTools, registerSceneTools, registerPageTools]) register(server, projects);
  return server;
}
