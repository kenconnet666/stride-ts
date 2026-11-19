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
import { AnimationComponent } from '../animation/AnimationComponent';
import { ModelNodeLink } from '../animation/ModelNodeLink';
import { AnimationClip, Skeleton, type AnimationNative } from '../animation/resources';
import type { EntityManager } from '../engine/EntityManager';
import { resolveSceneValues, SceneScriptBinder, scriptAssetRefs, type SceneScriptMap } from './sceneScripts';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import { Collider, type ColliderShape } from '../physics/Collider';
import { Body, Character, Static } from '../physics/components';
import { CONSTRAINT_COMPONENTS, type ConstraintComponentBase } from '../physics/ConstraintComponent';
import type { ConstraintSettings } from '../physics/Simulation';
import type { ScriptConstructor } from '../engine/scripts';
import { Background, Camera, Instance, Instancing, Light, Model, Skinned, Sprite } from '../rendering/components';
import { ModelMorph, ModelSkeleton } from '../animation/AnimationSystem';
import { Morphed } from '../animation/morphs';
import type { EntityId } from '../data/prop';
import { Material, type MaterialShaderTrees } from '../rendering/Material';
import { Prefab } from './Prefab';
import { SceneTemplate } from './SceneTemplate';
import { Mesh, type Bounds, type MeshData } from '../rendering/Mesh';
import { Cubemap, Skybox } from '../rendering/Skybox';
import { SpriteSheet } from '../rendering/SpriteSheet';
import { SpriteFont } from '../rendering/text/SpriteFont';
import { Texture, type ImageDecoder, type TextureDecoder } from '../rendering/Texture';
import type { AudioEngine } from '../audio/AudioEngine';
import { Sound } from '../audio/Sound';
import type { ParticleModuleClass } from '../particles/modules';
import { ColorTreeCompiler } from '../rendering/colorTree';
import type { ShaderClass } from '../rendering/shaderClass';
import { ParticleSystemComponent } from '../particles/ParticleSystemComponent';
import { UIComponent } from '../ui/UIComponent';
import { UIElementLink } from '../ui/UIElementLink';
import { buildElement, uiAssetPaths, UILibrary, UIPage, type UIResources } from '../ui/UIPage';
import { decodeAnimation, decodeCubemap, decodeGlyphBlock, decodeModel, decodeSkeleton, EXTENSIONS, TEXTURE_EXTENSIONS, vertexLayoutOffsets, type TextureEncoding, type ModelMeshData, type MaterialFile, type PrefabFile, type ColliderShapeFile, type FontFile, type GameSettingsFile, type SceneEntityFile, type SceneFile, type SceneForwardRenderer, type SceneLightShadow, type SceneNavigation, type ScenePhysics, type SceneRenderTexture, type SkyboxFile, type SpriteSheetFile, type TextureRef, type TextureSlot, type SceneUI, type UIFile, type ParticleModuleFile, type SoundFile } from './format';

declare module '../data/prop' {
  interface AssetTypes {
    model: LoadedModel;
    material: Material;
    animation: AnimationClip;
    scene: SceneReference;
    prefab: Prefab;
    font: SpriteFont;
    spriteSheet: SpriteSheet;
    uiPage: UIPage;
    uiLibrary: UILibrary;
    sound: Sound;
  }
}

/** 脚本属性引用的场景（Stride 的 Scene 类型的属性）：只是路径，交给 Game.setRootScene 时才加载。 */
export interface SceneReference {
  readonly path: string;
}

/** loadScene 的选项。 */
export interface LoadSceneOptions {
  /** 场景里的 Stride 脚本类型（带命名空间）显式对应到 TS 脚本；没列的按类名在登记表里找，见 sceneScripts.ts。 */
  readonly scripts?: SceneScriptMap;
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

/** 场景引用的资源，实例化之前并行加载好。 */
interface SceneAssets {
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

export interface SceneInstance {
  readonly name: string;
  /** 按场景文件里的实体 id。 */
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
  /** addModel 建的多余网格的子实体，removeModel 时销毁。 */
  readonly #modelParts = new Map<EntityId, Entity[]>();
  /** 没有材质的网格用它：白色。 */
  readonly defaultMaterial = new Material('default');
  readonly #shaderClasses: (name: string) => ShaderClass | undefined;
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
  /** 解码声音；Game 启动时设置（game.audio）。 */
  audio: AudioEngine | undefined;

