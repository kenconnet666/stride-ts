/**
 * 把场景文件、预制体文件里的实体建成运行时的实体（ContentManager 的 loadScene、loadPrefab、loadSceneTemplate 用）：
 * 先把实体文件引用的资源并行加载好（preload），再建实体和组件（instantiate）。
 */
import { AnimationComponent } from '../animation/AnimationComponent';
import { ModelNodeLink } from '../animation/ModelNodeLink';
import type { AnimationClip } from '../animation/resources';
import type { Sound } from '../audio/Sound';
import type { EntityId } from '../data/prop';
import type { Entity } from '../engine/Entity';
import type { EntityManager } from '../engine/EntityManager';
import type { ScriptConstructor } from '../engine/scripts';
import { Transform } from '../engine/transform';
import type { ParticleModuleClass } from '../particles/modules';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { Collider, type ColliderShape } from '../physics/Collider';
import { Body, Character, Static } from '../physics/components';
import { CONSTRAINT_COMPONENTS, type ConstraintComponentBase } from '../physics/ConstraintComponent';
import type { ConstraintSettings } from '../physics/Simulation';
import { Background, Camera, Instance, Instancing, Light, Sprite } from '../rendering/components';
import type { Material } from '../rendering/Material';
import type { Cubemap, Skybox } from '../rendering/Skybox';
import type { SpriteSheet } from '../rendering/SpriteSheet';
import type { SpriteFont } from '../rendering/text/SpriteFont';
import type { Texture } from '../rendering/Texture';
import { UIComponent } from '../ui/UIComponent';
import { UIElementLink } from '../ui/UIElementLink';
import type { UILibrary, UIPage } from '../ui/UIPage';
import type { ContentManager, LoadedModel, LoadSceneOptions, SceneReference } from './ContentManager';
import type { ColliderShapeFile, SceneEntityFile, SceneLightShadow, SceneLocalLightShadow, SceneUI } from './format';
import { textureRefs, preload } from './loading';
import type { Prefab } from './Prefab';
import { SceneScriptBinder, scriptAssetRefs } from './sceneScripts';

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

export class SceneBuilder {
  readonly #content: ContentManager;

  constructor(content: ContentManager) {
    this.#content = content;
  }

  /** 实体文件引用的资源（包括脚本属性引用的）并行加载好。 */
  async preload(files: readonly SceneEntityFile[], where: string): Promise<SceneAssets> {
    const content = this.#content;
    const components = files.map((e) => e.components);
    const colliderModels = components.flatMap((c) => [...(c.static?.shapes ?? []), ...(c.character?.shapes ?? []), ...(c.body?.shapes ?? [])])
      .flatMap((s) => (s.type === 'mesh' || s.type === 'convexHull' ? [s.model] : []));
    const scriptAssets = scriptAssetRefs(components.flatMap((c) => c.scripts ?? []));
    const unsupported = scriptAssets.find((ref) => !SCRIPT_ASSET_KINDS.has(ref.kind));
    if (unsupported) throw new Error(`${where}: script properties referring to ${unsupported.kind} assets are not supported yet (${unsupported.path})`);
    const scriptPaths = (kind: string) => scriptAssets.filter((ref) => ref.kind === kind).map((ref) => ref.path);
    const [models, materials, animations, skyboxes, cubemaps, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds] = await Promise.all([
      preload([...components.flatMap((c) => (c.model ? [c.model.model] : [])), ...colliderModels, ...scriptPaths('model')], (p) => content.loadModel(p)),
      preload([...components.flatMap((c) => (c.model?.materials ?? []).filter((m): m is string => m !== null)), ...scriptPaths('material')], (p) => content.loadMaterial(p)),
      preload([...components.flatMap((c) => (c.animation?.animations ?? []).map((a) => a.clip)), ...scriptPaths('animation')], (p) => content.loadAnimation(p)),
      preload(components.flatMap((c) => (c.light?.type === 'skybox' ? [c.light.skybox] : [])), (p) => content.loadSkybox(p)),
      preload(components.flatMap((c) => (c.background?.type === 'cubemap' ? [c.background.texture] : [])), (p) => content.loadCubemap(p)),
      preload(scriptPaths('prefab'), (p) => content.loadPrefab(p)),
      preload([...components.flatMap((c) => (c.sprite && 'sheet' in c.sprite ? [c.sprite.sheet] : [])), ...scriptPaths('spriteSheet')], (p) => content.loadSpriteSheet(p)),
      preload(scriptPaths('font'), (p) => content.loadFont(p)),
      preload(scriptPaths('texture'), (p) => content.loadTextureAsset(p)),
      preload([...components.flatMap((c) => (c.ui?.page ? [c.ui.page] : [])), ...scriptPaths('uiPage')], (p) => content.loadUIPage(p)),
      preload(scriptPaths('uiLibrary'), (p) => content.loadUILibrary(p)),
      preload(scriptPaths('sound'), (p) => content.loadSound(p)),
    ]);
    // 背景的平面图片和精灵的贴图按 sRGB 读（同 Stride 的颜色贴图）；渲染目标贴图按路径建一次
    const imageRefs = components.flatMap((c) => [
      ...(c.background?.type === '2d' ? [c.background.image] : []), ...(c.sprite && 'texture' in c.sprite ? [c.sprite.texture] : []),
      ...(c.particleSystem ? textureRefs(c.particleSystem) : []),
    ]);
    const images = new Map(await Promise.all(imageRefs.map(async (ref) => 'renderTexture' in ref
      ? [ref.renderTexture, content.renderTexture(ref)] as const
      : [ref.texture, await content.loadTextureRef(ref, true)] as const)));
    return { models, materials, animations, skyboxes, cubemaps, images, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds };
  }

