/**
 * 资源数据库：内容目录里有哪些资源、各自是哪些文件、谁引用了谁。启动时扫一遍目录（scan），之后文件变了只重读变了的
 * （refresh，文件监视和保存接口调它）。资源浏览器、"改名、删除前看看谁在用"、生成资源句柄（assetTypes.ts）都读它。
 *
 * 资源按"种类 + 内容路径"认，种类由文件的扩展名定（引擎的 EXTENSIONS、TEXTURE_EXTENSIONS）；认不出的文件不管。
 * 引用关系用引擎的 assetReferences 取，和运行时加载场景时去读哪些文件是同一份逻辑。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeAnimation, decodeModel, EXTENSIONS, isProceduralModel, parseJsonc, parseProceduralModel, TEXTURE_EXTENSIONS, type UIFile } from '@stride-ts/engine/content-format';
import { assetKindExtension, assetReferences, customAssetKinds, type AssetKind, type AssetReference } from '@stride-ts/engine/content-references';
import type { AssetChanges, AssetRecord } from '../../shared/protocol.ts';

/** 声音的音频文件（引擎的 SoundEncoding）。 */
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav', '.flac', '.aac'];
/** 导入设置旁边的源模型（ModelSourceFormat）：运行时不读，编辑器重新导入时用。 */
const MODEL_SOURCE_EXTENSIONS = ['.glb', '.gltf', '.fbx', '.obj'];

/** 内置的扩展名 → 种类（贴图、音频、源模型有好几种扩展名）。 */
const BUILTIN_EXTENSIONS: readonly (readonly [extension: string, kind: AssetKind])[] = [
  ...Object.entries(EXTENSIONS).filter(([kind]) => kind !== 'glyphs').map(([kind, extension]) => [extension, kind as AssetKind] as const),
  ...Object.values(TEXTURE_EXTENSIONS).map((extension) => [extension, 'image'] as const),
  ...AUDIO_EXTENSIONS.map((extension) => [extension, 'audio'] as const),
  ...MODEL_SOURCE_EXTENSIONS.map((extension) => [extension, 'modelSource'] as const),
];

/**
 * 扩展名 → 种类（内置的加上登记的自定义种类），长的在前：`.material.json` 要先于别的 `.json` 认出来。JSON 的种类也认 `.jsonc`
 * （人手写、带注释的，`.shelf.jsonc`）。登记变了重建。
 */
let kindByExtension: { readonly custom: number; readonly table: readonly (readonly [string, AssetKind])[] } | undefined;
function extensionTable(): readonly (readonly [string, AssetKind])[] {
  const custom = customAssetKinds();
  if (kindByExtension?.custom !== custom.size) {
    const table = [...BUILTIN_EXTENSIONS, ...[...custom].map(([kind, { extension }]) => [extension, kind as AssetKind] as const)]
      .flatMap(([extension, kind]) => (extension.endsWith('.json') ? [[extension, kind], [`${extension}c`, kind]] as const : [[extension, kind]] as const))
      .sort((a, b) => b[0].length - a[0].length);
    kindByExtension = { custom: custom.size, table };
  }
  return kindByExtension.table;
}

/** 字体的一个字形块：`<字体>.<块号>.glyphs`。 */
const GLYPH_BLOCK = /^(.*)\.\d+\.glyphs$/;

/** 代码里能直接引用的种类（引擎的 AssetTypes）；UI 文件按内容分页面和库。 */
const HANDLE_KINDS: ReadonlySet<AssetKind> = new Set(['model', 'material', 'animation', 'scene', 'prefab', 'font', 'spriteSheet', 'texture', 'sound']);

/** 内容目录里的一个文件属于哪个资源；part 是附属文件（字形块），不是主文件。认不出的是 undefined。 */
export function classifyAssetFile(file: string): { kind: AssetKind; path: string; part: boolean } | undefined {
  const glyphs = GLYPH_BLOCK.exec(file);
  if (glyphs) return { kind: 'font', path: glyphs[1]!, part: true };
  for (const [extension, kind] of extensionTable()) {
    if (file.endsWith(extension) && file.length > extension.length) return { kind, path: file.slice(0, -extension.length), part: false };
  }
  return undefined;
}