  constructor({ root = 'content/', read = fetchReader, shaderClass = () => undefined }: ContentOptions = {}) {
    this.#shaderClasses = shaderClass;
    const base = typeof document === 'undefined' ? 'file:///' : document.baseURI;
    this.root = new URL(root, base);
    this.#read = read;
  }

  loadModel(path: string): Promise<LoadedModel> {
    return this.#once(path + EXTENSIONS.model, async (url) => {
      const data = decodeModel(await this.#read(url), url.href);
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
        ({ texture: await this.#loadTextureRef(ref, srgb), scale, offset, sampler: { ...(filter ? { filter } : {}), ...(addressU ? { addressU } : {}), ...(addressV ? { addressV } : {}) } });
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
        ...(file.roughness === undefined ? {} : { roughness: file.roughness }),
        ...(glossinessTexture ? { glossinessMap: { ...glossinessTexture, channel: file.glossinessTexture!.channel, invert: file.glossinessTexture!.invert } } : {}),
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
  async #shaderTrees({ emissiveTree: emissive, normalTree: normal, displacementTree: displacement, layers = [] }: MaterialFile): Promise<MaterialShaderTrees | undefined> {
    if (!emissive && !normal && !displacement && layers.length === 0) return undefined;
    const layerTrees = layers.flatMap((l) => [l.blend, l.diffuse, l.specular?.color, l.specular?.intensity, l.metalness, l.glossiness?.tree, l.normal?.tree, l.emissive?.tree]);
    const refs = [emissive?.tree, normal?.tree, displacement?.tree, ...layerTrees].flatMap((t) => (t ? particleTextures(t) : []));
    const textures = new Map(await Promise.all(refs.map(async (ref) => [ref.texture, await this.#loadTextureRef(ref, ref.srgb ?? true)] as const)));
    const compiler = new ColorTreeCompiler({ texture: (path) => textures.get(path), shaderClass: (name) => this.#shaderClasses(name) }, 3);
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
      ]),
    ];
    return {
      code: compiler.declarations + functions.filter(Boolean).join(''),
      textures: compiler.textures,
      ...(emissive ? { emissive: { intensity: emissive.intensity, useAlpha: emissive.useAlpha } } : {}),
      ...(normal ? { normal: { scaleAndBias: normal.scaleAndBias, isXYNormal: normal.isXYNormal } } : {}),
      ...(displacement ? { displacement: { intensity: displacement.intensity, scaleAndBias: displacement.scaleAndBias } } : {}),
      ...(layers.length > 0 ? {
        layers: layers.map((layer) => ({
          diffuse: layer.diffuse !== undefined, specular: layer.specular !== undefined, metalness: layer.metalness !== undefined,
          emissive: layer.emissive !== undefined,
          ...(layer.glossiness ? { glossiness: { invert: layer.glossiness.invert } } : {}),
          ...(layer.normal ? { normal: { scaleAndBias: layer.normal.scaleAndBias, isXYNormal: layer.normal.isXYNormal } } : {}),
        })),
      } : {}),
    };
  }

  loadCubemap(path: string): Promise<Cubemap> {
    return this.#once(path + EXTENSIONS.cubemap, async (url) => new Cubemap(path, decodeCubemap(await this.#read(url), url.href)));
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
      const sprites = await Promise.all(file.sprites.map(async ({ texture, region, ...sprite }) => ({ ...sprite, region: [...region] as [number, number, number, number], texture: await this.#loadTextureRef(texture, true) })));
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
      Promise.all(paths.textures.map(async (value) => 'texture' in value ? [value.texture.texture, await this.#loadTextureRef(value.texture, true)] as const : undefined)),
    ]);
    return { file, resources: { spriteSheets, fonts, textures: new Map(textures.filter((entry) => entry !== undefined)) } };
  }

  /** 加载单独引用的贴图资源（脚本属性、合成器渲染器引用的）：先读它的 TextureRef，再按里面的编码和 sRGB 读贴图。 */
  loadTextureAsset(path: string): Promise<Texture> {
    return this.#once(path + EXTENSIONS.texture, async (url) => {
      const ref = this.#json<TextureRef>(await this.#read(url));
      return this.#loadTextureRef(ref, ref.srgb ?? true);
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
      const loaders: Readonly<Record<string, (p: string) => Promise<object>>> = {
        model: (p) => this.loadModel(p), material: (p) => this.loadMaterial(p), animation: (p) => this.loadAnimation(p),
        prefab: (p) => this.loadPrefab(p), font: (p) => this.loadFont(p), texture: (p) => this.loadTextureAsset(p),
        spriteSheet: (p) => this.loadSpriteSheet(p), scene: (p) => Promise.resolve({ path: p } satisfies SceneReference),
      };
      const loaded = new Map<string, object>(await Promise.all(refs.map(async ({ kind, path: assetPath }) => {
        const load = loaders[kind];
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
  loadSound(path: string): Promise<Sound> {
    return this.#once(path + EXTENSIONS.sound, async (url) => {
      const file = this.#json<SoundFile>(await this.#read(url));
      const audio = this.audio;
      if (!audio) throw new Error(`loading ${url.href}: sounds need an audio engine (Game sets one when it starts)`);
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
    const created = this.#instantiate(scene.entities, assets, entities, options, path, scene.offset);
    const compositor = scene.compositor && {
      ...scene.compositor,
      textureCameras: (scene.compositor.textureCameras ?? []).map(({ texture, ...camera }) => ({ ...camera, texture: this.renderTexture(texture) })),
    };
    return { name: scene.name, entities: created, ...(scene.physics ? { physics: scene.physics } : {}), ...(scene.navigation ? { navigation: scene.navigation } : {}), ...(compositor ? { compositor } : {}) };
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
      const scene = this.#json<SceneFile>(await this.#read(url));
      return { scene, assets: await this.#preloadAssets(scene.entities, url) };
    });
  }

  /**
   * 把场景当模板加载（见 SceneTemplate）：场景文件和它引用的资源加载好，不建实体；模板实体实例化时脚本按 options 对应，同 loadScene。
   */
  loadSceneTemplate(path: string, options: LoadSceneOptions = {}): Promise<SceneTemplate> {
    return this.#once(path + EXTENSIONS.scene, 'template', async () => {
      const { scene, assets } = await this.#sceneWithAssets(path);
      return new SceneTemplate(path, scene.entities, (files, name) => new Prefab(name, (entities) => {
        const created = this.#instantiate(files, assets, entities, options, name);
        return [created.get(files[0]!.id)!];
      }));
    });
  }

  /** 加载预制体：引用的资源先加载好，实例化时才建实体（见 Prefab）。实例化时脚本按 options 对应，同 loadScene。 */
  loadPrefab(path: string, options: LoadSceneOptions = {}): Promise<Prefab> {
    return this.#once(path + EXTENSIONS.prefab, async (url) => {
      const file = this.#json<PrefabFile>(await this.#read(url));
      const assets = await this.#preloadAssets(file.entities, url);
      const roots = file.entities.filter((entity) => entity.parent === null).map((entity) => entity.id);
      return new Prefab(file.name, (entities) => {
        const created = this.#instantiate(file.entities, assets, entities, options, path);
        return roots.map((id) => created.get(id)!);
      });
    });
  }

  /** 实体文件引用的资源（包括脚本属性引用的）并行加载好。 */
  async #preloadAssets(files: readonly SceneEntityFile[], url: URL): Promise<SceneAssets> {
    const components = files.map((e) => e.components);
    const colliderModels = components.flatMap((c) => [...(c.static?.shapes ?? []), ...(c.character?.shapes ?? []), ...(c.body?.shapes ?? [])])
      .flatMap((s) => (s.type === 'mesh' || s.type === 'convexHull' ? [s.model] : []));
    const scriptAssets = scriptAssetRefs(components.flatMap((c) => c.scripts ?? []));
    const unsupported = scriptAssets.find((ref) => !SCRIPT_ASSET_KINDS.has(ref.kind));
    if (unsupported) throw new Error(`${url.href}: script properties referring to ${unsupported.kind} assets are not supported yet (${unsupported.path})`);
    const scriptPaths = (kind: string) => scriptAssets.filter((ref) => ref.kind === kind).map((ref) => ref.path);
    const [models, materials, animations, skyboxes, cubemaps, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds] = await Promise.all([
      preload([...components.flatMap((c) => (c.model ? [c.model.model] : [])), ...colliderModels, ...scriptPaths('model')], (p) => this.loadModel(p)),
      preload([...components.flatMap((c) => (c.model?.materials ?? []).filter((m): m is string => m !== null)), ...scriptPaths('material')], (p) => this.loadMaterial(p)),
      preload([...components.flatMap((c) => (c.animation?.animations ?? []).map((a) => a.clip)), ...scriptPaths('animation')], (p) => this.loadAnimation(p)),
      preload(components.flatMap((c) => (c.light?.type === 'skybox' ? [c.light.skybox] : [])), (p) => this.loadSkybox(p)),
      preload(components.flatMap((c) => (c.background?.type === 'cubemap' ? [c.background.texture] : [])), (p) => this.loadCubemap(p)),
      preload(scriptPaths('prefab'), (p) => this.loadPrefab(p)),
      preload([...components.flatMap((c) => (c.sprite && 'sheet' in c.sprite ? [c.sprite.sheet] : [])), ...scriptPaths('spriteSheet')], (p) => this.loadSpriteSheet(p)),
      preload(scriptPaths('font'), (p) => this.loadFont(p)),
      preload(scriptPaths('texture'), (p) => this.loadTextureAsset(p)),
      preload([...components.flatMap((c) => (c.ui?.page ? [c.ui.page] : [])), ...scriptPaths('uiPage')], (p) => this.loadUIPage(p)),
      preload(scriptPaths('uiLibrary'), (p) => this.loadUILibrary(p)),
      preload(scriptPaths('sound'), (p) => this.loadSound(p)),
    ]);
    // 背景的平面图片和精灵的贴图按 sRGB 读（同 Stride 的颜色贴图）；渲染目标贴图按路径建一次
    const imageRefs = components.flatMap((c) => [
      ...(c.background?.type === '2d' ? [c.background.image] : []), ...(c.sprite && 'texture' in c.sprite ? [c.sprite.texture] : []),
      ...(c.particleSystem ? particleTextures(c.particleSystem) : []),
    ]);
    const images = new Map(await Promise.all(imageRefs.map(async (ref) => 'renderTexture' in ref
      ? [ref.renderTexture, this.renderTexture(ref)] as const
      : [ref.texture, await this.#loadTextureRef(ref, true)] as const)));
    return { models, materials, animations, skyboxes, cubemaps, images, prefabs, spriteSheets, fonts, textures, uiPages, uiLibraries, sounds };
  }

  /**
   * 按实体文件建实体：先按顺序建实体和组件（父实体在前），再挂实例的主实体，最后挂脚本（这时所有实体都在，脚本属性里的
   * 实体引用才解析得了）。返回按文件里的实体 id 的表；where 用在报错和警告里。
   */
  #instantiate(files: readonly SceneEntityFile[], assets: SceneAssets, entities: EntityManager, options: LoadSceneOptions, where: string, offset?: readonly [number, number, number]): Map<string, Entity> {
    const created = new Map<string, Entity>();
    for (const file of files) {
      // 场景的偏移（Stride 的 Scene.Offset）加在根实体上
      const position = offset && file.parent === null ? file.position.map((value, i) => value + offset[i]!) as unknown as typeof file.position : file.position;
      const entity = entities.create({ name: file.name, components: [Transform.with({ position, rotation: file.rotation, scale: file.scale })] });
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
    else if (light?.type === 'point') entity.add(Light.with({ type: 'point', color: [...light.color, 1], intensity: light.intensity, radius: light.radius }));
    else if (light?.type === 'spot') {
      const { range, angleInner, angleOuter } = light;
      entity.add(Light.with({ type: 'spot', color: [...light.color, 1], intensity: light.intensity, range, angleInner, angleOuter }));
    } else if (light) entity.add(Light.with({ type: light.type, color: [...light.color, 1], intensity: light.intensity, ...(light.shadow ? shadowColumns(light.shadow) : {}) }));
    if (background?.type === 'cubemap') entity.add(Background.with({ texture: assets.cubemaps.get(background.texture)!.id, intensity: background.intensity }));
    else if (background) entity.add(Background.with({ image: assets.images.get(background.image.texture)!.id, intensity: background.intensity }));
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
    this.addModel(entity, assets.models.get(model.model)!, { materials: overrides, isShadowCaster: model.isShadowCaster ?? true });
  }

  /**
   * 给实体挂上加载好的模型（Stride 的 `new ModelComponent(model)`）：第一个网格挂在实体上，多出来的网格挂成子实体（一个实体只能
   * 有一个 Model），有骨架的接上动画。materials 按模型的材质槽覆盖（null 是用模型自带的）。
   */
  addModel(entity: Entity, loaded: LoadedModel, { materials = [], isShadowCaster = true }: { materials?: readonly (Material | null)[]; isShadowCaster?: boolean } = {}): void {
    const entities = entity.manager;
    if (entity.get(Model)) throw new Error(`entity '${entity.name}' already has a model; removeModel it first`);
    const skinned: { entity: Entity; skin: NativeSkin }[] = [];
    const morphed: Entity[] = [];
    const parts: Entity[] = [];
    loaded.meshes.forEach(({ mesh, material: slot, skin }, i) => {
      // 材质：实体按槽覆盖的，否则模型自带的，都没有时用默认材质
      const material = (slot === null ? null : (materials[slot] ?? loaded.materials[slot])) ?? this.defaultMaterial;
      const component = Model.with({ mesh: mesh.id, material: material.id, isShadowCaster });
      let part = entity;
      if (i === 0) entity.add(component);
      else {
        part = entities.create({ name: `${entity.name}/${mesh.name}`, components: [Transform, component] });
        part.require(Transform).parent = entity;
        parts.push(part);
      }
      if (skin) skinned.push({ entity: part, skin });
      if (mesh.data.morph) morphed.push(part);
    });
    if (loaded.skeleton) entities.game.animation.attach(entity, loaded.skeleton, skinned);
    if (loaded.morphTargets) entities.game.animation.attachMorphs(entity, loaded.morphTargets, morphed);
    if (parts.length > 0) this.#modelParts.set(entity.id, parts);
  }

  /**
   * 去掉 addModel 挂上的模型：多出来的网格子实体、实体上的网格、骨架和形变权重（Stride 里给 ModelComponent.Model 换模型时
   * 旧的这些都跟着换掉）。之后可以再 addModel。
   */
  removeModel(entity: Entity): void {
    for (const part of this.#modelParts.get(entity.id) ?? []) part.destroy();
    this.#modelParts.delete(entity.id);
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

  /** defaultSrgb：引用里没写 srgb 时按用途定。 */
  #loadTextureRef({ texture, encoding = 'ktx2', size, srgb }: TextureRef, defaultSrgb: boolean): Promise<Texture> {
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

/** 场景文件里的碰撞形状换成 Collider 的形状：网格形状引用模型加载出来的全部网格。 */
function colliderShape(shape: ColliderShapeFile, assets: SceneAssets): ColliderShape {
  const { position, rotation, mass } = shape;
  if (shape.type === 'mesh') return { type: 'mesh', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), position, rotation, mass };
  if (shape.type === 'convexHull') return { type: 'convexHull', meshes: assets.models.get(shape.model)!.meshes.map(({ mesh }) => mesh), hull: shape.hull, position, rotation, mass };
  return shape;
}

/** 脚本属性能引用的资源种类（model、material、animation、prefab 加载场景时预先加载，scene 只给路径）。 */
const SCRIPT_ASSET_KINDS: ReadonlySet<string> = new Set(['model', 'material', 'animation', 'scene', 'prefab', 'font', 'texture', 'spriteSheet', 'uiPage', 'uiLibrary', 'sound']);

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

/** 并行加载一组（去重的）路径，结果按路径放进 Map。 */
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

/** 粒子系统里引用的贴图（材质的 ComputeTextureColor 这些）。 */
function particleTextures(module: ParticleModuleFile): TextureRef[] {
  const found: TextureRef[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof (value as TextureRef).texture === 'string' && !('$type' in value)) found.push(value as TextureRef);
      else Object.values(value).forEach(visit);
    }
  };
  visit(module);
  return found;
}

async function preload<T>(paths: readonly string[], load: (path: string) => Promise<T>): Promise<Map<string, T>> {
  return new Map(await Promise.all([...new Set(paths)].map(async (path) => [path, await load(path)] as const)));
}

/** 场景文件里的阴影设置换成 Light 组件的列。 */
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
