/**
 * 资源文件引用了哪些别的资源。运行时的预加载（SceneBuilder.preload）和编辑器的资源数据库（@stride-ts/editor）都从这里取，
 * 所以"加载场景会去读哪些文件"和"数据库里谁引用了谁"是同一份逻辑。只依赖文件格式的类型，Node 里也能直接运行（所以相对导入
 * 写了扩展名）。
 */
import type {
  EXTENSIONS, GameSettingsFile, ModelData, SceneAssetKind, SceneEntityFile, SceneRenderTexture, SkyboxFile, SpriteSheetFile, TextureRef, UIFile,
  UISpriteValue,
} from './format';
import { textureRefs } from './loading.ts';
import { scriptAssetRefs } from './sceneScripts.ts';

/**
 * 资源的种类：内容文件的种类（EXTENSIONS 的键，字形块算字体的一部分），加上贴图文件（image：.ktx2、.svg、.png、.jpg）和
 * 声音的音频文件（audio）。
 */
export type AssetKind = Exclude<keyof typeof EXTENSIONS, 'glyphs'> | 'image' | 'audio';

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
  | { readonly kind: SceneAssetKind | 'skybox' | 'cubemap'; readonly path: string }
  | { readonly kind: 'image'; readonly path: string; readonly texture: TextureRef }
  | { readonly kind: 'renderTexture'; readonly path: string; readonly texture: SceneRenderTexture };

/** 实体文件引用的资源，按文件里的顺序，不去重；包括脚本属性引用的。 */
export function entityAssetReferences(files: readonly SceneEntityFile[]): EntityAssetReference[] {
  const refs: EntityAssetReference[] = [];
  const image = (texture: TextureRef | SceneRenderTexture): void => {
    if ('renderTexture' in texture) refs.push({ kind: 'renderTexture', path: texture.renderTexture, texture });
    else refs.push({ kind: 'image', path: texture.texture, texture });
  };
  for (const { components: c } of files) {
    if (c.model) {
      refs.push({ kind: 'model', path: c.model.model });
      for (const material of c.model.materials) if (material !== null) refs.push({ kind: 'material', path: material });
    }
    // 网格、凸包形状的碰撞体引用模型
    for (const shape of [...(c.static?.shapes ?? []), ...(c.character?.shapes ?? []), ...(c.body?.shapes ?? [])]) {
      if (shape.type === 'mesh' || shape.type === 'convexHull') refs.push({ kind: 'model', path: shape.model });
    }
    for (const { clip } of c.animation?.animations ?? []) refs.push({ kind: 'animation', path: clip });
    if (c.light?.type === 'skybox') refs.push({ kind: 'skybox', path: c.light.skybox });
    if (c.background?.type === 'cubemap') refs.push({ kind: 'cubemap', path: c.background.texture });
    else if (c.background) image(c.background.image);
    if (c.sprite && 'sheet' in c.sprite) refs.push({ kind: 'spriteSheet', path: c.sprite.sheet });
    else if (c.sprite) image(c.sprite.texture);
    if (c.particleSystem) textureRefs(c.particleSystem).forEach(image);
    if (c.ui?.page) refs.push({ kind: 'uiPage', path: c.ui.page });
    refs.push(...scriptAssetRefs(c.scripts ?? []));
  }
  return refs;
}

/** UI 文件引用的资源（加载时先并行加载好）。 */
export function uiAssetPaths(file: UIFile): { spriteSheets: string[]; fonts: string[]; textures: Extract<UISpriteValue, { texture: TextureRef }>[] } {
  const spriteSheets = new Set<string>(), fonts = new Set<string>();
  const textures: Extract<UISpriteValue, { texture: TextureRef }>[] = [];
  for (const element of file.elements) {
    for (const value of Object.values({ ...element.props, ...element.attached })) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      if ('$asset' in value) fonts.add(value.$asset);
      else if ('sheet' in value) spriteSheets.add(value.sheet);
      else if ('texture' in value) textures.push(value as Extract<UISpriteValue, { texture: TextureRef }>);
    }
  }
  return { spriteSheets: [...spriteSheets], fonts: [...fonts], textures };
}

/** 脚本属性里的资源种类 → 资源文件的种类（UI 页面和 UI 库是同一种文件）。 */
const fileKind = (kind: SceneAssetKind | 'skybox' | 'cubemap'): AssetKind => (kind === 'uiPage' || kind === 'uiLibrary' ? 'ui' : kind);

/**
 * 一个资源文件引用的别的资源，去过重。file 是解析好的内容：JSON 文件是它的对象，模型是 decodeModel 的结果；别的二进制
 * 文件（骨架、动画、立方体贴图、贴图、音频）不引用别的资源，不用给。path 是这个资源自己的内容路径（声音的音频文件和它同名）。
 */
export function assetReferences(kind: AssetKind, path: string, file: unknown): AssetReference[] {
  const refs: AssetReference[] = [];
  const image = ({ texture }: TextureRef) => refs.push({ kind: 'image', path: texture });
  const fromEntities = (found: readonly EntityAssetReference[]) => {
    for (const ref of found) {
      if (ref.kind === 'image') refs.push({ kind: 'image', path: ref.path });
      else if (ref.kind !== 'renderTexture') refs.push({ kind: fileKind(ref.kind), path: ref.path });
    }
  };
  switch (kind) {
    case 'scene':
    case 'prefab':
      fromEntities(entityAssetReferences((file as { entities: readonly SceneEntityFile[] }).entities));
      break;
    case 'model': {
      const { materials, skeleton } = file as Pick<ModelData, 'materials' | 'skeleton'>;
      for (const material of materials) if (material !== null) refs.push({ kind: 'material', path: material });
      if (skeleton !== undefined) refs.push({ kind: 'skeleton', path: skeleton });
      break;
    }
    case 'material':
      textureRefs(file).forEach(image);
      break;
    case 'spriteSheet':
      for (const sprite of (file as SpriteSheetFile).sprites) image(sprite.texture);
      break;
    case 'skybox':
      refs.push({ kind: 'cubemap', path: (file as SkyboxFile).radiance });
      break;
    case 'ui': {
      const { spriteSheets, fonts, textures } = uiAssetPaths(file as UIFile);
      for (const sheet of spriteSheets) refs.push({ kind: 'spriteSheet', path: sheet });
      for (const font of fonts) refs.push({ kind: 'font', path: font });
      for (const { texture } of textures) image(texture);
      break;
    }
    case 'gameSettings': {
      const { defaultScene, renderer } = file as GameSettingsFile;
      if (defaultScene !== null) refs.push({ kind: 'scene', path: defaultScene });
      if (renderer) for (const ref of scriptAssetRefs([renderer])) refs.push({ kind: fileKind(ref.kind), path: ref.path });
      break;
    }
    case 'texture':
      image(file as TextureRef);
      break;
    case 'sound':
      refs.push({ kind: 'audio', path });
      break;
    default:
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.path}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
