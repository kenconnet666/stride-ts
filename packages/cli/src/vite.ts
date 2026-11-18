/**
 * Vite 插件：在开发服务器和 preview 服务器上挂调试中枢（hub.ts），页面里的游戏打开 debug 后连上来，`stride` 命令就能用。
 * 中间件模式（没有自己的 HTTP 服务器）时不挂。
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { DebugHub } from './hub.ts';

export function strideDebug(): Plugin {
  let root = process.cwd();
  return {
    name: 'stride-debug',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      mount(server.httpServer as Server | null, server.middlewares, `${appName(root)} (dev)`);
    },
    configurePreviewServer(server) {
      mount(server.httpServer as Server | null, server.middlewares, `${appName(root)} (preview)`);
    },
  };
}

function mount(server: Server | null, middlewares: Connect.Server, name: string): void {
  if (!server) return;
  new DebugHub(name).attach(server, (handler) => middlewares.use(handler));
}

/** 应用的名字：根目录 package.json 的 name，没有时用目录名。 */
function appName(root: string): string {
  try {
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }).name ?? path.basename(root);
  } catch {
    return path.basename(root);
  }
}
