/**
 * 资源种类的登记表：内置的（EXTENSIONS 的各种，加上贴图、音频、源模型这几种附属的文件）和游戏、编辑器扩展登记的自定义种类。
 * 一种资源在引擎里要知道两件事：主文件的扩展名，文件里引用了哪些别的资源（编辑器移动、改名、删除资源时照它改写引用，资源
 * 浏览器列依赖，加载场景时预加载）。内置种类的引用写在 references.ts，自定义的写在登记里，查的时候走同一条路。
 *
 * 加一种自定义的资源：
 *   declare module '@stride-ts/engine' { interface CustomAssetKinds { lamp: LampFile } }   // 种类名 → 主文件的内容（类型）
 *   registerAssetKind('lamp', { extension: '.lamp.json', references: (file, refs) => refs.add('material', file, 'material') });
 *   registerAssetFields('lamp', fields<LampFile>({ ... }));                                  // 属性面板的字段（editor/fields）
 * 编辑器里的新建模板、界面上的名字、后端的烘焙由编辑器的扩展登记（@stride-ts/editor 的 README）。
 *
 * 只依赖文件格式，Node 里也能直接运行（编辑器后端、管线用），所以相对导入写了扩展名。
 */
import { EXTENSIONS } from './formats/assetFormat.ts';
import type { TextureRef } from './formats/format';
import type { AssetKind } from './references.ts';

/** 收集一个文件里的引用：`owner[key]` 是被引用的资源的内容路径。 */
export interface ReferenceSink {
  add(kind: AssetKind, owner: object, key: string | number): void;
  /** 贴图引用（TextureRef 的 texture 是图片的内容路径）。 */
  image(texture: TextureRef): void;
}

/** 一种自定义资源在引擎里的说明；F 是主文件解析好的内容。 */
export interface AssetKindDefinition<F = unknown> {
  /** 主文件的扩展名，带点（`.lamp.json`）；以 `.json` 结尾的是 JSON 文件，编辑器能经接口读写、在属性面板里改。 */
  readonly extension: string;
  /** 文件里引用别的资源的每一处；不引用别的资源时不写。 */
  readonly references?: (file: F, refs: ReferenceSink) => void;
}

/**
 * 自定义的资源种类：游戏、编辑器扩展用声明合并加（键是种类名，值是主文件的内容），AssetKind 就包括它们，
 * registerAssetKind 的 references 拿到的文件也是这个类型。
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- 留给声明合并的接口
export interface CustomAssetKinds {}

type CustomFile<K extends string> = K extends keyof CustomAssetKinds ? CustomAssetKinds[K] : unknown;

const custom = new Map<string, AssetKindDefinition<never>>();

/**
 * 登记一种自定义的资源（同一个种类再登记一次是替换：热重载时扩展模块重新执行）。种类名不能和内置的重，扩展名不能和别的
 * 种类重。
 */
export function registerAssetKind<K extends string>(kind: K, definition: AssetKindDefinition<CustomFile<K>>): void {
  if (Object.hasOwn(EXTENSIONS, kind) || kind === 'image' || kind === 'audio' || kind === 'modelSource') throw new Error(`registerAssetKind: '${kind}' is a built-in asset kind`);
  if (!/^\.[\w.-]+$/.test(definition.extension)) throw new Error(`registerAssetKind: the extension of '${kind}' must start with a dot, got '${definition.extension}'`);
  const taken = [...Object.entries(EXTENSIONS), ...[...custom].filter(([other]) => other !== kind).map(([other, { extension }]) => [other, extension] as const)]
    .find(([, extension]) => extension === definition.extension);
  if (taken) throw new Error(`registerAssetKind: '${definition.extension}' is already the extension of '${taken[0]}'`);
  custom.set(kind, definition as AssetKindDefinition<never>);
}

/** 登记过的自定义种类（种类名和说明）。 */
export function customAssetKinds(): ReadonlyMap<string, AssetKindDefinition<never>> {
  return custom;
}

/** 一种资源主文件的扩展名；贴图、音频、源模型有好几种扩展名，没有一个主文件扩展名（undefined），没登记的种类也是。 */
export function assetKindExtension(kind: AssetKind): string | undefined {
  if (kind === 'image' || kind === 'audio' || kind === 'modelSource') return undefined;
  return Object.hasOwn(EXTENSIONS, kind) ? EXTENSIONS[kind as keyof typeof EXTENSIONS] : custom.get(kind)?.extension;
}

/** 主文件是 JSON 的种类（编辑器能经接口读写）。模型可以是 JSON 写的程序生成的形状，也算（二进制的模型读写时再拒绝）。 */
export function isJsonAssetKind(kind: AssetKind): boolean {
  return kind === 'model' || (assetKindExtension(kind)?.endsWith('.json') ?? false);
}

/** 自定义种类的文件里的引用（内置种类的在 references.ts 的 assetReferenceSlots）。 */
export function customAssetReferences(kind: string, file: unknown, refs: ReferenceSink): void {
  custom.get(kind)?.references?.(file as never, refs);
}
