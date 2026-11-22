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
      const hub = mount(server.httpServer as Server | null, server.middlewares, `${appName(root)} (dev)`);
      if (!hub) return;
      // 开发服务器的错误（模块编译失败：页面只是停在加载、游戏连不上中枢，命令行什么也看不到）也进中枢的日志
      const logger = server.config.logger;
      const error = logger.error.bind(logger);
      logger.error = (message, options) => {
        hub.serverError(stripAnsi(message).slice(0, 4000));
        error(message, options);
      };
    },
    configurePreviewServer(server) {
      mount(server.httpServer as Server | null, server.middlewares, `${appName(root)} (preview)`);
    },
  };
}

function mount(server: Server | null, middlewares: Connect.Server, name: string): DebugHub | undefined {
  if (!server) return undefined;
  const hub = new DebugHub(name);
  hub.attach(server, (handler) => middlewares.use(handler));
  return hub;
}

/** 去掉终端的颜色控制码。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** 应用的名字：根目录 package.json 的 name，没有时用目录名。 */
function appName(root: string): string {
  try {
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: string }).name ?? path.basename(root);
  } catch {
    return path.basename(root);
  }
}
