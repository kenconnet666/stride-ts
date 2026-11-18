/**
 * 动画系统：Stride 的 AnimationProcessor、SkeletonUpdater、ModelSkinningUpdater 合在一起。每帧在脚本和物理之后，给每个
 * 带骨架的模型求姿势（同一个实体上有 AnimationComponent 时按它的混合栈，没有时是静止姿势），再算它各个蒙皮网格的
 * 蒙皮矩阵。所有模型的请求写进一个 AnimationBatch，stride-native 在工作线程上并行求值；蒙皮矩阵留在原生内存里，
 * 渲染器（MeshRenderFeature）按 Skinned.palette 找到它们直接上传。
 *
 * 带骨架的模型由内容管理挂上（attach）：模型实体加 ModelSkeleton，每个网格实体加 Skinned。实体销毁时释放原生对象。
 *
 * 和 Stride 不同：Stride 在 Draw 里推进动画（用绘制的时间）；这里在 update 里（用更新的时间），暂停和单步因此对动画也生效。
 * 动画组件什么都没在播时 Stride 保留上一个姿势，这里也一样，只有第一次求一次静止姿势（不然蒙皮矩阵全是 0，网格看不见）。
 */
import { AnimationBatch, type AnimationInstance, type Skin as NativeSkin, type SkinPalette, type StrideNative } from '@stride-ts/native';
import type { EntityId } from '../data/prop';
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Skinned } from '../rendering/components';
import { AnimationComponent, type AnimationBlendStack } from './AnimationComponent';
import type { AnimationClip, Skeleton } from './resources';

/** 带骨架的模型：模型实体上，state 是动画系统里的骨架状态（从 1 开始）。 */
export const ModelSkeleton = component('ModelSkeleton', {
  state: prop.u32().default(0).transient(),
});

/** 模型的一个蒙皮网格：网格所在的实体和它的蒙皮（关节和逆绑定矩阵，同一个模型的实例共用）。 */
export interface SkinnedPart {
  readonly entity: Entity;
  readonly skin: NativeSkin;
}

interface PartState {
  readonly skin: NativeSkin;
  readonly palette: SkinPalette;
  /** 在所有蒙皮矩阵连起来的缓冲里的起点（按关节数）。 */
  readonly base: number;
}

interface SkeletonState {
  readonly entity: EntityId;
  readonly skeleton: Skeleton;
  readonly instance: AnimationInstance;
  readonly parts: readonly PartState[];
  /** 已经求过至少一次姿势。 */
  posed: boolean;
}

export class AnimationSystem {
  readonly #entities: EntityManager;
  readonly #batch: AnimationBatch;
  readonly #states: (SkeletonState | undefined)[] = [undefined];
  readonly #freeStates: number[] = [];
  readonly #palettes = new PaletteSpace();
  readonly #stack: BatchStack;

  /** 每帧推进动画、求姿势和蒙皮矩阵（加进 EntityManager，物理之后跑）。 */
  readonly system = system('AnimationSystem', {
    with: { skeleton: ModelSkeleton },
    phase: 'afterPhysics',
    update: ({ skeleton, count }, time) => this.#update(skeleton.state, count, time.elapsed),
    removed: (entity) => this.#release(entity),
  });

  constructor(native: StrideNative, entities: EntityManager) {
    this.#entities = entities;
    this.#batch = new AnimationBatch(native);
    this.#stack = new BatchStack(this.#batch);
  }

  /** 所有蒙皮矩阵连起来的关节数（渲染器按它分配 GPU 缓冲）。 */
  get paletteCapacity(): number {
    return this.#palettes.capacity;
  }

  /** 每个蒙皮网格的蒙皮矩阵：在连起来的缓冲里的起点（按关节数）和原生内存上的视图。 */
  forEachPalette(visit: (base: number, matrices: Float32Array) => void): void {
    for (const state of this.#states) {
      for (const part of state?.parts ?? []) visit(part.base, part.palette.matrices());
    }
  }

  /** 给模型实体挂上骨架：创建骨架实例，每个蒙皮网格分配一份蒙皮矩阵，网格实体加上 Skinned。 */
  attach(entity: Entity, skeleton: Skeleton, parts: readonly SkinnedPart[]): void {
    if (entity.get(ModelSkeleton)) throw new Error(`entity '${entity.name}' already has a skeleton`);
    const states: PartState[] = parts.map(({ entity: partEntity, skin }) => {
      const base = this.#palettes.allocate(skin.jointCount);
      partEntity.add(Skinned.with({ palette: base }));
      return { skin, palette: skin.createPalette(), base };
    });
    const state: SkeletonState = { entity: entity.id, skeleton, instance: skeleton.native.createInstance(), parts: states, posed: false };
    const id = this.#freeStates.pop() ?? this.#states.length;
    this.#states[id] = state;
    entity.add(ModelSkeleton.with({ state: id }));
  }

