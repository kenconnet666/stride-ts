/**
 * 资源文件引用了哪些别的资源。运行时的预加载（SceneBuilder.preload）和编辑器的资源数据库（@stride-ts/editor）都从这里取，
 * 所以"加载场景会去读哪些文件"和"数据库里谁引用了谁"是同一份逻辑。编辑器移动、改名资源时也照这里找到的位置改写引用它的
 * 文件（assetReferenceSlots）。只依赖文件格式的类型，Node 里也能直接运行（所以相对导入写了扩展名）。
 */
import type {
  AnimationData, BuildingFile, BrushFile, CityFile, WaterFile, SdfFile, PolyMeshFile, EXTENSIONS, MaterialFile, GameSettingsFile, TimelineFile, ModelData, ScatterFile, SceneAssetKind, SceneEntityFile, TreeFile, SceneRenderTexture, SkyboxFile, SoundFile, SplineFile, SpriteSheetFile, TerrainFile, TextModelFile, TextureRef, UIFile,
  UISpriteValue,
} from './formats/format';
import { textureRefs } from './loading.ts';
import { visitScriptAssets } from './sceneScripts.ts';

/**
 * 资源的种类：内容文件的种类（EXTENSIONS 的键，字形块算字体的一部分），加上贴图文件（image：.ktx2、.svg、.png、.jpg）、
 * 声音的音频文件（audio）和导入设置旁边的源模型文件（modelSource：.glb、.gltf、.fbx、.obj）。
 */
export type AssetKind = Exclude<keyof typeof EXTENSIONS, 'glyphs'> | 'image' | 'audio' | 'modelSource';

export interface AssetReference {
  readonly kind: AssetKind;
  /** 内容路径（不带扩展名）。 */
  readonly path: string;
}

/**
 * 实体文件（场景、预制体）里对资源的一处引用。kind 是加载它的方式：脚本属性引用的 UI 分页面和库（文件是同一种），贴图带着
 * 怎么读它的设置，渲染目标贴图不是文件（运行时建）。
 */
export type EntityAssetReference =
  | { readonly kind: SceneAssetKind | 'skybox' | 'cubemap' | 'lightProfile' | 'splats' | 'terrain' | 'scatter' | 'city' | 'water'; readonly path: string }
  | { readonly kind: 'image'; readonly path: string; readonly texture: TextureRef }
  | { readonly kind: 'renderTexture'; readonly path: string; readonly texture: SceneRenderTexture };

/** 文件里写着这个路径的地方：`owner[key]` 是那个字符串。 */
type Place = readonly [owner: object, key: string | number];

/** 实体文件引用的资源，按文件里的顺序，不去重；包括脚本属性引用的。 */
export function entityAssetReferences(files: readonly SceneEntityFile[]): EntityAssetReference[] {
  const refs: EntityAssetReference[] = [];
  visitEntityReferences(files, (ref) => refs.push(ref));
  return refs;
}

/**
 * 实体文件里的每一处引用，连同它写在哪；包括预制体实例的覆盖里的（visitOverrideReferences）。组件可以不全（覆盖只写了
 * 改的那一处）：缺的部分跳过。空路径（编辑器里刚加上、还没选资源的槽）不算引用：不加载、不报断了的引用。
 */
