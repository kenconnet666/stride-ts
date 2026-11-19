/**
 * 编辑器里的场景文档：场景文件（SceneFile 的 JSON）是真相，编辑器的每个操作都是对它的一次修改（SceneEdit），运行着的实体
 * 照着文档更新，保存就是把文档写出去。不从运行时的实体反推文件：运行时里资源已经换成了 id、合并过默认值，推不回去，
 * 而且脚本运行中改的状态不该进文件。
 *
 * 修改只有三种：改一个实体里某条路径上的值、加实体、删实体；`apply` 返回把它撤回去的那个修改，撤销重做（UndoStack）
 * 就建在这上面。文档是不可变的：每次修改得到新的对象，没动的实体还是原来那个对象，所以"哪些实体变了"比较引用就知道
 * （content/SceneBuilder 的 changedEntities），界面和运行时（LiveScene）都只更新变了的。
 *
 * 预制体文件也是一列实体，同样用这个类（`new SceneDocument<PrefabFile>(prefab)`）。
 *
 * 开销（实体数 n）：改值是拷一遍实体列表的引用（十万个实体不到 1 毫秒）；加、删不管一次动多少个实体都只扫一遍列表。
 */
import type { SceneEntityFile, SceneFile } from '../content/format';

/** 有一列实体的文件：场景、预制体。 */
export interface EntitiesFile {
  readonly name: string;
  readonly entities: readonly SceneEntityFile[];
}

/** 实体文件里的一条路径：`['position']`、`['components', 'light', 'intensity']`、`['components', 'scripts', 0, 'props', 'speed']`。 */
export type ScenePath = readonly (string | number)[];

export type SceneEdit =
  /**
   * 把实体里 path 上的值设成 value；value 是 undefined 时删掉这个键。列表：下标等于长度是在末尾加一项，undefined 只能去掉
   * 最后一项；别的改法把整个列表设成新的。
   */
  | { readonly type: 'set'; readonly entity: string; readonly path: ScenePath; readonly value: unknown }
  /**
   * 加实体（一个，或者一棵子树、一次粘贴的全部）。index 是加完以后它在实体列表里的位置，按从小到大给；父实体必须排在它前面
   * （可以是同一次加的）。
   */
  | { readonly type: 'add'; readonly entities: readonly { readonly entity: SceneEntityFile; readonly index: number }[] }
  /** 删实体；留下的实体里不能还有它们的子实体（删一棵子树用 removeSubtree 给出全部）。 */
  | { readonly type: 'remove'; readonly entities: readonly string[] }
  /** 几个修改当成一个（一起做、一起撤销）；换父实体就是删了再加在别处。 */
  | { readonly type: 'batch'; readonly edits: readonly SceneEdit[] };

export class SceneDocument<F extends EntitiesFile = SceneFile> {
  #file: F;
  #version = 0;

  constructor(file: F) {
    this.#file = file;
  }

