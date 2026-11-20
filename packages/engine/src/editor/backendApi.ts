/**
 * 游戏页面写文件经过的编辑器后端接口（@stride-ts/editor 的 EditorBackend，地址同它的 EDITOR_API_PATH）：开发服务器上开着编辑器
 * 时才有。在模型上画贴图存遮罩、烘序列帧存图集用 saveImage，离线渲染存成片用 saveExport。
 */
const API = '/__stride/editor/api';

/** 写内容目录里的一张 png（PUT /image，建新的或覆盖；path 是内容路径，不带扩展名）。 */
export async function saveImage(path: string, png: Uint8Array<ArrayBuffer>): Promise<void> {
  const response = await fetch(`${API}/image?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'x-stride-editor': '1' }, body: png });
  if (!response.ok) throw new Error(`saving ${path} failed: ${await errorOf(response)}`);
}

/** 存一个导出的文件到工程的 exports 文件夹（POST /export），返回工程里的相对路径。 */
export async function saveExport(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const response = await fetch(`${API}/export?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-stride-editor': '1' }, body: bytes });
  const body = await response.json() as { path?: string; error?: string };
  if (!response.ok || !body.path) throw new Error(`saving ${name} failed: ${body.error ?? `HTTP ${response.status}`}`);
  return body.path;
}

async function errorOf(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { error?: string }).error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
