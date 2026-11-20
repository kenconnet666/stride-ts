/**
 * 把场景文件、预制体文件里的实体建成运行时的实体（ContentManager 的 loadScene、loadPrefab、loadSceneTemplate 用）：
 * 先把实体文件引用的资源并行加载好（preload），再建实体和组件（instantiate）；编辑器改了实体文件以后，update 把建好的实体
 * 改成新的样子。每种组件怎么加、怎么去掉在 BUILDERS 里。
 */
import { AnimationComponent } from '../animation/AnimationComponent';
import { ModelNodeLink } from '../animation/ModelNodeLink';
import type { AnimationClip } from '../animation/resources';
import type { Sound } from '../audio/Sound';
import type { EntityId } from '../data/prop';
import type { ComponentType } from '../engine/component';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import type { ScriptConstructor } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { ParticleModuleClass } from '../particles/modules';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { Collider, type ColliderShape } from '../physics/Collider';
import { Body, Character, PhysicsBody, Static } from '../physics/components';
import { CONSTRAINT_COMPONENTS, type ConstraintComponentBase } from '../physics/ConstraintComponent';
import type { ConstraintSettings } from '../physics/Simulation';
import { Background, Camera, Instance, Instancing, Light, Model, ReflectionProbe, SkyAtmosphere, Sprite, VolumetricClouds, VolumetricFog } from '../rendering/components';
import { DayNightCycle } from '../rendering/sky/DayNightCycle';
import { Precipitation } from '../weather/Precipitation';
import { Weather } from '../weather/Weather';
import { WindZone } from '../weather/WindField';
import type { Material } from '../rendering/mesh/Material';
import type { Mesh } from '../rendering/mesh/Mesh';
import type { Cubemap, Skybox } from '../rendering/lighting/Skybox';
import type { SpriteSheet } from '../rendering/SpriteSheet';
import type { SpriteFont } from '../rendering/text/SpriteFont';
import type { Texture } from '../graphics/Texture';
import { UIComponent } from '../ui/UIComponent';
import { UIElementLink } from '../ui/UIElementLink';
import type { UILibrary, UIPage } from '../ui/UIPage';
import type { ContentManager, LoadedModel, LoadSceneOptions, SceneReference } from './ContentManager';
import type { ColliderShapeFile, SceneEntityFile, SceneLightShadow, SceneLocalLightShadow, ScenePostEffects, SceneUI } from './format';
import { preload } from './loading';
import type { Prefab } from './Prefab';
import { entityAssetReferences, type EntityAssetReference } from './references';
import { SceneScriptBinder } from './sceneScripts';

/** 场景引用的资源，实例化之前并行加载好。 */
export interface SceneAssets {
  readonly models: ReadonlyMap<string, LoadedModel>;
  readonly materials: ReadonlyMap<string, Material>;
  readonly animations: ReadonlyMap<string, AnimationClip>;
  readonly skyboxes: ReadonlyMap<string, Skybox>;
  readonly cubemaps: ReadonlyMap<string, Cubemap>;
  /** 背景和精灵的贴图（包括渲染目标贴图），按内容路径。 */
  readonly images: ReadonlyMap<string, Texture>;
  readonly spriteSheets: ReadonlyMap<string, SpriteSheet>;
  /** 脚本属性引用的预制体、字体、贴图、UI 页面和库。 */
  readonly prefabs: ReadonlyMap<string, Prefab>;
  readonly fonts: ReadonlyMap<string, SpriteFont>;
  readonly textures: ReadonlyMap<string, Texture>;
  readonly uiPages: ReadonlyMap<string, UIPage>;
  readonly uiLibraries: ReadonlyMap<string, UILibrary>;
  readonly sounds: ReadonlyMap<string, Sound>;
}

/** 一个网格配一个材质画（预热管线用，见 ContentManager.pipelineWarmer）。 */
export interface ModelUse {
  readonly mesh: Mesh;
  readonly material: Material;
  readonly skinned: boolean;
  readonly isShadowCaster: boolean;
}

