/**
 * Vite 插件：把编辑器的后端（EditorBackend）挂在开发服务器上。工程就是 Vite 的根目录；HTTP 接口走服务器的中间件，
 * 文件变化用 Vite 自己的监视器（它本来就看着整个根目录，包括 public），资源变了经 HMR 通道推给页面
 * （EDITOR_ASSETS_EVENT）。只在开发服务器上有：preview 和构建不带编辑器。
 */
import type { Plugin } from 'vite';
import { EDITOR_ASSETS_EVENT } from '../protocol.ts';
import { EditorBackend } from './EditorBackend.ts';

export function strideEditor(): Plugin {
  return {
    name: 'stride-editor',
    apply: 'serve',
    async configureServer(server) {
      const backend = await EditorBackend.open(server.config.root, server.config.publicDir);
      server.middlewares.use((request, response, next) => backend.handle(request, response, next));
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, (file) => backend.fileChanged(file));
      backend.onAssetsChanged((changes) => server.ws.send(EDITOR_ASSETS_EVENT, changes));
    },
  };
}