function visitEntityReferences(files: readonly SceneEntityFile[], visitAny: (ref: EntityAssetReference, ...place: Place) => void): void {
  const visit = (ref: EntityAssetReference, ...place: Place) => {
    if (ref.path !== '') visitAny(ref, ...place);
  };
  const image = (texture: TextureRef | SceneRenderTexture | undefined): void => {
    if (!texture) return;
    if ('renderTexture' in texture) visit({ kind: 'renderTexture', path: texture.renderTexture, texture }, texture, 'renderTexture');
    else visit({ kind: 'image', path: texture.texture, texture }, texture, 'texture');
  };
  for (const entity of files) {
    const c = entity.components;
    if (entity.prefab) visitOverrideReferences(entity.prefab, visit);
    if (c.model) {
      if (typeof c.model.model === 'string') visit({ kind: 'model', path: c.model.model }, c.model, 'model');
      const materials = c.model.materials;
      materials?.forEach((material, i) => typeof material === 'string' && visit({ kind: 'material', path: material }, materials, i));
    }
    // 网格、凸包形状的碰撞体引用模型
    for (const shape of [...(c.static?.shapes ?? []), ...(c.character?.shapes ?? []), ...(c.body?.shapes ?? [])]) {
      if (shape.type === 'mesh' || shape.type === 'convexHull') visit({ kind: 'model', path: shape.model }, shape, 'model');
    }
    for (const animation of c.animation?.animations ?? []) visit({ kind: 'animation', path: animation.clip }, animation, 'clip');
    if (c.light?.type === 'skybox') visit({ kind: 'skybox', path: c.light.skybox }, c.light, 'skybox');
    if ((c.light?.type === 'point' || c.light?.type === 'spot') && c.light.profile) visit({ kind: 'lightProfile', path: c.light.profile }, c.light, 'profile');
    if (c.gaussianSplat) visit({ kind: 'splats', path: c.gaussianSplat.splats }, c.gaussianSplat, 'splats');
    if (c.terrain) visit({ kind: 'terrain', path: c.terrain.terrain }, c.terrain, 'terrain');
    if (c.scatter) visit({ kind: 'scatter', path: c.scatter.scatter }, c.scatter, 'scatter');
    if (c.city) visit({ kind: 'city', path: c.city.city }, c.city, 'city');
    if (c.water) visit({ kind: 'water', path: c.water.water }, c.water, 'water');
    if (c.background?.type === 'cubemap') visit({ kind: 'cubemap', path: c.background.texture }, c.background, 'texture');
    else if (c.background) image(c.background.image);
    if (c.decal?.albedo) image(c.decal.albedo);
    // 法线贴图默认按线性读（同材质的法线贴图）
    if (c.decal?.normal) visit({ kind: 'image', path: c.decal.normal.texture, texture: { srgb: false, ...c.decal.normal } }, c.decal.normal, 'texture');
    if (c.sprite && 'sheet' in c.sprite) visit({ kind: 'spriteSheet', path: c.sprite.sheet }, c.sprite, 'sheet');
    else if (c.sprite) image(c.sprite.texture);
    if (c.particleSystem) textureRefs(c.particleSystem).forEach(image);
    if (c.ui?.page) visit({ kind: 'uiPage', path: c.ui.page }, c.ui, 'page');
    visitScriptAssets(c.scripts ?? [], (value) => visit({ kind: value.kind, path: value.$asset }, value, '$asset'));
  }
}

/**
 * 预制体实例的覆盖里的资源路径（换材质、换模型、脚本属性引用的资源）：覆盖的值按它的路径放进一个只有这一处的实体，照实体的
 * 规则找；值本身就是路径时，找到的位置换回覆盖上（`override.value`），所以移动资源时改写的是覆盖。
 */
function visitOverrideReferences(prefab: NonNullable<SceneEntityFile['prefab']>, visit: (ref: EntityAssetReference, ...place: Place) => void): void {
  for (const override of prefab.set ?? []) {
    const { path } = override;
    if (path[0] !== 'components' || path.length < 2) continue;
    const probe: Record<string | number, unknown> = {};
    let node: Record<string | number, unknown> | unknown[] = probe;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      // 覆盖的路径里脚本按类型名指：放成只有这一个脚本的列表
      if (Array.isArray(node) && path[i - 1] === 'scripts') {
        const script = { type: key, props: {} };
        node.push(script);
        node = script;
        continue;
      }
      const child = key === 'scripts' || typeof path[i + 1] === 'number' ? [] : {};
      (node as Record<string | number, unknown>)[key] = child;
      node = child;
    }
    const last = path.at(-1)!;
    if (Array.isArray(node) && path.at(-2) === 'scripts') node.push(override.value);
    else (node as Record<string | number, unknown>)[last] = override.value;
    const leaf = node;
    visitEntityReferences([{ components: probe['components'] } as unknown as SceneEntityFile], (ref, owner, key) => {
      if (owner === leaf && key === last) visit(ref, override, 'value');
      else visit(ref, owner, key);
    });
  }
}

