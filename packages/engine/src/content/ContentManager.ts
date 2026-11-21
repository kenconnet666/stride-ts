/**
 * 内容管理（对应 Stride 的 ContentManager）：按内容路径加载资源管线产出的模型、材质、贴图、立方体贴图、天空盒、场景（格式见 format.ts），
 * 同一个路径只加载一次（缓存的是 Promise，并发请求也只发一次），并把场景实例化成实体。
 *
 *   const scene = await game.content.loadScene('scenes/MainScene');
 *   scene.entities.get(id);
 *
 * 引用计数、卸载、按组加载、在 Worker 里解码（README 的"实例化、懒加载、缓存"）以后加。
 */
import type { Skin as NativeSkin } from '@stride-ts/native';
import { AnimationClip, Skeleton, type AnimationNative } from '../animation/resources';
import type { AssetTypes } from '../data/prop';
import type { EntityManager } from '../engine/EntityManager';
import { resolveSceneValues, scriptAssetRefs, type SceneScriptMap } from './sceneScripts';
import type { Entity, EntityScene } from '../engine/Entity';
import { SceneRoot, Transform } from '../engine/transform';
import type { Vec3Like } from '../data/vectors';
import { Model, ModelPart, Skinned } from '../rendering/components';
import { ModelMorph, ModelSkeleton } from '../animation/AnimationSystem';
import { Morphed } from '../animation/morphs';
import { Material, type MaterialShaderLayer, type MaterialShaderTrees } from '../rendering/mesh/Material';
import { preload, textureRefs } from './loading';
import { expandPrefabInstances, loadPrefabs } from './prefabInstances';
import { Prefab, type PrefabShape } from './Prefab';
import { changedEntities, SceneBuilder, type ModelUse, type SceneAssets } from './SceneBuilder';
import { SceneTemplate } from './SceneTemplate';
import { Mesh, type Bounds, type MeshData } from '../rendering/mesh/Mesh';
import { Cubemap, Skybox } from '../rendering/lighting/Skybox';
import { LightProfile, parseIes } from '../rendering/lighting/LightProfile';
import { SplatCloud } from '../rendering/splats/SplatRenderer';
import { SpriteSheet } from '../rendering/SpriteSheet';
import { SpriteFont } from '../rendering/text/SpriteFont';
import { Texture, type ImageDecoder, type TextureData, type TextureDecoder } from '../graphics/Texture';
import type { AudioEngine } from '../audio/AudioEngine';
import { Sound } from '../audio/Sound';
import { SOUND_SYNTH_RATE, synthesizeSound } from '../audio/soundSynth';
import { ColorTreeCompiler } from '../rendering/mesh/colorTree';
import { compileMaterialGraph, materialGraphTextures, type MaterialGraphOutput } from '../rendering/mesh/materialGraph';
import type { GraphFile } from '../graph/nodeGraph';
import type { ShaderClass } from '../rendering/shaderClass';
import { buildElement, UILibrary, UIPage, type UIResources } from '../ui/UIPage';
import { uiAssetPaths } from './references';
import { decodeAnimation, decodeCubemap, decodeGlyphBlock, decodeSkeleton, isVideoEncoding, readModelFile, EXTENSIONS, TEXTURE_EXTENSIONS, vertexLayoutOffsets, type ScenePostEffects, type TextureEncoding, type ModelMeshData, type MaterialFile, type PrefabFile, type SceneEntityFile, type FontFile, type GameSettingsFile, type SceneFile, type SceneForwardRenderer, type SceneNavigation, type ScenePhysics, type SceneRenderTexture, type SkyboxFile, type SpriteSheetFile, type TextureRef, type TextureSlot, type UIFile, type ParticleModuleFile, type SoundFile, type TimelineFile } from './format';
import { Timeline } from '../timeline/Timeline';
import { checkWorldFile, type WorldFile } from './worldFormat';

declare module '../data/prop' {
  interface AssetTypes {
    model: LoadedModel;
    material: Material;
    animation: AnimationClip;
    scene: SceneReference;
    prefab: Prefab;
    font: SpriteFont;
    spriteSheet: SpriteSheet;
    texture: Texture;
    uiPage: UIPage;
    uiLibrary: UILibrary;
    sound: Sound;
    timeline: Timeline;
  }
}

/** 脚本属性引用的场景（Stride 的 Scene 类型的属性）：只是路径，交给 Game.setRootScene 时才加载。 */
export interface SceneReference {
  readonly path: string;
}

/**
 * 带着种类的资源路径：`content.load(handle)` 的结果类型跟着种类走，场景的句柄可以直接交给 Game.setRootScene、loadScene。
 * 工程里的句柄由工具按内容目录生成（`src/assets.gen.ts`，见 docs/architecture.md 的"资源的强类型"），资源改名、删掉以后
 * 引用它的代码在类型检查时报错。
 */
export interface AssetHandle<K extends keyof AssetTypes = keyof AssetTypes, S = unknown> {
  readonly kind: K;
  readonly path: string;
  /** 只在类型里：资源的结构（生成的句柄给预制体写上它的 PrefabShape），运行时没有这个字段。 */
  readonly shape?: S;
}

/** 句柄加载出来的东西：带结构的预制体是 Prefab<结构>，别的按种类。 */
export type LoadedAsset<K extends keyof AssetTypes, S = unknown> = K extends 'prefab' ? (S extends PrefabShape ? Prefab<S> : Prefab) : AssetTypes[K];

/** 资源句柄；S 是资源的结构（生成的预制体句柄写 `assetRef<'prefab', 它的结构>(…)`）。 */
export function assetRef<K extends keyof AssetTypes, S = unknown>(kind: K, path: string): AssetHandle<K, S> {
  return { kind, path };
}

/** loadScene 的选项。 */
export interface LoadSceneOptions {
  /** 场景里的 Stride 脚本类型（带命名空间）显式对应到 TS 脚本；没列的按类名在登记表里找，见 sceneScripts.ts。 */
  readonly scripts?: SceneScriptMap;
  /** 场景的偏移（Stride 的 Scene.Offset）；没给时用场景文件里的。加载以后改 `scene.offset`。 */
  readonly offset?: readonly [number, number, number];
  /**
   * 作为这个场景的子场景（Stride 的 Scene.Parent）：偏移接在父场景的偏移后面；用 Game.loadScene 加载时，父场景卸载、根场景换掉
   * 也跟着卸载。
   */
  readonly parent?: EntityScene | undefined;
  /** 挂不挂场景文件里的脚本，没给是挂。编辑器的编辑状态不挂（脚本不跑），见 editor/LiveScene。 */
  readonly attachScripts?: boolean;
  /**
   * Game.loadScene 用不用场景自己的设置（合成器、仿真、导航），没给是用。编辑器里一起看的参考场景（子场景）只要实体，不改正在
   * 编辑的场景的画面和仿真。
   */
  readonly applySettings?: boolean;
}

