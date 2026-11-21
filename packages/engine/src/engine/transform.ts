/**
 * 实体的变换（对应 Stride 的 TransformComponent）：本地位置、旋转、缩放和父实体，世界矩阵由 stride-native 算。
 * 数据在原生的变换存储（game.transforms）里，表里只存槽位；物理世界可以绑定这些槽位，步进后直接写回。
 *
 *   const box = entities.create({ components: [Transform.with({ position: [0, 5, 0] })] });
 *   box.require(Transform).position.y += 1;
 *   lamp.require(Transform).parent = box;
 *
 * 系统里按槽位读写：`const p = transform.slot[i] * 3; transform.position[p + 1] -= 1;`。
 * 世界矩阵在每帧 update 之后、draw 之前统一计算（Game 的帧循环），所以 update 里读到的 world 是上一帧的。
 * 和 Stride 不同，实体不自动带 Transform：只有数据的实体（粒子之类）用不着它，要的时候列出来。
 */
import type { TransformSlot, TransformStore } from '@stride-ts/native';
import { prop, type DataValues, type EntityId } from '../data/prop';
import { createSchema, type Column } from '../data/schema';
import { Matrix, type Matrix4, type MatrixSource } from '../data/Matrix';
import type { Vec3Like } from '../data/vectors';
import { ComponentType, type ExternalStorage } from './component';
import type { Entity } from './Entity';
import type { EntityManager } from './EntityManager';

const shape = {
  position: prop.vec3(),
  rotation: prop.quat(),
  scale: prop.vec3().default([1, 1, 1]),
};

export type TransformShape = typeof shape;

/** 系统里拿到的 Transform 列：每行一个槽位，其余是原生存储的列，按槽位下标。 */
export interface TransformColumns {
  /** 每行实体的槽位：position[slot * 3]、rotation[slot * 4]、scale[slot * 3]、world[slot * 16]。 */
  readonly slot: Int32Array;
  /** 本地位置（双精度）。 */
  readonly position: Float64Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  /** 世界矩阵（双精度），列主序 4x4，平移在 12..14；每帧 update 之后算出。玩法（物理、声音、导航、脚本）用它。 */
  readonly world: Float64Array;
  /**
   * 渲染用的世界矩阵（单精度），平移相对渲染原点（`game.renderOrigin`，相机附近按格对齐）；和 world 一起算出。渲染（GPU、剔除、
   * 灯光、相机的视图矩阵）一律用它：远处的东西在相机附近也有足够的精度。
   */
  readonly renderWorld: Float32Array;
}

export type TransformView = DataValues<TransformShape> & {
  /** 世界矩阵（双精度，列主序 4x4），原生内存上的视图。 */
  readonly world: Float64Array;
  /** 渲染用的世界矩阵（单精度，平移相对渲染原点 `game.renderOrigin`），渲染的代码用它。 */
  readonly renderWorld: Float32Array;
  /** 父实体，undefined 表示根。父实体也要有 Transform，不能形成环；改父实体时本地值不变（同 Stride）。 */
  parent: Entity | undefined;
  readonly children: readonly Entity[];
  /**
   * 现在就算出世界矩阵（这个实体和它的祖先，Stride 的 UpdateWorldMatrix）。世界矩阵平时在每帧 update 之后统一算，
   * 脚本在那之前（比如第一帧的 start 里）要用世界位姿时先调用它。
   */
  updateWorldMatrix(): void;
  /** 本地位置、旋转、缩放拼成的矩阵（Stride 的 LocalMatrix）；写进 out，没给时新建一个。 */
  localMatrix(out?: Matrix4): Matrix4;
  /** 把矩阵拆成本地位置、旋转、缩放（Stride 的 `matrix.Decompose(out Scale, out Rotation, out Position)`），只对没有切变的矩阵精确。 */
  setLocalMatrix(matrix: MatrixSource): void;
};

/** 一个变换存储在 TS 这边的记录：槽位属于哪个实体（场景的根不属于实体）、每个槽位有哪些子槽位。 */
interface TransformState {
  readonly store: TransformStore;
  readonly data: readonly Column[];
  readonly owner: (EntityId | undefined)[];
  readonly children: (Set<number> | undefined)[];
}

const states = new WeakMap<TransformStore, TransformState>();