/** 实体文件里的模型会怎么画：每个网格配哪个材质（规则同 ContentManager.addModel）。 */
function modelUses(files: readonly SceneEntityFile[], assets: SceneAssets, defaultMaterial: Material): ModelUse[] {
  const uses: ModelUse[] = [];
  for (const { components: { model } } of files) {
    const loaded = model && assets.models.get(model.model);
    if (!loaded) continue;
    for (const { mesh, material: slot, skin } of loaded.meshes) {
      const override = slot === null || model.materials[slot] == null ? undefined : assets.materials.get(model.materials[slot]);
      const material = override ?? (slot === null ? undefined : loaded.materials[slot]) ?? defaultMaterial;
      uses.push({ mesh, material, skinned: skin !== undefined, isShadowCaster: model.isShadowCaster ?? true });
    }
  }
  return uses;
}

export class SceneBuilder {
  readonly #content: ContentManager;

  constructor(content: ContentManager) {
    this.#content = content;
  }

  /** 实体文件引用的资源（包括脚本属性引用的）并行加载好。 */
  async preload(files: readonly SceneEntityFile[], where: string, postEffects?: ScenePostEffects | null): Promise<SceneAssets> {
    const content = this.#content;
    const refs = entityAssetReferences(files);
    const unsupported = refs.find((ref) => !PRELOADED_KINDS.has(ref.kind));
    if (unsupported) throw new Error(`${where}: script properties referring to ${unsupported.kind} assets are not supported yet (${unsupported.path})`);
    const paths = (kind: EntityAssetReference['kind']) => refs.filter((ref) => ref.kind === kind).map((ref) => ref.path);
    const [models, materials, animations, skyboxes, cubemaps, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds] = await Promise.all([
      preload(paths('model'), (p) => content.loadModel(p)),
      preload(paths('material'), (p) => content.loadMaterial(p)),
      preload(paths('animation'), (p) => content.loadAnimation(p)),
      preload(paths('skybox'), (p) => content.loadSkybox(p)),
      preload(paths('cubemap'), (p) => content.loadCubemap(p)),
      preload(paths('prefab'), (p) => content.loadPrefab(p)),
      preload(paths('spriteSheet'), (p) => content.loadSpriteSheet(p)),
      preload(paths('font'), (p) => content.loadFont(p)),
      preload(paths('texture'), (p) => content.loadTextureAsset(p)),
      preload(paths('uiPage'), (p) => content.loadUIPage(p)),
      preload(paths('uiLibrary'), (p) => content.loadUILibrary(p)),
      preload(paths('sound'), (p) => content.loadSound(p)),
    ]);
    // 背景的平面图片和精灵的贴图按 sRGB 读（同 Stride 的颜色贴图）；渲染目标贴图按路径建一次
    const images = new Map<string, Texture>();
    await Promise.all(refs.map(async (ref) => {
      if (ref.kind === 'renderTexture') images.set(ref.path, content.renderTexture(ref.texture));
      else if (ref.kind === 'image') images.set(ref.path, await content.loadTextureRef(ref.texture, true));
    }));
    const assets: SceneAssets = { models, materials, animations, skyboxes, cubemaps, images, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds };
    // 管线也算要等的资源：建实体之前在后台编好，第一帧和以后生成这些模型时都不用当场编译着色器
    await content.pipelineWarmer?.(modelUses(files, assets, content.defaultMaterial), postEffects, files);
    return assets;
  }