/** meshopt 解码的一个请求（同 @stride-ts/native 的 MeshoptRequest）。 */
export interface MeshoptRequest {
  readonly source: Uint8Array;
  readonly count: number;
  readonly stride: number;
  readonly mode: 'attributes' | 'triangles';
}

/** 并行解码一批 meshopt 流，返回每个请求的 count * stride 个字节。 */
export type MeshoptDecoder = (requests: readonly MeshoptRequest[]) => Promise<Uint8Array[]>;

/** 读一个文件；默认用 fetch，测试和 Node 里可以换成读本地文件。 */
export type ContentReader = (url: URL) => Promise<ArrayBuffer>;

export interface ContentOptions {
  /** 内容根目录；默认是页面旁边的 `content/`。 */
  readonly root?: string | URL;
  readonly read?: ContentReader;
  /** 按名字找游戏登记的着色器类（材质的颜色树用；Game 给的是它的 Registry）。 */
  readonly shaderClass?: (name: string) => ShaderClass | undefined;
}

/** 加载好的模型：网格（蒙皮网格带着它的蒙皮）、材质槽（模型自带的材质，没有的槽是 null）和蒙皮网格用的骨架。 */
export interface LoadedModel {
  readonly meshes: readonly { readonly mesh: Mesh; readonly material: number | null; readonly skin?: NativeSkin }[];
  readonly materials: readonly (Material | null)[];
  readonly skeleton?: Skeleton;
  /** 形变目标的名字，按模型的目标槽排。 */
  readonly morphTargets?: readonly string[];
}


/** 场景开不开后处理；场景没带合成器设置（沿用现在的）时是 undefined。 */
/** 场景合成器的后处理设置（null 是不做后处理）；场景没有合成器时不知道。 */
const postEffectsOf = (scene: SceneFile): ScenePostEffects | null | undefined => scene.compositor?.postEffects;

/** 合成器里画进渲染目标贴图的相机，贴图已经建好。 */
export interface TextureCamera extends SceneForwardRenderer {
  readonly cameraSlot: number;
  readonly texture: Texture;
}

/** 场景的合成器设置（贴图已经建好）：主画面的前向渲染器，和先画的渲染目标贴图。 */
export interface CompositorSettings extends SceneForwardRenderer {
  readonly textureCameras: readonly TextureCamera[];
  /** false 时不画阴影（见 SceneCompositor.shadows）。 */
  readonly shadows?: false;
  /** 粒子画在 UI 上面（见 SceneCompositor.particlesOverUI）。 */
  readonly particlesOverUI?: true;
  /** 网格效果的名字（见 SceneCompositor.meshEffect）。 */
  readonly meshEffect?: string;
}

/** 加载好的游戏设置（ContentManager.loadGameSettings）。 */
export interface GameSettings {
  readonly name: string;
  readonly defaultScene: string | null;
  /** 合成器的根是游戏自己的渲染器时：Stride 的类型名和加载好的属性（键名小写开头）。 */
  readonly renderer: { readonly type: string; readonly props: Readonly<Record<string, unknown>> } | null;
  /** 默认的后备缓冲大小（Stride 的 RenderingSettings.DefaultBackBufferWidth、Height），见 GameSettingsFile。 */
  readonly defaultBackBufferSize: readonly [number, number];
}

export interface SceneInstance extends EntityScene {
  readonly name: string;
  /** 场景文件的内容路径；直接给场景文件建的（instantiateScene）没有。 */
  readonly path?: string;
  /**
   * 场景的偏移（Stride 的 Scene.Offset），相对父场景；可以直接改 x、y、z。场景里实体的世界位置带着它（和父场景的偏移），
   * 本地位置不带。
   */
  readonly offset: Vec3Like;
  /** 场景文件建的实体，按文件里的实体 id；运行时放进场景的实体（Entity.scene）不在这里。 */
  readonly entities: ReadonlyMap<string, Entity>;
  /** 场景用的仿真设置（Game.loadScene 交给 simulation）。 */
  readonly physics?: ScenePhysics;
  /** 场景用的导航设置（Game.loadScene 交给 navigation）。 */
  readonly navigation?: SceneNavigation;
  /** 场景用的合成器设置（Game.loadScene 交给图形合成器）。 */
  readonly compositor?: CompositorSettings;
}

const fetchReader: ContentReader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`loading ${url.href} failed: HTTP ${response.status}`);
  return response.arrayBuffer();
};

export class ContentManager {
  readonly root: URL;
  readonly #read: ContentReader;
  readonly #cache = new Map<string, Promise<unknown>>();
  readonly #renderTextures = new Map<string, Texture>();
  /** 没有材质的网格用它：白色。 */
  readonly defaultMaterial = new Material('default');
  readonly #shaderClasses: (name: string) => ShaderClass | undefined;
  readonly #scenes = new SceneBuilder(this);
  /**
   * 把 KTX2 贴图转码成设备支持的格式；加载了原生的 texture 功能时，Game 在图形设备建好之后设置（ktx2Decoder），
   * 测试里可以换成假的。
   */
  textureDecoder: TextureDecoder | undefined;
  /** 把 SVG、PNG、JPEG 贴图解成 RGBA8；Game 启动时设置（browserImageDecoder），测试里可以换成假的。 */
  imageDecoder: ImageDecoder | undefined;
  /** 解码 meshopt 压缩的模型；Game 启动时设置（原生模块的 decodeMeshoptBatch，各个流在原生线程里并行解）。 */
  meshoptDecoder: MeshoptDecoder | undefined;
  /** 加载骨架、动画剪辑和蒙皮；Game 启动时设置（原生模块）。 */
  animationNative: AnimationNative | undefined;
  /**
   * 预热管线：这些网格配这些材质要用的管线在后台编译，编好时完成；Game 启动时设置（MeshRenderFeature.warm），没设置
   * （没有渲染）时不预热。postEffects 是要加载的场景的后处理设置（影响用哪一套管线，后处理的管线也一起预热；null 是不做后
   * 处理），预制体不知道，不给。
   */
  pipelineWarmer: ((uses: readonly ModelUse[], postEffects: ScenePostEffects | null | undefined, files: readonly SceneEntityFile[]) => Promise<void>) | undefined;
  /** 解码声音；Game 启动时设置（game.audio）。 */
  audio: AudioEngine | undefined;

