/**
 * Stride 工程的资源索引：扫描各个包的资源目录，按 GUID 找资源（场景、模型、材质、预制体、纹理）。
 * 资源的内容路径是"包名/相对资源目录的路径"（不带扩展名），比如 `PrototypingBlocks/Models/Wall0x2x5`；
 * Stride 的引用写成 `guid:url`，url 有时带包名有时不带，按 GUID 找最可靠。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseStrideYaml, type StrideObject } from './yaml.ts';

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

const ASSET_EXTENSIONS = new Set(['.sdscene', '.sdm3d', '.sdmat', '.sdprefab', '.sdtex', '.sdsky', '.sdgamesettings']);

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