  /** 现在的文件（不可变）；保存就是把它写成 JSON（`JSON.stringify(document.file, null, 1)`，同导入器写的）。 */
  get file(): F { return this.#file; }
  /** 每做一次修改加一。 */
  get version(): number { return this.#version; }

  entity(id: string): SceneEntityFile | undefined {
    return this.#file.entities[indexOf(this.#file.entities, id)];
  }

  /** 实体的直接子实体，按文件里的顺序。 */
  children(id: string | null): SceneEntityFile[] {
    return this.#file.entities.filter((entity) => entity.parent === id);
  }

  /** 实体里 path 上现在的值；路径不存在时是 undefined。 */
  get(entity: string, path: ScenePath): unknown {
    let value: unknown = this.#require(entity);
    for (const key of path) {
      if (value === null || typeof value !== 'object') return undefined;
      value = (value as Record<string | number, unknown>)[key];
    }
    return value;
  }

  /** 做一个修改，返回撤回它的修改。不合法的修改（实体不存在、id 重复、父实体在后面、还有子实体）抛异常，文档不变。 */
  apply(edit: SceneEdit): SceneEdit {
    const [file, inverse] = applyEdit(this.#file, edit);
    this.#file = file;
    this.#version++;
    return inverse;
  }

  /** 删掉一个实体和它的所有后代的修改。 */
  removeSubtree(id: string): SceneEdit {
    this.#require(id);
    // 父实体排在前面：顺着扫一遍，后代都收得到
    const ids = new Set([id]);
    for (const entity of this.#file.entities) if (entity.parent !== null && ids.has(entity.parent)) ids.add(entity.id);
    return { type: 'remove', entities: [...ids] };
  }

  #require(id: string): SceneEntityFile {
    const entity = this.entity(id);
    if (!entity) throw new Error(`scene ${this.#file.name}: no entity ${id}`);
    return entity;
  }
}

/**
 * 实体列表 → 实体的 id 到下标的表，用到时才建。只改值的修改不动顺序，得到的新列表接着用同一张表；加、删实体得到的新列表
 * 没有表，下次要找时再建。
 */
const INDICES = new WeakMap<readonly SceneEntityFile[], ReadonlyMap<string, number>>();

function indexOf(entities: readonly SceneEntityFile[], id: string): number {
  let indices = INDICES.get(entities);
  if (!indices) {
    indices = new Map(entities.map((entity, index) => [entity.id, index]));
    INDICES.set(entities, indices);
  }
  return indices.get(id) ?? -1;
}

function applyEdit<F extends EntitiesFile>(file: F, edit: SceneEdit): [F, SceneEdit] {
  const where = `scene ${file.name}`;
  switch (edit.type) {
    case 'batch': {
      // 逆操作按相反的顺序
      const inverses: SceneEdit[] = [];
      let current = file;
      for (const step of edit.edits) {
        const [next, inverse] = applyEdit(current, step);
        current = next;
        inverses.unshift(inverse);
      }
      return [current, { type: 'batch', edits: inverses }];
    }
    case 'set': {
      const index = indexOf(file.entities, edit.entity);
      if (index < 0) throw new Error(`${where}: no entity ${edit.entity}`);
      if (edit.path.length === 0) throw new Error(`${where}: an edit needs a path`);
      if (edit.path.length === 1 && (edit.path[0] === 'id' || edit.path[0] === 'parent')) throw new Error(`${where}: ${String(edit.path[0])} cannot be set; remove and add the entity instead`);
      const [updated, previous] = setAt(file.entities[index]!, edit.path, edit.value, `${where}: entity ${edit.entity}`);
      const entities = file.entities.slice();
      entities[index] = updated as SceneEntityFile;
      // 顺序没变：下标的表接着用
      const indices = INDICES.get(file.entities);
      if (indices) INDICES.set(entities, indices);
      return [{ ...file, entities }, { type: 'set', entity: edit.entity, path: edit.path, value: previous }];
    }
    case 'add': {
      const additions = edit.entities;
      const added = new Map(additions.map(({ entity, index }) => [entity.id, index]));
      if (added.size !== additions.length) throw new Error(`${where}: the same entity is added twice`);
      // 按位置把新实体插进去：一遍扫完
      const entities = new Array<SceneEntityFile>(file.entities.length + additions.length);
      let next = 0, kept = 0;
      for (let i = 0; i < entities.length; i++) entities[i] = additions[next]?.index === i ? additions[next++]!.entity : file.entities[kept++]!;
      if (next !== additions.length || kept !== file.entities.length) {
        throw new Error(`${where}: cannot add entities at ${additions.map(({ index }) => index).join(', ')}; give ascending positions in the resulting list of ${entities.length}`);
      }
      // 原来在第 at 个的实体现在的位置：前面插进了几个，它就往后挪几个（index 减去"第几个"是插入点前面原有实体的个数，从小到大）
      const shifted = (at: number): number => {
        let low = 0, high = additions.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (additions[middle]!.index - middle <= at) low = middle + 1;
          else high = middle;
        }
        return at + low;
      };
      for (const { entity, index } of additions) {
        if (indexOf(file.entities, entity.id) >= 0) throw new Error(`${where}: entity ${entity.id} already exists`);
        if (entity.parent === null) continue;
        const existing = indexOf(file.entities, entity.parent);
        const parent = added.get(entity.parent) ?? (existing < 0 ? Infinity : shifted(existing));
        if (parent >= index) throw new Error(`${where}: entity ${entity.id} must come after its parent ${entity.parent}`);
      }
      return [{ ...file, entities }, { type: 'remove', entities: additions.map(({ entity }) => entity.id) }];
    }
    case 'remove': {
      const removing = new Set(edit.entities);
      if (removing.size !== edit.entities.length) throw new Error(`${where}: the same entity is removed twice`);
      for (const id of removing) if (indexOf(file.entities, id) < 0) throw new Error(`${where}: no entity ${id}`);
      const entities: SceneEntityFile[] = [];
      const removed: { entity: SceneEntityFile; index: number }[] = [];
      file.entities.forEach((entity, index) => {
        if (removing.has(entity.id)) removed.push({ entity, index });
        else if (entity.parent !== null && removing.has(entity.parent)) throw new Error(`${where}: entity ${entity.parent} still has children`);
        else entities.push(entity);
      });
      return [{ ...file, entities }, { type: 'add', entities: removed }];
    }
  }
}

/** 不改原对象：沿路径一层层拷贝，返回新的根和路径上原来的值。 */
function setAt(root: unknown, path: ScenePath, value: unknown, where: string): [unknown, unknown] {
  const [key, ...rest] = path as [string | number, ...(string | number)[]];
  if (root === null || typeof root !== 'object') throw new Error(`${where}: ${String(key)} is not inside an object`);
  const container = root as Record<string | number, unknown>;
  const [next, previous] = rest.length === 0 ? [value, container[key]] : setAt(container[key], rest, value, where);
  if (Array.isArray(root)) {
    if (typeof key !== 'number' || key < 0 || key > root.length) throw new Error(`${where}: ${String(key)} is not an index of the list`);
    const copy = root.slice();
    if (next === undefined) {
      // 列表里只能去掉最后一项（它的逆操作是在末尾设回去）；去掉中间的会让后面的下标都变，改成把整个列表设成新的
      if (key !== root.length - 1) throw new Error(`${where}: only the last item of a list can be removed; set the whole list instead`);
      copy.pop();
    } else {
      copy[key] = next;
    }
    return [copy, previous];
  }
  const copy = { ...container };
  if (next === undefined) delete copy[key];
  else copy[key] = next;
  return [copy, previous];
}

/**
 * 撤销重做：记下每次修改的逆操作。连着改同一个值（拖 Gizmo、拖滑块，每帧一次）时给同一个 mergeKey，它们并成一步，
 * 撤销回到拖之前的值。
 */
export class UndoStack<F extends EntitiesFile = SceneFile> {
  readonly #document: SceneDocument<F>;
  #undo: { inverse: SceneEdit; mergeKey: string | undefined }[] = [];
  #redo: SceneEdit[] = [];

  constructor(document: SceneDocument<F>) {
    this.#document = document;
  }

  /** 文档现在的文件（所以撤销栈可以直接交给 EditAgent.open：它读文件、经 apply 和 commit 改）。 */
  get file(): F { return this.#document.file; }

  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }

  /** 做一个修改并记下来；重做的记录清掉。mergeKey 和上一步的一样时并进上一步。 */
  apply(edit: SceneEdit, mergeKey?: string): void {
    const inverse = this.#document.apply(edit);
    this.#redo = [];
    const last = this.#undo.at(-1);
    // 并进上一步：撤销只要回到最早的那个值，新的逆操作不用留
    if (mergeKey !== undefined && last?.mergeKey === mergeKey) return;
    this.#undo.push({ inverse, mergeKey });
  }

  /** 结束一次连着的修改（松开鼠标）：之后同样的 mergeKey 也另起一步。 */
  commit(): void {
    const last = this.#undo.at(-1);
    if (last) last.mergeKey = undefined;
  }

  undo(): boolean {
    const step = this.#undo.pop();
    if (!step) return false;
    this.#redo.push(this.#document.apply(step.inverse));
    return true;
  }

  redo(): boolean {
    const edit = this.#redo.pop();
    if (!edit) return false;
    this.#undo.push({ inverse: this.#document.apply(edit), mergeKey: undefined });
    return true;
  }
}
