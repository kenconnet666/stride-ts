/**
 * 内容管理（对应 Stride 的 ContentManager）：按内容路径加载资源管线产出的模型、材质、贴图、立方体贴图、天空盒、场景（格式见 format.ts），
 * 同一个路径只加载一次（缓存的是 Promise，并发请求也只发一次），并把场景实例化成实体。
 *
 *   const scene = await game.content.loadScene('scenes/MainScene');
 *   scene.entities.get(id);
 *
 * 引用计数、卸载、按组加载、在 Worker 里解码（README 的"实例化、懒加载、缓存"）以后加。
 */
import type { EntityManager } from '../engine/EntityManager';
import type { Entity } from '../engine/Entity';
import { Transform } from '../engine/transform';
import { Background, Camera, Light, Model } from '../rendering/components';
import { Material } from '../rendering/Material';
import { Mesh, type MeshData } from '../rendering/Mesh';
import { Cubemap, Skybox } from '../rendering/Skybox';
import { Texture, type ImageDecoder, type TextureDecoder } from '../rendering/Texture';
import { decodeCubemap, decodeModel, EXTENSIONS, TEXTURE_EXTENSIONS, vertexLayoutOffsets, type TextureEncoding, type ModelMeshData, type MaterialFile, type SceneEntityFile, type SceneFile, type SceneLightShadow, type SkyboxFile } from './format';

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
}

/** 加载好的模型：网格和材质槽（模型自带的材质，没有的槽是 null）。 */
export interface LoadedModel {
  readonly meshes: readonly { readonly mesh: Mesh; readonly material: number | null }[];
  readonly materials: readonly (Material | null)[];
}

/** 场景引用的资源，实例化之前并行加载好。 */
interface SceneAssets {
  readonly models: ReadonlyMap<string, LoadedModel>;
  readonly materials: ReadonlyMap<string, Material>;
  readonly skyboxes: ReadonlyMap<string, Skybox>;
  readonly cubemaps: ReadonlyMap<string, Cubemap>;
}

export interface SceneInstance {
  readonly name: string;
  /** 按场景文件里的实体 id。 */
  readonly entities: ReadonlyMap<string, Entity>;
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
  /** 没有材质的网格用它：白色。 */
  readonly defaultMaterial = new Material('default');
  /**
   * 把 KTX2 贴图转码成设备支持的格式；加载了原生的 texture 功能时，Game 在图形设备建好之后设置（ktx2Decoder），
   * 测试里可以换成假的。
   */
  textureDecoder: TextureDecoder | undefined;
  /** 把 SVG、PNG、JPEG 贴图解成 RGBA8；Game 启动时设置（browserImageDecoder），测试里可以换成假的。 */
  imageDecoder: ImageDecoder | undefined;
  /** 解码 meshopt 压缩的模型；Game 启动时设置（原生模块的 decodeMeshoptBatch，各个流在原生线程里并行解）。 */
  meshoptDecoder: MeshoptDecoder | undefined;

  constructor({ root = 'content/', read = fetchReader }: ContentOptions = {}) {
    const base = typeof document === 'undefined' ? 'file:///' : document.baseURI;
    this.root = new URL(root, base);
    this.#read = read;
  }

