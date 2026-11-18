/**
 * 把 Stride 工程的场景导入成运行时内容（格式见 @stride-ts/engine 的 content/format.ts）：场景里的实体、
 * 变换和父子关系，ModelComponent 引用的模型（源 FBX/glTF 经 stride-tools 导入）、材质和贴图（源图片解码后
 * 编成 KTX2 加 Basis），相机，光源（天空盒光的球谐同 Stride 的 SkyboxGenerator，镜面的预滤波在运行时做），背景。
 * 现在不认识的组件（物理、脚本、动画）跳过并计数，后面的里程碑逐个接上。
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StrideTools } from '@stride-ts/native/tools';
import {
  EXTENSIONS,
  encodeCubemap,
  encodeModel,
  plainMesh,
  VERTEX_FLOATS,
  type ColliderShapeFile,
  type ColorOperator,
  type MaterialFile,
  type ModelMeshData,
  type NormalMapSlot,
  type SceneCharacter,
  type SceneAssetKind,
  type SceneCollidable,
  type SceneEntityFile,
  type SceneBody,
  type SceneRenderTexture,
  type SceneSprite,
  type SpriteBlend,
  type SceneFile,
  type SceneLightShadow,
  type ScenePhysics,
  type SceneScript,
  type SceneScriptValue,
  type SkyboxFile,
  TEXTURE_EXTENSIONS,
  type TextureEncoding,
  type TextureSampler,
  type TextureSlot,
  type Vec3Tuple,
} from '@stride-ts/engine/content-format';
import { readDdsCubemap, regenerateMips, toRgb9e5, type FloatCubemap } from '../hdr.ts';
import { addTangents, compressMeshes, type SourceMesh } from '../mesh.ts';
import { importCompositor } from './compositor.ts';
import { proceduralMesh } from './procedural.ts';
import { importAnimation, importMatrix, importSkeleton, meshSkin, type AnimationImportContext, type ImportedSkeleton } from './animation.ts';
import { importTransform, sourceOf, type AssetEntry, type StrideProject } from './project.ts';
import { asNumber, asObject, dictionaryKey, parseAssetReference, parseObjectReference, type StrideObject, type StrideValue } from './yaml.ts';

export interface ImportResult {
  /** 场景的内容路径。 */
  readonly scene: string;
  readonly entities: number;
  readonly models: readonly string[];
  readonly materials: readonly string[];
  /** 贴图和立方体贴图。 */
  readonly textures: readonly string[];
  readonly skyboxes: readonly string[];
  /** 跳过的组件类型和个数。 */
  readonly skipped: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}

export interface ImporterOptions {
  /** 天空盒镜面光照的立方体贴图边长（2 的幂），默认 256，同 Stride 的 SkyboxAsset.SpecularCubeMapSize；运行时按它生成。 */
  readonly specularCubemapSize?: number;
  /**
   * 导出不压缩的内容，方便查看和调试：模型是 32 字节的 float 顶点、不用 meshopt。默认 false：量化加 meshopt
   * （见 ../mesh.ts）。运行时两种都能读。
   */
  readonly plain?: boolean;
  /**
   * 覆盖目录：`<目录>/<内容路径>.svg`（或 .png、.jpg）存在时，用它代替资源的源图片，原样导出（SVG 是矢量，下载最小）。
   * Stride 仓库只读，换成矢量版之类的改动放在这里。
   */
  readonly overrides?: string;
  /**
   * 没有覆盖文件的贴图怎么导出：ktx2（默认，Basis 压缩，显存最省）、source（源文件是 PNG/JPEG 时原样复制，
   * 浏览器解码）、smallest（两者取下载小的）。
   */
  readonly textureEncoding?: 'ktx2' | 'source' | 'smallest';
}

/** 导出的贴图：内容路径、编码，svg 带上栅格化尺寸。 */
interface ImportedTexture {
  readonly texture: string;
  readonly encoding: TextureEncoding;
  readonly size?: readonly [number, number];
  /** 按 sRGB 采样（Stride 的贴图类型决定）。 */
  readonly srgb: boolean;
}

