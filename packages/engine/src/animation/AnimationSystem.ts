/**
 * 动画系统：Stride 的 AnimationProcessor、SkeletonUpdater、ModelSkinningUpdater 合在一起。每帧在脚本和物理之后，给每个
 * 带骨架的模型求姿势（同一个实体上有 AnimationComponent 时按它的混合栈，没有时是静止姿势），再算它各个蒙皮网格的
 * 蒙皮矩阵。所有模型的请求写进一个 AnimationBatch，stride-native 在工作线程上并行求值；蒙皮矩阵留在原生内存里，
 * 渲染器（MeshRenderFeature）按 Skinned.palette 找到它们直接上传。
 *
 * 带骨架的模型由内容管理挂上（attach）：模型实体加 ModelSkeleton，每个网格实体加 Skinned。实体销毁时释放原生对象。
 * 带形变目标的模型（attachMorphs）：模型实体加 ModelMorph（权重见 morphs()），带形变的网格实体加 Morphed；剪辑里的形变曲线
 * 和骨架的轨道走同一个混合栈（MorphStack）。没有骨架、只有形变的模型由 morphSystem 推进它的 AnimationComponent。
 *
 * 和 Stride 不同：Stride 在 Draw 里推进动画（用绘制的时间）；这里在 update 里（用更新的时间），暂停和单步因此对动画也生效。
 * 动画组件什么都没在播时 Stride 保留上一个姿势，这里也一样，只有第一次求一次静止姿势（不然蒙皮矩阵全是 0，网格看不见）。
 */
import { AnimationBatch, type AnimationIk, type AnimationInstance, type Skin as NativeSkin, type SkinPalette, type StrideNative } from '@stride-ts/native';
import type { EntityId } from '../data/prop';
import { prop } from '../data/prop';
import { component } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import { Transform } from '../engine/transform';
import { system } from '../engine/system';
import { Skinned } from '../rendering/components';
import { AnimationComponent, type AnimationBlendStack } from './AnimationComponent';
import { PropertyAnimated, PropertyStack } from './curves';
import { ModelMorphs, Morphed, MorphStack } from './morphs';
import { AnimationClip, type Skeleton } from './resources';

/** 带骨架的模型：模型实体上，state 是动画系统里的骨架状态（从 1 开始）。 */
export const ModelSkeleton = component('ModelSkeleton', {
  state: prop.u32().default(0).transient(),
});

