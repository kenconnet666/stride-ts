/// <reference types="vite/client" />
/**
 * 前端这边对后端接口的封装（约定见 ../protocol.ts）：读工程、列资源、读和保存 JSON 资源，听资源的变化。
 * 页面要由带着 strideEditor 插件的开发服务器提供。
 */
import {
  EDITOR_API_PATH, EDITOR_ASSETS_EVENT, type AssetChanges, type AssetKind, type AssetRecord, type ProjectInfo,
} from '../protocol.ts';

/** 每个接口请求都要带的头，同后端的 EDITOR_HEADER。 */
const HEADERS = { 'x-stride-editor': '1' };

export class EditorClient {
  project(): Promise<ProjectInfo> {
    return request('GET', '/project');
  }

  /** 内容目录里的所有资源。 */
  assets(): Promise<AssetRecord[]> {
    return request('GET', '/assets');
  }

  /** 读一个 JSON 资源（场景、预制体、材质……）的内容。 */
  readAsset<T = unknown>(kind: AssetKind, path: string): Promise<T> {
    return request('GET', assetRoute(kind, path));
  }

  /** 保存一个 JSON 资源（新建或覆盖），返回它在数据库里的记录。 */
  saveAsset(kind: AssetKind, path: string, content: object): Promise<AssetRecord> {
    return request('PUT', assetRoute(kind, path), content);
  }

  /**
   * 资源变了（自己保存的、别的程序改的、导入器写的）以后调；返回取消登记的函数。走 Vite 的 HMR 通道，正式构建里没有
   * （编辑器只在开发服务器上跑）。
   */
  onAssetsChanged(listener: (changes: AssetChanges) => void): () => void {
    const hot = import.meta.hot;
    if (!hot) throw new Error('the editor needs the dev server (import.meta.hot is not available)');
    hot.on(EDITOR_ASSETS_EVENT, listener);
    return () => hot.off(EDITOR_ASSETS_EVENT, listener);
  }
}

const assetRoute = (kind: AssetKind, path: string) => `/asset?kind=${encodeURIComponent(kind)}&path=${encodeURIComponent(path)}`;

async function request<T>(method: string, route: string, body?: object): Promise<T> {
  const response = await fetch(`${EDITOR_API_PATH}${route}`, { method, headers: HEADERS, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as T | { error: string };
  if (!response.ok) throw new Error(`editor ${method} ${route}: ${(result as { error: string }).error}`);
  return result as T;
}