/** UI 文件引用的资源（加载时先并行加载好）。 */
export function uiAssetPaths(file: UIFile): { spriteSheets: string[]; fonts: string[]; textures: Extract<UISpriteValue, { texture: TextureRef }>[] } {
  const spriteSheets = new Set<string>(), fonts = new Set<string>();
  const textures: Extract<UISpriteValue, { texture: TextureRef }>[] = [];
  for (const value of uiAssetValues(file)) {
    if ('$asset' in value) fonts.add(value.$asset);
    else if ('sheet' in value) spriteSheets.add(value.sheet);
    else textures.push(value);
  }
  return { spriteSheets: [...spriteSheets], fonts: [...fonts], textures };
}

/** UI 元素的属性里引用资源的值：字体（`$asset`）、精灵表里的精灵（`sheet`）、贴图（`texture`）。 */
function uiAssetValues(file: UIFile): ({ $asset: string } | { sheet: string } | Extract<UISpriteValue, { texture: TextureRef }>)[] {
  const values: ({ $asset: string } | { sheet: string } | Extract<UISpriteValue, { texture: TextureRef }>)[] = [];
  for (const element of file.elements) {
    for (const value of Object.values({ ...element.props, ...element.attached })) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      if ('$asset' in value || 'sheet' in value || 'texture' in value) values.push(value as (typeof values)[number]);
    }
  }
  return values;
}

/** 脚本属性里的资源种类 → 资源文件的种类（UI 页面和 UI 库是同一种文件）。 */
const fileKind = (kind: SceneAssetKind | 'skybox' | 'cubemap' | 'lightProfile' | 'splats' | 'terrain' | 'scatter' | 'city' | 'water'): AssetKind => (kind === 'uiPage' || kind === 'uiLibrary' ? 'ui' : kind);

/**
 * 一个资源文件引用的别的资源，去过重。file 是解析好的内容：JSON 文件是它的对象，模型、动画是 decodeModel、decodeAnimation
 * 的结果；别的二进制文件（骨架、立方体贴图、贴图、音频）不引用别的资源，不用给。path 是这个资源自己的内容路径（声音的音频文件和它同名）。
 */
export function assetReferences(kind: AssetKind, path: string, file: unknown): AssetReference[] {
  const refs: AssetReference[] = assetReferenceSlots(kind, file).map(({ kind, path }) => ({ kind, path }));
  // 声音的音频文件、导入设置的源模型不写在文件里，和它同名；合成的音效没有音频文件
  if (kind === 'sound' && (file as SoundFile | undefined)?.encoding !== 'synth') refs.push({ kind: 'audio', path });
  if (kind === 'modelImport') refs.push({ kind: 'modelSource', path });
  if (kind === 'imageImport') refs.push({ kind: 'image', path });
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.path}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** 文件里的一处引用，和它写在哪：`owner[key]` 是那个路径。编辑器移动、改名资源时改写它（file 要是可以改的那份）。 */
export interface AssetReferenceSlot extends AssetReference {
  readonly owner: object;
  readonly key: string | number;
}

/**
 * 一个资源文件里的每一处引用（按文件里的顺序，不去重），参数同 assetReferences。不含不写在文件里的引用（声音和它同名的
 * 音频文件）、不是文件的引用（渲染目标贴图）。
 */
