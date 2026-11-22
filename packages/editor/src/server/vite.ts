/**
 * Vite 插件：把编辑器挂在应用的开发服务器上。只在开发服务器上有：preview 和构建不带编辑器。
 *
 * - 后端（EditorBackend）：工程就是 Vite 的根目录；HTTP 接口走服务器的中间件，文件变化用 Vite 自己的监视器（它本来就看着
 *   整个根目录，包括 public），资源变了经 HMR 通道推给页面（EDITOR_ASSETS_EVENT）。
 * - 界面（EDITOR_UI_PATH，`src/ui`）：编辑器的页面由第二个 Vite 服务器（中间件模式）提供，挂在同一个 HTTP 服务器上，
 *   所以和游戏页面同源——界面把游戏页面嵌在 iframe 里，直接拿它的 `game.editor`。第二个服务器第一次有人打开编辑器时才建：
 *   界面用 Vue 和 vue-tsx-pro 的编译插件，游戏页面不经过它，不开编辑器的时候一点开销也没有。
 */
import { fileURLToPath } from 'node:url';
import type { Plugin, ViteDevServer } from 'vite';
import { EDITOR_ASSETS_EVENT, EDITOR_UI_PATH } from '../protocol.ts';
import { EditorBackend } from './EditorBackend.ts';
import { syncAssetPackages } from './assetPackages.ts';
import { loadProject } from './project.ts';

const UI_ROOT = fileURLToPath(new URL('../ui', import.meta.url));

export function strideEditor(): Plugin {
  return {
    name: 'stride-editor',
    apply: 'serve',
    async configureServer(server) {
      const backend = await EditorBackend.open(server.config.root, server.config.publicDir);
      server.middlewares.use((request, response, next) => backend.handle(request, response, next));
      for (const event of ['add', 'change', 'unlink'] as const) server.watcher.on(event, (file) => backend.fileChanged(file));

      let ui: Promise<ViteDevServer> | undefined;
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(EDITOR_UI_PATH) && request.url !== EDITOR_UI_PATH.slice(0, -1)) return next();
        // 编辑器的页面要和嵌在里面的游戏页面一样跨源隔离（游戏的原生模块用 SharedArrayBuffer）
        for (const [name, value] of Object.entries(server.config.server.headers ?? {})) if (value !== undefined) response.setHeader(name, value);
        ui ??= createUiServer(server);
        ui.then((child) => child.middlewares(request, response, next), next);
      });
      backend.onAssetsChanged((changes) => {
        server.ws.send(EDITOR_ASSETS_EVENT, changes);
        void ui?.then((child) => child.ws.send(EDITOR_ASSETS_EVENT, changes));
      });
      server.httpServer?.once('close', () => {
        void ui?.then((child) => child.close());
        void backend.close();
      });
    },
  };
}

/** 构建之前把工程依赖的资源包同步进内容目录（开发服务器上是编辑器后端打开工程时同步），静态目录里才有它们。 */
export function strideAssetPackages(): Plugin {
  return {
    name: 'stride-asset-packages',
    apply: 'build',
    async configResolved(config) {
      const project = await loadProject(config.root);
      await syncAssetPackages(project.root, project.contentDir);
    },
  };
}

/** 编辑器界面的开发服务器：中间件模式，HMR 的 WebSocket 挂在应用的 HTTP 服务器上（按路径和应用自己的分开）。 */
async function createUiServer(app: ViteDevServer): Promise<ViteDevServer> {
  const [{ createServer }, { vueTsxPro }] = await Promise.all([import('vite'), import('@zerodep-dev/vue-tsx-pro-tsx/vite')]);
  return createServer({
    configFile: false,
    root: UI_ROOT,
    base: EDITOR_UI_PATH,
    // 编译缓存和预构建的依赖放在应用自己的缓存目录旁边，不和游戏的混在一起
    cacheDir: `${app.config.cacheDir}-editor`,
    plugins: vueTsxPro(),
    server: { middlewareMode: true, hmr: app.httpServer ? { server: app.httpServer } : false },
    appType: 'spa',
    clearScreen: false,
    ...(app.config.logLevel ? { logLevel: app.config.logLevel } : {}),
  });
}
