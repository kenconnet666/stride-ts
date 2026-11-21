/**
 * 按 id 找资源（网格、材质、立方体贴图、天空盒、碰撞体）：数据组件的列里只能存数字，所以组件存资源的 id，
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

  /** 去掉一个资源；id 不再复用（列里还存着旧 id 的组件取到 undefined，不会错指到别的资源）。 */
  remove(id: number): void {
    this.#items[id] = undefined;
  }
}