  /** 模型实体的骨架实例（模型空间的关节矩阵，挂到骨骼节点上要用）；没有骨架时是 undefined。 */
  instanceOf(entity: Entity): AnimationInstance | undefined {
    const view = entity.get(ModelSkeleton);
    return view ? this.#states[view.state]?.instance : undefined;
  }

  /**
   * 模型实体上名为 nodeName 的骨骼节点的模型空间矩阵（列主序 4x4，原生内存上的视图，下一次求姿势时更新）；
   * 没有骨架、没有这个节点时是 undefined。
   */
  nodeMatrix(entity: Entity, nodeName: string): Float32Array | undefined {
    const view = entity.get(ModelSkeleton);
    const state = view ? this.#states[view.state] : undefined;
    const joint = state?.skeleton.jointIndex(nodeName) ?? -1;
    return state && joint >= 0 ? state.instance.modelMatrices().subarray(joint * 16, joint * 16 + 16) : undefined;
  }

  destroy(): void {
    for (const state of this.#states) if (state) this.#free(state);
    this.#states.length = 1;
    this.#batch[Symbol.dispose]();
  }

  #update(stateIds: ArrayLike<number>, count: number, elapsed: number): void {
    const batch = this.#batch.clear();
    const components: AnimationComponent[] = [];
    for (let i = 0; i < count; i++) {
      const state = this.#states[stateIds[i]!]!;
      const animation = this.#entities.entity(state.entity).get(AnimationComponent);
      this.#stack.begin(state.skeleton);
      batch.instance(state.instance);
      let pushed = 0;
      if (animation?.blendTreeBuilder) {
        animation.blendTreeBuilder.buildBlendTree(this.#stack);
        pushed = this.#stack.pushed;
      } else if (animation) {
        pushed = animation.advanceAndBuild(elapsed, this.#stack);
        components.push(animation);
      }
      // 什么都没压时保留上一个姿势（同 Stride），只有第一次求静止姿势
      if (pushed === 0 && state.posed) continue;
      state.posed = true;
      for (const part of state.parts) batch.skin(part.skin, part.palette);
    }
    batch.evaluate();
    for (const animation of components) animation.updateWeights(elapsed);
  }

  #release(entity: EntityId): void {
    const id = this.#entities.entity(entity).require(ModelSkeleton).state;
    const state = this.#states[id];
    if (!state) return;
    this.#free(state);
    this.#states[id] = undefined;
    this.#freeStates.push(id);
  }

  #free(state: SkeletonState): void {
    for (const part of state.parts) {
      part.palette[Symbol.dispose]();
      this.#palettes.release(part.base, part.skin.jointCount);
    }
    state.instance.destroy();
  }
}

/** 给 BlendTreeBuilder 的混合栈：直接写进原生的 AnimationBatch，检查剪辑和模型用的是同一个骨架。 */
class BatchStack implements AnimationBlendStack {
  readonly #batch: AnimationBatch;
  #skeleton: Skeleton | undefined;
  pushed = 0;

  constructor(batch: AnimationBatch) {
    this.#batch = batch;
  }

  begin(skeleton: Skeleton): void {
    this.#skeleton = skeleton;
    this.pushed = 0;
  }

  push(clip: AnimationClip, time: number): this {
    if (clip.skeleton !== this.#skeleton) {
      throw new Error(`animation '${clip.name}' is for skeleton '${clip.skeleton.name}', but the model uses '${this.#skeleton?.name}'`);
    }
    this.#batch.push(clip.native, time);
    this.pushed++;
    return this;
  }

  blend(factor: number): this {
    this.#batch.blend(factor);
    return this;
  }

  add(factor: number): this {
    this.#batch.add(factor);
    return this;
  }

  subtract(factor: number): this {
    this.#batch.subtract(factor);
    return this;
  }
}

/** 蒙皮矩阵在连起来的缓冲里的位置：按关节数分配，释放的按大小留着给同样大小的复用。 */
class PaletteSpace {
  #capacity = 0;
  readonly #free = new Map<number, number[]>();

  get capacity(): number {
    return this.#capacity;
  }

  allocate(joints: number): number {
    const reused = this.#free.get(joints)?.pop();
    if (reused !== undefined) return reused;
    const base = this.#capacity;
    this.#capacity += joints;
    return base;
  }

  release(base: number, joints: number): void {
    let list = this.#free.get(joints);
    if (!list) this.#free.set(joints, (list = []));
    list.push(base);
  }
}
