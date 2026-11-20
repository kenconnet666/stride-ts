/**
 * 把 Stride 工程的场景和预制体导入成运行时内容（格式见 @stride-ts/engine 的 content/format.ts）：实体的层级和变换，
 * 模型（源 FBX/glTF 经 stride-tools 导入，含骨架和蒙皮）、动画、相机、光源、背景、精灵和精灵表，物理（碰撞体、刚体、
 * 角色、约束，GameSettings 里的仿真和碰撞矩阵）、导航设置，以及游戏脚本的属性。材质、贴图、天空盒在 materials.ts。
 * 还不认识的组件（音频等）跳过并计数。
 */
import { convertInstances, type ConvertedPrefab, type StrideBase } from './instances.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MeshData, StrideTools } from '@stride-ts/native/tools';
import {
  EXTENSIONS,
  encodeModel,
  plainMesh,
  VERTEX_FLOATS,
  type ColliderShapeFile,
  type TextureRef,
  type GameSettingsFile,
  type PrefabFile,
  type ModelMeshData,
  type SceneCharacter,
  type SceneAssetKind,
  type SoundEncoding,
  type SoundFile,
  type SceneCollidable,
  type SceneEntityFile,
  type MaterialFile,
  type SceneBody,
  type SceneConstraint,
  type SceneRenderTexture,
  type SceneSprite,
  type SceneUI,
  type SceneSpriteFromSheet,
  type SceneSpriteFromTexture,
  type SpriteSheetFile,
  type SpriteBlend,
  type SceneFile,
  type SceneLightShadow,
  type SceneLocalLightShadow,
  type SceneNavigation,
  type ScenePhysics,
  type SceneScript,
  type SceneScriptValue,
  type Vec3Tuple,
  parseCollisionMask,
} from '@stride-ts/engine/content-format';
import { addTangents, compressMeshes, meshMorph, type SourceMesh, type SourceMorph } from '../mesh.ts';
import { importCompositor, renderGroupOf } from './compositor.ts';
import { FontImporter } from './fonts.ts';
import { MaterialImporter, type ImportedTexture } from './materials.ts';
import { importParticleSystem } from './particles.ts';
import type { DerivedDataCache } from '../cache.ts';
import { proceduralMesh } from './procedural.ts';
import { cleanNodeName, importAnimation, importMatrix, importSkeleton, meshSkin, type AnimationImportContext, type ImportedSkeleton } from './animation.ts';
import { importTransform, loadSourceScene, once, sourceOf, type AssetEntry, type StrideProject } from './project.ts';
import { UIImporter } from './ui.ts';
import { asNumber, asObject, color4, dictionaryKey, lowerFirst, parseAssetReference, parseObjectReference, quaternion, vec2, vec3, type StrideObject, type StrideValue } from './yaml.ts';

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
   * 浏览器解码）、smallest（两者取下载小的）。要压缩、宽高又不是 4 的倍数的贴图总是编成 KTX2（要先缩放，见 #importTexture）。
   */
  readonly textureEncoding?: 'ktx2' | 'source' | 'smallest';
  /** 找系统字体（SystemFontProvider）的目录；不给时按操作系统，同 Stride。 */
  readonly systemFontDirs?: readonly string[];
  /** 贵的导入结果（贴图编成 KTX2）的缓存，见 ../cache.ts；不给时每次都现算。命令行默认用 ~/.stride-ts/cache/pipeline。 */
  readonly cache?: DerivedDataCache;
}

/** 补上默认值的选项（材质导入也用）。 */
export type ResolvedImporterOptions = Required<Omit<ImporterOptions, 'systemFontDirs' | 'cache'>>;

/** 一次场景或预制体层级导入的上下文。 */
interface HierarchyContext {
  /** 组件和实体的 Id → 所在实体的 Id。 */
  readonly owners: ReadonlyMap<string, string>;
  /** 合成器里相机槽位的 Id → 下标（Camera.slot）；预制体是空的。 */
  readonly cameraSlots: ReadonlyMap<string, number>;
  /** 合成器里渲染阶段的 Id → 名字；只在导入游戏自己的渲染器的属性时有，引用阶段的属性导出成阶段的名字。 */
  readonly renderStages?: ReadonlyMap<string, string>;
}

/** Stride.BepuPhysics 的约束组件的类型名前缀。 */
const CONSTRAINT_PREFIX = 'Stride.BepuPhysics.Constraints.';
/** 原样复制的音频源文件的扩展名。 */
const SOUND_ENCODINGS: Readonly<Record<string, SoundEncoding>> = { mp3: 'mp3', ogg: 'ogg', wav: 'wav', flac: 'flac', m4a: 'aac', aac: 'aac' };

type Components = { -readonly [K in keyof SceneEntityFile['components']]: SceneEntityFile['components'][K] };

export class StrideImporter {
  readonly #project: StrideProject;
  readonly #tools: StrideTools;
  readonly #out: string;
  readonly #options: ResolvedImporterOptions;
  readonly #materials: MaterialImporter;
  readonly #fonts: FontImporter;
  readonly #ui: UIImporter;
  readonly #models = new Map<string, Promise<string>>();
  readonly #skeletons = new Map<string, Promise<ImportedSkeleton>>();
  readonly #animations = new Map<string, Promise<string>>();
  readonly #skipped = new Map<string, number>();
  readonly #warnings: string[] = [];
  readonly #prefabs = new Map<string, Promise<string>>();
  /** 转好的预制体（内容路径 → 实体和改了名的 id），场景里的实例转成引用时和它比。 */
  readonly #convertedPrefabs = new Map<string, ConvertedPrefab>();
  readonly #sounds = new Map<string, Promise<string>>();
  readonly #spriteSheets = new Map<string, Promise<string>>();

