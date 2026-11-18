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
import { Matrix, type Matrix4 } from '../mathematics/Matrix';
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
  readonly position: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  /** 世界矩阵，列主序 4x4，平移在 12..14；每帧 update 之后算出。 */
  readonly world: Float32Array;
}

export type TransformView = DataValues<TransformShape> & {
  /** 世界矩阵（列主序 4x4），原生内存上的视图。 */
  readonly world: Float32Array;
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
  setLocalMatrix(matrix: Readonly<Matrix4>): void;
};

/** 一个变换存储在 TS 这边的记录：槽位属于哪个实体、每个槽位有哪些子槽位。 */
interface TransformState {
  readonly store: TransformStore;
  readonly data: readonly Column[];
  readonly owner: EntityId[];
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
  const state = stateOf(manager);
  const slot = slotOf(manager, entity);
  const parentSlot = parent ? slotOf(manager, parent.id) : null;
  const previous = state.store.parent[slot]!;
  state.store.setParent(slot, parentSlot);
  state.children[previous]?.delete(slot);
  if (parentSlot !== null) (state.children[parentSlot] ??= new Set()).add(slot);
}

const external: ExternalStorage = {
  tableFields: createSchema({ slot: prop.int() }, 'f32', new Set(), 'Transform').fields,

  data: (manager) => stateOf(manager).data,

  allocate(manager, entity) {
    const state = stateOf(manager);
    const slot = state.store.allocate();
    state.owner[slot] = entity;
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
      parent: {
        enumerable: true,
        get: () => {
          const parent = stateOf(manager).store.parent[slotOf(manager, entity)]!;
          return parent === 0 ? undefined : manager.entity(stateOf(manager).owner[parent]!);
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
        value: (matrix: Readonly<Matrix4>) => {
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
export function transformSlot(entity: Entity): TransformSlot {
  return slotOf(entity.manager, entity.id);
}