export function assetReferenceSlots(kind: AssetKind, file: unknown): AssetReferenceSlot[] {
  const slots: AssetReferenceSlot[] = [];
  const add = (kind: AssetKind, owner: object, key: string | number) => slots.push({ kind, path: (owner as Record<string | number, string>)[key]!, owner, key });
  const image = (texture: TextureRef) => add('image', texture, 'texture');
  switch (kind) {
    case 'scene':
    case 'prefab': {
      const entities = (file as { entities: readonly SceneEntityFile[] }).entities;
      visitEntityReferences(entities, (ref, owner, key) => {
        if (ref.kind !== 'renderTexture') add(ref.kind === 'image' ? 'image' : fileKind(ref.kind), owner, key);
      });
      // 预制体实例引用它的预制体（覆盖的值里的资源路径在上面，visitEntityReferences 一起找了）
      for (const entity of entities) if (entity.prefab) add('prefab', entity.prefab, 'path');
      break;
    }
    case 'model': {
      const model = file as Pick<ModelData, 'materials' | 'skeleton'>;
      model.materials.forEach((material, i) => material !== null && add('material', model.materials, i));
      if (model.skeleton !== undefined) add('skeleton', model, 'skeleton');
      break;
    }
    case 'animation': {
      const animation = file as Pick<AnimationData, 'skeleton'>;
      if (animation.skeleton !== undefined) add('skeleton', animation, 'skeleton');
      break;
    }
    case 'material':
      textureRefs(file).forEach(image);
      // 节点图里贴图节点引用的贴图资源
      for (const node of (file as MaterialFile).graph?.nodes ?? []) {
        if (node.type === 'texture' && typeof node.params?.['texture'] === 'string') add('texture', node.params, 'texture');
      }
      break;
    case 'spriteSheet':
      for (const sprite of (file as SpriteSheetFile).sprites) image(sprite.texture);
      break;
    case 'skybox':
      add('cubemap', file as SkyboxFile, 'radiance');
      break;
    case 'ui':
      for (const value of uiAssetValues(file as UIFile)) {
        if ('$asset' in value) add('font', value, '$asset');
        else if ('sheet' in value) add('spriteSheet', value, 'sheet');
        else image(value.texture);
      }
      break;
    case 'gameSettings': {
      const settings = file as GameSettingsFile;
      if (settings.defaultScene !== null) add('scene', settings, 'defaultScene');
      if (settings.renderer) visitScriptAssets([settings.renderer], (value) => add(fileKind(value.kind), value, '$asset'));
      break;
    }
    case 'texture':
      image(file as TextureRef);
      break;
    case 'timeline':
      for (const track of (file as TimelineFile).tracks) if (track.type === 'sound') for (const clip of track.clips) add('sound', clip, 'sound');
      break;
    case 'brush':
    case 'sdf':
    case 'poly': {
      const materials = (file as BrushFile | SdfFile | PolyMeshFile).materials;
      materials.forEach((material, i) => material !== null && add('material', materials, i));
      break;
    }
    case 'tree':
    case 'building':
    case 'spline': {
      const materials = (file as SplineFile | TreeFile | BuildingFile).materials;
      materials.forEach((material, i) => material !== null && add('material', materials, i));
      break;
    }
    case 'terrain': {
      const terrain = file as TerrainFile;
      if (terrain.material) add('material', terrain, 'material');
      // 贴着的样条：样条改了地形跟着重新加载、按改动的范围重算
      (terrain.splines ?? []).forEach((entry) => add('spline', entry, 'spline'));
      break;
    }
    case 'water': {
      const water = file as WaterFile;
      if (water.river) add('spline', water.river, 'spline');
      break;
    }
    case 'city': {
      const city = file as CityFile;
      city.roads.forEach((_, i) => add('spline', city.roads, i));
      city.buildings.forEach((rule) => add('model', rule, 'model'));
      break;
    }
    case 'scatter': {
      const layers = (file as ScatterFile).layers;
      layers.forEach((layer) => {
        if (layer.model) add('model', layer, 'model');
        layer.lods?.forEach((lod) => lod.model && add('model', lod, 'model'));
        if (layer.material) add('material', layer, 'material');
      });
      break;
    }
    case 'text': {
      const text = file as TextModelFile;
      text.materials.forEach((material, i) => material !== null && add('material', text.materials, i));
      if (text.font) add('font', text, 'font');
      break;
    }
    default:
  }
  return slots;
}