const SOURCE_ENCODINGS: Readonly<Record<string, TextureEncoding>> = { '.svg': 'svg', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' };

const srgbToLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

type Components = { -readonly [K in keyof SceneEntityFile['components']]: SceneEntityFile['components'][K] };

export class StrideImporter {
  readonly #project: StrideProject;
  readonly #tools: StrideTools;
  readonly #out: string;
  readonly #options: Required<ImporterOptions>;
  readonly #models = new Map<string, Promise<string>>();
  readonly #materials = new Map<string, Promise<string>>();
  readonly #textures = new Map<string, Promise<ImportedTexture>>();
  readonly #cubemaps = new Map<string, Promise<string>>();
  readonly #skyboxes = new Map<string, Promise<string>>();
  readonly #skeletons = new Map<string, Promise<ImportedSkeleton>>();
  readonly #animations = new Map<string, Promise<string>>();
  /** 解码过的 HDR 立方体贴图源文件：天空盒光照和背景常用同一张。 */
  readonly #hdrSources = new Map<string, Promise<FloatCubemap>>();
  readonly #skipped = new Map<string, number>();
  readonly #warnings: string[] = [];
  readonly #materialFiles = new Map<string, Promise<MaterialFile>>();
  /** 正在导入的场景里，组件和实体的 Id 对应的实体 Id（脚本属性里的 ref!! 引用用）。 */
  #owners = new Map<string, string>();
  /** 正在导入的场景用的图形合成器里，相机槽位的 Id 对应的下标（Camera.slot）。 */
  #cameraSlots: ReadonlyMap<string, number> = new Map();

  /** out：内容根目录，导出的文件按内容路径放在下面。 */
  constructor(project: StrideProject, tools: StrideTools, out: string, { specularCubemapSize = 256, plain = false, overrides = '', textureEncoding = 'ktx2' }: ImporterOptions = {}) {
    this.#project = project;
    this.#tools = tools;
    this.#out = out;
    this.#options = { specularCubemapSize, plain, overrides, textureEncoding };
  }

  async importScene(asset: AssetEntry): Promise<ImportResult> {
    if (asset.type !== 'SceneAsset') throw new Error(`${asset.file} is a ${asset.type}, not a scene`);
    const parts = asset.data['Hierarchy'] && asObject(asset.data['Hierarchy'])?.['Parts'];
    if (!Array.isArray(parts)) throw new Error(`${asset.file}: no Hierarchy.Parts`);

    const entities = parts.map((part) => asObject(asObject(part)?.['Entity'])).filter((e): e is StrideObject => e !== undefined);
    // 父子关系写在父实体 Transform 的 Children 里，引用的是子实体 Transform 组件的 Id
    const entityOfTransform = new Map<string, string>();
    for (const entity of entities) {
      const transform = componentOf(entity, 'TransformComponent');
      if (transform && typeof transform['Id'] === 'string') entityOfTransform.set(transform['Id'], entity['Id'] as string);
    }
    const parentOf = new Map<string, string>();
    for (const entity of entities) {
      const children = asObject(componentOf(entity, 'TransformComponent')?.['Children']) ?? {};
      for (const ref of Object.values(children)) {
        const child = entityOfTransform.get(parseObjectReference(ref) ?? '');
        if (child) parentOf.set(child, entity['Id'] as string);
      }
    }

    this.#owners = new Map();
    for (const entity of entities) {
      this.#owners.set(entity['Id'] as string, entity['Id'] as string);
      for (const component of Object.values(asObject(entity['Components']) ?? {})) {
        const id = asObject(component)?.['Id'];
        if (typeof id === 'string') this.#owners.set(id, entity['Id'] as string);
      }
    }
    const compositor = importCompositor(this.#compositorOf(asset), (id) => {
      const texture = this.#project.get(id, asset.file);
      return texture.type === 'RenderTexture' ? renderTextureOf(texture) : undefined;
    });
    this.#cameraSlots = compositor.cameraSlots;
    const files = await Promise.all(entities.map((entity) => this.#entity(entity, parentOf.get(entity['Id'] as string) ?? null, asset)));
    const usesPhysics = files.some((file) => file.components.static || file.components.character || file.components.body);
    const scene: SceneFile = {
      name: path.basename(asset.path),
      ...(usesPhysics ? { physics: this.#physicsSettings(asset) } : {}),
      ...(compositor.main ? { compositor: compositor.main } : {}),
      entities: parentsFirst(files),
    };
    await this.#write(asset.path + EXTENSIONS.scene, JSON.stringify(scene, null, 1));
    return {
      scene: asset.path,
      entities: scene.entities.length,
      models: [...this.#models.keys()],
      materials: [...this.#materials.keys()],
      textures: [...this.#textures.keys(), ...this.#cubemaps.keys()],
      skyboxes: [...this.#skyboxes.keys()],
      skipped: this.#skipped,
      warnings: this.#warnings,
    };
  }

  async #entity(entity: StrideObject, parent: string | null, scene: AssetEntry): Promise<SceneEntityFile> {
    const where = `${scene.file}: entity '${String(entity['Name'])}'`;
    const transform = componentOf(entity, 'TransformComponent') ?? {};
    const components: Components = {};
    for (const component of Object.values(asObject(entity['Components']) ?? {})) {
      const object = asObject(component);
      const type = object?.$type ?? 'unknown';
      if (!object || type === 'TransformComponent') continue;
      if (isScriptType(type)) {
        components.scripts = [...(components.scripts ?? []), await this.#script(type, object, where)];
        continue;
      }
      const handled = await this.#component(type, object, components, where);
      if (!handled) this.#skipped.set(type, (this.#skipped.get(type) ?? 0) + 1);
    }
    return {
      id: entity['Id'] as string,
      name: typeof entity['Name'] === 'string' ? entity['Name'] : '',
      parent,
      position: vec3(transform['Position'], 0),
      rotation: quaternion(transform['Rotation']),
      scale: vec3(transform['Scale'], 1),
      components,
    };
  }

  /** 游戏的脚本组件：类型名去掉程序集，属性名改成小写开头，值按 SceneScriptValue 换过来。 */
  async #script(type: string, component: StrideObject, where: string): Promise<SceneScript> {
    const name = type.slice(0, type.indexOf(','));
    const props: Record<string, SceneScriptValue> = {};
    for (const [key, value] of Object.entries(component)) {
      if (key === 'Id' || key.startsWith('~') || key === '$type') continue;
      props[lowerFirst(key)] = await this.#scriptValue(value, `${where}: ${name}.${key}`);
    }
    return { type: name, props };
  }

  async #scriptValue(value: StrideValue | undefined, where: string): Promise<SceneScriptValue> {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const object = parseObjectReference(value);
      if (object !== undefined) {
        const entity = this.#owners.get(object);
        if (entity === undefined) this.#warnings.push(`${where}: reference ${object} is not in this scene; using null`);
        return entity === undefined ? null : { $entity: entity };
      }
      const reference = parseAssetReference(value);
      if (reference && GUID.test(reference.id)) return this.#scriptAsset(this.#project.get(reference.id, where), where);
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.#scriptValue(item, where)));
    const entries = Object.entries(value).filter(([key]) => key !== '$type');
    // Stride 把列表存成以哈希为键的映射；Vector2、Vector3、Quaternion 存成 X、Y（Z、W）
    if (entries.length > 0 && entries.every(([key]) => /^[0-9a-f]{32}$/.test(key))) return Promise.all(entries.map(([, item]) => this.#scriptValue(item, where)));
    const keys = entries.map(([key]) => key).join(',');
    if (keys === 'X,Y' || keys === 'X,Y,Z' || keys === 'X,Y,Z,W') return entries.map(([, item]) => (typeof item === 'number' ? item : 0));
    const object: Record<string, SceneScriptValue> = {};
    for (const [key, item] of entries) object[lowerFirst(key)] = await this.#scriptValue(item, where);
    return object;
  }

  /** 脚本属性引用的资源：能导入的种类导入并给出内容路径，别的记警告。场景只给路径，不跟着导入（要用 --scene 另外导入）。 */
  async #scriptAsset(asset: AssetEntry, where: string): Promise<SceneScriptValue> {
    const kinds: Record<string, [SceneAssetKind, () => Promise<string>]> = {
      Model: ['model', () => this.#model(asset)],
      MaterialAsset: ['material', () => this.#material(asset)],
      Animation: ['animation', () => this.#animation(asset)],
      SceneAsset: ['scene', () => Promise.resolve(asset.path)],
    };
    const kind = kinds[asset.type];
    if (!kind) {
      this.#warnings.push(`${where}: ${asset.type} ${asset.path} is not supported in script properties; using null`);
      return null;
    }
    return { $asset: await kind[1](), kind: kind[0] };
  }

  /** 把一个组件写进 components；不认识的返回 false。 */
  async #component(type: string, component: StrideObject, components: Components, where: string): Promise<boolean> {
    switch (type) {
      case 'ModelComponent':
        components.model = await this.#modelComponent(component, where);
        return true;
      case 'CameraComponent':
        components.camera = cameraOf(component, this.#cameraSlots);
        return true;
      case 'InstancingComponent':
        if (asObject(component['Type'])?.$type !== 'InstancingEntityTransform') this.#warnings.push(`${where}: instancing ${String(asObject(component['Type'])?.$type)} is not supported; using InstancingEntityTransform`);
        components.instancing = {};
        return true;
      case 'InstanceComponent': {
        // Master 引用的是 InstancingComponent 的 Id，换成它所在的实体
        const master = parseObjectReference(component['Master']);
        const entity = master === undefined ? undefined : this.#owners.get(master);
        if (master !== undefined && entity === undefined) this.#warnings.push(`${where}: instancing master ${master} is not in this scene; using null`);
        components.instance = { master: entity ?? null };
        return true;
      }
      case 'AnimationComponent':
        components.animation = await this.#animationComponent(component, where);
        return true;
      case 'LightComponent': {
        const light = await this.#light(component, where);
        if (light) components.light = light;
        return light !== undefined;
      }
      case 'SpriteComponent': {
        const sprite = await this.#sprite(component, where);
        if (sprite) components.sprite = sprite;
        return sprite !== undefined;
      }
      case 'BackgroundComponent': {
        const texture = parseAssetReference(component['Texture']);
        if (!texture) return false;
        const asset = this.#project.get(texture.id, where);
        const intensity = asNumber(component['Intensity'], 1);
        components.background = component['Is2D'] === true
          ? { type: '2d', image: await this.#texture(asset), intensity }
          : { type: 'cubemap', texture: await this.#cubemap(asset), intensity };
        return true;
      }
      case 'Stride.BepuPhysics.StaticComponent,Stride.BepuPhysics': {
        const collidable = await this.#collidable(component, where);
        if (collidable) components.static = collidable;
        return collidable !== undefined;
      }
      case 'Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics': {
        const body = await this.#body(component, where);
        if (body) components.body = body;
        return body !== undefined;
      }
      case 'Stride.BepuPhysics.CharacterComponent,Stride.BepuPhysics': {
        const character = await this.#character(component, where);
        if (character) components.character = character;
        return character !== undefined;
      }
      default:
        return false;
    }
  }

  /**
   * Stride.BepuPhysics 的 CollidableComponent：碰撞体（CompoundCollider 的各形状，或者 MeshCollider 引用的模型）、
   * 碰撞层和摩擦，默认值同 Stride。没有能用的形状时记警告、返回 undefined。
   */
  async #collidable(component: StrideObject, where: string): Promise<SceneCollidable | undefined> {
    const collider = asObject(component['Collider']);
    const shapes: ColliderShapeFile[] = [];
    const type = colliderType(collider);
    if (type === 'CompoundCollider') {
      for (const child of Object.values(asObject(collider!['Colliders']) ?? {})) {
        const object = asObject(child) ?? {};
        const shape = colliderType(object) === 'ConvexHullCollider' ? await this.#convexHull(object, where) : colliderShape(object);
        if (shape) shapes.push(shape);
        else this.#warnings.push(`${where}: collider ${colliderType(asObject(child))} is not supported; skipping it`);
      }
    } else if (type === 'MeshCollider') {
      const reference = parseAssetReference(collider!['Model']);
      if (!reference) throw new Error(`${where}: MeshCollider has no model`);
      const model = await this.#model(this.#project.get(reference.id, where));
      shapes.push({ type: 'mesh', model, position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: asNumber(collider!['Mass'], 1) });
    } else if (type === 'EmptyCollider') {
      shapes.push({ type: 'empty', position: [0, 0, 0], rotation: [0, 0, 0, 1], mass: 1 });
    } else {
      this.#warnings.push(`${where}: collider ${type} is not supported; skipping the physics component`);
    }
    if (shapes.length === 0) return undefined;
    const layer = /^Layer(\d+)$/.exec(String(component['CollisionLayer'] ?? 'Layer0'));
    const handler = asObject(component['ContactEventHandler'])?.$type;
    const trigger = handler === 'Stride.BepuPhysics.Definitions.Trigger,Stride.BepuPhysics';
    if (handler !== undefined && !trigger) this.#warnings.push(`${where}: contact event handler ${handler} is not supported; ignored (scripts can set one with simulation.setContactHandler)`);
    return { shapes, layer: layer ? Number(layer[1]) : 0, friction: asNumber(component['FrictionCoefficient'], 1), ...(trigger ? { trigger } : {}) };
  }

  /** Stride.BepuPhysics 的 BodyComponent：碰撞体加刚体的设置，默认值同 Stride。 */
  async #body(component: StrideObject, where: string): Promise<SceneBody | undefined> {
    const collidable = await this.#collidable(component, where);
    if (!collidable) return undefined;
    return {
      ...collidable,
      kinematic: component['Kinematic'] === true,
      gravity: component['Gravity'] !== false,
      sleepThreshold: asNumber(component['SleepThreshold'], 0.01),
      interpolated: component['InterpolationMode'] === 'Interpolated',
    };
  }

  /** Stride 的 ConvexHullCollider：引用的 HullAsset 由模型的顶点算（不做分解），带上它的缩放、旋转、偏移。 */
  async #convexHull(collider: StrideObject, where: string): Promise<ColliderShapeFile | undefined> {
    const reference = parseAssetReference(collider['Hull']);
    if (!reference) return undefined;
    const hull = this.#project.get(reference.id, where);
    if (asObject(hull.data['Decomposition'])?.['Enabled'] === true) this.#warnings.push(`${hull.file}: convex decomposition is not supported yet; using one hull`);
    const model = parseAssetReference(hull.data['Model']);
    if (!model) throw new Error(`${hull.file}: the hull has no model`);
    return {
      type: 'convexHull',
      model: await this.#model(this.#project.get(model.id, hull.file)),
      hull: { scale: vec3(hull.data['Scaling'], 1), rotation: quaternion(hull.data['LocalRotation']), offset: vec3(hull.data['LocalOffset'], 0) },
      position: vec3(collider['PositionLocal'], 0),
      rotation: quaternion(collider['RotationLocal']),
      mass: asNumber(collider['Mass'], 1),
    };
  }

  /** Stride.BepuPhysics 的 CharacterComponent：碰撞体加角色参数，默认值同 Stride。 */
  async #character(component: StrideObject, where: string): Promise<SceneCharacter | undefined> {
    const collidable = await this.#collidable(component, where);
    if (!collidable) return undefined;
    return {
      ...collidable,
      speed: asNumber(component['Speed'], 10),
      // JumpForce 的数据别名是 JumpSpeed
      jumpForce: asNumber(component['JumpForce'] ?? component['JumpSpeed'], 10),
      maximumHorizontalForce: asNumber(component['MaximumHorizontalForce'], 200),
      maximumVerticalForce: asNumber(component['MaximumVerticalForce'], 1000),
      slopeAngle: asNumber(component['SlopeAngle'], 50),
      airControlForceScale: asNumber(component['AirControlForceScale'], 0.2),
      airControlScale: asNumber(component['AirControlScale'], 0.2),
      gravity: component['Gravity'] !== false,
      interpolated: component['InterpolationMode'] === 'Interpolated',
    };
  }

  /** Stride 的 SpriteComponent：现在只支持 SpriteFromTexture（贴图或渲染目标贴图）。 */
  async #sprite(component: StrideObject, where: string): Promise<SceneSprite | undefined> {
    const provider = asObject(component['SpriteProvider']);
    if (provider?.$type !== 'SpriteFromTexture') {
      this.#warnings.push(`${where}: sprite provider ${provider?.$type ?? 'null'} is not supported yet; the sprite is skipped`);
      return undefined;
    }
    const reference = parseAssetReference(provider['Texture']);
    if (!reference) return undefined;
    if (component['Swizzle'] !== undefined && component['Swizzle'] !== 'None') this.#warnings.push(`${where}: sprite swizzle is not supported yet; ignored`);
    const asset = this.#project.get(reference.id, where);
    return {
      texture: asset.type === 'RenderTexture' ? renderTextureOf(asset) : await this.#texture(asset),
      pixelsPerUnit: asNumber(provider['PixelsPerUnit'], 100),
      center: vec2(provider['Center'], 0),
      centerFromMiddle: provider['CenterFromMiddle'] !== false,
      type: component['SpriteType'] === 'Billboard' ? 'billboard' : 'sprite',
      color: color4(component['Color']),
      intensity: asNumber(component['Intensity'], 1),
      isTransparent: provider['IsTransparent'] !== false,
      premultipliedAlpha: component['PremultipliedAlpha'] !== false,
      ignoreDepth: component['IgnoreDepth'] === true,
      isAlphaCutoff: component['IsAlphaCutoff'] === true,
      blendMode: SPRITE_BLENDS[String(component['BlendMode'] ?? 'Auto')] ?? 'auto',
      sampler: SPRITE_SAMPLERS[String(component['Sampler'] ?? 'LinearClamp')] ?? 'linearClamp',
    };
  }

  /** 场景的 GameSettings（DefaultScene 是这个场景的优先，没有时取第一个）。 */
  #gameSettings(scene: AssetEntry): AssetEntry | undefined {
    const settings = this.#project.ofType('GameSettingsAsset');
    return settings.find((s) => parseAssetReference(s.data['DefaultScene'])?.id === scene.id) ?? settings[0];
  }

  /** GameSettings 引用的图形合成器。 */
  #compositorOf(scene: AssetEntry): StrideObject | undefined {
    const reference = parseAssetReference(this.#gameSettings(scene)?.data['GraphicsCompositor']);
    return reference ? this.#project.get(reference.id, scene.file).data : undefined;
  }

  /**
   * 场景的仿真设置：GameSettings 里 BepuConfiguration 的 BepuSimulations 中 AssociatedScene 是这个场景或为空的那个
   * （GameSettings 优先取 DefaultScene 是这个场景的），没有时用 Stride 的默认值。
   */
  #physicsSettings(scene: AssetEntry): ScenePhysics {
    const defaults = this.#gameSettings(scene)?.data['Defaults'];
    const configuration = (Array.isArray(defaults) ? defaults : [])
      .map(asObject)
      .find((d) => d?.$type?.startsWith('Stride.BepuPhysics.BepuConfiguration'));
    const list = configuration?.['BepuSimulations'];
    const simulations = (Array.isArray(list) ? list : []).map(asObject);
    const simulation = simulations.find((s) => parseAssetReference(s?.['AssociatedScene'])?.id === scene.id)
      ?? simulations.find((s) => s?.['AssociatedScene'] === null || s?.['AssociatedScene'] === undefined) ?? {};
    return {
      gravity: vec3(simulation['PoseGravity'], 0, [0, -9.8, 0]),
      linearDamping: asNumber(simulation['PoseLinearDamping'], 0.05),
      angularDamping: asNumber(simulation['PoseAngularDamping'], 0.05),
      fixedTimeStep: asNumber(simulation['FixedTimeStepSeconds'], 1 / 60),
      maxStepsPerFrame: asNumber(simulation['MaxStepPerFrame'], 3),
    };
  }

  async #light(component: StrideObject, where: string): Promise<SceneEntityFile['components']['light'] | undefined> {
    const type = asObject(component['Type']);
    const intensity = asNumber(component['Intensity'], 1);
    switch (type?.$type) {
      case 'LightDirectional':
      case 'LightAmbient': {
        const color = asObject(asObject(type['Color'])?.['Value']) ?? {};
        const shadow = type.$type === 'LightDirectional' ? this.#shadow(asObject(type['Shadow']), where) : undefined;
        return {
          type: type.$type === 'LightDirectional' ? 'directional' : 'ambient',
          color: [asNumber(color['R'], 1), asNumber(color['G'], 1), asNumber(color['B'], 1)],
          intensity,
          ...(shadow ? { shadow } : {}),
        };
      }
      case 'LightSkybox': {
        const skybox = parseAssetReference(type['Skybox']);
        return skybox ? { type: 'skybox', skybox: await this.#skybox(this.#project.get(skybox.id, where)), intensity } : undefined;
      }
      default:
        return undefined;
    }
  }

  /** 方向光的阴影（LightDirectionalShadowMap）；没开时返回 undefined。没写的字段取 Stride 的默认值。 */
  #shadow(shadow: StrideObject | undefined, where: string): SceneLightShadow | undefined {
    if (!shadow || shadow['Enabled'] !== true) return undefined;
    const filter = asObject(shadow['Filter']);
    let filterName: SceneLightShadow['filter'] = 'none';
    if (filter?.$type === 'LightShadowMapFilterTypePcf') filterName = PCF_FILTERS[String(filter['FilterSize'] ?? 'Filter3x3')] ?? 'pcf3x3';
    else if (filter) this.#warnings.push(`${where}: shadow filter ${filter.$type ?? 'value'} is not supported; using a single comparison sample`);
    const partition = asObject(shadow['PartitionMode']);
    if (partition?.$type === 'LightDirectionalShadowMap.PartitionManual') {
      this.#warnings.push(`${where}: manual shadow cascade splits are not supported; using the logarithmic partition`);
    }
    const bias = asObject(shadow['BiasParameters']) ?? {};
    const depthRange = asObject(shadow['DepthRange']) ?? {};
    return {
      size: SHADOW_SIZES[String(shadow['Size'] ?? 'Medium')] ?? 'medium',
      filter: filterName,
      cascadeCount: CASCADE_COUNTS[String(shadow['CascadeCount'] ?? 'FourCascades')] ?? 'four',
      depthBias: asNumber(bias['DepthBias'], 0.01),
      normalOffsetScale: asNumber(bias['NormalOffsetScale'], 10),
      stabilization: STABILIZATION_MODES[String(shadow['StabilizationMode'] ?? 'ProjectionSnapping')] ?? 'projectionSnapping',
      pssmFactor: partition?.$type === 'LightDirectionalShadowMap.PartitionLogarithmic' ? asNumber(partition['PSSMFactor'], 0.5) : 0.5,
      depthRange: depthRange['IsAutomatic'] === false ? 'manual' : 'automatic',
      minDistance: asNumber(depthRange['ManualMinDistance'], 0),
      maxDistance: asNumber(depthRange['ManualMaxDistance'], 50),
      blendCascades: depthRange['IsBlendingCascades'] !== false,
    };
  }

  async #modelComponent(component: StrideObject, where: string): Promise<NonNullable<SceneEntityFile['components']['model']>> {
    const reference = parseAssetReference(component['Model']);
    if (!reference) throw new Error(`${where}: ModelComponent has no model`);
    const model = await this.#model(this.#project.get(reference.id, where));
    // 按槽覆盖材质：键是 "<hash>~<槽号>"
    const materials: (string | null)[] = [];
    for (const [key, value] of Object.entries(asObject(component['Materials']) ?? {})) {
      const slot = Number(dictionaryKey(key));
      const material = parseAssetReference(value);
      if (!Number.isInteger(slot) || !material) continue;
      while (materials.length < slot) materials.push(null);
      materials[slot] = await this.#material(this.#project.get(material.id, where));
    }
    return { model, materials, ...(component['IsShadowCaster'] === false ? { isShadowCaster: false } : {}) };
  }

  /** 导入一个模型资源（.sdm3d），返回它的内容路径。 */
  #model(asset: AssetEntry): Promise<string> {
    return once(this.#models, asset, () => this.#importModel(asset));
  }

  async #importModel(asset: AssetEntry): Promise<void> {
    if (asset.type === 'ProceduralModelAsset') return this.#importProceduralModel(asset);
    // 材质槽按 .sdm3d 里的顺序；源文件里的网格按材质名对上槽
    const slots = Object.values(asObject(asset.data['Materials']) ?? {}).map((slot) => asObject(slot) ?? {});
    const slotNames = slots.map((slot) => String(slot['Name'] ?? ''));
    const slotAssets = slots.map((slot) => {
      const reference = parseAssetReference(asObject(slot['MaterialInstance'])?.['Material']);
      return reference ? this.#project.get(reference.id, asset.file) : null;
    });
    const materials = await Promise.all(slotAssets.map((material) => (material ? this.#material(material) : null)));
    // 材质用法线贴图的槽：这些网格要生成切线
    const normalMapped = await Promise.all(slotAssets.map(async (material) => material !== null && (await this.#materialFileOf(material)).normalMap !== undefined));

    const { pivot, scale } = importTransform(asset);
    const skeletonReference = parseAssetReference(asset.data['Skeleton']);
    const skeleton = skeletonReference ? await this.#skeleton(this.#project.get(skeletonReference.id, asset.file)) : undefined;
    const modelTransform = importMatrix(asset);
    const source = sourceOf(asset);
    // OBJ 不能从内容认出来，按扩展名告诉原生侧
    const scene = await this.#tools.loadScene(await readFile(source), path.extname(source).toLowerCase() === '.obj' ? 'obj' : 'auto');
    try {
      const meshes: SourceMesh[] = [];
      for (let m = 0; m < scene.meshCount; m++) {
        const data = scene.mesh(m);
        const materialName = data.material === null ? undefined : scene.materials[data.material];
        let slot = materialName === undefined ? -1 : slotNames.indexOf(materialName);
        // Blender 导出时重名的材质带 .001 这样的后缀，Stride 的模型资源里只列了不带后缀的那个
        if (slot < 0 && materialName !== undefined) slot = slotNames.indexOf(materialName.replace(/\.\d{3}$/, ''));
        if (slot < 0 && materialName !== undefined) {
          this.#warnings.push(`${asset.file}: mesh material '${materialName}' has no slot in the model; using slot 0`);
          slot = slots.length > 0 ? 0 : -1;
        }
        const skin = skeleton ? meshSkin(data, scene, skeleton, modelTransform, asset.file, (message) => this.#warnings.push(message)) : undefined;
        const mesh: SourceMesh = { name: `mesh${m}`, material: slot < 0 ? null : slot, vertices: interleave(data, pivot, scale), indices: data.indices, ...(skin ? { skin } : {}) };
        if (slot < 0 || !normalMapped[slot]) meshes.push(mesh);
        else if (data.normals && data.uvs) meshes.push(addTangents(mesh, this.#tools));
        else {
          this.#warnings.push(`${asset.file}: mesh ${m} has a normal-mapped material but no ${data.normals ? 'UVs' : 'normals'}; it gets no tangents`);
          meshes.push(mesh);
        }
      }
      const encoded: ModelMeshData[] = this.#options.plain
        ? meshes.map((mesh) => plainMesh(mesh.name, mesh.material, mesh.vertices, mesh.vertices.length / VERTEX_FLOATS <= 0xffff ? Uint16Array.from(mesh.indices) : mesh.indices, { ...(mesh.tangents ? { tangents: mesh.tangents } : {}), ...(mesh.skin ? { skin: mesh.skin } : {}) }))
        : compressMeshes(meshes, this.#tools);
      await this.#write(asset.path + EXTENSIONS.model, encodeModel({ meshes: encoded, materials, ...(skeleton ? { skeleton: skeleton.path } : {}) }));
    } finally {
      scene.destroy();
    }
  }

  /** Stride 的程序模型（.sdpromodel）：照 Stride 生成网格（procedural.ts），一个网格一个材质槽。 */
  async #importProceduralModel(asset: AssetEntry): Promise<void> {
    const type = asObject(asset.data['Type']) ?? {};
    const generated = proceduralMesh(type);
    if (!generated) throw new Error(`${asset.file}: procedural model ${type.$type ?? 'null'} is not supported yet`);
    const reference = parseAssetReference(asObject(type['MaterialInstance'])?.['Material']);
    const materialAsset = reference ? this.#project.get(reference.id, asset.file) : null;
    const material = materialAsset ? await this.#material(materialAsset) : null;
    let mesh: SourceMesh = {
      name: 'mesh0',
      material: material === null ? null : 0,
      vertices: interleave({ positions: generated.positions, normals: generated.normals, uvs: generated.uvs }, [0, 0, 0], 1),
      indices: generated.indices,
    };
    if (materialAsset && (await this.#materialFileOf(materialAsset)).normalMap !== undefined) mesh = addTangents(mesh, this.#tools);
    const encoded = this.#options.plain
      ? [plainMesh(mesh.name, mesh.material, mesh.vertices, mesh.vertices.length / VERTEX_FLOATS <= 0xffff ? Uint16Array.from(mesh.indices) : mesh.indices, mesh.tangents ? { tangents: mesh.tangents } : {})]
      : compressMeshes([mesh], this.#tools);
    await this.#write(asset.path + EXTENSIONS.model, encodeModel({ meshes: encoded, materials: material === null ? [] : [material] }));
  }

  /** 导入骨架资源（.sdskel），同一个只导入一次。 */
  #skeleton(asset: AssetEntry): Promise<ImportedSkeleton> {
    let pending = this.#skeletons.get(asset.path);
    if (!pending) {
      pending = importSkeleton(asset, this.#animationContext);
      this.#skeletons.set(asset.path, pending);
    }
    return pending;
  }

  /** 导入动画资源（.sdanim），返回它的内容路径。 */
  #animation(asset: AssetEntry): Promise<string> {
    return once(this.#animations, asset, async () => {
      const reference = parseAssetReference(asset.data['Skeleton']);
      if (!reference) throw new Error(`${asset.file}: the animation has no skeleton`);
      await importAnimation(asset, await this.#skeleton(this.#project.get(reference.id, asset.file)), this.#animationContext);
    });
  }

  get #animationContext(): AnimationImportContext {
    return { tools: this.#tools, write: (contentPath, data) => this.#write(contentPath, data), warn: (message) => void this.#warnings.push(message) };
  }

  /** Stride 的 AnimationComponent：Animations 是名字到剪辑的字典。 */
  async #animationComponent(component: StrideObject, where: string): Promise<NonNullable<SceneEntityFile['components']['animation']>> {
    const animations: { name: string; clip: string }[] = [];
    for (const [key, value] of Object.entries(asObject(component['Animations']) ?? {})) {
      // 字典项写成 名字: 引用，或者 { Key: 名字, Value: 引用 }
      const entry = asObject(value);
      const name = entry && 'Key' in entry ? String(entry['Key']) : dictionaryKey(key);
      const reference = parseAssetReference(entry && 'Value' in entry ? entry['Value'] : value);
      if (!reference) continue;
      animations.push({ name, clip: await this.#animation(this.#project.get(reference.id, where)) });
    }
    return { animations };
  }

  /** 导入一个材质资源（.sdmat），返回它的内容路径。 */
  #material(asset: AssetEntry): Promise<string> {
    return once(this.#materials, asset, async () => this.#write(asset.path + EXTENSIONS.material, JSON.stringify(await this.#materialFileOf(asset), null, 1)));
  }

  /** 材质资源转成的 MaterialFile，同一个只转一次（模型导入时还要看它有没有法线贴图）。 */
  #materialFileOf(asset: AssetEntry): Promise<MaterialFile> {
    let pending = this.#materialFiles.get(asset.path);
    if (!pending) {
      pending = this.#materialFile(asset);
      this.#materialFiles.set(asset.path, pending);
    }
    return pending;
  }

  async #materialFile(asset: AssetEntry): Promise<MaterialFile> {
    const attributes = asObject(asset.data['Attributes']) ?? {};
    const diffuse = asObject(asObject(attributes['Diffuse'])?.['DiffuseMap']);
    const uvScale = vec2(asObject(attributes['Overrides'])?.['UVScale'], 1);
    const { color, texture, operator } = diffuse ? this.#evaluateColor(diffuse, asset, uvScale) : { color: WHITE, operator: 'multiply' as const };
    const specular = asObject(attributes['Specular']);
    const workflow = specular?.$type;
    if (specular && workflow !== 'MaterialMetalnessMapFeature' && workflow !== 'MaterialSpecularMapFeature') this.#warnings.push(`${asset.file}: specular ${workflow ?? 'feature'} is not supported; the material has no specular`);
    const metalness = workflow === 'MaterialMetalnessMapFeature' ? this.#scalar(asObject(specular!['MetalnessMap']), 0, asset) : undefined;
    const microSurface = asObject(attributes['MicroSurface']);
    const glossiness = this.#scalar(asObject(microSurface?.['GlossinessMap']), 0, asset);
    // Invert 为真时这张图存的是粗糙度（MaterialGlossinessMapFeature.Invert）
    const roughness = microSurface?.['Invert'] === true ? glossiness : 1 - glossiness;
    const material: MaterialFile = {
      name: path.basename(asset.path),
      baseColor: color,
      ...(texture ? { baseColorTexture: textureSlot(await texture.texture, texture.scale, texture.offset, texture.sampler) } : {}),
      ...(texture && operator !== 'multiply' ? { baseColorOperator: operator } : {}),
      ...(metalness === undefined ? {} : { metalness }),
      ...(workflow === 'MaterialSpecularMapFeature' ? { specular: this.#specularColor(specular!, asset, uvScale) } : {}),
      roughness,
      ...await this.#emissive(asObject(attributes['Emissive']), asset, uvScale),
      ...await this.#occlusion(asObject(attributes['Occlusion']), asset, uvScale),
      ...await this.#normalMap(asObject(attributes['Surface']), asset, uvScale),
      ...this.#transparency(asObject(attributes['Transparency']), asset, uvScale),
    };
    if (asObject(asset.data['Layers']) && Object.keys(asObject(asset.data['Layers'])!).length > 0) {
      this.#warnings.push(`${asset.file}: material layers are not supported yet (P2 shader system); using the base material`);
    }
    return material;
  }

  /** 镜面颜色工作流（MaterialSpecularMapFeature）：镜面颜色乘强度；镜面贴图还不支持，用它的后备颜色。 */
  #specularColor(feature: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): Vec3Tuple {
    const map = this.#evaluateColor(asObject(feature['SpecularMap']) ?? {}, asset, uvScale);
    if (map.texture) this.#warnings.push(`${asset.file}: specular textures are not supported; using the color`);
    const intensity = Math.min(Math.max(this.#scalar(asObject(feature['Intensity']), 1, asset), 0), 1);
    return [map.color[0] * intensity, map.color[1] * intensity, map.color[2] * intensity];
  }

  /** 透明（MaterialTransparencyBlendFeature）：alpha 限制在 0..1，tint 是常量颜色；别的透明特性记警告。 */
  #transparency(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Pick<MaterialFile, 'transparency'> {
    if (!feature) return {};
    if (feature.$type !== 'MaterialTransparencyBlendFeature') {
      this.#warnings.push(`${asset.file}: transparency ${feature.$type ?? 'feature'} is not supported; the material is opaque`);
      return {};
    }
    const alpha = Math.min(Math.max(this.#scalar(asObject(feature['Alpha']), 1, asset), 0), 1);
    const tint = this.#evaluateColor(asObject(feature['Tint']) ?? { $type: 'ComputeColor' }, asset, uvScale);
    if (tint.texture) this.#warnings.push(`${asset.file}: a textured transparency tint is not supported; using the color`);
    const [r, g, b] = tint.color;
    return { transparency: { type: 'blend', alpha, ...(r === 1 && g === 1 && b === 1 ? {} : { tint: [r, g, b] }) } };
  }

  /** 法线贴图（MaterialNormalMapFeature）：开关的默认值同 Stride；InvertY 来自贴图资源的 NormalMapTextureType（默认 true）。 */
  async #normalMap(surface: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<{ normalMap?: NormalMapSlot }> {
    if (!surface) return {};
    if (surface.$type !== 'MaterialNormalMapFeature') {
      this.#warnings.push(`${asset.file}: surface ${surface.$type ?? 'feature'} is not supported; using the vertex normals`);
      return {};
    }
    const node = asObject(surface['NormalMap']) ?? {};
    const reference = parseAssetReference(node['Texture']);
    if (node.$type !== 'ComputeTextureColor' || !reference) {
      this.#warnings.push(`${asset.file}: normal map ${node.$type ?? 'value'} without a texture is not supported; using the vertex normals`);
      return {};
    }
    const textureAsset = this.#project.get(reference.id, asset.file);
    const type = asObject(textureAsset.data['Type']);
    const scale = vec2(node['Scale'], 1);
    const slot = textureSlot(await this.#texture(textureAsset), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(node['Offset'], 0), samplerOf(node));
    return {
      normalMap: {
        ...slot,
        scaleAndBias: surface['ScaleAndBias'] !== false,
        isXYNormal: surface['IsXYNormal'] !== false,
        invertY: type?.$type === 'NormalMapTextureType' && type['InvertY'] !== false,
      },
    };
  }

  /**
   * 自发光（MaterialEmissiveMapFeature）：颜色乘强度，同 Stride 的 MaterialSurfaceEmissiveShading；颜色树化简成"贴图乘颜色"
   * （比如 PhysicsSample 的 ComputeBinaryColor：贴图乘 ComputeFloat4），贴图加颜色的记警告、只用颜色。
   */
  async #emissive(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<Pick<MaterialFile, 'emissive' | 'emissiveTexture'>> {
    if (!feature) return {};
    const map = this.#evaluateColor(asObject(feature['EmissiveMap']) ?? {}, asset, uvScale);
    const intensity = this.#scalar(asObject(feature['Intensity']), 1, asset);
    const emissive: Vec3Tuple = [map.color[0] * intensity, map.color[1] * intensity, map.color[2] * intensity];
    if (map.texture && map.operator !== 'multiply') this.#warnings.push(`${asset.file}: emissive texture with operator ${map.operator} is not supported; using the color`);
    const texture = map.texture && map.operator === 'multiply' ? map.texture : undefined;
    return { emissive, ...(texture ? { emissiveTexture: textureSlot(await texture.texture, texture.scale, texture.offset, texture.sampler) } : {}) };
  }

  /**
   * Occlusion 特性：环境光遮蔽（数值或贴图的一个通道，DirectLightingFactor 决定直射光受多少影响），cavity：可见的漫反射、
   * 镜面分别乘 lerp(1, cavity, DiffuseCavity / SpecularCavity)（Stride 的 MaterialPixelStream.PrepareMaterialForLightingAndShading）。
   */
  async #occlusion(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<Pick<MaterialFile, 'cavity' | 'ambientOcclusion'>> {
    if (!feature) return {};
    const map = asObject(feature['AmbientOcclusionMap']);
    const reference = map?.$type === 'ComputeTextureScalar' ? parseAssetReference(map['Texture']) : undefined;
    const directLighting = this.#scalar(asObject(feature['DirectLightingFactor']), 0, asset);
    let ambientOcclusion: MaterialFile['ambientOcclusion'];
    if (reference) {
      const scale = vec2(map!['Scale'], 1);
      const slot = textureSlot(await this.#texture(this.#project.get(reference.id, asset.file)), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(map!['Offset'], 0), samplerOf(map!));
      const channel = String(map!['Channel'] ?? 'R').toLowerCase() as 'r' | 'g' | 'b' | 'a';
      ambientOcclusion = { value: 1, texture: { ...slot, channel }, directLighting };
    } else {
      const value = this.#scalar(map, 1, asset);
      if (value !== 1) ambientOcclusion = { value, directLighting };
    }
    const cavity = this.#scalar(asObject(feature['CavityMap']), 1, asset);
    const lerp = (amount: number) => 1 + (cavity - 1) * amount;
    const diffuse = lerp(this.#scalar(asObject(feature['DiffuseCavity']), 1, asset));
    const specular = lerp(this.#scalar(asObject(feature['SpecularCavity']), 1, asset));
    return { ...(ambientOcclusion ? { ambientOcclusion } : {}), ...(diffuse === 1 && specular === 1 ? {} : { cavity: { diffuse, specular } }) };
  }

  /** ComputeFloat 的值；没有贴图的 ComputeTextureScalar 用它的 FallbackValue（Stride 也是这样）。 */
  #scalar(node: StrideObject | undefined, fallback: number, asset: AssetEntry): number {
    if (!node) return fallback;
    if (node.$type === 'ComputeFloat') return asNumber(node['Value'], fallback);
    if (node.$type === 'ComputeTextureScalar') {
      if (parseAssetReference(node['Texture'])) this.#warnings.push(`${asset.file}: scalar textures are not supported; using the fallback value`);
      return asNumber(asObject(node['FallbackValue'])?.['Value'], fallback);
    }
    this.#warnings.push(`${asset.file}: scalar ${node.$type ?? 'value'} is not supported; using ${fallback}`);
    return fallback;
  }

  /**
   * Stride 材质的颜色树（ComputeColor、ComputeTextureColor、ComputeBinaryColor）化成"一张贴图按运算符组合一个颜色"，
   * 也就是运行时着色器支持的形状；纯颜色的子树在导入时算好。超出这个形状的树（两张贴图、贴图和颜色混用不同的
   * 运算符）记警告，只保留一张贴图。
   */
  #evaluateColor(node: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): ColorExpression {
    switch (node.$type) {
      case 'ComputeColor':
        return { color: linearColor(node['Value']), operator: 'multiply' };
      case 'ComputeFloat4': {
        // 不是颜色：不做 sRGB 转换
        const v = asObject(node['Value']) ?? {};
        return { color: [asNumber(v['X'], 0), asNumber(v['Y'], 0), asNumber(v['Z'], 0), asNumber(v['W'], 0)], operator: 'multiply' };
      }
      case 'ComputeTextureColor': {
        const reference = parseAssetReference(node['Texture']);
        if (!reference) return { color: linearColor(asObject(node['FallbackValue'])?.['Value']), operator: 'multiply' };
        const scale = vec2(node['Scale'], 1);
        const texture = { texture: this.#texture(this.#project.get(reference.id, asset.file)), scale: [scale[0] * uvScale[0], scale[1] * uvScale[1]], offset: vec2(node['Offset'], 0), sampler: samplerOf(node) } as const;
        return { color: WHITE, texture, operator: 'multiply' };
      }
      case 'ComputeBinaryColor': {
        const name = String(node['Operator']);
        const left = this.#evaluateColor(asObject(node['LeftChild']) ?? {}, asset, uvScale);
        const right = this.#evaluateColor(asObject(node['RightChild']) ?? {}, asset, uvScale);
        const fold = BINARY_OPERATORS[name];
        const texture = left.texture ?? right.texture;
        if (!texture) {
          if (fold) return { color: combine(left.color, right.color, fold), operator: 'multiply' };
          this.#warnings.push(`${asset.file}: color operator ${name} is not supported; using the left side`);
          return left;
        }
        if (left.texture && right.texture) {
          this.#warnings.push(`${asset.file}: combining two textures is not supported; using the left one`);
          return left;
        }
        // 剩下的是"一边有贴图、一边是颜色"；支持的两个运算都满足交换律，不用管贴图在哪边
        const [textured, constant] = left.texture ? [left, right] : [right, left];
        const operator = TEXTURE_OPERATORS[name];
        const pureTexture = textured.operator === 'multiply' && textured.color.every((c) => c === 1);
        if (operator && pureTexture) return { color: constant.color, texture, operator };
        if (operator && fold && operator === textured.operator) return { color: combine(textured.color, constant.color, fold), texture, operator };
        this.#warnings.push(`${asset.file}: color operator ${name} on a texture is not supported; ignoring the color`);
        return textured;
      }
      default:
        this.#warnings.push(`${asset.file}: color ${node.$type ?? 'value'} is not supported; using white`);
        return { color: WHITE, operator: 'multiply' };
    }
  }

  /** 导入一个贴图资源（.sdtex），同一张只导入一次。 */
  #texture(asset: AssetEntry): Promise<ImportedTexture> {
    let pending = this.#textures.get(asset.path);
    if (!pending) {
      pending = this.#importTexture(asset);
      this.#textures.set(asset.path, pending);
    }
    return pending;
  }

  /** 有覆盖文件就原样导出它；否则按 textureEncoding：编成 KTX2（UASTC 加 mipmap），或复制 PNG/JPEG 源文件。 */
  async #importTexture(asset: AssetEntry): Promise<ImportedTexture> {
    const override = await this.#override(asset.path);
    const type = asObject(asset.data['Type']);
    // 颜色贴图默认按 sRGB 采样（Stride 的 ColorTextureType.UseSRgbSampling），法线、灰度贴图是线性的
    const srgb = type?.$type === 'ColorTextureType' && type['UseSRgbSampling'] !== false;
    if (override) return this.#copyTexture(asset.path, override.encoding, await readFile(override.file), srgb);

    const file = sourceOf(asset);
    const bytes = await readFile(file);
    const sourceEncoding = SOURCE_ENCODINGS[path.extname(file).toLowerCase()];
    const policy = this.#options.textureEncoding;
    if (policy === 'source' && sourceEncoding) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
    const image = await this.#tools.decodeImage(bytes);
    const ktx2 = await this.#tools.encodeBasis(image.pixels, image.width, image.height, { mode: 'uastc', srgb, mipmaps: true });
    if (policy === 'smallest' && sourceEncoding && bytes.byteLength < ktx2.byteLength) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
    await this.#write(asset.path + TEXTURE_EXTENSIONS.ktx2, ktx2);
    return { texture: asset.path, encoding: 'ktx2', srgb };
  }

  async #copyTexture(contentPath: string, encoding: TextureEncoding, bytes: Uint8Array, srgb: boolean): Promise<ImportedTexture> {
    await this.#write(contentPath + TEXTURE_EXTENSIONS[encoding], bytes);
    const size = encoding === 'svg' ? svgSize(new TextDecoder().decode(bytes)) : undefined;
    return { texture: contentPath, encoding, ...(size ? { size } : {}), srgb };
  }

  /** 覆盖目录里这个内容路径的文件（.svg 优先，然后 .png、.jpg）。 */
  async #override(contentPath: string): Promise<{ file: string; encoding: TextureEncoding } | undefined> {
    if (!this.#options.overrides) return undefined;
    for (const [extension, encoding] of Object.entries(SOURCE_ENCODINGS)) {
      const file = path.join(this.#options.overrides, contentPath + extension);
      if (await access(file).then(() => true, () => false)) return { file, encoding };
    }
    return undefined;
  }

  /** 把一个 HDR 立方体贴图资源（.sdtex，源文件是 DDS）导出成 .cubemap：RGB9E5，mip 同 #hdrSource。 */
  #cubemap(asset: AssetEntry): Promise<string> {
    return once(this.#cubemaps, asset, async () => {
      const source = await this.#hdrSource(asset);
      const levels = source.levels.map((level) => new Uint8Array(toRgb9e5(level).buffer));
      await this.#write(asset.path + EXTENSIONS.cubemap, encodeCubemap({ size: source.size, format: 'rgb9e5ufloat', levels }));
    });
  }

  /**
   * 导入天空盒（.sdsky）：漫反射是 3 阶球谐，同 Stride 的 SkyboxGenerator，从源文件的浮点数据算；镜面的预滤波
   * 在运行时从源立方体贴图生成，这里只记下尺寸。源立方体贴图导出成 .cubemap，背景用同一张时只导出一次。
   * 返回天空盒的内容路径。
   */
  #skybox(asset: AssetEntry): Promise<string> {
    return once(this.#skyboxes, asset, async () => {
      const reference = parseAssetReference(asset.data['CubeMap']);
      if (!reference) throw new Error(`${asset.file}: skybox has no CubeMap`);
      const texture = this.#project.get(reference.id, asset.file);
      const source = await this.#hdrSource(texture);
      const [sh, radiance] = await Promise.all([this.#tools.cubemapSH({ size: source.size, faces: source.levels[0]! }), this.#cubemap(texture)]);
      const file: SkyboxFile = { diffuseSH: [...sh], radiance, specularSize: this.#options.specularCubemapSize };
      await this.#write(asset.path + EXTENSIONS.skybox, JSON.stringify(file, null, 1));
    });
  }

  /** 贴图资源的源立方体贴图；GenerateMipmaps（默认开）时同 Stride 从第 0 级重建 mip，否则用文件里的。 */
  #hdrSource(asset: AssetEntry): Promise<FloatCubemap> {
    let pending = this.#hdrSources.get(asset.path);
    if (!pending) {
      const file = sourceOf(asset);
      const generateMipmaps = asset.data['GenerateMipmaps'] !== false;
      pending = readFile(file).then((bytes) => {
        const cube = readDdsCubemap(bytes, file);
        return generateMipmaps ? regenerateMips(cube) : cube;
      });
      this.#hdrSources.set(asset.path, pending);
    }
    return pending;
  }

  async #write(contentPath: string, data: string | Uint8Array): Promise<void> {
    const file = path.join(this.#out, contentPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
}

/** 同一个资源只导入一次：缓存导入的 Promise，结果是资源的内容路径。 */
/** Stride 的 LightShadowMapSize、LightShadowMapFilterTypePcfSize、LightShadowMapCascadeCount、LightShadowMapStabilizationMode。 */
const SHADOW_SIZES: Readonly<Record<string, SceneLightShadow['size']>> = { XSmall: 'xsmall', Small: 'small', Medium: 'medium', Large: 'large', XLarge: 'xlarge' };
const PCF_FILTERS: Readonly<Record<string, SceneLightShadow['filter']>> = { Filter3x3: 'pcf3x3', Filter5x5: 'pcf5x5', Filter7x7: 'pcf7x7' };
const CASCADE_COUNTS: Readonly<Record<string, SceneLightShadow['cascadeCount']>> = { OneCascade: 'one', TwoCascades: 'two', FourCascades: 'four' };
const STABILIZATION_MODES: Readonly<Record<string, SceneLightShadow['stabilization']>> = { None: 'none', ViewSnapping: 'viewSnapping', ProjectionSnapping: 'projectionSnapping' };

function once(cache: Map<string, Promise<string>>, asset: AssetEntry, importAsset: () => Promise<void>): Promise<string> {
  let pending = cache.get(asset.path);
  if (!pending) {
    pending = importAsset().then(() => asset.path);
    cache.set(asset.path, pending);
  }
  return pending;
}

/** 材质里的贴图槽：ktx2 是默认，不写 encoding。 */
function textureSlot({ texture, encoding, size, srgb }: ImportedTexture, scale: readonly [number, number], offset: readonly [number, number], sampler: TextureSampler): TextureSlot {
  return { texture, ...(encoding === 'ktx2' ? {} : { encoding }), ...(size ? { size } : {}), srgb, scale, offset, ...sampler };
}

/**
 * 贴图节点（ComputeTextureColor、ComputeTextureScalar）的采样器，只写和默认值（线性、重复）不同的。Stride 的过滤方式里带
 * Anisotropic 的是各向异性，Point（含 Comparison、MinMagMipPoint）是最近点，其余（含混合的几种）按线性。
 */
function samplerOf(node: StrideObject): TextureSampler {
  const filtering = String(node['Filtering'] ?? 'Linear');
  const filter = /Anisotropic/.test(filtering) ? 'anisotropic' : /^(Comparison)?Point$|^(Comparison)?MinMagMipPoint$/.test(filtering) ? 'point' : undefined;
  const address = (value: StrideValue | undefined) => {
    const mode = String(value ?? 'Wrap');
    return mode === 'Clamp' || mode === 'Border' ? 'clamp' : mode === 'Mirror' || mode === 'MirrorOnce' ? 'mirror' : undefined;
  };
  const [addressU, addressV] = [address(node['AddressModeU']), address(node['AddressModeV'])];
  return { ...(filter ? { filter } : {}), ...(addressU ? { addressU } : {}), ...(addressV ? { addressV } : {}) } as TextureSampler;
}

/** SVG 根元素的 width、height（像素，不带单位或 px）；没有时用 viewBox 的大小；都没有时返回 undefined（运行时用图片本身的尺寸）。 */
export function svgSize(svg: string): [number, number] | undefined {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!root) return undefined;
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const pixels = (value: string | undefined) => (value && /^\s*[\d.]+\s*(px)?\s*$/.test(value) ? Math.round(parseFloat(value)) : undefined);
  const [width, height] = [pixels(attribute('width')), pixels(attribute('height'))];
  if (width && height) return [width, height];
  const viewBox = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  return viewBox && viewBox.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0 ? [Math.round(viewBox[2]!), Math.round(viewBox[3]!)] : undefined;
}

type Color4Tuple = readonly [number, number, number, number];

const WHITE: Color4Tuple = [1, 1, 1, 1];

/** 颜色树化简后的形状：有贴图时结果 = operator(贴图采样, color)，没有贴图时就是 color。 */
interface ColorExpression {
  readonly color: Color4Tuple;
  /** texture 是导入中的贴图。 */
  readonly texture?: { readonly texture: Promise<ImportedTexture>; readonly scale: readonly [number, number]; readonly offset: readonly [number, number]; readonly sampler: TextureSampler };
  readonly operator: ColorOperator;
}

/** 着色器里能和贴图组合的运算符（Stride 的 Add 是 3ds 风格的加法，对不透明的颜色就是相加）。 */
const TEXTURE_OPERATORS: Readonly<Record<string, ColorOperator>> = { Add: 'add', Multiply: 'multiply' };

function combine(a: Color4Tuple, b: Color4Tuple, op: (a: number, b: number) => number): Color4Tuple {
  return [op(a[0], b[0]), op(a[1], b[1]), op(a[2], b[2]), a[3] * b[3]];
}

/** Stride 的 BinaryOperator（ComputeBinaryColor 用）里常见的几个。 */
const BINARY_OPERATORS: Readonly<Record<string, (a: number, b: number) => number>> = {
  Add: (a, b) => a + b,
  Subtract: (a, b) => a - b,
  Multiply: (a, b) => a * b,
  Divide: (a, b) => (b === 0 ? 0 : a / b),
  Average: (a, b) => (a + b) / 2,
  Min: Math.min,
  Max: Math.max,
  Screen: (a, b) => 1 - (1 - a) * (1 - b),
  Overlay: (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b)),
};

function componentOf(entity: StrideObject, type: string): StrideObject | undefined {
  return Object.values(asObject(entity['Components']) ?? {}).map(asObject).find((c) => c?.$type === type);
}

/** 父实体排在子实体前面（运行时按顺序创建并挂接）。 */
function parentsFirst(entities: readonly SceneEntityFile[]): SceneEntityFile[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const ordered: SceneEntityFile[] = [];
  const done = new Set<string>();
  const visit = (entity: SceneEntityFile) => {
    if (done.has(entity.id)) return;
    done.add(entity.id);
    const parent = entity.parent === null ? undefined : byId.get(entity.parent);
    if (parent) visit(parent);
    ordered.push(parent || entity.parent === null ? entity : { ...entity, parent: null });
  };
  entities.forEach(visit);
  return ordered;
}

function vec3(value: StrideValue | undefined, fallback: number, whole?: [number, number, number]): [number, number, number] {
  const v = asObject(value);
  if (!v && whole) return whole;
  return [asNumber(v?.['X'], fallback), asNumber(v?.['Y'], fallback), asNumber(v?.['Z'], fallback)];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 游戏的脚本：带程序集名、不在 Stride 的命名空间里（引擎组件要么没有命名空间，要么以 Stride. 开头）。 */
function isScriptType(type: string): boolean {
  return type.includes(',') && !type.startsWith('Stride.');
}

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** 碰撞体的类型名，去掉命名空间和程序集（"Stride.BepuPhysics.Definitions.Colliders.BoxCollider,Stride.BepuPhysics" → "BoxCollider"）。 */
function colliderType(collider: StrideObject | undefined): string {
  const type = collider?.$type ?? 'none';
  return type.slice(0, type.includes(',') ? type.indexOf(',') : undefined).split('.').pop()!;
}

/** CompoundCollider 里的一个形状，默认值同 Stride（BoxCollider 边长 1，胶囊半径 0.35、长 0.5，球半径 0.5，圆柱半径 0.5、长 1）。 */
function colliderShape(collider: StrideObject): ColliderShapeFile | undefined {
  const local = { position: vec3(collider['PositionLocal'], 0), rotation: quaternion(collider['RotationLocal']), mass: asNumber(collider['Mass'], 1) };
  switch (colliderType(collider)) {
    case 'BoxCollider':
      return { type: 'box', size: vec3(collider['Size'], 1), ...local };
    case 'SphereCollider':
      return { type: 'sphere', radius: asNumber(collider['Radius'], 0.5), ...local };
    case 'CapsuleCollider':
      return { type: 'capsule', radius: asNumber(collider['Radius'], 0.35), length: asNumber(collider['Length'], 0.5), ...local };
    case 'CylinderCollider':
      return { type: 'cylinder', radius: asNumber(collider['Radius'], 0.5), length: asNumber(collider['Length'], 1), ...local };
    default:
      return undefined;
  }
}

/** Stride 的 RenderTexture 资源（.sdrendertex），默认值同 Stride：512x512、LDR、sRGB。 */
function renderTextureOf(asset: AssetEntry): SceneRenderTexture {
  return {
    renderTexture: asset.path,
    width: asNumber(asset.data['Width'], 512),
    height: asNumber(asset.data['Height'], 512),
    hdr: asset.data['Format'] === 'HDR',
    srgb: asset.data['UseSRgbSampling'] !== false,
  };
}

const SPRITE_BLENDS: Readonly<Record<string, SpriteBlend>> = { Auto: 'auto', None: 'none', AlphaBlend: 'alphaBlend', AdditiveBlend: 'additiveBlend', NoColor: 'noColor' };
const SPRITE_SAMPLERS: Readonly<Record<string, SceneSprite['sampler']>> = { LinearClamp: 'linearClamp', PointClamp: 'pointClamp', AnisotropicClamp: 'anisotropicClamp' };

/** Stride 的 Color4（原样，不换颜色空间）。 */
function color4(value: StrideValue | undefined): [number, number, number, number] {
  const c = asObject(value) ?? {};
  return [asNumber(c['R'], 1), asNumber(c['G'], 1), asNumber(c['B'], 1), asNumber(c['A'], 1)];
}

function vec2(value: StrideValue | undefined, fallback: number): [number, number] {
  const v = asObject(value) ?? {};
  return [asNumber(v['X'], fallback), asNumber(v['Y'], fallback)];
}

function quaternion(value: StrideValue | undefined): [number, number, number, number] {
  const q = asObject(value) ?? {};
  return [asNumber(q['X'], 0), asNumber(q['Y'], 0), asNumber(q['Z'], 0), asNumber(q['W'], 1)];
}

/** Stride 的颜色值是 sRGB：转成线性。 */
function linearColor(value: StrideValue | undefined): [number, number, number, number] {
  const c = asObject(value) ?? {};
  return [srgbToLinear(asNumber(c['R'], 1)), srgbToLinear(asNumber(c['G'], 1)), srgbToLinear(asNumber(c['B'], 1)), asNumber(c['A'], 1)];
}

/** 相机；slots 是合成器的相机槽位 Id 到下标，槽位是 0（Main）时不写。 */
function cameraOf(component: StrideObject, slots: ReadonlyMap<string, number>): NonNullable<SceneEntityFile['components']['camera']> {
  const slot = typeof component['Slot'] === 'string' ? (slots.get(component['Slot']) ?? 0) : 0;
  return {
    verticalFieldOfView: asNumber(component['VerticalFieldOfView'], 45),
    nearClipPlane: asNumber(component['NearClipPlane'], 0.1),
    farClipPlane: asNumber(component['FarClipPlane'], 1000),
    ...(slot > 0 ? { slot } : {}),
    ...(component['Projection'] === 'Orthographic' ? { projection: 'orthographic', orthographicSize: asNumber(component['OrthographicSize'], 10) } : {}),
  };
}

/** 导入的网格变成 FLOAT_LAYOUT 的交错顶点（位置减去轴心再乘缩放，同 Stride 的 PivotPosition、ScaleImport），没有的属性填 0。 */
function interleave(
  mesh: { positions: Float32Array; normals: Float32Array | null; uvs: Float32Array | null },
  pivot: readonly [number, number, number],
  scale: number,
): Float32Array {
  const count = mesh.positions.length / 3;
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    const o = v * VERTEX_FLOATS;
    for (let k = 0; k < 3; k++) vertices[o + k] = (mesh.positions[v * 3 + k]! - pivot[k]!) * scale;
    if (mesh.normals) vertices.set(mesh.normals.subarray(v * 3, v * 3 + 3), o + 3);
    if (mesh.uvs) vertices.set(mesh.uvs.subarray(v * 2, v * 2 + 2), o + 6);
  }
  return vertices;
}