  /**
   * 按实体文件建实体：先按顺序建实体和只管自己的组件（父实体在前），再加引用别的实体的组件（约束、实例的主实体、挂到骨骼
   * 节点这些，目标可能排在后面），最后挂脚本（这时所有实体都在，脚本属性里的实体引用才解析得了）。返回按文件里的实体 id 的表；
   * where 用在报错和警告里。into 是已经有实体的表（往建好的场景里加实体时给）：新建的加进去，父实体和引用也在里面找。
   */
  instantiate(
    files: readonly SceneEntityFile[], assets: SceneAssets, entities: EntityManager, options: LoadSceneOptions, where: string,
    into = new Map<string, Entity>(),
  ): Map<string, Entity> {
    const created = into;
    const context = (file: SceneEntityFile): BuildContext => ({ content: this.#content, assets, manager: entities, created, file, where });
    const listed = new Set(files.map((file) => file.id));
    for (const file of files) {
      const entity = entities.create({ name: file.name, components: [Transform.with({ position: file.position, rotation: file.rotation, scale: file.scale })] });
      if (file.parent !== null) {
        if (!created.has(file.parent) && listed.has(file.parent)) throw new Error(`${where}: entity '${file.name}' comes before its parent ${file.parent}`);
        entity.require(Transform).parent = parentOf(file, created, where);
      }
      created.set(file.id, entity);
      addComponents(entity, EARLY_KEYS, context(file));
    }
    for (const file of files) addComponents(created.get(file.id)!, LATE_KEYS, context(file));
    if (options.attachScripts ?? true) this.#attachScripts(files, assets, entities, options, where, created);
    return created;
  }

  /**
   * 把建好的实体从 before 改成 after 的样子（编辑器里改了场景文档以后，见 editor/LiveScene）。名字、位置、父实体直接改；
   * 组件只重建变了的那几种（components 里值的引用变了的键）：去掉旧的、按新的值加上。实体还是那个实体，别处引用它的不用动。
   * 脚本不动（编辑状态不挂脚本）。assets 里要有 after 引用的资源。
   */
  update(entity: Entity, before: SceneEntityFile, after: SceneEntityFile, assets: SceneAssets, created: ReadonlyMap<string, Entity>, where: string): void {
    if (before.name !== after.name) entity.name = after.name;
    const transform = entity.require(Transform);
    if (before.parent !== after.parent) transform.parent = after.parent === null ? undefined : parentOf(after, created, where);
    if (before.position !== after.position) Object.assign(transform.position, { x: after.position[0], y: after.position[1], z: after.position[2] });
    if (before.rotation !== after.rotation) Object.assign(transform.rotation, { x: after.rotation[0], y: after.rotation[1], z: after.rotation[2], w: after.rotation[3] });
    if (before.scale !== after.scale) Object.assign(transform.scale, { x: after.scale[0], y: after.scale[1], z: after.scale[2] });
    if (before.components === after.components) return;
    const changed = COMPONENT_KEYS.filter((key) => before.components[key] !== after.components[key]);
    const context: BuildContext = { content: this.#content, assets, manager: entity.manager, created, file: after, where };
    // 先按相反的顺序去掉旧的，再按建实体时的顺序加新的
    for (const key of [...changed].reverse()) if (before.components[key] !== undefined) BUILDERS[key].remove(entity, context);
    addComponents(entity, changed, context);
  }

  /** 挂场景文件里的脚本。脚本属性可以引用别的脚本（同一个实体上排在后面的也行）：被引用的还没挂上的推迟到下一轮。 */
  #attachScripts(
    files: readonly SceneEntityFile[], assets: SceneAssets, entities: EntityManager, options: LoadSceneOptions, where: string,
    created: ReadonlyMap<string, Entity>,
  ): void {
    const binder = new SceneScriptBinder(entities.game.registry, options.scripts);
    const byKind: Readonly<Record<string, ReadonlyMap<string, object>>> = {
      model: assets.models, material: assets.materials, animation: assets.animations, prefab: assets.prefabs, font: assets.fonts, texture: assets.textures,
      spriteSheet: assets.spriteSheets, uiPage: assets.uiPages, uiLibrary: assets.uiLibraries, sound: assets.sounds,
    };
    const context = {
      entities: created,
      asset: (kind: string, assetPath: string): object => (kind === 'scene' ? ({ path: assetPath } satisfies SceneReference) : byKind[kind]!.get(assetPath)!),
      extraEntity: (owner: Entity): Entity => {
        const extra = entities.create({ name: owner.name, components: [Transform] });
        // 是 owner 的子实体：owner 销毁时一起销毁
        extra.require(Transform).parent = owner;
        return extra;
      },
    };
    let pending = files.flatMap((file) => (file.components.scripts ?? []).map((script) => ({ file, script })));
    while (pending.length > 0) {
      const deferred = pending.filter(({ file, script }) => !binder.attach(created.get(file.id)!, script, context, `${where}: ${file.name}`, { deferMissing: true }));
      if (deferred.length === pending.length) {
        // 没有进展：不推迟地挂第一个，引用的东西不在时它报错
        const { file, script } = deferred.shift()!;
        binder.attach(created.get(file.id)!, script, context, `${where}: ${file.name}`);
      }
      pending = deferred;
    }
  }
}

/**
 * 实体的父实体。父实体不在场景里时警告，挂到它所在的预制体实例上（父实体是 `<实例>/<预制体里的 id>`、预制体改了删掉了这个
 * 成员时：挂到还在的、最近的那一层实例上），都没有就放在最上层；不让整个场景加载不了。
 */
function parentOf(file: SceneEntityFile, created: ReadonlyMap<string, Entity>, where: string): Entity | undefined {
  const parent = file.parent!;
  const found = created.get(parent);
  if (found) return found;
  for (let slash = parent.lastIndexOf('/'); slash > 0; slash = parent.lastIndexOf('/', slash - 1)) {
    const instance = created.get(parent.slice(0, slash));
    if (instance) {
      console.warn(`[stride] ${where}: entity '${file.name}' has parent ${parent}, which is not in the scene (removed from its prefab?); attached to '${instance.name}' instead`);
      return instance;
    }
  }
  console.warn(`[stride] ${where}: entity '${file.name}' has parent ${parent}, which is not in the scene; placed at the top level`);
  return undefined;
}

/** 两个版本的实体文件之间的差别。 */
export interface EntityChanges {
  /** 新加的实体，按 after 里的顺序（父实体在前）。 */
  readonly added: readonly SceneEntityFile[];
  /** 删掉的实体的 id。 */
  readonly removed: readonly string[];
  /** 内容变了的实体：原来的和现在的。 */
  readonly changed: readonly (readonly [before: SceneEntityFile, after: SceneEntityFile])[];
}

/**
 * 两个版本的实体文件之间变了的实体（比较对象的引用，所以改文件要拷贝着改，见 editor/SceneDocument）。最常见的修改不加不删
 * （拖着改一个值，每帧一次）：这时两边一一对应，扫一遍引用就够了，不建表；实体有加有删时才按 id 对。
 */
export function changedEntities(before: readonly SceneEntityFile[], after: readonly SceneEntityFile[]): EntityChanges {
  if (before === after) return NO_CHANGES;
  if (before.length === after.length) {
    const changed: [SceneEntityFile, SceneEntityFile][] = [];
    let aligned = true;
    for (let i = 0; i < after.length && aligned; i++) {
      if (before[i] === after[i]) continue;
      if (before[i]!.id === after[i]!.id) changed.push([before[i]!, after[i]!]);
      else aligned = false;
    }
    if (aligned) return { added: [], removed: [], changed };
  }
  const old = new Map(before.map((entity) => [entity.id, entity]));
  const added: SceneEntityFile[] = [], changed: [SceneEntityFile, SceneEntityFile][] = [];
  for (const entity of after) {
    const previous = old.get(entity.id);
    if (!previous) added.push(entity);
    else if (previous !== entity) changed.push([previous, entity]);
    old.delete(entity.id);
  }
  return { added, removed: [...old.keys()], changed };
}

const NO_CHANGES: EntityChanges = { added: [], removed: [], changed: [] };

type SceneComponents = SceneEntityFile['components'];
/** 实体文件里的组件，脚本以外的（脚本要等所有实体都在，单独挂）。 */
type ComponentKey = Exclude<keyof SceneComponents, 'scripts'>;

interface BuildContext {
  readonly content: ContentManager;
  readonly assets: SceneAssets;
  readonly manager: EntityManager;
  /** 这个场景里已经建好的实体，按文件里的 id。 */
  readonly created: ReadonlyMap<string, Entity>;
  readonly file: SceneEntityFile;
  readonly where: string;
}

/** 实体文件里的一种组件怎么加到实体上、怎么去掉（去掉以后可以按新的值再加）。 */
interface ComponentBuilder<K extends ComponentKey> {
  add(entity: Entity, value: NonNullable<SceneComponents[K]>, context: BuildContext): void;
  remove(entity: Entity, context: BuildContext): void;
}

/** 去掉这几种组件、脚本里实体上有的。 */
/** 场景组件的 remove → 它去掉的组件类型（第一个是主要的那个），反查场景文件的键用（sceneComponentKey）。 */
const DROPPED = new WeakMap<object, readonly (ComponentType<any> | ScriptConstructor)[]>();

const drop = (...types: readonly (ComponentType<any> | ScriptConstructor)[]) => {
  const remove = (entity: Entity): void => {
    for (const type of types) if (entity.has(type)) entity.remove(type);
  };
  DROPPED.set(remove, types);
  return remove;
};

const collider = (shapes: readonly ColliderShapeFile[], assets: SceneAssets) => new Collider(shapes.map((shape) => colliderShape(shape, assets))).id;

/** 引用的实体（场景里的 id）换成运行时的 id；null 是没指定。 */
function entityRef(id: string | null, { created, file, where }: BuildContext, what: string): EntityId {
  if (id === null) return -1 as EntityId;
  const entity = created.get(id);
  if (!entity) throw new Error(`${where}: entity '${file.name}' refers to ${id} (${what}), which is not in the scene`);
  return entity.id;
}

/**
 * 键的顺序就是加的顺序。物理组件去掉时连 PhysicsBody 一起去掉：仿真要到下一帧才发现物体没主了，不去掉的话马上加回来的
 * 组件会接着用旧的物体（旧的形状）。
 */
const BUILDERS: { readonly [K in ComponentKey]: ComponentBuilder<K> } = {
  static: {
    add: (entity, { shapes, layer, friction, trigger = false }, { assets }) => entity.add(Static.with({ collider: collider(shapes, assets), layer, friction, trigger })),
    remove: drop(Static, PhysicsBody),
  },
  character: {
    add: (entity, { shapes, trigger: _trigger, ...settings }, { assets }) => entity.add(Character.with({ collider: collider(shapes, assets), ...settings })),
    remove: drop(Character, PhysicsBody),
  },
  body: {
    add: (entity, { shapes, ...settings }, { assets }) => entity.add(Body.with({ collider: collider(shapes, assets), ...settings })),
    remove: drop(Body, PhysicsBody),
  },
  camera: { add: (entity, camera) => entity.add(Camera.with(camera)), remove: drop(Camera) },
  instancing: { add: (entity) => entity.add(Instancing), remove: drop(Instancing) },
  light: {
    add: (entity, light, { assets }) => {
      if (light.type === 'skybox') entity.add(Light.with({ type: 'skybox', skybox: assets.skyboxes.get(light.skybox)!.id, intensity: light.intensity }));
      else if (light.type === 'point') {
        entity.add(Light.with({ type: 'point', color: [...light.color, 1], intensity: light.intensity, radius: light.radius, ...(light.shadow ? localShadowColumns(light.shadow) : {}) }));
      } else if (light.type === 'spot') {
        const { range, angleInner, angleOuter } = light;
        entity.add(Light.with({ type: 'spot', color: [...light.color, 1], intensity: light.intensity, range, angleInner, angleOuter, ...(light.shadow ? localShadowColumns(light.shadow) : {}) }));
      } else entity.add(Light.with({ type: light.type, color: [...light.color, 1], intensity: light.intensity, ...(light.shadow ? shadowColumns(light.shadow) : {}) }));
    },
    remove: drop(Light),
  },
  background: {
    add: (entity, background, { assets }) => {
      const group = { intensity: background.intensity ?? 1, renderGroup: background.renderGroup ?? 0 };
      if (background.type === 'cubemap') entity.add(Background.with({ texture: assets.cubemaps.get(background.texture)!.id, ...group }));
      else entity.add(Background.with({ image: assets.images.get(background.image.texture)!.id, ...group }));
    },
    remove: drop(Background),
  },
  reflectionProbe: {
    add: (entity, probe) => {
      entity.add(ReflectionProbe.with({
        size: [...probe.size],
        ...(probe.blendDistance === undefined ? {} : { blendDistance: probe.blendDistance }),
        ...(probe.boxProjection === undefined ? {} : { boxProjection: probe.boxProjection }),
        ...(probe.intensity === undefined ? {} : { intensity: probe.intensity }),
        ...(probe.refresh === undefined ? {} : { refresh: probe.refresh }),
      }));
    },
    remove: drop(ReflectionProbe),
  },
  // 风场和雨雪（Stride 没有）：没写的字段用组件的默认值
  windZone: { add: (entity, zone) => entity.add(WindZone.with({ ...zone })), remove: drop(WindZone) },
  precipitation: { add: (entity, precipitation) => entity.add(Precipitation.with({ ...precipitation })), remove: drop(Precipitation) },
  weather: { add: (entity, weather) => entity.add(Weather.with({ ...weather })), remove: drop(Weather) },
  sprite: {
    add: (entity, sprite, { assets }) => {
      if ('sheet' in sprite) {
        const { sheet, color, ...settings } = sprite;
        entity.add(Sprite.with({ ...settings, sheet: assets.spriteSheets.get(sheet)!.id, color: [...color] }));
      } else {
        const { texture, center, color, ...settings } = sprite;
        const id = assets.images.get('renderTexture' in texture ? texture.renderTexture : texture.texture)!.id;
        entity.add(Sprite.with({ ...settings, texture: id, centerX: center[0], centerY: center[1], color: [...color] }));
      }
    },
    remove: drop(Sprite),
  },
  particleSystem: {
    // 粒子模块引用的实体在模拟时才找
    add: (entity, particleSystem, { assets, manager, created }) => {
      entity.add({ script: ParticleSystemComponent, init: {} });
      entity.require(ParticleSystemComponent).load(particleSystem, {
        texture: (path) => assets.images.get(path),
        entityPosition: (id) => {
          const world = created.get(id)?.get(Transform)?.world;
          return world ? [world[12]!, world[13]!, world[14]!] : undefined;
        },
        module: (type) => manager.game.registry.particleModule(type) as ParticleModuleClass | undefined,
        shaderClass: (name) => manager.game.registry.shaderClass(name),
      });
    },
    remove: drop(ParticleSystemComponent),
  },
  animation: {
    add: (entity, animation, { assets }) => {
      entity.add({ script: AnimationComponent, init: {} });
      const clips = entity.require(AnimationComponent).animations;
      for (const { name, clip } of animation.animations) clips.set(name, assets.animations.get(clip)!);
    },
    remove: drop(AnimationComponent),
  },
  model: {
    add: (entity, model, { content, assets }) => {
      const overrides = model.materials.map((path) => (path === null ? null : (assets.materials.get(path) ?? null)));
      content.addModel(entity, assets.models.get(model.model)!, { materials: overrides, isShadowCaster: model.isShadowCaster ?? true, renderGroup: model.renderGroup ?? 0 });
    },
    remove: (entity, { content }) => content.removeModel(entity),
  },
  // 下面的引用别的实体（可能排在后面）：实体都建好以后才加
  constraints: {
    // 约束在脚本启动时加进仿真
    add: (entity, constraints, context) => {
      for (const constraint of constraints) {
        // 各种约束的组件按设置的类型参数化，这里只按基类用
        const component = CONSTRAINT_COMPONENTS[constraint.type as keyof typeof CONSTRAINT_COMPONENTS] as unknown as ScriptConstructor<ConstraintComponentBase> | undefined;
        if (!component) {
          console.warn(`[stride] ${context.where}: ${context.file.name}: constraint type '${constraint.type}' is not supported; skipped`);
          continue;
        }
        const body = (id: string) => {
          const found = context.created.get(id);
          if (!found) throw new Error(`${context.where}: entity '${context.file.name}' has a constraint on ${id}, which is not in the scene`);
          return found;
        };
        entity.add({ script: component, init: {} });
        const script = entity.require(component);
        script.settings = { ...constraint.settings, type: constraint.type, bodyA: body(constraint.bodyA), ...(constraint.bodyB ? { bodyB: body(constraint.bodyB) } : {}) } as ConstraintSettings;
        script.enabled = constraint.enabled;
      }
    },
    remove: drop(...(Object.values(CONSTRAINT_COMPONENTS) as unknown as ScriptConstructor[])),
  },
  ui: { add: (entity, ui, { assets }) => entity.add(uiComponent(ui, assets)), remove: drop(UIComponent) },
  instance: {
    add: (entity, instance, context) => entity.add(Instance.with({ master: entityRef(instance.master, context, 'instancing master') })),
    remove: drop(Instance),
  },
  nodeLink: {
    add: (entity, link, context) => entity.add(ModelNodeLink.with({ target: entityRef(link.target, context, 'model node link target'), nodeName: link.nodeName })),
    remove: drop(ModelNodeLink),
  },
  uiElementLink: {
    add: (entity, link, context) => entity.add(UIElementLink.with({ target: entityRef(link.target, context, 'UI element link target'), nodeName: link.nodeName })),
    remove: drop(UIElementLink),
  },
  skyAtmosphere: {
    // 没写的字段用组件的默认值（地球）；三维的数组拷一份，组件不留场景文件的引用
    add: (entity, { sun, moon, ...sky }, context) => entity.add(SkyAtmosphere.with({
      ...Object.fromEntries(Object.entries(sky).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])),
      sun: entityRef(sun ?? null, context, 'sun of the sky atmosphere'),
      moon: entityRef(moon ?? null, context, 'moon of the sky atmosphere'),
    })),
    remove: drop(SkyAtmosphere),
  },
  dayNightCycle: { add: (entity, cycle) => entity.add(DayNightCycle.with({ ...cycle })), remove: drop(DayNightCycle) },
  volumetricClouds: { add: (entity, clouds) => entity.add(VolumetricClouds.with({ ...clouds })), remove: drop(VolumetricClouds) },
  volumetricFog: { add: (entity, { color, ...fog }) => entity.add(VolumetricFog.with({ ...fog, ...(color ? { color: [...color] } : {}) })), remove: drop(VolumetricFog) },
};