/** 带形变目标的模型：模型实体上，state 是动画系统里的形变权重（从 1 开始）。 */
export const ModelMorph = component('ModelMorph', {
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
  /** 姿势由别处写（布娃娃）：每帧调它写好关节矩阵，不求动画，只算蒙皮。 */
  poseSource: (() => void) | undefined;
  /** 求值以后做的 IK，按来源（脚贴地、看向各一个）；变了要重新交给原生。 */
  ik: Map<object, readonly AnimationIk[]> | undefined;
  ikDirty: boolean;
  /** 从 blendFromPose 存的快照淡回动画：还剩多少秒、一共多少秒。 */
  fade: { remaining: number; readonly duration: number } | undefined;
  /** 按距离降频跳过的帧攒下的时间（秒），下次求值时一起推进。 */
  pending: number;
}

export class AnimationSystem {
  readonly #entities: EntityManager;
  readonly #batch: AnimationBatch;
  readonly #states: (SkeletonState | undefined)[] = [undefined];
  readonly #freeStates: number[] = [];
  readonly #palettes = new SlotSpace();
  readonly #morphs: (ModelMorphs | undefined)[] = [undefined];
  readonly #freeMorphs: number[] = [];
  readonly #morphSpace = new SlotSpace();
  readonly #stack: BatchStack;
  readonly #cloning: Disposable;
  /**
   * 动画按距离降频（Stride 没有；同虚幻的 Update Rate Optimizations、Unity 的 Animator 的 culling）：离关注点（focus，Game 每帧给
   * 主相机的位置）不到 distances[0] 米的每帧求，不到 distances[1] 的隔一帧，不到 distances[2] 的每 4 帧一次，再远的每 8 帧；跳过的帧
   * 保留上一个姿势，时间攒着下次一起推进；按实体编号错开，一群人不挤在同一帧。空数组关掉。
   */
  readonly lod = { distances: [25, 60, 120] as number[] };
  /** 降频的关注点（世界位置）；没有时每帧都求。 */
  focus: readonly [number, number, number] | undefined;
  /** 上一帧：求了几个骨架、跳过了几个。 */
  lodStats = { evaluated: 0, skipped: 0 };

  /** 每帧推进动画、求姿势和蒙皮矩阵（加进 EntityManager，物理之后跑）。 */
  readonly system = system('AnimationSystem', {
    with: { skeleton: ModelSkeleton },
    phase: 'afterPhysics',
    update: ({ skeleton, count }, time) => this.#update(skeleton.state, count, time.elapsed),
    removed: (entity) => this.#release(entity),
  });

  /** 没有骨架也没有形变的实体播带属性曲线的剪辑（灯、相机、普通的实体）：推进它的动画组件，把曲线的值写到组件上。 */
  readonly propertySystem = system('AnimationSystem.properties', {
    with: { animated: PropertyAnimated },
    without: [ModelSkeleton, ModelMorph],
    phase: 'afterPhysics',
    update: ({ entities, count }, time) => {
      for (let i = 0; i < count; i++) this.#animateMorphs(entities[i]!, undefined, time.elapsed);
    },
  });

  /** 没有骨架、只有形变的模型：推进它的动画组件，按形变曲线写权重。 */
  readonly morphSystem = system('AnimationSystem.morphs', {
    with: { morph: ModelMorph },
    without: [ModelSkeleton],
    phase: 'afterPhysics',
    update: ({ morph, entities, count }, time) => {
      for (let i = 0; i < count; i++) this.#animateMorphs(entities[i]!, this.#morphs[morph.state[i]!]!, time.elapsed);
    },
    removed: (entity) => this.#releaseMorphs(entity),
  });

  readonly #native: StrideNative;
  readonly #retargeted = new WeakMap<AnimationClip, Map<string, AnimationClip>>();

  constructor(native: StrideNative, entities: EntityManager) {
    this.#native = native;
    this.#entities = entities;
    this.#batch = new AnimationBatch(native);
    this.#stack = new BatchStack(this.#batch);
    this.#cloning = entities.onClone((clones) => this.#attachClones(clones));
  }

  /**
   * 克隆的模型实体挂上自己的骨架实例和形变权重（共用骨架、蒙皮这些资源）：姿势从绑定姿势开始，形变权重照抄现在的值。
   * ModelSkeleton、Skinned 这些只有运行时状态的组件克隆时不抄，在这里按被克隆的那一份重新挂。
   */
  #attachClones(clones: ReadonlyMap<Entity, Entity>): void {
    /** 被克隆的子树里带着 type、而且 field 等于 value 的实体的克隆（找出一个骨架、一组权重对应的网格实体）。 */
    const partsWith = (type: typeof Skinned | typeof Morphed, field: 'palette' | 'weights', value: number): Entity[] =>
      [...clones].filter(([source]) => (source.get(type) as Record<string, number> | undefined)?.[field] === value).map(([, clone]) => clone);
    for (const [source, clone] of clones) {
      const state = this.#states[source.get(ModelSkeleton)?.state ?? 0];
      if (state) {
        const parts = state.parts.flatMap(({ skin, base }) => partsWith(Skinned, 'palette', base).map((entity) => ({ entity, skin })));
        this.attach(clone, state.skeleton, parts);
      }
      const morphs = this.#morphs[source.get(ModelMorph)?.state ?? 0];
      if (morphs) this.attachMorphs(clone, morphs.morphTargetNames, partsWith(Morphed, 'weights', morphs.base)).weights.set(morphs.weights);
    }
  }

  /** 所有蒙皮矩阵连起来的关节数（渲染器按它分配 GPU 缓冲）。 */
  get paletteCapacity(): number {
    return this.#palettes.capacity;
  }

  /** 所有模型实例的形变权重连起来的个数（渲染器按它分配 GPU 缓冲）。 */
  get morphCapacity(): number {
    return this.#morphSpace.capacity;
  }

  /** 每个模型实例的形变权重：在连起来的缓冲里的起点和权重。 */
  forEachMorph(visit: (base: number, weights: Float32Array) => void): void {
    for (const morphs of this.#morphs) if (morphs) visit(morphs.base, morphs.weights);
  }

  /** 模型实体的形变权重；模型没有形变目标时是 undefined。 */
  morphs(entity: Entity): ModelMorphs | undefined {
    const view = entity.get(ModelMorph);
    return view ? this.#morphs[view.state] : undefined;
  }

  /** 给模型实体挂上形变权重（targetNames 按模型的目标槽），带形变的网格实体加上 Morphed。 */
  attachMorphs(entity: Entity, targetNames: readonly string[], parts: readonly Entity[]): ModelMorphs {
    if (entity.get(ModelMorph)) throw new Error(`entity '${entity.name}' already has morph targets`);
    const morphs = new ModelMorphs(targetNames, this.#morphSpace.allocate(targetNames.length));
    for (const part of parts) part.add(Morphed.with({ weights: morphs.base }));
    const id = this.#freeMorphs.pop() ?? this.#morphs.length;
    this.#morphs[id] = morphs;
    entity.add(ModelMorph.with({ state: id }));
    return morphs;
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
    const state: SkeletonState = { entity: entity.id, skeleton, instance: skeleton.native.createInstance(), parts: states, posed: false, poseSource: undefined, ik: undefined, ikDirty: false, fade: undefined, pending: 0 };
    const id = this.#freeStates.pop() ?? this.#states.length;
    this.#states[id] = state;
    entity.add(ModelSkeleton.with({ state: id }));
  }

  /** 模型实体的骨架实例（模型空间的关节矩阵，挂到骨骼节点上要用）；没有骨架时是 undefined。 */
  instanceOf(entity: Entity): AnimationInstance | undefined {
    const view = entity.get(ModelSkeleton);
    return view ? this.#states[view.state]?.instance : undefined;
  }

  /** 模型实体的骨架（关节的名字、父关节）；没有骨架时是 undefined。 */
  skeletonOf(entity: Entity): Skeleton | undefined {
    const view = entity.get(ModelSkeleton);
    return view ? this.#states[view.state]?.skeleton : undefined;
  }

  /**
   * 让别处写这个模型的姿势（布娃娃）：每帧调 source 写好关节矩阵（instanceOf 的 modelMatrices），动画组件不再求值，蒙皮照常；
   * undefined 交还给动画。没有骨架时报错。
   */
  setPoseSource(entity: Entity, source: (() => void) | undefined): void {
    const view = entity.get(ModelSkeleton);
    const state = view ? this.#states[view.state] : undefined;
    if (!state) throw new Error(`setPoseSource: entity '${entity.name}' has no skeleton`);
    state.poseSource = source;
  }

  /**
   * 从现在的姿势（上一次求值的，或者布娃娃写的）在 duration 秒里淡回动画：姿势先存成快照，之后每帧动画的姿势和它按剩下的时间混。
   * rootCorrection（列主序 4x4）是模型自己挪了时的修正（新的模型到世界的逆乘旧的，布娃娃以后扶正），姿势在世界里不跳。没有骨架时
   * 报错。
   */
  blendFromPose(entity: Entity, duration: number, rootCorrection?: ArrayLike<number>): void {
    const view = entity.get(ModelSkeleton);
    const state = view ? this.#states[view.state] : undefined;
    if (!state) throw new Error(`blendFromPose: entity '${entity.name}' has no skeleton`);
    state.instance.snapshot(rootCorrection);
    state.fade = duration > 0 ? { remaining: duration, duration } : undefined;
  }

  /**
   * 重定向（照虚幻的 IK Retargeter、Unity 的 Humanoid）：给别的骨架做的剪辑搬到 target 上，返回新的剪辑（缓存：同一个剪辑、骨架、
   * 选项只建一次）。关节默认按名字对（去掉 `mixamorig:` 这类命名空间前缀，不分大小写，只看字母和数字），map 写"目标关节名: 源关节名"
   * 盖掉自动对的；对不上的目标关节保持静止姿势跟着父关节。髋默认找两边都对上的、名字带 hips 或 pelvis 的，没有时取第一个对上的；
   * inPlace 时髋不挪（原地的动画）。两边的静止姿势要像（都是 T 字或都是 A 字）。
   */
  retarget(clip: AnimationClip, target: Skeleton, options: { map?: Readonly<Record<string, string>>; inPlace?: boolean } = {}): AnimationClip {
    const bones = clip.bones;
    if (!bones) throw new Error(`retarget: animation '${clip.name}' has no skeleton tracks`);
    const key = `${target.name}|${JSON.stringify(options)}`;
    let byKey = this.#retargeted.get(clip);
    if (!byKey) this.#retargeted.set(clip, (byKey = new Map()));
    const cached = byKey.get(key);
    if (cached) return cached;
    const source = bones.skeleton;
    const sourceByName = new Map(source.joints.map((joint, j) => [retargetName(joint.name), j]));
    const sourceOf = target.joints.map((joint) => {
      const explicit = options.map?.[joint.name];
      if (explicit !== undefined) {
        const index = source.jointIndex(explicit);
        if (index < 0) throw new Error(`retarget: source skeleton '${source.name}' has no joint '${explicit}' (map for '${joint.name}')`);
        return index;
      }
      return sourceByName.get(retargetName(joint.name)) ?? -1;
    });
    if (!sourceOf.some((s) => s >= 0)) throw new Error(`retarget: no joint of '${target.name}' matches '${source.name}' (give a map)`);
    let hips = -1;
    if (!options.inPlace) {
      hips = target.joints.findIndex((joint, j) => sourceOf[j]! >= 0 && /hips|pelvis/i.test(joint.name));
      if (hips < 0) hips = sourceOf.findIndex((s) => s >= 0);
    }
    const native = this.#native.retargetAnimation(bones.native, source.native, target.native, sourceOf, hips, hips >= 0 ? sourceOf[hips]! : -1);
    const result = new AnimationClip(`${clip.name}@${target.name}`, clip.duration, clip.repeatMode, { skeleton: target, native }, clip.morphWeights, clip.curves);
    byKey.set(key, result);
    return result;
  }

  /**
   * 设模型的 IK（每次求动画以后在原生里做，见 @stride-ts/native 的 AnimationIk）：owner 是来源（一个脚本），几个来源的按登记的先后
   * 依次做；空数组去掉这个来源的。目标在模型空间。没有骨架时报错。
   */
  setIk(entity: Entity, owner: object, iks: readonly AnimationIk[]): void {
    const view = entity.get(ModelSkeleton);
    const state = view ? this.#states[view.state] : undefined;
    if (!state) throw new Error(`setIk: entity '${entity.name}' has no skeleton`);
    state.ik ??= new Map();
    if (iks.length === 0) state.ik.delete(owner);
    else state.ik.set(owner, iks);
    state.ikDirty = true;
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
    this.#cloning[Symbol.dispose]();
    for (const state of this.#states) if (state) this.#free(state);
    this.#states.length = 1;
    this.#morphs.length = 1;
    this.#batch[Symbol.dispose]();
  }

  /** 这个实体这一帧要不要求动画（按距离降频）。 */
  #due(state: SkeletonState, entity: Entity, frame: number): boolean {
    const focus = this.focus, distances = this.lod.distances;
    if (!focus || distances.length === 0 || !state.posed || state.fade) return true;
    const world = entity.require(Transform).world;
    const distance = Math.hypot(world[12]! - focus[0], world[13]! - focus[1], world[14]! - focus[2]);
    let band = distances.findIndex((limit) => distance < limit);
    if (band < 0) band = distances.length;
    const interval = 1 << band;
    return (frame + state.entity) % interval === 0;
  }

  #update(stateIds: ArrayLike<number>, count: number, elapsed: number): void {
    const batch = this.#batch.clear();
    const components: [AnimationComponent, number][] = [];
    const frame = this.#entities.game.updateTime.frameCount;
    let evaluated = 0, skipped = 0;
    for (let i = 0; i < count; i++) {
      const state = this.#states[stateIds[i]!]!;
      if (state.poseSource) {
        state.poseSource();
        batch.posed(state.instance);
        state.posed = true;
        for (const part of state.parts) batch.skin(part.skin, part.palette);
        continue;
      }
      const entity = this.#entities.entity(state.entity);
      if (!this.#due(state, entity, frame)) {
        state.pending += elapsed;
        skipped++;
        continue;
      }
      const dt = elapsed + state.pending;
      state.pending = 0;
      evaluated++;
      const animation = entity.get(AnimationComponent);
      if (state.ikDirty) {
        state.instance.setIk([...state.ik!.values()].flat());
        state.ikDirty = false;
      }
      this.#stack.begin(state.skeleton, this.morphs(entity));
      batch.instance(state.instance);
      let pushed = 0;
      if (animation?.blendTreeBuilder) {
        animation.blendTreeBuilder.buildBlendTree(this.#stack);
        pushed = this.#stack.pushed;
      } else if (animation) {
        pushed = animation.advanceAndBuild(dt, this.#stack);
        components.push([animation, dt]);
      }
      if (pushed > 0) {
        this.#stack.morphs.apply();
        this.#stack.properties.apply(entity);
      }
      // 从快照淡出（布娃娃交还给动画）：动画的姿势和快照按剩下的时间混；没有动画时只压快照
      let poses = this.#stack.poses;
      const fade = state.fade;
      if (fade) {
        batch.pushSnapshot();
        if (poses > 0) batch.blend(Math.max(0, fade.remaining / fade.duration));
        poses = 1;
        fade.remaining -= dt;
        if (fade.remaining <= 0) state.fade = undefined;
      }
      // 没压进骨架的姿势时保留上一个姿势（同 Stride），只有第一次求静止姿势
      if (poses === 0 && state.posed && !state.ik?.size) continue;
      state.posed = true;
      for (const part of state.parts) batch.skin(part.skin, part.palette);
    }
    batch.evaluate();
    for (const [animation, dt] of components) animation.updateWeights(dt);
    this.lodStats = { evaluated, skipped };
  }

  /** 没有骨架的实体：形变权重（有的话）和属性曲线。 */
  #animateMorphs(id: EntityId, morphs: ModelMorphs | undefined, elapsed: number): void {
    const entity = this.#entities.entity(id);
    const animation = entity.get(AnimationComponent);
    if (!animation) return;
    this.#stack.begin(undefined, morphs);
    if (animation.blendTreeBuilder) animation.blendTreeBuilder.buildBlendTree(this.#stack);
    else animation.advanceAndBuild(elapsed, this.#stack);
    this.#stack.morphs.apply();
    this.#stack.properties.apply(entity);
    if (!animation.blendTreeBuilder) animation.updateWeights(elapsed);
  }

  #releaseMorphs(entity: EntityId): void {
    const id = this.#entities.entity(entity).require(ModelMorph).state;
    const morphs = this.#morphs[id];
    if (!morphs) return;
    this.#morphSpace.release(morphs.base, morphs.weights.length);
    this.#morphs[id] = undefined;
    this.#freeMorphs.push(id);
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

/**
 * 给 BlendTreeBuilder 的混合栈：骨架的部分直接写进原生的 AnimationBatch（检查剪辑和模型用的是同一个骨架），形变的部分在
 * MorphStack 上做，属性曲线的部分在 PropertyStack 上做。没有骨架的实体只算后两样。有骨架的模型也可以播没有骨架轨道的剪辑
 * （只有形变或者属性曲线）：它不往原生的栈里压姿势，合并的时候只有一边有姿势就留那一边。
 */
class BatchStack implements AnimationBlendStack {
  readonly #batch: AnimationBatch;
  readonly morphs = new MorphStack();
  readonly properties = new PropertyStack();
  #skeleton: Skeleton | undefined;
  /** 和混合栈一一对应：这一项在原生的栈里有没有姿势。 */
  readonly #posed: boolean[] = [];
  pushed = 0;
  /** 压进原生栈的骨架姿势的个数。 */
  poses = 0;

  constructor(batch: AnimationBatch) {
    this.#batch = batch;
  }

  begin(skeleton: Skeleton | undefined, morphs: ModelMorphs | undefined): void {
    this.#skeleton = skeleton;
    this.morphs.begin(morphs);
    this.properties.begin();
    this.#posed.length = 0;
    this.pushed = this.poses = 0;
  }

  push(clip: AnimationClip, time: number): this {
    let posed = false;
    if (this.#skeleton && clip.bones) {
      if (clip.bones.skeleton !== this.#skeleton) {
        throw new Error(`animation '${clip.name}' is for skeleton '${clip.bones.skeleton.name}', but the model uses '${this.#skeleton.name}'`);
      }
      this.#batch.push(clip.bones.native, time);
      posed = true;
      this.poses++;
    }
    this.#posed.push(posed);
    this.morphs.push(clip, time);
    this.properties.push(clip.curves, Math.min(Math.max(time, 0), clip.duration));
    this.pushed++;
    return this;
  }

  blend(factor: number): this {
    if (this.#combine()) this.#batch.blend(factor);
    this.morphs.blend(factor);
    this.properties.blend(factor);
    return this;
  }

  add(factor: number): this {
    if (this.#combine()) this.#batch.add(factor);
    this.morphs.add(factor);
    this.properties.add(factor);
    return this;
  }

  subtract(factor: number): this {
    if (this.#combine()) this.#batch.subtract(factor);
    this.morphs.subtract(factor);
    this.properties.subtract(factor);
    return this;
  }

  blendMasked(factor: number, joints: readonly string[]): this {
    if (this.#combine()) this.#batch.blendMasked(factor, this.#skeleton!.mask(joints));
    // 形变权重、属性曲线不按关节分：留下面那层的
    this.morphs.blend(0);
    this.properties.blend(0);
    return this;
  }

  addMasked(factor: number, joints: readonly string[]): this {
    if (this.#combine()) this.#batch.addMasked(factor, this.#skeleton!.mask(joints));
    this.morphs.add(0);
    this.properties.add(0);
    return this;
  }

  /** 合并栈顶的两项：两边都有骨架的姿势时返回 true（原生的栈上要做这次运算）；只有一边有时那个姿势原样留在原生的栈顶。 */
  #combine(): boolean {
    if (this.#posed.length < 2) throw new Error('animation blend stack: an operation needs two poses');
    const b = this.#posed.pop()!, a = this.#posed.at(-1)!;
    this.#posed[this.#posed.length - 1] = a || b;
    return a && b;
  }
}

/** 连起来的缓冲里的位置（蒙皮矩阵按关节数、形变权重按目标数）：释放的按大小留着给同样大小的复用。 */
class SlotSpace {
  #capacity = 0;
  readonly #free = new Map<number, number[]>();

  get capacity(): number {
    return this.#capacity;
  }

  allocate(size: number): number {
    const reused = this.#free.get(size)?.pop();
    if (reused !== undefined) return reused;
    const base = this.#capacity;
    this.#capacity += size;
    return base;
  }

  release(base: number, size: number): void {
    let list = this.#free.get(size);
    if (!list) this.#free.set(size, (list = []));
    list.push(base);
  }
}

/** 重定向时按名字对关节用的写法：去掉命名空间前缀（`mixamorig:Hips`），小写，只留字母和数字。 */
export function retargetName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}
