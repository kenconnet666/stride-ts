/**
 * 按 id 找资源（网格、材质、立方体贴图、天空盒）：数据组件的列里只能存数字，所以组件存资源的 id，
 * 渲染特性按 id 取回对象。id 从 1 开始，0 表示"没有"。
 */
export class ResourceTable<T> {
  readonly #items: (T | undefined)[] = [undefined];

  /** 登记一个资源，返回它的 id。 */
  add(item: T): number {
    this.#items.push(item);
    return this.#items.length - 1;
  }

  get(id: number): T | undefined {
    return this.#items[id];
  }
}