function stateOf(manager: EntityManager): TransformState {
  const store = manager.game.transforms as TransformStore | undefined;
  if (!store) throw new Error('Transform needs the native transform store: create entities with Transform after Game.run has loaded the native module');
  let state = states.get(store);
  if (!state) {
    state = { store, data: [store.position, store.rotation, store.scale], owner: [], children: [] };
    states.set(store, state);
  }
  return state;
}

function slotOf(manager: EntityManager, entity: EntityId): TransformSlot {
  return manager.slotOf(entity, Transform) as TransformSlot;
}

function setParent(manager: EntityManager, entity: EntityId, parent: Entity | undefined): void {
  if (parent && parent.manager !== manager) throw new Error(`entity ${entity} and its parent '${parent.name}' belong to different games`);
  // 没有父实体的实体挂在它所在场景的根下面（见 SceneRoot）
  const sceneRoot = parent ? undefined : manager.peek(entity)?.ownScene?.root;
  attach(stateOf(manager), slotOf(manager, entity), parent ? slotOf(manager, parent.id) : (sceneRoot?.slot ?? null));
}

/** 槽位挂到 parentSlot 下面（null 是没有父节点），两边的子槽位表跟着改。 */
function attach(state: TransformState, slot: number, parentSlot: number | null): void {
  const previous = state.store.parent[slot]!;
  state.store.setParent(slot as TransformSlot, parentSlot as TransformSlot | null);
  state.children[previous]?.delete(slot);
  if (parentSlot !== null) (state.children[parentSlot] ??= new Set()).add(slot);
}

/**
 * 场景的根（Stride 的 Scene.Offset、Scene.Parent）：场景在变换存储里占一个槽位，不属于任何实体。场景里没有父实体的实体在存储里
 * 挂在它下面，世界矩阵因此带上场景的偏移；子场景的根挂在父场景的根下面，偏移一层层累加。实体自己的本地位置不带偏移，对脚本
 * 来说它们仍然是根（Transform.parent 是 undefined）。
 */
export class SceneRoot {
  /** @internal 在变换存储里的槽位。 */
  readonly slot: TransformSlot;
  /** 场景的偏移（相对父场景）；可以随时改，下一次算世界矩阵时生效。 */
  readonly offset: Vec3Like;
  readonly #state: TransformState;