const COMPONENT_KEYS = Object.keys(BUILDERS) as ComponentKey[];

/**
 * 场景文件里加出 type 这种组件的键（`UIComponent` → `ui`，`Model` → `model`）：编辑器给脚本补上它要的组件（requires）时用。
 * 不是从场景文件加的（游戏自己的组件、脚本）是 undefined。
 */
export function sceneComponentKey(type: ComponentType<any> | ScriptConstructor): ComponentKey | undefined {
  if (type === Model) return 'model';
  return COMPONENT_KEYS.find((key) => DROPPED.get(BUILDERS[key].remove)?.[0] === type);
}
const LATE_KEYS = COMPONENT_KEYS.slice(COMPONENT_KEYS.indexOf('constraints'));
const EARLY_KEYS = COMPONENT_KEYS.slice(0, COMPONENT_KEYS.indexOf('constraints'));

/** 把实体文件里这几种组件（有的那些）加到实体上。 */
function addComponents(entity: Entity, keys: readonly ComponentKey[], context: BuildContext): void {
  for (const key of keys) {
    const value = context.file.components[key];
    if (value !== undefined) (BUILDERS[key] as ComponentBuilder<ComponentKey>).add(entity, value, context);
  }
}

/** 场景文件里的碰撞形状换成 Collider 的形状：网格形状引用模型加载出来的全部网格。 */
function colliderShape(shape: ColliderShapeFile, assets: SceneAssets): ColliderShape {
  const { position, rotation, mass } = shape;
  if (shape.type === 'mesh') return { type: 'mesh', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), position, rotation, mass };
  if (shape.type === 'convexHull') return { type: 'convexHull', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), hull: shape.hull, position, rotation, mass };
  return shape;
}