  /** 每种资源怎么按路径加载（load 和 GameSettings 里引用的资源用）；场景只给路径。 */
  readonly #loaders: { readonly [K in keyof AssetTypes]: (path: string) => Promise<AssetTypes[K]> } = {
    model: (path) => this.loadModel(path),
    material: (path) => this.loadMaterial(path),
    animation: (path) => this.loadAnimation(path),
    scene: (path) => Promise.resolve({ path }),
    prefab: (path) => this.loadPrefab(path),
    font: (path) => this.loadFont(path),
    spriteSheet: (path) => this.loadSpriteSheet(path),
    texture: (path) => this.loadTextureAsset(path),
    uiPage: (path) => this.loadUIPage(path),
    uiLibrary: (path) => this.loadUILibrary(path),
    sound: (path) => this.loadSound(path),
    timeline: (path) => this.loadTimeline(path),
  };

  constructor({ root = 'content/', read = fetchReader, shaderClass = () => undefined }: ContentOptions = {}) {
    this.#shaderClasses = shaderClass;
    const base = typeof document === 'undefined' ? 'file:///' : document.baseURI;
    this.root = new URL(root, base);
    this.#read = read;
  }

  /**
   * 忘掉这些资源（内容路径）已经加载的结果，下次用到时重新读文件：编辑器里资源改了（热重载，LiveScene.reloadAssets）。
   * 已经建出来的对象不动，用它们的实体要重建才换上新的。返回丢掉了几项。
   */
  evict(paths: Iterable<string>): number {
    let removed = 0;
    for (const path of paths) {
      const prefix = new URL(`${path}.`, this.root).href;
      for (const key of [...this.#cache.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.#cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** 按句柄加载：`const prefab = await content.load(assets.prefabs.Bullet)`。 */
  load<K extends keyof AssetTypes, S = unknown>(handle: AssetHandle<K, S>): Promise<LoadedAsset<K, S>> {
    return this.#loaders[handle.kind](handle.path) as Promise<LoadedAsset<K, S>>;
  }

  loadModel(path: string): Promise<LoadedModel> {
    return this.#once(path + EXTENSIONS.model, async (url) => {
      const data = readModelFile(await this.#read(url), url.href);
      const [meshes, materials, skeleton] = await Promise.all([
        this.#decodeMeshes(data.meshes, url),
        Promise.all(data.materials.map((material) => (material === null ? null : this.loadMaterial(material)))),
        data.skeleton === undefined ? undefined : this.loadSkeleton(data.skeleton),
      ]);
      const loaded = data.meshes.map((file, i) => {
        const mesh = new Mesh(`${path}/${file.name}`, meshes[i]!);
        const skin = file.skin && this.#animationNative(url).createSkin(new Uint32Array(file.skin.joints), new Float32Array(file.skin.inverseBinds));
        return { mesh, material: file.material, ...(skin ? { skin } : {}) };
      });
      if (loaded.some((part) => part.skin) && !skeleton) throw new Error(`${url.href}: the model has skinned meshes but no skeleton`);
      // 蒙皮网格动起来会超出绑定姿势的包围盒：剔除时用整个模型的包围盒放大一半（和 Stride 不同，Stride 每帧按骨骼算）
      const skinnedBounds = inflate(unionBounds(loaded.map(({ mesh }) => mesh.bounds)), 1.5);
      for (const part of loaded) if (part.skin) part.mesh.cullBounds = skinnedBounds;
      // 形变把顶点推出静止的包围盒：按最大的增量放大（权重按到 2 算，MorphTargets 的滑条最大是 2）
      for (const { mesh } of loaded) if (mesh.data.morph) mesh.cullBounds = expand(mesh.cullBounds, 2 * mesh.morphReach);
      if (loaded.some(({ mesh }) => mesh.data.morph) && !data.morphTargets) throw new Error(`${url.href}: the model has morphed meshes but no morph targets`);
      return { meshes: loaded, materials, ...(skeleton ? { skeleton } : {}), ...(data.morphTargets ? { morphTargets: data.morphTargets } : {}) };
    });
  }

  loadSkeleton(path: string): Promise<Skeleton> {
    return this.#once(path + EXTENSIONS.skeleton, async (url) => {
      const { joints, archive } = decodeSkeleton(await this.#read(url), url.href);
      return new Skeleton(path, joints, this.#animationNative(url).loadSkeleton(archive));
    });
  }

  /** 动画剪辑；它的骨架一起加载。 */
  loadAnimation(path: string): Promise<AnimationClip> {
    return this.#once(path + EXTENSIONS.animation, async (url) => {
      const { duration, repeatMode, skeleton, morphWeights, archive } = decodeAnimation(await this.#read(url), url.href);
      const bones = skeleton === undefined ? undefined : { skeleton: await this.loadSkeleton(skeleton), native: this.#animationNative(url).loadAnimation(archive) };
      return new AnimationClip(path, bones?.native.duration ?? duration, repeatMode, bones, morphWeights);
    });
  }

  #animationNative(url: URL): AnimationNative {
    if (!this.animationNative) throw new Error(`loading ${url.href}: skeletons, animations and skins need animationNative (Game sets one when it starts)`);
    return this.animationNative;
  }

  /** 模型文件里的网格变成 MeshData：压缩的一起交给 meshoptDecoder 并行解码，没压缩的直接用文件里的字节。 */
  async #decodeMeshes(meshes: readonly ModelMeshData[], url: URL): Promise<MeshData[]> {
    const compressed = meshes.filter((mesh) => mesh.compression === 'meshopt');
    let decoded: Uint8Array[] = [];
    if (compressed.length > 0) {
      if (!this.meshoptDecoder) throw new Error(`loading ${url.href}: compressed meshes need a meshoptDecoder (Game sets one when it starts)`);
      decoded = await this.meshoptDecoder(compressed.flatMap((mesh) => [
        { source: mesh.vertices, count: mesh.vertexCount, stride: vertexLayoutOffsets(mesh.layout).stride, mode: 'attributes' as const },
        { source: mesh.indices, count: mesh.indexCount, stride: mesh.indexFormat === 'uint16' ? 2 : 4, mode: 'triangles' as const },
      ]));
    }
    let next = 0;
    return meshes.map((mesh) => {
      const [vertices, indexBytes] = mesh.compression === 'meshopt' ? [decoded[next++]!, decoded[next++]!] : [mesh.vertices, mesh.indices];
      const indices = mesh.indexFormat === 'uint16'
        ? new Uint16Array(indexBytes.buffer, indexBytes.byteOffset, mesh.indexCount)
        : new Uint32Array(indexBytes.buffer, indexBytes.byteOffset, mesh.indexCount);
      const morph = mesh.morphData && new Uint32Array(mesh.morphData.buffer, mesh.morphData.byteOffset, mesh.morphData.byteLength / 4);
      return { vertices, indices, layout: mesh.layout, dequantize: mesh.dequantize, ...(morph ? { morph } : {}) };
    });
  }

  loadMaterial(path: string): Promise<Material> {
    return this.#once(path + EXTENSIONS.material, async (url) => {
      const file = this.#json<MaterialFile>(await this.#read(url));
      // 颜色贴图按 sRGB 解；法线、遮蔽这些数据贴图是线性的
      const slot = async ({ scale, offset, filter, addressU, addressV, ...ref }: TextureSlot, srgb: boolean) =>
        ({ texture: await this.loadTextureRef(ref, srgb), scale, offset, sampler: { ...(filter ? { filter } : {}), ...(addressU ? { addressU } : {}), ...(addressV ? { addressV } : {}) } });
      const { normalMap: normal, ambientOcclusion: occlusion } = file;
      const [baseColorTexture, emissiveTexture, normalTexture, occlusionTexture, shaderTrees, glossinessTexture] = await Promise.all([
        file.baseColorTexture && slot(file.baseColorTexture, true),
        file.emissiveTexture && slot(file.emissiveTexture, true),
        normal && slot(normal, false),
        occlusion?.texture && slot(occlusion.texture, false),
        this.#shaderTrees(file),
        file.glossinessTexture && slot(file.glossinessTexture, false),
      ]);
      return new Material(file.name, {
        baseColor: file.baseColor,
        ...(baseColorTexture ? { baseColorTexture } : {}),
        ...(file.baseColorOperator ? { baseColorOperator: file.baseColorOperator } : {}),
        ...(file.metalness === undefined ? {} : { metalness: file.metalness }),
        ...(file.specular ? { specular: file.specular } : {}),
        ...(file.specularEnergyConservative === false ? { specularEnergyConservative: false } : {}),
        ...(file.specularShading === false ? { specularShading: false } : {}),
        ...(file.microfacet ? { microfacet: file.microfacet } : {}),
        ...(file.celShading ? { celShading: file.celShading } : {}),
        ...(file.diffuseShading === false ? { diffuseShading: false } : {}),
        ...(file.glass ? { glass: file.glass } : {}),
        ...(file.subsurfaceScattering ? { subsurfaceScattering: file.subsurfaceScattering } : {}),
        ...(file.sheen ? { sheen: file.sheen } : {}),
        ...(file.anisotropy ? { anisotropy: file.anisotropy } : {}),
        ...(file.transmission ? { transmission: file.transmission } : {}),
        ...(file.roughness === undefined ? {} : { roughness: file.roughness }),
        ...(glossinessTexture ? { glossinessMap: { ...glossinessTexture, channel: file.glossinessTexture!.channel, invert: file.glossinessTexture!.invert, ...(file.glossinessTexture!.metalnessChannel ? { metalnessChannel: file.glossinessTexture!.metalnessChannel } : {}) } } : {}),
        ...(file.emissive ? { emissive: file.emissive } : {}),
        ...(emissiveTexture ? { emissiveTexture } : {}),
        ...(shaderTrees ? { shaderTrees } : {}),
        ...(file.doubleSided ? { doubleSided: true } : {}),
        ...(occlusion ? { ambientOcclusion: { value: occlusion.value, directLighting: occlusion.directLighting, ...(occlusionTexture ? { texture: { ...occlusionTexture, channel: occlusion.texture!.channel } } : {}) } } : {}),
        ...(file.cavity ? { cavity: file.cavity } : {}),
        ...(normalTexture ? { normalMap: { ...normalTexture, scaleAndBias: normal!.scaleAndBias, isXYNormal: normal!.isXYNormal, invertY: normal!.invertY } } : {}),
        ...(file.transparency ? { transparency: file.transparency } : {}),
        ...(file.alphaCutoff === undefined ? {} : { alphaCutoff: file.alphaCutoff }),
      });
    });
  }

  /**
   * 材质的颜色树（自发光、法线贴图、位移贴图）：先加载它们引用的贴图，再用同一个编译器编译（贴图共用绑定组 3，着色器类按游戏
   * 登记的找）。一棵树都没有时是 undefined。
   */
  async #shaderTrees({ name, emissiveTree: emissive, normalTree: normal, displacementTree: displacement, layers = [], clearCoat: coat, graph }: MaterialFile): Promise<MaterialShaderTrees | undefined> {
    if (!emissive && !normal && !displacement && layers.length === 0 && !coat && !graph) return undefined;
    const layerTrees = layers.flatMap((l) => [l.blend, l.diffuse, l.specular?.color, l.specular?.intensity, l.metalness, l.glossiness?.tree, l.normal?.tree, l.emissive?.tree]);
    // 清漆的树：函数名 → 树和返回类型
    const coatTrees: (readonly [string, ParticleModuleFile, 'vec4f' | 'f32'])[] = coat ? [
      ['coatLodDistance', coat.lodDistance, 'f32'],
      ['coatBaseDiffuse', coat.basePaint.diffuse, 'vec4f'], ['coatBaseGloss', coat.basePaint.glossiness, 'f32'],
      ['coatFlakesDiffuse', coat.metalFlakes.diffuse, 'vec4f'], ['coatFlakesGloss', coat.metalFlakes.glossiness, 'f32'],
      ['coatFlakesMetalness', coat.metalFlakes.metalness, 'f32'], ['coatFlakesNormal', coat.metalFlakes.normal.tree, 'vec4f'],
      ['coatTopGloss', coat.coat.glossiness, 'f32'], ['coatTopMetalness', coat.coat.metalness, 'f32'], ['coatTopNormal', coat.coat.normal.tree, 'vec4f'],
    ] : [];
    const refs = [emissive?.tree, normal?.tree, displacement?.tree, ...layerTrees, ...coatTrees.map(([, tree]) => tree)].flatMap((t) => (t ? textureRefs(t) : []));
    const textures = new Map(await Promise.all(refs.map(async (ref) => [ref.texture, await this.loadTextureRef(ref, ref.srgb ?? true)] as const)));
    const compiler = new ColorTreeCompiler({ texture: (path) => textures.get(path), shaderClass: (name) => this.#shaderClasses(name) }, 3);
    const graphCode = graph ? await this.#graphLayer(graph, compiler, layers.length, name) : undefined;
    const functions = [
      emissive && `fn emissiveTree() -> vec4f {\n  return ${compiler.color(emissive.tree)};\n}\n`,
      normal && `fn normalTree() -> vec4f {\n  return ${compiler.color(normal.tree)};\n}\n`,
      displacement && `fn displacementTree() -> f32 {\n  return ${compiler.vertexScalar(displacement.tree)};\n}\n`,
      ...layers.flatMap((layer, i) => [
        `fn layer${i}Blend() -> f32 {\n  return ${compiler.scalar(layer.blend)};\n}\n`,
        layer.diffuse && `fn layer${i}Diffuse() -> vec4f {\n  return ${compiler.color(layer.diffuse)};\n}\n`,
        layer.specular && `fn layer${i}Specular() -> vec3f {\n  return ${compiler.color(layer.specular.color)}.rgb * clamp(${compiler.scalar(layer.specular.intensity)}, 0.0, 1.0);\n}\n`,
        layer.metalness && `fn layer${i}Metalness() -> f32 {\n  return ${compiler.scalar(layer.metalness)};\n}\n`,
        layer.glossiness && `fn layer${i}Gloss() -> f32 {\n  return ${compiler.scalar(layer.glossiness.tree)};\n}\n`,
        layer.normal && `fn layer${i}Normal() -> vec4f {\n  return ${compiler.color(layer.normal.tree)};\n}\n`,
        layer.emissive && `fn layer${i}Emissive() -> vec3f {\n  return ${compiler.color(layer.emissive.tree)}.rgb * ${layer.emissive.intensity};\n}\n`,
        layer.occlusion && `fn layer${i}Occlusion() -> f32 {\n  return ${compiler.scalar(layer.occlusion.tree)};\n}\n`,
      ]),
      ...coatTrees.map(([name, tree, type]) => `fn ${name}() -> ${type} {\n  return ${type === 'f32' ? compiler.scalar(tree) : compiler.color(tree)};\n}\n`),
      graphCode?.code,
    ];
    return {
      code: compiler.declarations + functions.filter(Boolean).join(''),
      textures: compiler.textures,
      ...(emissive ? { emissive: { intensity: emissive.intensity, useAlpha: emissive.useAlpha } } : {}),
      ...(normal ? { normal: { scaleAndBias: normal.scaleAndBias, isXYNormal: normal.isXYNormal } } : {}),
      ...(displacement ? { displacement: { intensity: displacement.intensity, scaleAndBias: displacement.scaleAndBias } } : {}),
      ...(coat ? {
        clearCoat: {
          baseInvert: coat.basePaint.invert, flakesInvert: coat.metalFlakes.invert, topInvert: coat.coat.invert,
          flakesNormal: { scaleAndBias: coat.metalFlakes.normal.scaleAndBias, isXYNormal: coat.metalFlakes.normal.isXYNormal },
          topNormal: { scaleAndBias: coat.coat.normal.scaleAndBias, isXYNormal: coat.coat.normal.isXYNormal },
        },
      } : {}),
      ...(graphCode ? { graph: true } : {}),
      ...(layers.length > 0 || graphCode ? {
        layers: [...layers.map((layer) => ({
          diffuse: layer.diffuse !== undefined, specular: layer.specular !== undefined, metalness: layer.metalness !== undefined,
          emissive: layer.emissive !== undefined,
          ...(layer.glossiness ? { glossiness: { invert: layer.glossiness.invert } } : {}),
          ...(layer.normal ? { normal: { scaleAndBias: layer.normal.scaleAndBias, isXYNormal: layer.normal.isXYNormal } } : {}),
          ...(layer.occlusion ? { occlusion: { directLighting: layer.occlusion.directLighting } } : {}),
        })), ...(graphCode ? [graphCode.layer] : [])],
      } : {}),
    };
  }

  /**
   * 材质节点图（rendering/mesh/materialGraph.ts）编成第 index 层：先加载贴图节点引用的贴图资源，图的代码加上这一层的各个函数
   * （权重 1，读 materialGraph() 算好的 graph_* 变量）。
   */
  async #graphLayer(graph: GraphFile, compiler: ColorTreeCompiler, index: number, name: string): Promise<{ code: string; layer: MaterialShaderLayer }> {
    const textures = new Map(await Promise.all(materialGraphTextures(graph).map(async (path) => [path, await this.loadTextureAsset(path)] as const)));
    const compiled = compileMaterialGraph(graph, compiler, (path, uv) => {
      const texture = textures.get(path);
      return texture && compiler.sampleTexture(texture, uv);
    }, `material ${name}`);
    const has = (output: MaterialGraphOutput) => compiled.outputs.has(output);
    const layer = (fn: string, type: string, body: string) => `fn layer${index}${fn}() -> ${type} {\n  return ${body};\n}\n`;
    const code = [
      compiled.code,
      layer('Blend', 'f32', '1.0'),
      has('baseColor') && layer('Diffuse', 'vec4f', 'graph_baseColor'),
      has('metalness') && layer('Metalness', 'f32', 'graph_metalness'),
      has('roughness') && layer('Gloss', 'f32', 'graph_roughness'),
      has('normal') && layer('Normal', 'vec4f', 'vec4f(graph_normal, 1.0)'),
      has('emissive') && layer('Emissive', 'vec3f', 'graph_emissive.rgb'),
      has('occlusion') && layer('Occlusion', 'f32', 'graph_occlusion'),
    ].filter(Boolean).join('');
    return {
      code,
      layer: {
        diffuse: has('baseColor'), specular: false, metalness: has('metalness'), emissive: has('emissive'),
        // 图给的是粗糙度（invert：不再用 1 减）
        ...(has('roughness') ? { glossiness: { invert: true } } : {}),
        ...(has('normal') ? { normal: { scaleAndBias: false, isXYNormal: false } } : {}),
        ...(has('occlusion') ? { occlusion: { directLighting: 1 } } : {}),
      },
    };
  }

  loadCubemap(path: string): Promise<Cubemap> {
    return this.#once(path + EXTENSIONS.cubemap, async (url) => new Cubemap(path, decodeCubemap(await this.#read(url), url.href)));
  }

  /** 高斯泼溅（.splat）。 */
  loadSplats(path: string): Promise<SplatCloud> {
    return this.#once(path + EXTENSIONS.splats, async (url) => new SplatCloud(path, await this.#read(url)));
  }

  /** 配光曲线（IES 文件）。 */
  loadLightProfile(path: string): Promise<LightProfile> {
    return this.#once(path + EXTENSIONS.lightProfile, async (url) => new LightProfile(path, parseIes(new TextDecoder().decode(await this.#read(url)), url.href)));
  }

  loadSkybox(path: string): Promise<Skybox> {
    return this.#once(path + EXTENSIONS.skybox, async (url) => {
      const file = this.#json<SkyboxFile>(await this.#read(url));
      return new Skybox(path, file.diffuseSH, await this.loadCubemap(file.radiance), file.specularSize);
    });
  }

  /**
   * 加载贴图。KTX2 的格式（包括是不是 sRGB）由文件决定；浏览器解码的图片（png、jpeg、svg）按 srgb 选格式，
   * 同一张图按 sRGB 和线性各加载一份。
   */
  loadTexture(path: string, { encoding = 'ktx2', srgb = true, size }: { encoding?: TextureEncoding; srgb?: boolean; size?: readonly [number, number] } = {}): Promise<Texture> {
    const variant = encoding === 'ktx2' || srgb ? '' : ' (linear)';
    return this.#once(path + TEXTURE_EXTENSIONS[encoding], variant, async (url) => {
      if (isVideoEncoding(encoding)) return new Texture(path, await loadVideo(url, srgb));
      const bytes = new Uint8Array(await this.#read(url));
      if (encoding === 'ktx2') {
        if (!this.textureDecoder) {
          throw new Error(`loading ${url.href}: no textureDecoder; run the game with nativeFeatures: [texture] (import { texture } from '@stride-ts/native/texture')`);
        }
        return new Texture(path, await this.textureDecoder(bytes));
      }
      if (!this.imageDecoder) throw new Error(`loading ${url.href}: no imageDecoder (Game sets one when it starts)`);
      return new Texture(path, await this.imageDecoder(bytes, { encoding, srgb, ...(size ? { size } : {}) }));
    });
  }

  /** 加载精灵表：精灵用到的贴图按 sRGB 读，同一张贴图只加载一次。 */
  loadSpriteSheet(path: string): Promise<SpriteSheet> {
    return this.#once(path + EXTENSIONS.spriteSheet, async (url) => {
      const file = this.#json<SpriteSheetFile>(await this.#read(url));
      const sprites = await Promise.all(file.sprites.map(async ({ texture, region, ...sprite }) => ({ ...sprite, region: [...region] as [number, number, number, number], texture: await this.loadTextureRef(texture, true) })));
      return new SpriteSheet(path, sprites);
    });
  }

  /**
   * 加载 UI 页面（Stride 的 UIPage）：引用的精灵表、字体、贴图先加载好，再建元素树。同一页面只建一次（同 Stride 的
   * Content.Load），用到它的地方共用这棵树。
   */
  loadUIPage(path: string): Promise<UIPage> {
    return this.#once(path + EXTENSIONS.ui, 'page', async (url) => {
      const { file, resources } = await this.#uiFile(url);
      return new UIPage(file.name, file.root === undefined ? null : buildElement(file, file.root, resources));
    });
  }

  /** 加载 UI 库（Stride 的 UILibrary）：instantiateElement 每次按模板新建元素。 */
  loadUILibrary(path: string): Promise<UILibrary> {
    return this.#once(path + EXTENSIONS.ui, 'library', async (url) => {
      const { file, resources } = await this.#uiFile(url);
      return new UILibrary(file, resources);
    });
  }

  async #uiFile(url: URL): Promise<{ file: UIFile; resources: UIResources }> {
    const file = this.#json<UIFile>(await this.#read(url));
    const paths = uiAssetPaths(file);
    const [spriteSheets, fonts, textures] = await Promise.all([
      preload(paths.spriteSheets, (p) => this.loadSpriteSheet(p)),
      preload(paths.fonts, (p) => this.loadFont(p)),
      Promise.all(paths.textures.map(async (value) => 'texture' in value ? [value.texture.texture, await this.loadTextureRef(value.texture, true)] as const : undefined)),
    ]);
    return { file, resources: { spriteSheets, fonts, textures: new Map(textures.filter((entry) => entry !== undefined)) } };
  }

  /** 加载单独引用的贴图资源（脚本属性、合成器渲染器引用的）：先读它的 TextureRef，再按里面的编码和 sRGB 读贴图。 */
  loadTextureAsset(path: string): Promise<Texture> {
    return this.#once(path + EXTENSIONS.texture, async (url) => {
      const ref = this.#json<TextureRef>(await this.#read(url));
      return this.loadTextureRef(ref, ref.srgb ?? true);
    });
  }

  /**
   * 加载游戏设置（.game.json）：默认场景的路径，合成器的根是游戏自己的渲染器时它的类型名和属性（属性引用的资源加载好）。
   */
  loadGameSettings(path: string): Promise<GameSettings> {
    return this.#once(path + EXTENSIONS.gameSettings, async (url) => {
      const file = this.#json<GameSettingsFile>(await this.#read(url));
      const common = { name: file.name, defaultScene: file.defaultScene, defaultBackBufferSize: file.defaultBackBufferSize ?? [1280, 720] } as const;
      if (!file.renderer) return { ...common, renderer: null };
      const refs = scriptAssetRefs([file.renderer]);
      const loaded = new Map<string, object>(await Promise.all(refs.map(async ({ kind, path: assetPath }) => {
        const load = (this.#loaders as Readonly<Record<string, ((p: string) => Promise<object>) | undefined>>)[kind];
        if (!load) throw new Error(`${url.href}: renderer properties referring to ${kind} assets are not supported`);
        return [`${kind}:${assetPath}`, await load(assetPath)] as const;
      })));
      const props = resolveSceneValues(file.renderer.props, { entities: new Map(), asset: (kind, assetPath) => loaded.get(`${kind}:${assetPath}`)! });
      return { ...common, renderer: { type: file.renderer.type, props } };
    });
  }

  /**
   * 加载声音：不流式的下载并整个解码，流式的只记下音频文件的地址（实例播放时边下边放）。
   */
  /** 时间轴（TimelineFile）和它的声音轨道用到的声音（播放到时不用等加载）。 */
  /** 世界（`.world.json`）：读进来、检查过的文件；格子的场景由 world/WorldStreaming.ts 按需加载。 */
  loadWorld(path: string): Promise<WorldFile> {
    return this.#once(path + EXTENSIONS.world, async (url) => checkWorldFile(this.#json<unknown>(await this.#read(url)), path));
  }

  loadTimeline(path: string): Promise<Timeline> {
    return this.#once(path + EXTENSIONS.timeline, async (url) => {
      const file = this.#json<TimelineFile>(await this.#read(url));
      const paths = [...new Set(file.tracks.flatMap((track) => (track.type === 'sound' ? track.clips.map((clip) => clip.sound) : [])))];
      const sounds = new Map(await Promise.all(paths.map(async (sound) => [sound, await this.loadSound(sound)] as const)));
      return new Timeline(file, sounds);
    });
  }

  loadSound(path: string): Promise<Sound> {
    return this.#once(path + EXTENSIONS.sound, async (url) => {
      const file = this.#json<SoundFile>(await this.#read(url));
      const audio = this.audio;
      if (!audio) throw new Error(`loading ${url.href}: sounds need an audio engine (Game sets one when it starts)`);
      if (file.encoding === 'synth') return new Sound(audio, file.name, { buffer: audio.fromSamples(synthesizeSound(file.synth ?? {}), SOUND_SYNTH_RATE) }, file.spatialized);
      const audioUrl = new URL(`${path}.${file.encoding}`, this.root);
      const source = file.streamFromDisk ? { url: audioUrl.href } : { buffer: await audio.decode(await this.#read(audioUrl)) };
      return new Sound(audio, file.name, source, file.spatialized);
    });
  }

  /** 加载字体：先只读度量和码位块的清单，字形的块用到时再下载（见 SpriteFont）。 */
  loadFont(path: string): Promise<SpriteFont> {
    return this.#once(path + EXTENSIONS.font, async (url) => {
      const file = this.#json<FontFile>(await this.#read(url));
      return new SpriteFont(file, async (block) => {
        const blockUrl = new URL(`${path}.${block}${EXTENSIONS.glyphs}`, this.root);
        return decodeGlyphBlock(await this.#read(blockUrl), blockUrl.href);
      });
    });
  }

  /**
   * 加载场景并把它的实体创建在 entities 里：场景引用的模型、材质、天空盒、立方体贴图（包括脚本属性引用的）先并行加载完，
   * 再按顺序创建实体和组件，最后挂脚本（这时所有实体都在，脚本属性里的实体引用才解析得了）。
   */
  async loadScene(path: string, entities: EntityManager, options: LoadSceneOptions = {}): Promise<SceneInstance> {
    const { scene, assets } = await this.#sceneWithAssets(path);
    return this.#createScene(scene, assets, entities, options, path, path);
  }

  /**
   * 按给的场景文件建场景（不经内容路径，文件不进缓存；它引用的资源照常按路径加载）。编辑器里场景文件在场景文档里
   * （editor/SceneDocument），不在内容目录里。
   */
  async instantiateScene(file: SceneFile, entities: EntityManager, options: LoadSceneOptions = {}): Promise<SceneInstance> {
    const where = `scene ${file.name}`;
    const scene = { ...file, entities: await this.#expandInstances(file.entities, where) };
    return this.#createScene(scene, await this.#scenes.preload(scene.entities, where, postEffectsOf(scene)), entities, options, where);
  }

  /**
   * 把建好的场景从 before 改成 after 的样子（编辑器改了场景文档以后）：加的实体建出来，删的销毁，变了的只改变了的部分
   * （SceneBuilder.update）。要用的资源先加载好，然后一口气改完，中间不会画出改了一半的场景。同一个场景的两次 updateScene
   * 不能同时进行（等上一次的 Promise，LiveScene 替你排队）。场景自己的设置（偏移、仿真、导航、合成器）变了不在这里管。
   */
  async updateScene(instance: SceneInstance, before: SceneFile, after: SceneFile, entities: EntityManager, options: LoadSceneOptions = {}): Promise<void> {
    if (before.entities === after.entities) return;
    const where = `scene ${after.name}`;
    // 实例展开以后再比（没变的实例展开出同一批对象，见 prefabInstances.ts）
    const { added, removed, changed } = changedEntities(await this.#expandInstances(before.entities, where), await this.#expandInstances(after.entities, where));
    if (added.length + removed.length + changed.length === 0) return;
    // 资源：新实体的，和组件变了的实体的。加载不了的资源不让整次失败：用到它的组件先不建（记警告），实体照样跟上文档；old 还是
    // 文件里的样子，去掉组件对没建的组件是空操作，资源有了以后再跟上时加上
    const loaded = await this.#scenes.preloadAvailable([...added, ...changed.filter(([old, file]) => file.components !== old.components).map(([, file]) => file)], where);
    const available = new Map(loaded.files.map((file) => [file.id, file]));
    const usable = (file: SceneEntityFile) => available.get(file.id) ?? file;
    // instance.entities 就是建场景时的那张表
    const live = instance.entities as Map<string, Entity>;
    // 先加（变了的实体可能要挂到新实体下面），再改（要留下的子实体从要删的父实体下面挪走），最后删
    this.#scenes.instantiate(added.map(usable), loaded.assets, entities, options, where, live);
    for (const file of added) live.get(file.id)!.scene = instance;
    for (const [old, file] of changed) {
      const entity = live.get(file.id);
      // 运行中被销毁了的（脚本销毁的）不管
      if (entity?.alive) this.#scenes.update(entity, old, usable(file), loaded.assets, live, where);
    }
    for (const id of removed) {
      const entity = live.get(id);
      live.delete(id);
      // 父实体销毁时子实体已经跟着销毁了
      if (entity?.alive) entity.destroy();
    }
  }

  /**
   * 实体列表里的预制体实例展开成普通实体（prefabInstances.ts）：用到的预制体文件（连嵌套的）先加载好。指不到的覆盖记警告。
   */
  async #expandInstances(entities: readonly SceneEntityFile[], where: string): Promise<readonly SceneEntityFile[]> {
    if (!entities.some((entity) => entity.prefab)) return entities;
    const prefabs = await loadPrefabs(entities, async (path) => (await this.#prefabFile(path)).entities);
    return expandPrefabInstances(entities, prefabs, (message) => console.warn(`${where}: ${message}`));
  }

  /** 预制体文件本身（没展开、不加载它引用的资源）：展开实例用。 */
  #prefabFile(path: string): Promise<PrefabFile> {
    return this.#once(path + EXTENSIONS.prefab, 'file', async (url) => this.#json<PrefabFile>(await this.#read(url)));
  }

  /** 场景文件里的合成器设置换成图形合成器要的（渲染目标贴图换成贴图）；场景没写时是 undefined。 */
  compositorSettings(scene: SceneFile): CompositorSettings | undefined {
    return scene.compositor && {
      ...scene.compositor,
      textureCameras: (scene.compositor.textureCameras ?? []).map(({ texture, ...camera }) => ({ ...camera, texture: this.renderTexture(texture) })),
    };
  }

  /** where 用在报错里；path 是场景文件的内容路径（按路径加载的才有）。 */
  #createScene(scene: SceneFile, assets: SceneAssets, entities: EntityManager, options: LoadSceneOptions, where: string, path?: string): SceneInstance {
    const created = this.#scenes.instantiate(scene.entities, assets, entities, options, where);
    const [x, y, z] = options.offset ?? scene.offset ?? [0, 0, 0];
    // 没有变换存储（场景里也就没有带 Transform 的实体）时只记下偏移
    const root = entities.game.transforms ? new SceneRoot(entities, [x, y, z], options.parent?.root) : undefined;
    const compositor = this.compositorSettings(scene);
    const instance: SceneInstance = { name: scene.name, ...(path !== undefined ? { path } : {}), entities: created, root, offset: root?.offset ?? { x, y, z }, ...(scene.physics ? { physics: scene.physics } : {}), ...(scene.navigation ? { navigation: scene.navigation } : {}), ...(compositor ? { compositor } : {}) };
    for (const entity of created.values()) entity.scene = instance;
    return instance;
  }

  /**
   * 只加载场景文件和它引用的资源，不建实体（Stride 的 Content.LoadAsync 预加载，TopDownRPG 的 SceneStreaming 走近分块时用）；
   * 之后的 loadScene 直接用加载好的。
   */
  async preloadScene(path: string): Promise<void> {
    await this.#sceneWithAssets(path);
  }

  #sceneWithAssets(path: string): Promise<{ scene: SceneFile; assets: SceneAssets }> {
    return this.#once(path + EXTENSIONS.scene, async (url) => {
      const file = this.#json<SceneFile>(await this.#read(url));
      const scene = { ...file, entities: await this.#expandInstances(file.entities, url.href) };
      return { scene, assets: await this.#scenes.preload(scene.entities, url.href, postEffectsOf(scene)) };
    });
  }

  /**
   * 把场景当模板加载（见 SceneTemplate）：场景文件和它引用的资源加载好，不建实体；模板实体实例化时脚本按 options 对应，同 loadScene。
   */
  loadSceneTemplate(path: string, options: LoadSceneOptions = {}): Promise<SceneTemplate> {
    return this.#once(path + EXTENSIONS.scene, 'template', async () => {
      const { scene, assets } = await this.#sceneWithAssets(path);
      return new SceneTemplate(path, scene.entities, (files, name) => new Prefab(name, files, (entities) => this.#scenes.instantiate(files, assets, entities, options, name)));
    });
  }

  /** 加载预制体：引用的资源先加载好，实例化时才建实体（见 Prefab）。实例化时脚本按 options 对应，同 loadScene。 */
  loadPrefab(path: string, options: LoadSceneOptions = {}): Promise<Prefab> {
    return this.#once(path + EXTENSIONS.prefab, async (url) => {
      const raw = this.#json<PrefabFile>(await this.#read(url));
      const file = { ...raw, entities: await this.#expandInstances(raw.entities, url.href) };
      const assets = await this.#scenes.preload(file.entities, url.href);
      return new Prefab(file.name, file.entities, (entities) => this.#scenes.instantiate(file.entities, assets, entities, options, path));
    });
  }

  /**
   * 给实体挂上加载好的模型（Stride 的 `new ModelComponent(model)`）：第一个网格挂在实体上，多出来的网格挂成子实体（一个实体只能
   * 有一个 Model），有骨架的接上动画。materials 按模型的材质槽覆盖（null 是用模型自带的）。
   */
  addModel(
    entity: Entity, loaded: LoadedModel,
    { materials = [], isShadowCaster = true, renderGroup = 0 }: { materials?: readonly (Material | null)[]; isShadowCaster?: boolean; renderGroup?: number } = {},
  ): void {
    const entities = entity.manager;
    if (entity.get(Model)) throw new Error(`entity '${entity.name}' already has a model; removeModel it first`);
    const skinned: { entity: Entity; skin: NativeSkin }[] = [];
    const morphed: Entity[] = [];
    loaded.meshes.forEach(({ mesh, material: slot, skin }, i) => {
      // 材质：实体按槽覆盖的，否则模型自带的，都没有时用默认材质
      const material = (slot === null ? null : (materials[slot] ?? loaded.materials[slot])) ?? this.defaultMaterial;
      const component = Model.with({ mesh: mesh.id, material: material.id, isShadowCaster, renderGroup });
      let part = entity;
      if (i === 0) entity.add(component);
      else {
        part = entities.create({ name: `${entity.name}/${mesh.name}`, components: [Transform, component, ModelPart] });
        part.require(Transform).parent = entity;
      }
      if (skin) skinned.push({ entity: part, skin });
      if (mesh.data.morph) morphed.push(part);
    });
    if (loaded.skeleton) entities.game.animation.attach(entity, loaded.skeleton, skinned);
    if (loaded.morphTargets) entities.game.animation.attachMorphs(entity, loaded.morphTargets, morphed);
  }

  /**
   * 去掉 addModel 挂上的模型：多出来的网格子实体、实体上的网格、骨架和形变权重（Stride 里给 ModelComponent.Model 换模型时
   * 旧的这些都跟着换掉）。之后可以再 addModel。
   */
  removeModel(entity: Entity): void {
    for (const child of entity.get(Transform)?.children ?? []) if (child.has(ModelPart)) child.destroy();
    for (const type of [ModelSkeleton, ModelMorph, Skinned, Morphed, Model]) if (entity.get(type)) entity.remove(type);
  }

  /** 渲染目标贴图（Stride 的 RenderTexture）：同一个内容路径只建一次，内容由合成器画进去。 */
  renderTexture({ renderTexture, width, height, hdr, srgb }: SceneRenderTexture): Texture {
    let texture = this.#renderTextures.get(renderTexture);
    if (!texture) {
      texture = Texture.renderTarget(renderTexture, width, height, hdr ? 'rgba16float' : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm');
      this.#renderTextures.set(renderTexture, texture);
    }
    return texture;
  }

  /** @internal 按贴图引用加载。defaultSrgb：引用里没写 srgb 时按用途定。 */
  loadTextureRef({ texture, encoding = 'ktx2', size, srgb }: TextureRef, defaultSrgb: boolean): Promise<Texture> {
    return this.loadTexture(texture, { encoding, srgb: srgb ?? defaultSrgb, ...(size ? { size } : {}) });
  }

  /** 同一个文件（按 variant 区分同一文件的不同加载方式）只加载一次。 */
  #once<T>(path: string, variant: string, load: (url: URL) => Promise<T>): Promise<T>;
  #once<T>(path: string, load: (url: URL) => Promise<T>): Promise<T>;
  #once<T>(path: string, a: string | ((url: URL) => Promise<T>), b?: (url: URL) => Promise<T>): Promise<T> {
    const [variant, load] = typeof a === 'string' ? [a, b!] : ['', a];
    const url = new URL(path, this.root);
    const key = url.href + variant;
    let pending = this.#cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load(url);
      this.#cache.set(key, pending);
      // 失败的不留在缓存里，下次可以重试
      pending.catch(() => this.#cache.delete(key));
    }
    return pending;
  }

  #json<T>(buffer: ArrayBuffer): T {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  }
}