  /**
   * 按实体文件建实体：先按顺序建实体和组件（父实体在前），再挂实例的主实体，最后挂脚本（这时所有实体都在，脚本属性里的
   * 实体引用才解析得了）。返回按文件里的实体 id 的表；where 用在报错和警告里。
   */
  instantiate(files: readonly SceneEntityFile[], assets: SceneAssets, entities: EntityManager, options: LoadSceneOptions, where: string): Map<string, Entity> {
    const created = new Map<string, Entity>();
    for (const file of files) {
      const entity = entities.create({ name: file.name, components: [Transform.with({ position: file.position, rotation: file.rotation, scale: file.scale })] });
      if (file.parent !== null) {
        const parent = created.get(file.parent);
        if (!parent) throw new Error(`${where}: entity '${file.name}' comes before its parent ${file.parent}`);
        entity.require(Transform).parent = parent;
      }
      created.set(file.id, entity);
      this.#addComponents(entity, file, assets, entities, created);
    }
    // 约束组件引用的物体可能排在后面：实体都建好以后再挂（约束在脚本启动时加）
    for (const file of files) {
      for (const constraint of file.components.constraints ?? []) {
        // 各种约束的组件按设置的类型参数化，这里只按基类用
        const component = CONSTRAINT_COMPONENTS[constraint.type as keyof typeof CONSTRAINT_COMPONENTS] as unknown as ScriptConstructor<ConstraintComponentBase> | undefined;
        if (!component) {
          console.warn(`[stride] ${where}: ${file.name}: constraint type '${constraint.type}' is not supported; skipped`);
          continue;
        }
        const body = (id: string) => {
          const entity = created.get(id);
          if (!entity) throw new Error(`${where}: entity '${file.name}' has a constraint on ${id}, which is not in the scene`);
          return entity;
        };
        const entity = created.get(file.id)!;
        entity.add({ script: component, init: {} });
        const script = entity.require(component);
        script.settings = { ...constraint.settings, type: constraint.type, bodyA: body(constraint.bodyA), ...(constraint.bodyB ? { bodyB: body(constraint.bodyB) } : {}) } as ConstraintSettings;
        script.enabled = constraint.enabled;
      }
    }
    // 实例的主实体、挂到骨骼节点的目标可能排在后面：实体都建好以后再挂
    const entityOf = (id: string | null, file: SceneEntityFile, what: string): EntityId => {
      if (id === null) return -1 as EntityId;
      const entity = created.get(id);
      if (!entity) throw new Error(`${where}: entity '${file.name}' refers to ${id} (${what}), which is not in the scene`);
      return entity.id;
    };
    for (const file of files) {
      const { instance, nodeLink, ui, uiElementLink } = file.components;
      if (ui) created.get(file.id)!.add(uiComponent(ui, assets));
      if (instance) created.get(file.id)!.add(Instance.with({ master: entityOf(instance.master, file, 'instancing master') }));
      if (nodeLink) created.get(file.id)!.add(ModelNodeLink.with({ target: entityOf(nodeLink.target, file, 'model node link target'), nodeName: nodeLink.nodeName }));
      if (uiElementLink) created.get(file.id)!.add(UIElementLink.with({ target: entityOf(uiElementLink.target, file, 'UI element link target'), nodeName: uiElementLink.nodeName }));
    }
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
    // 脚本属性可以引用别的脚本（同一个实体上排在后面的也行）：被引用的还没挂上的推迟到下一轮，一轮没有进展时按原样报错
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
    return created;
  }

