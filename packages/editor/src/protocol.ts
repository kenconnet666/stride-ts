/**
 * 编辑器的后端（Node，挂在开发服务器上）和前端（浏览器）之间的约定：HTTP 接口的路径、推送事件的名字、来回传的数据。
 * 两边都导入这个文件，只有类型和常量。
 *
 * HTTP（都在 EDITOR_API_PATH 下面，JSON）：
 *   GET  /project                        工程（ProjectInfo）
 *   GET  /assets                         所有资源（AssetRecord[]）
 *   GET  /asset?kind=&path=              一个 JSON 资源的内容
 *   PUT  /asset?kind=&path=[&create=1]   保存一个 JSON 资源（请求体是它的内容），返回它的 AssetRecord；create 时只新建（已有的 409）。
 *                                        模型只认 JSON 写的那种（程序生成的形状）
 *   DELETE /asset?kind=&path=[&force=1]  删掉一个资源（DeleteResult）；有别的资源引用它时不删（409），force 时照删
 *   POST /import?folder=&name=           导入拖进来的文件（请求体是文件的字节，name 是文件名）：音频成声音、图片成贴图、模型（glb、gltf、fbx、obj）
 *                                        成模型加材质加贴图，返回 ImportResult
 *   POST /move                           移动、改名资源（请求体 MoveRequest，返回 MoveResult），引用它们的文件跟着改写
 * 资源变了（编辑器保存的、别的程序改的、导入器写的）以后，后端经 Vite 的 HMR 通道推送 EDITOR_ASSETS_EVENT（AssetChanges）；
 * 前端用 `import.meta.hot.on(EDITOR_ASSETS_EVENT, ...)` 收。
 */
import type { AssetKind, AssetReference } from '@stride-ts/engine/content-references';

export const EDITOR_API_PATH = '/__stride/editor/api';
/** 编辑器的页面（server/vite.ts）：应用的开发服务器上的这个地址。 */
export const EDITOR_UI_PATH = '/__stride/editor/';
export const EDITOR_ASSETS_EVENT = 'stride:assets';

/** 工程清单（工程根目录下的 PROJECT_FILE）；文件可以没有，这时都用默认值。 */
export interface ProjectManifest {
  /** 清单的格式版本。 */
  readonly format: 1;
  /** 工程的名字；默认是 package.json 的 name。 */
  readonly name: string;
  /** 内容目录（运行时加载的资源，也是编辑器编辑的资源），相对工程根；默认 public/content。 */
  readonly content: string;
  /** 生成的资源句柄（见 docs/architecture.md 的"资源的强类型"），相对工程根；默认 src/assets.gen.ts。 */
  readonly assetTypes: string;
}

export const PROJECT_FILE = 'stride.project.json';

export interface ProjectInfo extends ProjectManifest {
  /** 内容目录在开发服务器上的地址（相对站点根，比如 `content/`）；内容目录不在 public 下面时是 null。 */
  readonly contentUrl: string | null;
}

/** 数据库里的一个资源。 */
export interface AssetRecord {
  readonly kind: AssetKind;
  /** 内容路径（不带扩展名）。 */
  readonly path: string;
  /** 它的文件，相对内容目录（正斜杠）：第一个是主文件，字体后面跟着它的字形块。 */
  readonly files: readonly string[];
  /** 所有文件的字节数。 */
  readonly bytes: number;
  /** 最后修改的时间（毫秒时间戳，取各文件里最晚的）。 */
  readonly modified: number;
  /** 它引用的资源（去过重；可能指向不存在的资源）。 */
  readonly references: readonly AssetReference[];
  /** 代码里用哪种句柄引用它（`prop.asset`、`content.load` 的种类）；不能直接引用的没有。 */
  readonly handle?: string;
  /** 主文件读不了、解析不了时的原因；这时 references 是空的。 */
  readonly error?: string;
}

/** 一个资源挪到哪：种类不变，内容路径从 from 换成 to。 */
export interface AssetMove {
  readonly kind: AssetKind;
  readonly from: string;
  readonly to: string;
}

/** 挪几个资源，或者把一个文件夹（内容路径的前缀）下面的资源整个挪走。 */
export type MoveRequest = { readonly assets: readonly AssetMove[] } | { readonly folder: string; readonly to: string };

export interface MoveResult {
  /** 挪过去以后的资源（声音和它同名的音频文件一起挪）。 */
  readonly moved: readonly AssetRecord[];
  /** 引用了挪走的资源、被改写了的资源。 */
  readonly rewritten: readonly AssetRecord[];
}

export interface DeleteResult {
  readonly removed: readonly AssetReference[];
  /** 还引用着删掉的资源的（force 删的时候），它们的引用断了。 */
  readonly broken: readonly AssetRecord[];
}

/** 导入一个文件的结果：新资源（模型导入时是模型；材质、贴图也写了，经推送到前端），和导入时的警告。 */
export interface ImportResult {
  readonly asset: AssetRecord;
  readonly warnings: readonly string[];
}

/** 一批文件变化以后数据库里变了的资源。 */
export interface AssetChanges {
  /** 新加的和内容变了的。 */
  readonly changed: readonly AssetRecord[];
  readonly removed: readonly AssetReference[];
}

export type { AssetKind, AssetReference };