function unionBounds(all: readonly Bounds[]): Bounds {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const bounds of all) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, bounds.min[c]!);
      max[c] = Math.max(max[c]!, bounds.max[c]!);
    }
  }
  return { min: [min[0]!, min[1]!, min[2]!], max: [max[0]!, max[1]!, max[2]!] };
}

/** 包围盒绕中心放大 factor 倍。 */
function inflate({ min, max }: Bounds, factor: number): Bounds {
  const at = (c: number, sign: number) => (min[c]! + max[c]!) / 2 + (sign * (max[c]! - min[c]!) * factor) / 2;
  return { min: [at(0, -1), at(1, -1), at(2, -1)], max: [at(0, 1), at(1, 1), at(2, 1)] };
}

/** 包围盒每边往外加 margin。 */
function expand({ min, max }: Bounds, margin: number): Bounds {
  return { min: [min[0] - margin, min[1] - margin, min[2] - margin], max: [max[0] + margin, max[1] + margin, max[2] + margin] };
}

/**
 * 视频贴图的源：静音、循环、行内播放的 `<video>`（静音才能不等用户操作就自动播放），第一帧解出来以后交给 GpuResources，
 * 它每来一帧新的画面拷一次。视频按地址边下边放，不先整个读进来。
 */
async function loadVideo(url: URL, srgb: boolean): Promise<TextureData> {
  const video = document.createElement('video');
  Object.assign(video, { muted: true, loop: true, playsInline: true, crossOrigin: 'anonymous', preload: 'auto', src: url.href });
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error(`loading ${url.href}: ${video.error?.message || 'the video cannot be played'}`)), { once: true });
  });
  await video.play().catch((error: unknown) => console.warn(`[stride] ${url.href} did not start playing`, error));
  return { format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', width: video.videoWidth, height: video.videoHeight, levels: [], video };
}