  /** created 是这个场景里已经建好的实体（按场景文件里的 id），粒子模块引用的实体在模拟时才找。 */
  #addComponents(entity: Entity, file: SceneEntityFile, assets: SceneAssets, entities: EntityManager, created: ReadonlyMap<string, Entity>): void {
    const { model, camera, light, background, animation, sprite, static: collidable, character, body, instancing, particleSystem } = file.components;
    const { materials } = assets;
    const collider = (shapes: readonly ColliderShapeFile[]) => new Collider(shapes.map((shape) => colliderShape(shape, assets))).id;
    if (collidable) entity.add(Static.with({ collider: collider(collidable.shapes), layer: collidable.layer, friction: collidable.friction, trigger: collidable.trigger ?? false }));
    if (character) {
      const { shapes, trigger: _trigger, ...settings } = character;
      entity.add(Character.with({ collider: collider(shapes), ...settings }));
    }
    if (body) {
      const { shapes, ...settings } = body;
      entity.add(Body.with({ collider: collider(shapes), ...settings }));
    }
    if (camera) entity.add(Camera.with(camera));
    if (instancing) entity.add(Instancing);
    if (light?.type === 'skybox') entity.add(Light.with({ type: 'skybox', skybox: assets.skyboxes.get(light.skybox)!.id, intensity: light.intensity }));
    else if (light?.type === 'point') {
      entity.add(Light.with({ type: 'point', color: [...light.color, 1], intensity: light.intensity, radius: light.radius, ...(light.shadow ? localShadowColumns(light.shadow) : {}) }));
    } else if (light?.type === 'spot') {
      const { range, angleInner, angleOuter } = light;
      entity.add(Light.with({ type: 'spot', color: [...light.color, 1], intensity: light.intensity, range, angleInner, angleOuter, ...(light.shadow ? localShadowColumns(light.shadow) : {}) }));
    } else if (light) entity.add(Light.with({ type: light.type, color: [...light.color, 1], intensity: light.intensity, ...(light.shadow ? shadowColumns(light.shadow) : {}) }));
    const backgroundGroup = { intensity: background?.intensity ?? 1, renderGroup: background?.renderGroup ?? 0 };
    if (background?.type === 'cubemap') entity.add(Background.with({ texture: assets.cubemaps.get(background.texture)!.id, ...backgroundGroup }));
    else if (background) entity.add(Background.with({ image: assets.images.get(background.image.texture)!.id, ...backgroundGroup }));
    if (sprite && 'sheet' in sprite) {
      const { sheet, color, ...settings } = sprite;
      entity.add(Sprite.with({ ...settings, sheet: assets.spriteSheets.get(sheet)!.id, color: [...color] }));
    } else if (sprite) {
      const { texture, center, color, ...settings } = sprite;
      const id = assets.images.get('renderTexture' in texture ? texture.renderTexture : texture.texture)!.id;
      entity.add(Sprite.with({ ...settings, texture: id, centerX: center[0], centerY: center[1], color: [...color] }));
    }
    if (particleSystem) {
      entity.add({ script: ParticleSystemComponent, init: {} });
      entity.require(ParticleSystemComponent).load(particleSystem, {
        texture: (path) => assets.images.get(path),
        entityPosition: (id) => {
          const world = created.get(id)?.get(Transform)?.world;
          return world ? [world[12]!, world[13]!, world[14]!] : undefined;
        },
        module: (type) => entities.game.registry.particleModule(type) as ParticleModuleClass | undefined,
        shaderClass: (name) => entities.game.registry.shaderClass(name),
      });
    }
    if (animation) {
      entity.add({ script: AnimationComponent, init: {} });
      const clips = entity.require(AnimationComponent).animations;
      for (const { name, clip } of animation.animations) clips.set(name, assets.animations.get(clip)!);
    }
    if (!model) return;
    const overrides = model.materials.map((path) => (path === null ? null : (materials.get(path) ?? null)));
    this.#content.addModel(entity, assets.models.get(model.model)!, { materials: overrides, isShadowCaster: model.isShadowCaster ?? true, renderGroup: model.renderGroup ?? 0 });
  }
}

/** 场景文件里的碰撞形状换成 Collider 的形状：网格形状引用模型加载出来的全部网格。 */
function colliderShape(shape: ColliderShapeFile, assets: SceneAssets): ColliderShape {
  const { position, rotation, mass } = shape;
  if (shape.type === 'mesh') return { type: 'mesh', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), position, rotation, mass };
  if (shape.type === 'convexHull') return { type: 'convexHull', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), hull: shape.hull, position, rotation, mass };
  return shape;
}

/** 脚本属性能引用的资源种类（model、material、animation、prefab 加载场景时预先加载，scene 只给路径）。 */
const SCRIPT_ASSET_KINDS: ReadonlySet<string> = new Set(['model', 'material', 'animation', 'scene', 'prefab', 'font', 'texture', 'spriteSheet', 'uiPage', 'uiLibrary', 'sound']);

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
  } as const;
}
