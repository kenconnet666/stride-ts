/**
 * Stride 工程的资源索引：扫描各个包的资源目录，按 GUID 找资源（场景、模型、材质、预制体、纹理）。
 * 资源的内容路径是"包名/相对资源目录的路径"（不带扩展名），比如 `PrototypingBlocks/Models/Wall0x2x5`；
 * Stride 的引用写成 `guid:url`，url 有时带包名有时不带，按 GUID 找最可靠。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Scene, StrideTools } from '@stride-ts/native/tools';
import { asNumber, asObject, parseStrideYaml, type StrideObject } from './yaml.ts';

/** 一个包的资源目录（Stride 包里 AssetFolders 指的目录）。 */
export interface AssetRoot {
  readonly package: string;
  readonly dir: string;
}

export interface AssetEntry {
  readonly id: string;
  /** YAML 顶层的类型：SceneAsset、Model（.sdm3d）、MaterialAsset…… */
  readonly type: string;
  readonly file: string;
  /** 内容路径：包名/相对路径，不带扩展名。 */
  readonly path: string;
  readonly data: StrideObject;
}

// Stride 的全部资源种类都建索引：引用总能解析到资源，导入器还不支持的种类由导入器给出警告，而不是"找不到资源"
const ASSET_EXTENSIONS = new Set([
  '.sdscene', '.sdprefab', '.sdm3d', '.sdpromodel', '.sdprefabmodel', '.sdmat', '.sdtex', '.sdsky', '.sdgamesettings',
  '.sdskel', '.sdanim', '.sdsheet', '.sdfnt', '.sdpcfnt', '.sduipage', '.sduilib', '.sdsnd', '.sdpart', '.sdhull',
  '.sdnavmesh', '.sdgfxcomp', '.sdrendertex', '.sdvid', '.sdhf', '.sdfx', '.sdsl',
]);

export class StrideProject {
  readonly #byId = new Map<string, AssetEntry>();
  readonly #byPath = new Map<string, AssetEntry>();

  /** 扫描所有包的资源目录并解析每个资源文件。 */
  static async open(roots: readonly AssetRoot[]): Promise<StrideProject> {
    const project = new StrideProject();
    for (const root of roots) {
      for (const file of await listFiles(root.dir)) {
        if (!ASSET_EXTENSIONS.has(path.extname(file))) continue;
        const data = parseStrideYaml(await readFile(file, 'utf8'), file);
        const id = data['Id'];
        if (typeof id !== 'string') continue;
        const relative = path.relative(root.dir, file).replace(/\\/g, '/').replace(/\.[^.]+$/, '');
        const entry: AssetEntry = { id, type: data.$type ?? 'unknown', file, path: `${root.package}/${relative}`, data };
        project.#byId.set(id, entry);
        project.#byPath.set(entry.path, entry);
      }
    }
    return project;
  }

  get size(): number {
    return this.#byId.size;
  }

  /** 按 GUID 找资源；找不到时抛错，带上引用它的地方。 */
  get(id: string, referencedFrom: string): AssetEntry {
    const entry = this.#byId.get(id);
    if (!entry) throw new Error(`${referencedFrom}: asset ${id} is not in any of the asset folders`);
    return entry;
  }

  /** 某种类型（YAML 顶层的类型，比如 GameSettingsAsset）的全部资源。 */
  ofType(type: string): AssetEntry[] {
    return [...this.#byId.values()].filter((entry) => entry.type === type);
  }

  /** 按内容路径找资源（包名/相对路径）。 */
  byPath(contentPath: string): AssetEntry | undefined {
    return this.#byPath.get(contentPath);
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

/** 资源的源文件（`Source` 相对资源文件；写成 `!file 路径` 时也认）。 */
export function sourceOf(asset: AssetEntry): string {
  const source = asset.data['Source'];
  const file = typeof source === 'string' ? source : asObject(source)?.$type === 'file' ? asObject(source)!['value'] : undefined;
  if (typeof file !== 'string') throw new Error(`${asset.file}: ${asset.type} has no Source`);
  return path.resolve(path.dirname(asset.file), file);
}

/** 导入源文件时的变换（模型、骨架、动画资源的 PivotPosition 和 ScaleImport）：位置' = (位置 - pivot) · scale。 */
export function importTransform(asset: AssetEntry): { pivot: [number, number, number]; scale: number } {
  const pivot = asObject(asset.data['PivotPosition']);
  return {
    pivot: [asNumber(pivot?.['X'], 0), asNumber(pivot?.['Y'], 0), asNumber(pivot?.['Z'], 0)],
    scale: asNumber(asset.data['ScaleImport'], 1),
  };
}

/** 同一个资源只导入一次：缓存导入的 Promise，结果是资源的内容路径。 */
export function once(cache: Map<string, Promise<string>>, asset: AssetEntry, importAsset: () => Promise<void>): Promise<string> {
  let pending = cache.get(asset.path);
  if (!pending) {
    pending = importAsset().then(() => asset.path);
    cache.set(asset.path, pending);
  }
  return pending;
}

/**
 * 读源文件交给原生的场景导入：.gltf 引用的外部 .bin 换成 data URI（原生侧读不了文件），.obj 按 OBJ 读，别的自动认。
 */
export async function loadSourceScene(tools: StrideTools, file: string): Promise<Scene> {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.obj') return tools.loadScene(await readFile(file), 'obj');
  if (extension !== '.gltf') return tools.loadScene(await readFile(file));
  const document = JSON.parse(await readFile(file, 'utf8')) as { buffers?: { uri?: string }[] };
  for (const buffer of document.buffers ?? []) {
    if (buffer.uri === undefined || buffer.uri.startsWith('data:')) continue;
    const bytes = await readFile(path.resolve(path.dirname(file), decodeURIComponent(buffer.uri)));
    buffer.uri = `data:application/octet-stream;base64,${bytes.toString('base64')}`;
  }
  return tools.loadScene(new TextEncoder().encode(JSON.stringify(document)), 'gltf');
}