/** 实体文件能引用的资源种类（加载场景时预先加载；scene 只给路径）。脚本属性里写了别的种类时报错。 */
const PRELOADED_KINDS: ReadonlySet<string> = new Set<EntityAssetReference['kind']>([
  'model', 'material', 'animation', 'scene', 'prefab', 'font', 'texture', 'spriteSheet', 'uiPage', 'uiLibrary', 'sound', 'skybox', 'cubemap', 'image', 'renderTexture',
]);

/** 场景文件里的 UIComponent。 */
function uiComponent({ page, resolution, size, resolutionStretch, ...flags }: SceneUI, assets: SceneAssets) {
  return UIComponent.with({
    ...(page ? { page: assets.uiPages.get(page)! } : {}),
    resolution: [...resolution],
    size: [...size],
    resolutionStretch,
    ...flags,
  });
}

/** 场景文件里的阴影设置换成 Light 组件的列。 */
function localShadowColumns(shadow: SceneLocalLightShadow) {
  return { shadow: true, shadowSize: shadow.size, shadowFilter: shadow.filter, shadowDepthBias: shadow.depthBias, shadowNormalOffsetScale: shadow.normalOffsetScale };
}

function shadowColumns(shadow: SceneLightShadow) {
  return {
    shadow: true,
    shadowSize: shadow.size,
    shadowFilter: shadow.filter,
    shadowCascadeCount: shadow.cascadeCount,
    shadowDepthBias: shadow.depthBias,
    shadowNormalOffsetScale: shadow.normalOffsetScale,
    shadowStabilization: shadow.stabilization,
    shadowPssmFactor: shadow.pssmFactor,
    shadowDepthRange: shadow.depthRange,
    shadowMinDistance: shadow.minDistance,
    shadowMaxDistance: shadow.maxDistance,
    shadowBlendCascades: shadow.blendCascades,
    shadowLightAngle: shadow.lightAngle ?? 0.53,
  } as const;
}