  constructor(manager: EntityManager, offset: readonly [number, number, number] = [0, 0, 0], parent?: SceneRoot) {
    const state = (this.#state = stateOf(manager));
    const slot = (this.slot = state.store.allocate());
    state.owner[slot] = undefined;
    state.store.position.set(offset, slot * 3);
    if (parent) attach(state, slot, parent.slot);
    const component = (axis: number): PropertyDescriptor => ({
      enumerable: true,
      get: () => state.store.position[slot * 3 + axis]!,
      set: (value: number) => (state.store.position[slot * 3 + axis] = value),
    });
    this.offset = Object.defineProperties({}, { x: component(0), y: component(1), z: component(2) }) as Vec3Like;
  }

  /** 场景卸载时释放：还挂在下面的（没跟着场景销毁的实体、别的场景的根）变成没有父节点。 */
  dispose(): void {
    const state = this.#state;
    for (const child of [...(state.children[this.slot] ?? [])]) attach(state, child, null);
    state.children[this.slot] = undefined;
    state.children[state.store.parent[this.slot]!]?.delete(this.slot);
    state.store.free(this.slot);
  }
}

/**
 * @internal 实体放进或者移出场景以后（Entity.scene、EntityManager.create）：没有父实体的实体改挂到新场景的根下面
 * （没有场景、或者场景没有根时不挂）。
 */
export function syncSceneRoot(manager: EntityManager, entity: Entity): void {
  if (!entity.has(Transform)) return;
  const state = stateOf(manager);
  const slot = slotOf(manager, entity.id);
  // 有父实体的跟着父实体
  if (state.owner[state.store.parent[slot]!] !== undefined) return;
  attach(state, slot, entity.ownScene?.root?.slot ?? null);
}

const external: ExternalStorage = {
  tableFields: createSchema({ slot: prop.int() }, 'f32', new Set(), 'Transform').fields,

  data: (manager) => stateOf(manager).data,

  allocate(manager, entity) {
    const state = stateOf(manager);
    const slot = state.store.allocate();
    state.owner[slot] = entity;
    // 已经在场景里的实体后加 Transform：挂到场景的根下面（刚创建的实体这时还没有实体对象，由 create 接着挂）
    const sceneRoot = manager.peek(entity)?.ownScene?.root;
    if (sceneRoot) attach(state, slot, sceneRoot.slot);
    return slot;
  },

  release(manager, entity, destroying) {
    const state = stateOf(manager);
    const slot = slotOf(manager, entity);
    const children = state.children[slot];
    if (children?.size) {
      if (!destroying) throw new Error(`cannot remove Transform from entity ${entity}: it has ${children.size} child entities; destroy or reparent them first`);
      // 像 Stride 把实体移出场景一样，子实体跟着销毁
      for (const child of [...children]) manager.destroy(state.owner[child]!);
    }
    state.children[state.store.parent[slot]!]?.delete(slot);
    state.children[slot] = undefined;
    state.owner[slot] = undefined;
    state.store.free(slot);
  },

  chunk(manager, set) {
    const { store } = stateOf(manager);
    // 表增长时槽位列会换成新数组，所以用访问器现取
    return {
      get slot() {
        return set.columns[0] as Int32Array;
      },
      position: store.position,
      rotation: store.rotation,
      scale: store.scale,
      world: store.world,
      renderWorld: store.renderWorld,
    } satisfies TransformColumns as TransformColumns;
  },

  extendView(manager, entity, view) {
    Object.defineProperties(view, {
      world: {
        enumerable: true,
        get: () => {
          const at = slotOf(manager, entity) * 16;
          return stateOf(manager).store.world.subarray(at, at + 16);
        },
      },
      renderWorld: {
        enumerable: true,
        get: () => {
          const at = slotOf(manager, entity) * 16;
          return stateOf(manager).store.renderWorld.subarray(at, at + 16);
        },
      },
      parent: {
        enumerable: true,
        get: () => {
          // 挂在场景的根下面（槽位不属于实体）的也是根
          const owner = stateOf(manager).owner[stateOf(manager).store.parent[slotOf(manager, entity)]!];
          return owner === undefined ? undefined : manager.entity(owner);
        },
        set: (parent: Entity | undefined) => setParent(manager, entity, parent),
      },
      children: {
        enumerable: true,
        get: () => {
          const state = stateOf(manager);
          return [...(state.children[slotOf(manager, entity)] ?? [])].map((child) => manager.entity(state.owner[child]!));
        },
      },
      updateWorldMatrix: {
        value: () => stateOf(manager).store.updateSlot(slotOf(manager, entity)),
      },
      localMatrix: {
        value: (out: Matrix4 = new Float32Array(16)) => {
          const { store } = stateOf(manager);
          const slot = slotOf(manager, entity);
          return Matrix.compose(out, store.position.subarray(slot * 3, slot * 3 + 3), store.rotation.subarray(slot * 4, slot * 4 + 4), store.scale.subarray(slot * 3, slot * 3 + 3));
        },
      },
      setLocalMatrix: {
        value: (matrix: MatrixSource) => {
          const { store } = stateOf(manager);
          const slot = slotOf(manager, entity);
          const { translation, rotation, scale } = Matrix.decompose(matrix);
          store.position.set(translation, slot * 3);
          store.rotation.set(rotation, slot * 4);
          store.scale.set(scale, slot * 3);
        },
      },
    });
  },
};

export const Transform = new ComponentType('Transform', shape, {}, external) as ComponentType<TransformShape, never> & {
  readonly __columns: TransformColumns;
  readonly __view: TransformView;
};

/** 实体的变换槽位，绑定物理刚体时用：`world.addBox({ halfExtent, transform: transformSlot(box) })`。 */
/** 变换槽位属于哪个实体（场景的根、空着的槽位是 undefined）；渲染那边按槽位认实例，点选时用它换回实体。 */
export function entityAtSlot(manager: EntityManager, slot: number): Entity | undefined {
  const id = stateOf(manager).owner[slot];
  return id === undefined ? undefined : manager.entity(id);
}

export function transformSlot(entity: Entity): TransformSlot {
  return slotOf(entity.manager, entity.id);
}
