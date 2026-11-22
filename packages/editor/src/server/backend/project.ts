/** 工程：根目录、清单（PROJECT_FILE，可以没有）和由它算出来的几个路径。 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEditorExtension, type EditorExtension } from '../../shared/extension.ts';
import { PROJECT_FILE, type ProjectInfo, type ProjectManifest } from '../../shared/protocol.ts';

export interface Project {
  /** 工程根目录（绝对路径）。 */
  readonly root: string;
  readonly manifest: ProjectManifest;
  /** 内容目录（绝对路径）。 */
  readonly contentDir: string;
  /** 生成的资源句柄文件（绝对路径）。 */
  readonly assetTypesFile: string;
}

/** 读工程：清单里没写的用默认值；清单文件不存在时全用默认值。publicDir 是开发服务器的静态目录，算内容的地址用。 */
export async function loadProject(root: string): Promise<Project> {
  const written = await readJson<Partial<ProjectManifest>>(path.join(root, PROJECT_FILE)) ?? {};
  if (written.format !== undefined && written.format !== 1) throw new Error(`${path.join(root, PROJECT_FILE)}: format ${String(written.format)} is not supported (expected 1)`);
  const packageName = (await readJson<{ name?: string }>(path.join(root, 'package.json')))?.name;
  const manifest: ProjectManifest = {
    format: 1,
    name: written.name ?? packageName ?? path.basename(root),
    content: written.content ?? 'public/content',
    assetTypes: written.assetTypes ?? 'src/assets.gen.ts',
    ...(written.extension !== undefined ? { extension: written.extension } : {}),
  };
  for (const key of ['content', 'assetTypes', 'extension'] as const) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (path.isAbsolute(value) || path.relative(root, path.resolve(root, value)).startsWith('..')) {
      throw new Error(`${path.join(root, PROJECT_FILE)}: ${key} must be a path inside the project, got '${value}'`);
    }
  }
  return { root, manifest, contentDir: path.resolve(root, manifest.content), assetTypesFile: path.resolve(root, manifest.assetTypes) };
}

/**
 * 装上工程的编辑器扩展（清单的 extension）：自定义的资源种类登记进引擎和编辑器，后面扫内容目录、烘焙才认得它们。
 * 模块要默认导出 defineEditorExtension 的结果。
 */
export async function installProjectExtension(project: Project): Promise<void> {
  const relative = project.manifest.extension;
  if (relative === undefined) return;
  const file = path.resolve(project.root, relative);
  const module = await import(pathToFileURL(file).href) as { default?: EditorExtension };
  if (!module.default || typeof module.default !== 'object') throw new Error(`${file}: the editor extension must default-export defineEditorExtension({ ... })`);
  installEditorExtension(module.default);
}

/** 给前端的工程信息。publicDir 是开发服务器的静态目录（绝对路径）。 */
export function projectInfo(project: Project, publicDir: string): ProjectInfo {
  const relative = path.relative(publicDir, project.contentDir);
  const served = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const extension = project.manifest.extension;
  return {
    ...project.manifest,
    contentUrl: served ? `${relative.split(path.sep).join('/')}/` : null,
    extensionFile: extension === undefined ? null : path.resolve(project.root, extension).split(path.sep).join('/'),
  };
}

/** 文件不存在时是 undefined；内容不是合法的 JSON 时报错。 */
async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`);
  }
}
