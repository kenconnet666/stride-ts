/**
 * 视口工具正在编辑的一个资源文件（多边形网格、样条、白盒、地形）：撤销、重做和存盘。撤销用 vue-tsx-pro 的 createHistory：
 * 文件按不可变的方式换，每一步只存引用（clone 是原样、equals 比引用）。工具一次操作做完（松开把手、落完一笔）调 commit 记一步、
 * 存盘；撤销、重做把那一步的文件交给 restore（换回工具里、刷新工具条），再存盘（后端重新烘模型、视口热重载）。
 */
import { createHistory, type History } from '@zerodep-dev/vue-tsx-pro-ui';
import type { EditorClient } from '../../EditorClient.ts';
import type { AssetKind } from '../../protocol.ts';

export interface FileEditingOptions<F> {
  readonly client: EditorClient;
  readonly kind: AssetKind;
  readonly path: string;
  /** 打开时文件的内容（撤销的起点）。 */
  readonly file: F;
  /** 撤销、重做换了文件：交给工具、刷新界面。 */
  readonly restore: (file: F) => void;
  /** 存盘失败（后端烘不出来、写不了）的原因。 */
  readonly onError: (message: string) => void;
}

export class FileEditing<F extends object> {
  readonly kind: AssetKind;
  readonly path: string;
  readonly history: History;
  readonly #options: FileEditingOptions<F>;
  #file: F;

  constructor(options: FileEditingOptions<F>) {
    this.#options = options;
    this.kind = options.kind;
    this.path = options.path;
    this.#file = options.file;
    this.history = createHistory<F>({
      read: () => this.#file,
      write: (file) => {
        this.#file = file;
        options.restore(file);
        this.#save();
      },
      clone: (file) => file,
      equals: (a, b) => a === b,
    });
  }

  /** 最近一次记下（存过）的文件。 */
  get file(): F {
    return this.#file;
  }

  /** 一次操作做完：记一步撤销、存盘；和上一步是同一个文件时什么也不做。 */
  commit(file: F): void {
    if (file === this.#file) return;
    this.#file = file;
    this.history.commit();
    this.#save();
  }

  #save(): void {
    const { client, kind, path, onError } = this.#options;
    void client.saveAsset(kind, path, this.#file).catch((error: unknown) => onError((error as Error).message));
  }
}