  loadModel(path: string): Promise<LoadedModel> {
    return this.#once(path + EXTENSIONS.model, async (url) => {
      const data = decodeModel(await this.#read(url), url.href);
      const [meshes, materials] = await Promise.all([
        this.#decodeMeshes(data.meshes, url),
        Promise.all(data.materials.map((material) => (material === null ? null : this.loadMaterial(material)))),
      ]);
      return {
        meshes: data.meshes.map((mesh, i) => ({ mesh: new Mesh(`${path}/${mesh.name}`, meshes[i]!), material: mesh.material })),
        materials,
      };
    });
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
      return { vertices, indices, layout: mesh.layout, dequantize: mesh.dequantize };
    });
  }

  loadMaterial(path: string): Promise<Material> {
    return this.#once(path + EXTENSIONS.material, async (url) => {
      const file = this.#json<MaterialFile>(await this.#read(url));
      const slot = file.baseColorTexture;
      return new Material(file.name, {
        baseColor: file.baseColor,
        ...(slot ? { baseColorTexture: { texture: await this.loadTexture(slot.texture, { encoding: slot.encoding ?? 'ktx2', srgb: true, ...(slot.size ? { size: slot.size } : {}) }), scale: slot.scale, offset: slot.offset } } : {}),
        ...(file.baseColorOperator ? { baseColorOperator: file.baseColorOperator } : {}),
        ...(file.metalness === undefined ? {} : { metalness: file.metalness }),
        ...(file.roughness === undefined ? {} : { roughness: file.roughness }),
        ...(file.emissive ? { emissive: file.emissive } : {}),
        ...(file.cavity ? { cavity: file.cavity } : {}),
      });
    });
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
   * 加载贴图。ktx2 交给 textureDecoder 转码；svg、png、jpeg 交给 imageDecoder（srgb 决定格式，svg 按 size 栅格化）。
   * 同一个文件只加载一次。
   */
  loadTexture(path: string, { encoding = 'ktx2', srgb = true, size }: { encoding?: TextureEncoding; srgb?: boolean; size?: readonly [number, number] } = {}): Promise<Texture> {
    return this.#once(path + TEXTURE_EXTENSIONS[encoding], async (url) => {
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

  /** 加载场景并把它的实体创建在 entities 里（场景引用的模型、材质、天空盒、立方体贴图先并行加载完）。 */
  async loadScene(path: string, entities: EntityManager): Promise<SceneInstance> {
    const url = new URL(path + EXTENSIONS.scene, this.root);
    const scene = this.#json<SceneFile>(await this.#read(url));
    const components = scene.entities.map((e) => e.components);
    const [models, materials, skyboxes, cubemaps] = await Promise.all([
      preload(components.flatMap((c) => (c.model ? [c.model.model] : [])), (p) => this.loadModel(p)),
      preload(components.flatMap((c) => (c.model?.materials ?? []).filter((m): m is string => m !== null)), (p) => this.loadMaterial(p)),
      preload(components.flatMap((c) => (c.light?.type === 'skybox' ? [c.light.skybox] : [])), (p) => this.loadSkybox(p)),
      preload(components.flatMap((c) => (c.background ? [c.background.texture] : [])), (p) => this.loadCubemap(p)),
    ]);
    const assets: SceneAssets = { models, materials, skyboxes, cubemaps };

    const created = new Map<string, Entity>();
    for (const file of scene.entities) {
      const entity = entities.create({ name: file.name, components: [Transform.with({ position: file.position, rotation: file.rotation, scale: file.scale })] });
      if (file.parent !== null) {
        const parent = created.get(file.parent);
        if (!parent) throw new Error(`${url.href}: entity '${file.name}' comes before its parent ${file.parent}`);
        entity.require(Transform).parent = parent;
      }
      created.set(file.id, entity);
      this.#addComponents(entity, file, assets, entities);
    }
    return { name: scene.name, entities: created };
  }

  #addComponents(entity: Entity, file: SceneEntityFile, assets: SceneAssets, entities: EntityManager): void {
    const { model, camera, light, background } = file.components;
    const { materials } = assets;
    if (camera) entity.add(Camera.with(camera));
    if (light?.type === 'skybox') entity.add(Light.with({ type: 'skybox', skybox: assets.skyboxes.get(light.skybox)!.id, intensity: light.intensity }));
    else if (light) entity.add(Light.with({ type: light.type, color: [...light.color, 1], intensity: light.intensity, ...(light.shadow ? shadowColumns(light.shadow) : {}) }));
    if (background) entity.add(Background.with({ texture: assets.cubemaps.get(background.texture)!.id, intensity: background.intensity }));
    if (!model) return;
    const loaded = assets.models.get(model.model)!;
    loaded.meshes.forEach(({ mesh, material: slot }, i) => {
      // 材质：实体按槽覆盖的，否则模型自带的，都没有时用默认材质
      const override = slot === null ? null : (model.materials[slot] ?? null);
      const material = (override === null ? null : materials.get(override)) ?? (slot === null ? null : loaded.materials[slot]) ?? this.defaultMaterial;
      const component = Model.with({ mesh: mesh.id, material: material.id, isShadowCaster: model.isShadowCaster ?? true });
      // 一个实体只能有一个 Model：多出来的网格挂成子实体
      if (i === 0) {
        entity.add(component);
        return;
      }
      const part = entities.create({ name: `${file.name}/${mesh.name}`, components: [Transform, component] });
      part.require(Transform).parent = entity;
    });
  }

  #once<T>(path: string, load: (url: URL) => Promise<T>): Promise<T> {
    const url = new URL(path, this.root);
    let pending = this.#cache.get(url.href) as Promise<T> | undefined;
    if (!pending) {
      pending = load(url);
      this.#cache.set(url.href, pending);
      // 失败的不留在缓存里，下次可以重试
      pending.catch(() => this.#cache.delete(url.href));
    }
    return pending;
  }

  #json<T>(buffer: ArrayBuffer): T {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  }
}

/** 并行加载一组（去重的）路径，结果按路径放进 Map。 */
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