/** 一种资源的主文件名（内容路径加扩展名）；贴图、音频、源模型有几种扩展名，不在这里。 */
export function assetFileName(kind: Exclude<AssetKind, 'image' | 'audio' | 'modelSource'>, assetPath: string): string {
  const extension = assetKindExtension(kind);
  if (extension === undefined) throw new Error(`no asset kind '${kind}' (register custom kinds with registerAssetKind)`);
  return assetPath + extension;
}

interface Entry {
  readonly kind: AssetKind;
  readonly path: string;
  main: string | undefined;
  readonly files: Map<string, { bytes: number; modified: number }>;
  references: readonly AssetReference[];
  handle: string | undefined;
  error: string | undefined;
  /** 给外面的快照，内容变了就丢掉重做。 */
  record: AssetRecord | undefined;
}

/** 数据库里认资源的键。 */
export const assetKey = (kind: AssetKind, assetPath: string): string => `${kind}:${assetPath}`;

export class AssetDatabase {
  readonly contentDir: string;
  readonly #entries = new Map<string, Entry>();
  /** 被引用的资源 → 引用它的资源的键；用到时才建，数据库变了就丢掉。 */
  #referrers: Map<string, string[]> | undefined;

  constructor(contentDir: string) {
    this.contentDir = contentDir;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** 一个资源的主文件（相对内容目录）：`.json` 和 `.jsonc` 是哪个就是哪个；没有这个资源、没有主文件时是 undefined。 */
  mainFile(kind: AssetKind, assetPath: string): string | undefined {
    return this.#entries.get(assetKey(kind, assetPath))?.main;
  }

  get(kind: AssetKind, assetPath: string): AssetRecord | undefined {
    const entry = this.#entries.get(assetKey(kind, assetPath));
    return entry && this.#record(entry);
  }

  /** 所有资源，按种类、路径排好。 */
  list(): AssetRecord[] {
    return [...this.#entries.values()].map((entry) => this.#record(entry))
      .sort((a, b) => (a.kind === b.kind ? compare(a.path, b.path) : compare(a.kind, b.kind)));
  }

  /** 引用了这个资源的资源。 */
  referrers(kind: AssetKind, assetPath: string): AssetRecord[] {
    if (!this.#referrers) {
      this.#referrers = new Map();
      for (const [key, entry] of this.#entries) {
        for (const reference of entry.references) {
          const target = assetKey(reference.kind, reference.path);
          const list = this.#referrers.get(target);
          if (list) list.push(key);
          else this.#referrers.set(target, [key]);
        }
      }
    }
    return (this.#referrers.get(assetKey(kind, assetPath)) ?? []).map((key) => this.#record(this.#entries.get(key)!));
  }

  /** 指向不存在的资源的引用。 */
  missing(): { from: AssetReference; to: AssetReference }[] {
    const found: { from: AssetReference; to: AssetReference }[] = [];
    for (const entry of this.#entries.values()) {
      for (const to of entry.references) {
        if (!this.#entries.has(assetKey(to.kind, to.path))) found.push({ from: { kind: entry.kind, path: entry.path }, to });
      }
    }
    return found;
  }

  /** 把内容目录整个扫一遍（目录不存在时数据库是空的）。 */
  async scan(): Promise<void> {
    this.#entries.clear();
    this.#referrers = undefined;
    let entries;
    try {
      entries = await readdir(this.contentDir, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const files = entries.filter((entry) => entry.isFile())
      .map((entry) => path.relative(this.contentDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
    await this.refresh(files);
  }

  /**
   * 这些文件（相对内容目录，正斜杠）加了、改了或者删了：重读它们所属的资源，返回变了的。文件现在在不在、变没变以磁盘
   * 为准（大小和修改时间），所以同一个文件报几次、报了没变的文件都没关系，也不会重读。
   */
  async refresh(files: readonly string[]): Promise<AssetChanges> {
    const touched = new Set<string>();
    const unique = [...new Set(files)];
    // 一次读一批：文件多的时候不把句柄用光
    for (let at = 0; at < unique.length; at += READ_BATCH) {
      const keys = await Promise.all(unique.slice(at, at + READ_BATCH).map((file) => this.#refreshFile(file)));
      for (const key of keys) if (key !== undefined) touched.add(key);
    }
    if (touched.size > 0) this.#referrers = undefined;
    const changed: AssetRecord[] = [];
    const removed: AssetReference[] = [];
    for (const key of touched) {
      const entry = this.#entries.get(key);
      if (entry) changed.push(this.#record(entry));
      else removed.push({ kind: key.slice(0, key.indexOf(':')) as AssetKind, path: key.slice(key.indexOf(':') + 1) });
    }
    return { changed, removed };
  }

  /** 返回这个文件所属的资源的键；认不出的文件、本来就不在的文件、没变的文件是 undefined。 */
  async #refreshFile(file: string): Promise<string | undefined> {
    const found = classifyAssetFile(file);
    if (!found) return undefined;
    const key = assetKey(found.kind, found.path);
    const absolute = path.join(this.contentDir, file);
    const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    let entry = this.#entries.get(key);
    if (!info?.isFile()) {
      if (!entry?.files.delete(file)) return undefined;
      entry.record = undefined;
      if (entry.files.size === 0) this.#entries.delete(key);
      else if (entry.main === file) Object.assign(entry, { main: undefined, references: [], handle: undefined, error: 'the main file is missing' });
      return key;
    }
    if (!entry) {
      entry = { kind: found.kind, path: found.path, main: undefined, files: new Map(), references: [], handle: undefined, error: found.part ? 'the main file is missing' : undefined, record: undefined };
      this.#entries.set(key, entry);
    }
    // 大小和修改时间都没变：没改过，不重读（自己保存的文件，监视器还会再报一次）
    const known = entry.files.get(file);
    if (known?.bytes === info.size && known.modified === info.mtimeMs) return undefined;
    entry.files.set(file, { bytes: info.size, modified: info.mtimeMs });
    entry.record = undefined;
    if (!found.part) {
      entry.main = file;
      await this.#read(entry, absolute);
    }
    return key;
  }

  /** 读主文件，取它引用的资源；读不了、解析不了时记下原因。 */
  async #read(entry: Entry, absolute: string): Promise<void> {
    entry.references = [];
    entry.error = undefined;
    entry.handle = HANDLE_KINDS.has(entry.kind) ? entry.kind : undefined;
    try {
      if (entry.kind === 'model') {
        const bytes = await readFile(absolute);
        // 两种写法：JSON 的（程序生成的形状）只有材质槽，二进制的材质、骨架在文件头里
        const model = isProceduralModel(bytes) ? { materials: parseProceduralModel(bytes, absolute).materials ?? [] } : decodeModel(ownBuffer(bytes), absolute);
        entry.references = assetReferences('model', entry.path, model);
      } else if (entry.kind === 'animation') {
        entry.references = assetReferences('animation', entry.path, decodeAnimation(ownBuffer(await readFile(absolute)), absolute));
      } else if (/\.jsonc?$/.test(entry.main!)) {
        const file: unknown = parseJsonc(await readFile(absolute, 'utf8'), absolute);
        entry.references = assetReferences(entry.kind, entry.path, file);
        if (entry.kind === 'ui') entry.handle = (file as UIFile).root !== undefined ? 'uiPage' : 'uiLibrary';
      }
    } catch (error) {
      entry.references = [];
      entry.error = (error as Error).message;
    }
  }

  #record(entry: Entry): AssetRecord {
    if (entry.record) return entry.record;
    const parts = [...entry.files.keys()].filter((file) => file !== entry.main).sort(compare);
    let bytes = 0, modified = 0;
    for (const file of entry.files.values()) {
      bytes += file.bytes;
      modified = Math.max(modified, file.modified);
    }
    return (entry.record = {
      kind: entry.kind,
      path: entry.path,
      files: entry.main === undefined ? parts : [entry.main, ...parts],
      bytes,
      modified,
      references: entry.references,
      ...(entry.handle !== undefined ? { handle: entry.handle } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    });
  }
}

const READ_BATCH = 64;

/** Node 的 Buffer 可能是一块大内存里的一段：拷出自己的 ArrayBuffer 再解。 */
export const ownBuffer = (bytes: Buffer): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** 按码位比较：排序结果不随机器的语言环境变。 */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