  /** out：内容根目录，导出的文件按内容路径放在下面。 */
  constructor(project: StrideProject, tools: StrideTools, out: string, { specularCubemapSize = 256, plain = false, overrides = '', textureEncoding = 'ktx2', systemFontDirs, cache }: ImporterOptions = {}) {
    this.#project = project;
    this.#tools = tools;
    this.#out = out;
    this.#options = { specularCubemapSize, plain, overrides, textureEncoding };
    const write = (contentPath: string, data: string | Uint8Array) => this.#write(contentPath, data);
    this.#materials = new MaterialImporter({ project, tools, options: this.#options, warnings: this.#warnings, write, ...(cache ? { cache } : {}) });
    this.#fonts = new FontImporter({ project, tools, warnings: this.#warnings, write, ...(systemFontDirs ? { systemFontDirs } : {}) });
    this.#ui = new UIImporter({
      project,
      warnings: this.#warnings,
      write,
      spriteSheet: (asset) => this.#spriteSheet(asset),
      texture: (asset) => this.#materials.texture(asset),
      font: (asset) => this.#fonts.font(asset),
    });
  }

  /** 到现在为止的警告（各次导入累计）。 */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /** 到现在为止跳过的组件（类型名到个数，各次导入累计）。 */
  get skipped(): ReadonlyMap<string, number> {
    return this.#skipped;
  }

  /**
   * 单独导入一个不挂在场景上的资源，返回它的内容路径：脚本用代码加载的资源（Stride 的 Content.Load：模型、材质、动画、预制体、
   * 字体、贴图、精灵表、UI、声音，同脚本属性能引用的那些），和游戏设置（.sdgamesettings：默认场景的路径、合成器的根是游戏自己的
   * 渲染器时它的类型名和属性，属性引用的字体、贴图一起导入）。场景要另外用 importScene 导入。
   */
  importAsset(asset: AssetEntry): Promise<string> {
    if (asset.type === 'GameSettingsAsset') return this.#gameSettingsFile(asset);
    const importer = asset.type === 'SceneAsset' ? undefined : this.#assetImporter(asset, asset.file);
    if (!importer) throw new Error(`${asset.file}: importing ${asset.type} on its own is not supported`);
    return importer[1]();
  }

  async #gameSettingsFile(asset: AssetEntry): Promise<string> {
    const sceneReference = parseAssetReference(asset.data['DefaultScene']);
    const compositorReference = parseAssetReference(asset.data['GraphicsCompositor']);
    const compositor = compositorReference ? importCompositor(this.#project.get(compositorReference.id, asset.file).data) : undefined;
    const game = compositor?.gameRenderer;
    const where = `${asset.file}: graphics compositor`;
    const renderer = game ? await this.#script(`${game.type},`, game.settings, where, { owners: new Map(), cameraSlots: compositor.cameraSlots, renderStages: compositor.renderStages }) : null;
    const defaults = asset.data['Defaults'];
    const rendering = (Array.isArray(defaults) ? defaults : []).map(asObject).find((d) => d?.$type?.startsWith('Stride.Graphics.RenderingSettings')) ?? {};
    const file: GameSettingsFile = {
      name: path.basename(asset.path),
      defaultScene: sceneReference ? this.#project.get(sceneReference.id, asset.file).path : null,
      renderer,
      defaultBackBufferSize: [asNumber(rendering['DefaultBackBufferWidth'], 1280), asNumber(rendering['DefaultBackBufferHeight'], 720)],
    };
    await this.#write(asset.path + EXTENSIONS.gameSettings, JSON.stringify(file, null, 1));
    return asset.path;
  }

  async importScene(asset: AssetEntry): Promise<ImportResult> {
    if (asset.type !== 'SceneAsset') throw new Error(`${asset.file} is a ${asset.type}, not a scene`);
    const compositor = importCompositor(this.#compositorOf(asset), (id) => {
      const texture = this.#project.get(id, asset.file);
      return texture.type === 'RenderTexture' ? renderTextureOf(texture) : undefined;
    });
    const files = (await this.#hierarchy(asset, compositor.cameraSlots)).entities;
    const usesPhysics = files.some((file) => file.components.static || file.components.character || file.components.body);
    const navigation = this.#navigationSettings(asset);
    const offset = vec3(asset.data['Offset'], 0);
    const scene: SceneFile = {
      name: path.basename(asset.path),
      ...(usesPhysics ? { physics: this.#physicsSettings(asset) } : {}),
      ...(usesPhysics && navigation ? { navigation } : {}),
      ...(offset.some((value) => value !== 0) ? { offset } : {}),
      ...(compositor.main ? { compositor: compositor.main } : {}),
      entities: files,
    };
    await this.#write(asset.path + EXTENSIONS.scene, JSON.stringify(scene, null, 1));
    return {
      scene: asset.path,
      entities: scene.entities.length,
      models: [...this.#models.keys()],
      ...this.#materials.imported,
      skipped: this.#skipped,
      warnings: this.#warnings,
    };
  }

  /** 导入预制体（.sdprefab），返回它的内容路径；脚本属性引用预制体时用，同一个只导入一次。 */
  #prefab(asset: AssetEntry): Promise<string> {
    return once(this.#prefabs, asset, async () => {
      const { entities, renamed } = await this.#hierarchy(asset, new Map());
      this.#convertedPrefabs.set(asset.path, { entities, renamed });
      const prefab: PrefabFile = { name: path.basename(asset.path), entities };
      await this.#write(asset.path + EXTENSIONS.prefab, JSON.stringify(prefab, null, 1));
    });
  }

  /**
   * 场景或预制体的实体层级（Hierarchy.Parts），父实体排在前面。cameraSlots 是合成器的相机槽位（预制体没有）。
   * 场景导入途中会导入脚本属性引用的预制体，所以层级里的引用表都放在这次调用的上下文里，不放在导入器上。
   * 预制体的实例转成引用（instances.ts）：renamed 是实例成员在 Stride 里的 id → 新 id。
   */
  async #hierarchy(asset: AssetEntry, cameraSlots: ReadonlyMap<string, number>): Promise<{ entities: SceneEntityFile[]; renamed: ReadonlyMap<string, string> }> {
    const parts = asset.data['Hierarchy'] && asObject(asset.data['Hierarchy'])?.['Parts'];
    if (!Array.isArray(parts)) throw new Error(`${asset.file}: no Hierarchy.Parts`);

    // 预制体的实例照场景文件里存的值（不和预制体合并，同 Stride 的资源编译器，见 docs/decisions.md 的"预制体的实例照文件里
    // 的值"），转成引用时这些值全部当覆盖，和预制体相同的去掉
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

    // 组件和实体的 Id → 所在实体的 Id（脚本属性和 InstanceComponent 里的 ref!! 引用用）
    const owners = new Map<string, string>();
    for (const entity of entities) {
      owners.set(entity['Id'] as string, entity['Id'] as string);
      for (const component of Object.values(asObject(entity['Components']) ?? {})) {
        const id = asObject(component)?.['Id'];
        if (typeof id === 'string') owners.set(id, entity['Id'] as string);
      }
    }
    const context: HierarchyContext = { owners, cameraSlots };
    const files = await Promise.all(entities.map((entity) => this.#entity(entity, parentOf.get(entity['Id'] as string) ?? null, asset, context)));
    // 实例的成员：Base 记着来自哪个预制体、对应预制体里的哪个实体、属于哪个实例；用到的预制体先导入（连嵌套的）
    const bases = new Map<string, StrideBase>();
    for (const part of parts) {
      const base = asObject(asObject(part)?.['Base']);
      const id = asObject(asObject(part)?.['Entity'])?.['Id'];
      if (!base || typeof id !== 'string') continue;
      const reference = String(base['BasePartAsset']);
      const prefab = this.#project.get(reference.slice(0, reference.indexOf(':')), asset.file);
      await this.#prefab(prefab);
      bases.set(id, { prefab: prefab.path, part: String(base['BasePartId']), instance: String(base['InstanceId']) });
    }
    const converted = convertInstances(parentsFirst(files), bases, this.#convertedPrefabs);
    if (converted.failure) this.#warnings.push(`${asset.file}: prefab instances kept expanded (${converted.failure})`);
    return { entities: [...converted.entities], renamed: converted.renamed };
  }

  async #entity(entity: StrideObject, parent: string | null, scene: AssetEntry, context: HierarchyContext): Promise<SceneEntityFile> {
    const where = `${scene.file}: entity '${String(entity['Name'])}'`;
    const transform = componentOf(entity, 'TransformComponent') ?? {};
    const components: Components = {};
    for (const component of Object.values(asObject(entity['Components']) ?? {})) {
      const object = asObject(component);
      const type = object?.$type ?? 'unknown';
      if (!object || type === 'TransformComponent') continue;
      if (type.startsWith(CONSTRAINT_PREFIX)) {
        const constraint = this.#constraint(type, object, where, context);
        if (constraint) components.constraints = [...(components.constraints ?? []), constraint];
        continue;
      }
      if (isScriptType(type)) {
        components.scripts = [...(components.scripts ?? []), await this.#script(type, object, where, context)];
        continue;
      }
      const handled = await this.#component(type, object, components, where, context);
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

  /**
   * Stride.BepuPhysics 的约束组件：A、B 引用的是物理组件，换成所在的实体；其余属性名首字母小写，向量、四元数换成数组。
   * 没有 A（或两体约束没有 B）的记警告、跳过。
   */
  #constraint(type: string, component: StrideObject, where: string, context: HierarchyContext): SceneConstraint | undefined {
    const name = type.slice(CONSTRAINT_PREFIX.length, type.indexOf(','));
    const constraintType = lowerFirst(name.replace(/ConstraintComponent$/, ''));
    const entity = (key: string) => {
      const reference = parseObjectReference(component[key]);
      return reference === undefined ? undefined : context.owners.get(reference);
    };
    const bodyA = entity('A'), bodyB = entity('B');
    const oneBody = constraintType.startsWith('oneBody');
    if (bodyA === undefined || (!oneBody && bodyB === undefined)) {
      this.#warnings.push(`${where}: ${name} has no ${bodyA === undefined ? 'A' : 'B'} body in this scene; skipping it`);
      return undefined;
    }
    const settings: Record<string, number | number[]> = {};
    for (const [key, value] of Object.entries(component)) {
      if (['Id', 'Enabled', 'A', 'B', '$type'].includes(key)) continue;
      if (typeof value === 'number') settings[lowerFirst(key)] = value;
      else {
        const vector = asObject(value);
        const keys = vector ? Object.keys(vector).join(',') : '';
        if (keys === 'X,Y,Z' || keys === 'X,Y,Z,W') settings[lowerFirst(key)] = Object.values(vector!).map((v) => asNumber(v, 0));
      }
    }
    return { type: constraintType, enabled: component['Enabled'] !== false, bodyA, ...(oneBody ? {} : { bodyB: bodyB! }), settings };
  }

  /** 游戏的脚本组件：类型名去掉程序集，属性名改成小写开头，值按 SceneScriptValue 换过来。 */
  async #script(type: string, component: StrideObject, where: string, context: HierarchyContext): Promise<SceneScript> {
    const name = type.includes(',') ? type.slice(0, type.indexOf(',')) : type;
    const props: Record<string, SceneScriptValue> = {};
    for (const [key, value] of Object.entries(component)) {
      // Priority 是 Stride 脚本基类的执行顺序，我们的脚本按挂上的顺序跑，不导入
      if (key === 'Id' || key === 'Priority' || key.startsWith('~') || key === '$type') continue;
      props[lowerFirst(key)] = await this.#scriptValue(value, `${where}: ${name}.${key}`, context);
    }
    return { type: name, props };
  }

  async #scriptValue(value: StrideValue | undefined, where: string, context: HierarchyContext): Promise<SceneScriptValue> {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const object = parseObjectReference(value);
      if (object !== undefined) {
        const stage = context.renderStages?.get(object);
        if (stage !== undefined) return stage;
        const entity = context.owners.get(object);
        if (entity === undefined) this.#warnings.push(`${where}: reference ${object} is not in this scene; using null`);
        return entity === undefined ? null : { $entity: entity };
      }
      const reference = parseAssetReference(value);
      if (reference && GUID.test(reference.id)) return this.#scriptAsset(this.#project.get(reference.id, where), where);
      return value;
    }
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.#scriptValue(item, where, context)));
    // 带类型标签的引用（`!Stride.BepuPhysics.BodyComponent,Stride.BepuPhysics ref!! Id`）解析出来是 { $type, value: 'ref!! Id' }
    if (typeof value['value'] === 'string' && parseObjectReference(value['value']) !== undefined) return this.#scriptValue(value['value'], where, context);
    const entries = Object.entries(value).filter(([key]) => key !== '$type');
    // Stride 把列表存成以哈希为键的映射；Vector2、Vector3、Quaternion 存成 X、Y（Z、W）
    if (entries.length > 0 && entries.every(([key]) => /^[0-9a-f]{32}$/.test(key))) return Promise.all(entries.map(([, item]) => this.#scriptValue(item, where, context)));
    const keys = entries.map(([key]) => key).join(',');
    if (keys === 'X,Y' || keys === 'X,Y,Z' || keys === 'X,Y,Z,W') return entries.map(([, item]) => (typeof item === 'number' ? item : 0));
    const object: Record<string, SceneScriptValue> = {};
    for (const [key, item] of entries) object[lowerFirst(key)] = await this.#scriptValue(item, where, context);
    return object;
  }

  /** 脚本属性引用的资源：能导入的种类导入并给出内容路径，别的记警告。场景只给路径，不跟着导入（要用 --scene 另外导入）。 */
  async #scriptAsset(asset: AssetEntry, where: string): Promise<SceneScriptValue> {
    const importer = this.#assetImporter(asset, where);
    if (!importer) {
      this.#warnings.push(`${where}: ${asset.type} ${asset.path} is not supported in script properties; using null`);
      return null;
    }
    return { $asset: await importer[1](), kind: importer[0] };
  }

  /** 按资源的类型给出它的种类和导入它的函数（返回内容路径）；不认识的类型是 undefined。 */
  #assetImporter(asset: AssetEntry, where: string): [SceneAssetKind, () => Promise<string>] | undefined {
    const kinds: Record<string, [SceneAssetKind, () => Promise<string>]> = {
      Model: ['model', () => this.#model(asset)],
      // 程序模型编出来也是模型（Stride 的 Model 类型的属性可以引用它）
      ProceduralModelAsset: ['model', () => this.#model(asset)],
      MaterialAsset: ['material', () => this.#materials.material(asset)],
      Animation: ['animation', () => this.#animation(asset)],
      SceneAsset: ['scene', () => Promise.resolve(asset.path)],
      PrefabAsset: ['prefab', () => this.#prefab(asset)],
      SpriteFont: ['font', () => this.#fonts.font(asset)],
      Texture: ['texture', () => this.#textureDescriptor(asset)],
      SpriteSheet: ['spriteSheet', () => this.#spriteSheet(asset)],
      UIPageAsset: ['uiPage', () => this.#ui.ui(asset)],
      UILibraryAsset: ['uiLibrary', () => this.#ui.ui(asset)],
      Sound: ['sound', () => this.#sound(asset, where)],
    };
    return kinds[asset.type];
  }

  /**
   * 声音（.sdsnd）：浏览器能解的源文件（mp3、ogg、wav、flac、aac）原样复制（D9 的 (c)，不转码），旁边写 SoundFile；
   * 别的格式报错（要转码，见 D9）。
   */
  #sound(asset: AssetEntry, where: string): Promise<string> {
    return once(this.#sounds, asset, async () => {
      const source = sourceOf(asset);
      const extension = path.extname(source).slice(1).toLowerCase();
      const encoding = SOUND_ENCODINGS[extension];
      if (!encoding) throw new Error(`${where}: sound ${asset.path} is a .${extension} file; only mp3, ogg, wav, flac and aac (m4a) are copied as they are`);
      await this.#write(`${asset.path}.${encoding}`, await readFile(source));
      const sound: SoundFile = {
        name: path.basename(asset.path),
        encoding,
        streamFromDisk: asset.data['StreamFromDisk'] === true,
        spatialized: asset.data['Spatialized'] === true,
      };
      await this.#write(asset.path + EXTENSIONS.sound, JSON.stringify(sound));
    });
  }

  /** 单独引用的贴图：导出贴图，旁边写它的 TextureRef（content.loadTexture 读）。 */
  async #textureDescriptor(asset: AssetEntry): Promise<string> {
    await this.#write(asset.path + EXTENSIONS.texture, JSON.stringify(await this.#textureRef(asset)));
    return asset.path;
  }

  /** 导出贴图，返回场景、资源文件里引用它的 TextureRef。 */
  async #textureRef(asset: AssetEntry): Promise<TextureRef> {
    const { texture, encoding, size, srgb } = await this.#materials.texture(asset);
    return { texture, ...(encoding === 'ktx2' ? {} : { encoding }), ...(size ? { size } : {}), srgb };
  }

  /** 把一个组件写进 components；不认识的返回 false。 */
  async #component(type: string, component: StrideObject, components: Components, where: string, context: HierarchyContext): Promise<boolean> {
    switch (type) {
      case 'ModelComponent': {
        const model = await this.#modelComponent(component, where);
        if (model) components.model = model;
        return true;
      }
      case 'CameraComponent':
        components.camera = cameraOf(component, context.cameraSlots);
        return true;
      case 'InstancingComponent':
        if (asObject(component['Type'])?.$type !== 'InstancingEntityTransform') this.#warnings.push(`${where}: instancing ${String(asObject(component['Type'])?.$type)} is not supported; using InstancingEntityTransform`);
        components.instancing = {};
        return true;
      case 'InstanceComponent': {
        // Master 引用的是 InstancingComponent 的 Id，换成它所在的实体
        const master = parseObjectReference(component['Master']);
        const entity = master === undefined ? undefined : context.owners.get(master);
        if (master !== undefined && entity === undefined) this.#warnings.push(`${where}: instancing master ${master} is not in this scene; using null`);
        components.instance = { master: entity ?? null };
        return true;
      }
      case 'AnimationComponent':
        components.animation = await this.#animationComponent(component, where);
        return true;
      case 'AudioEmitterComponent': {
        // 引擎自带同名的脚本；Sounds 是字典（键写成 "<项的 id>~<名字>"）
        const sounds: SceneScriptValue[] = [];
        for (const [key, reference] of Object.entries(asObject(component['Sounds']) ?? {})) {
          const asset = parseAssetReference(reference);
          if (asset) sounds.push({ name: dictionaryKey(key), sound: await this.#scriptAsset(this.#project.get(asset.id, where), where) });
        }
        const props = {
          sounds,
          useHRTF: component['UseHRTF'] === true,
          directionalFactor: asNumber(component['DirectionalFactor'], 0),
          // HrtfEnvironment 的 Small、Medium、Large、Outdoors
          environment: String(component['Environment'] ?? 'Small').toLowerCase(),
        };
        components.scripts = [...(components.scripts ?? []), { type: 'AudioEmitterComponent', props }];
        return true;
      }
      case 'AudioListenerComponent':
        components.scripts = [...(components.scripts ?? []), { type: 'AudioListenerComponent', props: {} }];
        return true;
      case 'RecastNavigationComponent':
        // Stride.BepuPhysics.Navigation 的寻路组件是个脚本（StartupScript），引擎自带同名的脚本
        components.scripts = [...(components.scripts ?? []), { type: 'RecastNavigationComponent', props: { speed: asNumber(component['Speed'], 5) } }];
        return true;
      case 'BepuNavigationBoundingBoxComponent':
        // Stride 里还没实现（源码里是 #warning unimplemented），导航网格不看它
        return true;
      case 'ModelNodeLinkComponent': {
        // Target 引用的是 ModelComponent 的 Id，换成它所在的实体
        const target = parseObjectReference(component['Target']);
        const entity = target === undefined ? undefined : context.owners.get(target);
        if (target !== undefined && entity === undefined) this.#warnings.push(`${where}: model node link target ${target} is not in this scene; using the parent`);
        components.nodeLink = { target: entity ?? null, nodeName: typeof component['NodeName'] === 'string' ? component['NodeName'] : '' };
        return true;
      }
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
      case 'UIElementLinkComponent': {
        // Target 引用的是 UIComponent 的 Id、Camera 引用的是 CameraComponent 的 Id，换成它们所在的实体
        const entity = (key: string, what: string) => {
          const id = parseObjectReference(component[key]);
          const owner = id === undefined ? undefined : context.owners.get(id);
          if (id !== undefined && owner === undefined) this.#warnings.push(`${where}: UI element link ${what} ${id} is not in this scene; using null`);
          return owner ?? null;
        };
        components.uiElementLink = { target: entity('Target', 'target'), camera: entity('Camera', 'camera'), nodeName: typeof component['NodeName'] === 'string' ? component['NodeName'] : '' };
        return true;
      }
      case 'UIComponent':
        components.ui = await this.#uiComponent(component, where);
        return true;
      case 'ParticleSystemComponent':
        components.particleSystem = await importParticleSystem(component, where, {
          texture: (id) => this.#textureRef(this.#project.get(id, where)),
          entity: (id) => context.owners.get(id),
          warn: (message) => this.#warnings.push(message),
        });
        return true;
      case 'BackgroundComponent': {
        const texture = parseAssetReference(component['Texture']);
        if (!texture) return false;
        const asset = this.#project.get(texture.id, where);
        const shared = { intensity: asNumber(component['Intensity'], 1), ...(renderGroupOf(component['RenderGroup']) !== 0 ? { renderGroup: renderGroupOf(component['RenderGroup']) } : {}) };
        components.background = component['Is2D'] === true
          ? { type: '2d', image: await this.#materials.texture(asset), ...shared }
          : { type: 'cubemap', texture: await this.#materials.cubemap(asset), ...shared };
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

  /** Stride 的 UIComponent：页面跟着导入；和 Stride 默认值一样的不写。 */
  async #uiComponent(component: StrideObject, where: string): Promise<SceneUI> {
    const page = parseAssetReference(component['Page']);
    const flag = (key: string, fallback: boolean) => (typeof component[key] === 'boolean' && component[key] !== fallback ? { [lowerFirst(key)]: component[key] } : {});
    const sampler = SPRITE_SAMPLERS[String(component['Sampler'] ?? 'LinearClamp')] ?? 'linearClamp';
    const renderGroup = renderGroupOf(component['RenderGroup']);
    return {
      page: page ? await this.#ui.ui(this.#project.get(page.id, where)) : null,
      resolution: vec3(component['Resolution'], 0, [1280, 720, 1000]),
      size: vec3(component['Size'], 0, [1.28, 0.72, 1]),
      resolutionStretch: lowerFirst(String(component['ResolutionStretch'] ?? 'FixedWidthAdaptableHeight')) as SceneUI['resolutionStretch'],
      ...flag('Enabled', true),
      ...(renderGroup !== 0 ? { renderGroup } : {}),
      ...flag('IsFullScreen', true),
      ...flag('IsBillboard', true),
      ...flag('IsFixedSize', false),
      ...flag('SnapText', true),
      ...(sampler === 'linearClamp' ? {} : { sampler }),
    };
  }

  /** Stride 的 SpriteComponent：SpriteFromTexture（贴图或渲染目标贴图）或 SpriteFromSheet（精灵表）。 */
  async #sprite(component: StrideObject, where: string): Promise<SceneSprite | undefined> {
    const provider = asObject(component['SpriteProvider']);
    const source = await this.#spriteSource(provider, where);
    if (!source) return undefined;
    if (component['Swizzle'] !== undefined && component['Swizzle'] !== 'None') this.#warnings.push(`${where}: sprite swizzle is not supported yet; ignored`);
    return {
      ...source,
      ...(component['Enabled'] === false ? { enabled: false } : {}),
      ...(renderGroupOf(component['RenderGroup']) !== 0 ? { renderGroup: renderGroupOf(component['RenderGroup']) } : {}),
      type: component['SpriteType'] === 'Billboard' ? 'billboard' : 'sprite',
      color: color4(component['Color']),
      intensity: asNumber(component['Intensity'], 1),
      // 精灵表的精灵由 Stride 的资源编译器看贴图有没有透明像素，我们一律当作透明（混合的结果一样）
      isTransparent: provider!['IsTransparent'] !== false,
      premultipliedAlpha: component['PremultipliedAlpha'] !== false,
      ignoreDepth: component['IgnoreDepth'] === true,
      isAlphaCutoff: component['IsAlphaCutoff'] === true,
      blendMode: SPRITE_BLENDS[String(component['BlendMode'] ?? 'Auto')] ?? 'auto',
      sampler: SPRITE_SAMPLERS[String(component['Sampler'] ?? 'LinearClamp')] ?? 'linearClamp',
    };
  }

  /** 精灵画什么：SpriteFromTexture 的贴图和尺寸设置，或 SpriteFromSheet 的精灵表和默认帧；不支持的警告后返回 undefined。 */
  async #spriteSource(provider: StrideObject | undefined, where: string): Promise<SceneSpriteFromTexture | SceneSpriteFromSheet | undefined> {
    if (provider?.$type === 'SpriteFromSheet') {
      const reference = parseAssetReference(provider['Sheet']);
      if (!reference) return undefined;
      return { sheet: await this.#spriteSheet(this.#project.get(reference.id, where)), frame: asNumber(provider['CurrentFrame'], 0) };
    }
    if (provider?.$type !== 'SpriteFromTexture') {
      this.#warnings.push(`${where}: sprite provider ${provider?.$type ?? 'null'} is not supported yet; the sprite is skipped`);
      return undefined;
    }
    const reference = parseAssetReference(provider['Texture']);
    if (!reference) return undefined;
    const asset = this.#project.get(reference.id, where);
    return {
      texture: asset.type === 'RenderTexture' ? renderTextureOf(asset) : await this.#materials.texture(asset),
      pixelsPerUnit: asNumber(provider['PixelsPerUnit'], 100),
      center: vec2(provider['Center'], 0),
      centerFromMiddle: provider['CenterFromMiddle'] !== false,
    };
  }

  /**
   * 导入精灵表（.sdsheet），返回它的内容路径。每张源图导出成一张贴图（内容路径是 `<精灵表>/<源图文件名>`），精灵记下
   * 它在源图上的区域；Stride 会把精灵重新打包进图集，画出来一样。贴图的设置取精灵表的（IsCompressed、UseSRgbSampling、
   * GenerateMipmaps，默认不生成 mip）。九宫格的边框（Borders，UI 用）记下来。
   */
  #spriteSheet(asset: AssetEntry): Promise<string> {
    return once(this.#spriteSheets, asset, async () => {
      const textures = new Map<string, Promise<ImportedTexture>>();
      const sprites = await Promise.all(Object.values(asObject(asset.data['Sprites']) ?? {}).map(async (value) => {
        const sprite = asObject(value)!;
        const source = sourceOf({ ...asset, data: sprite });
        let texture = textures.get(source);
        if (!texture) {
          const name = path.basename(source, path.extname(source));
          texture = this.#materials.texture({
            ...asset,
            id: `${asset.id}/${name}`,
            type: 'Texture',
            path: `${asset.path}/${name}`,
            data: {
              Source: sprite['Source'] ?? null,
              Type: {
                $type: 'ColorTextureType',
                UseSRgbSampling: asset.data['UseSRgbSampling'] ?? true,
                PremultiplyAlpha: asset.data['PremultiplyAlpha'] ?? true,
                ColorKeyEnabled: asset.data['ColorKeyEnabled'] ?? false,
                ...(asset.data['ColorKeyColor'] ? { ColorKeyColor: asset.data['ColorKeyColor'] } : {}),
              },
              IsCompressed: asset.data['IsCompressed'] ?? true,
              GenerateMipmaps: asset.data['GenerateMipmaps'] ?? false,
            },
          });
          textures.set(source, texture);
        }
        const region = asObject(sprite['TextureRegion']);
        // Stride 的 Borders 是 X 左、Y 上、Z 右、W 下
        const borders = ['X', 'Y', 'Z', 'W'].map((k) => asNumber(asObject(sprite['Borders'])?.[k], 0)) as [number, number, number, number];
        return {
          name: String(sprite['Name'] ?? ''),
          texture: await texture,
          region: [asNumber(region?.['X'], 0), asNumber(region?.['Y'], 0), asNumber(region?.['Width'], 0), asNumber(region?.['Height'], 0)] as const,
          pixelsPerUnit: asNumber(sprite['PixelsPerUnit'], 100),
          center: vec2(sprite['Center'], 0),
          centerFromMiddle: sprite['CenterFromMiddle'] !== false,
          ...(borders.some((b) => b !== 0) ? { borders } : {}),
        };
      }));
      const file: SpriteSheetFile = { name: path.basename(asset.path), sprites };
      await this.#write(asset.path + EXTENSIONS.spriteSheet, JSON.stringify(file, null, 1));
    });
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
      ...collisionMatrix(simulation),
    };
  }

  /** 场景的导航设置：GameSettings 里的 RecastNavigationConfiguration（没有时是 undefined，运行时用 Stride 的默认值）。 */
  #navigationSettings(scene: AssetEntry): SceneNavigation | undefined {
    const defaults = this.#gameSettings(scene)?.data['Defaults'];
    const configuration = (Array.isArray(defaults) ? defaults : []).map(asObject).find((d) => d?.$type === 'RecastNavigationConfiguration');
    if (!configuration) return undefined;
    const b = asObject(configuration['BuildSettings']) ?? {};
    for (const unsupported of ['PartitionType', 'VertsPerPoly'] as const) {
      const value = b[unsupported];
      if (value !== undefined && value !== 'WATERSHED' && value !== 6) this.#warnings.push(`${scene.file}: navigation ${unsupported} ${String(value)} is not supported; using ${unsupported === 'PartitionType' ? 'WATERSHED' : '6'}`);
    }
    return {
      build: {
        cellSize: asNumber(b['CellSize'], 0.3),
        cellHeight: asNumber(b['CellHeight'], 0.2),
        agentHeight: asNumber(b['AgentHeight'], 2),
        agentRadius: asNumber(b['AgentRadius'], 0.6),
        agentMaxClimb: asNumber(b['AgentMaxClimb'], 0.9),
        agentMaxSlopeDegrees: asNumber(b['AgentMaxSlope'], 45),
        tileSize: asNumber(b['TileSize'], 32),
        maxEdgeLength: asNumber(b['EdgeMaxLen'], 12),
        maxSimplificationError: asNumber(b['EdgeMaxError'], 1.3),
        minRegionSize: asNumber(b['MinRegionSize'], 8),
        mergeRegionSize: asNumber(b['MergedRegionSize'], 20),
        detailSampleDistance: asNumber(b['DetailSampleDist'], 6),
        detailSampleMaxError: asNumber(b['DetailSampleMaxError'], 1),
      },
      includedLayers: parseCollisionMask(b['IncludedLayers']),
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
      case 'LightPoint':
      case 'LightSpot': {
        // 默认值同 Stride：点光半径 1，聚光范围 3、内外锥角 30°、35°
        const color = asObject(asObject(type['Color'])?.['Value']) ?? {};
        const shadow = this.#localShadow(asObject(type['Shadow']), where);
        const rgb: Vec3Tuple = [asNumber(color['R'], 1), asNumber(color['G'], 1), asNumber(color['B'], 1)];
        return type.$type === 'LightSpot'
          ? { type: 'spot', color: rgb, intensity, range: asNumber(type['Range'], 3), angleInner: asNumber(type['AngleInner'], 30), angleOuter: asNumber(type['AngleOuter'], 35), ...(shadow ? { shadow } : {}) }
          : { type: 'point', color: rgb, intensity, radius: asNumber(type['Radius'], 1), ...(shadow ? { shadow } : {}) };
      }
      case 'LightSkybox': {
        const skybox = parseAssetReference(type['Skybox']);
        return skybox ? { type: 'skybox', skybox: await this.#materials.skybox(this.#project.get(skybox.id, where)), intensity } : undefined;
      }
      default:
        return undefined;
    }
  }

  /** 方向光的阴影（LightDirectionalShadowMap）；没开时返回 undefined。没写的字段取 Stride 的默认值。 */
  /** 点光、聚光的阴影（LightPointShadowMap、LightStandardShadowMap）：大小、滤波和两个偏移，默认值同 Stride。 */
  #localShadow(shadow: StrideObject | undefined, where: string): SceneLocalLightShadow | undefined {
    if (!shadow || shadow['Enabled'] !== true) return undefined;
    const bias = asObject(shadow['BiasParameters']) ?? {};
    return {
      size: SHADOW_SIZES[String(shadow['Size'] ?? 'Medium')] ?? 'medium',
      filter: this.#shadowFilter(shadow, where),
      depthBias: asNumber(bias['DepthBias'], 0.01),
      normalOffsetScale: asNumber(bias['NormalOffsetScale'], 10),
    };
  }

  #shadowFilter(shadow: StrideObject, where: string): SceneLightShadow['filter'] {
    const filter = asObject(shadow['Filter']);
    if (filter?.$type === 'LightShadowMapFilterTypePcf') return PCF_FILTERS[String(filter['FilterSize'] ?? 'Filter3x3')] ?? 'pcf3x3';
    if (filter) this.#warnings.push(`${where}: shadow filter ${filter.$type ?? 'value'} is not supported; using a single comparison sample`);
    return 'none';
  }

  #shadow(shadow: StrideObject | undefined, where: string): SceneLightShadow | undefined {
    if (!shadow || shadow['Enabled'] !== true) return undefined;
    const filterName = this.#shadowFilter(shadow, where);
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

  /** 模型组件；没有模型（`Model: null`，Stride 里就是不画）时是 undefined。 */
  async #modelComponent(component: StrideObject, where: string): Promise<SceneEntityFile['components']['model']> {
    const reference = parseAssetReference(component['Model']);
    if (!reference) return undefined;
    const model = await this.#model(this.#project.get(reference.id, where));
    // 按槽覆盖材质：键是 "<hash>~<槽号>"
    const materials: (string | null)[] = [];
    for (const [key, value] of Object.entries(asObject(component['Materials']) ?? {})) {
      const slot = Number(dictionaryKey(key));
      const material = parseAssetReference(value);
      if (!Number.isInteger(slot) || !material) continue;
      while (materials.length < slot) materials.push(null);
      materials[slot] = await this.#materials.material(this.#project.get(material.id, where));
    }
    const renderGroup = renderGroupOf(component['RenderGroup']);
    return { model, materials, ...(component['IsShadowCaster'] === false ? { isShadowCaster: false } : {}), ...(renderGroup !== 0 ? { renderGroup } : {}) };
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
    const materials = await Promise.all(slotAssets.map((material) => (material ? this.#materials.material(material) : null)));
    // 材质用法线贴图的槽：这些网格要生成切线
    const normalMapped = await Promise.all(slotAssets.map(async (material) => material !== null && needsTangents(await this.#materials.materialFile(material))));

    const { pivot, scale } = importTransform(asset);
    const skeletonReference = parseAssetReference(asset.data['Skeleton']);
    const skeleton = skeletonReference ? await this.#skeleton(this.#project.get(skeletonReference.id, asset.file)) : undefined;
    const modelTransform = importMatrix(asset);
    const scene = await loadSourceScene(this.#tools, sourceOf(asset));
    try {
      const meshes: SourceMesh[] = [];
      // 模型的形变目标表：各网格同名的目标合成一个槽（同 Stride 的 ModelMorphLayout）
      const morphTargets: string[] = [];
      for (let m = 0; m < scene.meshCount; m++) {
        const data = scene.mesh(m);
        // 没有材质的网格（OBJ 没写 usemtl）：Assimp 给它一个叫 DefaultMaterial 的材质，Stride 的模型资源里就是这个槽位
        const materialName = data.material === null ? 'DefaultMaterial' : scene.materials[data.material];
        // Stride 的 glTF 导入把没有材质的网格放进叫 Material 的槽（FBX、OBJ 经 Assimp 是 DefaultMaterial）
        // 槽位名按 Stride 导入时的清理找：原名；Blender 导出时重名的材质带 .001 这样的后缀，Stride 的模型资源里只列了不带后缀的；
        // FBX 的命名空间（c100:chr:x），新版 Stride 只留最后一段（CleanNodeName），旧版把 : 换成 _（UIElementLink 的骑士）
        const candidates = materialName === undefined ? [] : [materialName, materialName.replace(/\.\d{3}$/, ''), cleanNodeName(materialName), materialName.replaceAll(':', '_'), ...(data.material === null ? ['Material'] : [])];
        let slot = candidates.map((name) => slotNames.indexOf(name)).find((index) => index >= 0) ?? -1;
        if (slot < 0 && slots.length > 0) {
          this.#warnings.push(`${asset.file}: mesh material '${materialName}' has no slot in the model; using slot 0`);
          slot = 0;
        }
        const skin = skeleton ? meshSkin(data, scene, skeleton, modelTransform, asset.file, (message) => this.#warnings.push(message)) : undefined;
        const morph = sourceMorph(data, scale, morphTargets);
        const mesh: SourceMesh = {
          name: `mesh${m}`, material: slot < 0 ? null : slot, vertices: interleave(data, pivot, scale), indices: data.indices, ...(skin ? { skin } : {}), ...(morph ? { morph } : {}),
        };
        if (slot < 0 || !normalMapped[slot]) meshes.push(mesh);
        else if (data.normals && data.uvs) meshes.push(addTangents(mesh, this.#tools));
        else {
          this.#warnings.push(`${asset.file}: mesh ${m} has a normal-mapped material but no ${data.normals ? 'UVs' : 'normals'}; it gets no tangents`);
          meshes.push(mesh);
        }
      }
      const encoded: ModelMeshData[] = this.#options.plain
        ? meshes.map((mesh) => ({
          ...plainMesh(mesh.name, mesh.material, mesh.vertices, mesh.vertices.length / VERTEX_FLOATS <= 0xffff ? Uint16Array.from(mesh.indices) : mesh.indices, { ...(mesh.tangents ? { tangents: mesh.tangents } : {}), ...(mesh.skin ? { skin: mesh.skin } : {}) }),
          ...meshMorph(mesh),
        }))
        : compressMeshes(meshes, this.#tools);
      await this.#write(asset.path + EXTENSIONS.model, encodeModel({
        meshes: encoded, materials, ...(skeleton ? { skeleton: skeleton.path } : {}), ...(morphTargets.length > 0 ? { morphTargets } : {}),
      }));
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
    const material = materialAsset ? await this.#materials.material(materialAsset) : null;
    let mesh: SourceMesh = {
      name: 'mesh0',
      // 程序模型总有一个材质槽（Stride 的 MaterialInstance）：模型自己没给材质时槽是空的，实体的 Materials 照样能按槽覆盖
      material: 0,
      vertices: interleave({ positions: generated.positions, normals: generated.normals, uvs: generated.uvs }, [0, 0, 0], 1),
      indices: generated.indices,
    };
    if (materialAsset && needsTangents(await this.#materials.materialFile(materialAsset))) mesh = addTangents(mesh, this.#tools);
    const encoded = this.#options.plain
      ? [plainMesh(mesh.name, mesh.material, mesh.vertices, mesh.vertices.length / VERTEX_FLOATS <= 0xffff ? Uint16Array.from(mesh.indices) : mesh.indices, mesh.tangents ? { tangents: mesh.tangents } : {})]
      : compressMeshes([mesh], this.#tools);
    await this.#write(asset.path + EXTENSIONS.model, encodeModel({ meshes: encoded, materials: [material] }));
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
      // 没有骨架的剪辑只动形变权重（MorphTargets 的立方体）
      const reference = parseAssetReference(asset.data['Skeleton']);
      await importAnimation(asset, reference ? await this.#skeleton(this.#project.get(reference.id, asset.file)) : undefined, this.#animationContext);
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
  async #write(contentPath: string, data: string | Uint8Array): Promise<void> {
    const file = path.join(this.#out, contentPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
}

/** Stride 的 LightShadowMapSize、LightShadowMapFilterTypePcfSize、LightShadowMapCascadeCount、LightShadowMapStabilizationMode。 */
const SHADOW_SIZES: Readonly<Record<string, SceneLightShadow['size']>> = { XSmall: 'xsmall', Small: 'small', Medium: 'medium', Large: 'large', XLarge: 'xlarge' };
const PCF_FILTERS: Readonly<Record<string, SceneLightShadow['filter']>> = { Filter3x3: 'pcf3x3', Filter5x5: 'pcf5x5', Filter7x7: 'pcf7x7' };
const CASCADE_COUNTS: Readonly<Record<string, SceneLightShadow['cascadeCount']>> = { OneCascade: 'one', TwoCascades: 'two', FourCascades: 'four' };
const STABILIZATION_MODES: Readonly<Record<string, SceneLightShadow['stabilization']>> = { None: 'none', ViewSnapping: 'viewSnapping', ProjectionSnapping: 'projectionSnapping' };

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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BepuSimulation 的碰撞矩阵（Layer0 到 Layer31 各是一个 CollisionMask）：Stride 按对称矩阵存，反序列化时按层号依次
 * Set(layer, mask)，两层共有的那一位以后设的为准，没写的层保持全部碰撞。全部碰撞时不写。
 */
function collisionMatrix(simulation: StrideObject): { collisionMasks?: number[] } {
  const masks = Array.from({ length: 32 }, () => 0xffffffff);
  let listed = false;
  for (let layer = 0; layer < 32; layer++) {
    const value = simulation[`Layer${layer}`];
    if (value === undefined) continue;
    listed = true;
    const mask = parseCollisionMask(value);
    for (let other = 0; other < 32; other++) {
      const collide = ((mask >>> other) & 1) !== 0;
      masks[layer] = collide ? masks[layer]! | (1 << other) : masks[layer]! & ~(1 << other);
      masks[other] = collide ? masks[other]! | (1 << layer) : masks[other]! & ~(1 << layer);
    }
  }
  return listed && masks.some((mask) => mask >>> 0 !== 0xffffffff) ? { collisionMasks: masks.map((mask) => mask >>> 0) } : {};
}

/**
 * 游戏的脚本：带程序集名、不在 Stride 的命名空间里（引擎组件要么没有命名空间，要么以 Stride. 开头）；或者用 DataContract
 * 起了短名的（MorphTargets 的 `!MorphTargetsController`）：没有命名空间、名字也不以 Component 结尾（引擎组件的短名都是）。
 */
function isScriptType(type: string): boolean {
  if (type.includes(',')) return !type.startsWith('Stride.');
  return !type.endsWith('Component');
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
/** 网格的形变目标：位置增量乘导入缩放（pivot 是平移，不影响增量），目标按名字放进模型的目标表（没有的加在后面）。 */
function sourceMorph(data: MeshData, scale: number, morphTargets: string[]): SourceMorph | undefined {
  if (data.morphTargets.length === 0) return undefined;
  const slots = data.morphTargets.map(({ name }) => {
    const found = morphTargets.indexOf(name);
    return found >= 0 ? found : morphTargets.push(name) - 1;
  });
  return {
    slots,
    positions: data.morphTargets.map(({ positions }) => (scale === 1 ? positions : positions.map((value) => value * scale))),
    normals: data.morphTargets.map(({ normals }) => normals),
  };
}

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

/** 材质有法线贴图（贴图或颜色树）：网格要有 MikkTSpace 切线。 */
function needsTangents(material: MaterialFile): boolean {
  return material.normalMap !== undefined || material.normalTree !== undefined;
}
