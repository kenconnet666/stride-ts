/**
 * 工程的编辑器扩展（`stride.project.json` 的 `extension` 写模块的路径）：一次把一种自定义资源的全部登记进来——引擎要的
 * （扩展名、引用了哪些资源）、属性面板的字段、界面上的名字、"新建"菜单里的模板、后端怎么烘成模型。编辑器后端和 MCP 服务
 * 打开工程时装上（Node 里），界面也加载同一个模块（浏览器里，烘焙不在界面跑）；所以模块的顶层不能引用 Node 的东西，烘焙要用的
 * 放进 bake 里动态导入。
 *
 *   // apps/my-game/editor/extension.ts
 *   import { defineEditorExtension } from '@stride-ts/editor/extension';
 *   export default defineEditorExtension({
 *     assetKinds: [{
 *       kind: 'lamp', extension: '.lamp.json',
 *       label: { 'zh-CN': '台灯', en: 'Lamp' },
 *       references: (file, refs) => refs.add('material', file, 'material'),
 *       fields: fields<LampFile>({ ... }),
 *       template: { name: 'NewLamp', content: (name) => ({ name, material: null, height: 0.5 }) },
 *       bake: (file, { assetPath }) => [{ path: `${assetPath}.model`, bytes: JSON.stringify(lampModel(file)) }],
 *     }],
 *   });
 *
 * 类型上让 AssetKind 认得它：`declare module '@stride-ts/engine' { interface CustomAssetKinds { lamp: LampFile } }`。
 * 游戏运行时要加载这种资源（预加载引用）时，游戏代码里也装一次（installEditorExtension 只登记引擎那部分时不用编辑器）。
 */
import { registerAssetKind, type AssetKind, type ReferenceSink } from '@stride-ts/engine/content-references';
import { registerAssetFields, type Field } from '@stride-ts/engine/editor-fields';
import type { StrideTools } from '@stride-ts/native/tools';

/** 烘的时候能用的：原生工具（Manifold、贴图编码……）、读内容目录里的文件。 */
export interface ExtensionBakeContext {
  readonly tools: StrideTools;
  readonly read: (file: string) => Promise<Uint8Array>;
  /** 这个资源的内容路径；烘出的文件一般和它同名（`${assetPath}.model`）。 */
  readonly assetPath: string;
  /** 报错时消息的开头（`lamp Lamps/Desk`）。 */
  readonly where: string;
}

/** 烘出的一个文件：相对内容目录的路径和内容。 */
export interface ExtensionBakedFile {
  readonly path: string;
  readonly bytes: string | Uint8Array;
}

/** 扩展登记的一种资源；F 是主文件解析好的内容。 */
export interface ExtensionAssetKind<F = never> {
  /** 种类名（场景、接口里写的），不能和内置的重。 */
  readonly kind: string;
  /** 主文件的扩展名，带点；`.json` 结尾的能在属性面板里改。 */
  readonly extension: string;
  /** 文件里引用别的资源的每一处（移动、改名、删除时改写，列依赖）。 */
  readonly references?: (file: F, refs: ReferenceSink) => void;
  /** 属性面板的字段（引擎 editor/fields 的 `fields<F>()`）。 */
  readonly fields?: readonly Field[];
  /** 界面上的名字：一个字符串，或者按界面语言（`zh-CN`、`en`）；没写时显示种类名。 */
  readonly label?: string | Readonly<Partial<Record<'zh-CN' | 'en', string>>>;
  /** 资源浏览器"新建"菜单里的一项：默认的名字和初始内容。 */
  readonly template?: { readonly name: string; readonly content: (name: string) => F };
  /** 存下、改了以后后端烘出的文件（一般是同名的模型）；参数不对时抛错，消息以 context.where 开头。 */
  readonly bake?: (file: F, context: ExtensionBakeContext) => readonly ExtensionBakedFile[] | Promise<readonly ExtensionBakedFile[]>;
  /** 烘出的同名资源（跟着源文件挪、删）：种类和路径后缀，默认是同名的模型 `[['model', '']]`。 */
  readonly outputs?: readonly (readonly [AssetKind, string])[];
}

export interface EditorExtension {
  // 每种资源的文件类型不同，列表里只能是 any：defineAssetKind 给单个的类型
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly assetKinds?: readonly ExtensionAssetKind<any>[];
}

/** 给扩展模块的默认导出补类型（原样返回）。 */
export function defineEditorExtension(extension: EditorExtension): EditorExtension {
  return extension;
}

/** 单独写一种资源时补类型（原样返回）：`defineAssetKind<LampFile>({ ... })`。 */
export function defineAssetKind<F>(kind: ExtensionAssetKind<F>): ExtensionAssetKind<F> {
  return kind;
}

const installed = new Map<string, ExtensionAssetKind<unknown>>();

/** 装上一个扩展：引擎的种类和字段登记进去，名字、模板、烘焙记在这里（extensionAssetKind 查）。再装一次是替换。 */
export function installEditorExtension(extension: EditorExtension): void {
  for (const kind of extension.assetKinds ?? []) {
    registerAssetKind(kind.kind, { extension: kind.extension, ...(kind.references ? { references: kind.references as (file: unknown, refs: ReferenceSink) => void } : {}) });
    if (kind.fields) registerAssetFields(kind.kind, kind.fields);
    installed.set(kind.kind, kind as ExtensionAssetKind<unknown>);
  }
}

/** 装上的扩展登记的一种资源；不是扩展的种类是 undefined。 */
export function extensionAssetKind(kind: string): ExtensionAssetKind<unknown> | undefined {
  return installed.get(kind);
}

/** 装上的扩展登记的全部资源。 */
export function extensionAssetKinds(): readonly ExtensionAssetKind<unknown>[] {
  return [...installed.values()];
}

/** 扩展的种类在界面上的名字：按语言取，没有就用别的语言的，都没有用种类名。 */
export function extensionLabel(kind: ExtensionAssetKind<unknown>, locale: string): string {
  const { label } = kind;
  if (typeof label === 'string') return label;
  return label?.[locale as 'zh-CN' | 'en'] ?? label?.en ?? label?.['zh-CN'] ?? kind.kind;
}
