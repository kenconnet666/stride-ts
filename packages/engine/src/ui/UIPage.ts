/**
 * UI 页面和 UI 库（Stride 的 UIPage、UILibrary），以及按导入的 UIFile 建元素树。页面加载时建一次元素树；UI 库每次
 * instantiateElement 都按模板新建一棵（同 Stride 的 UILibraryExtensions.InstantiateElement 克隆模板）。
 */
import type { UIElementFile, UIElementType, UIFile, UISpriteValue, UIStripDefinition, UIValue } from '../content/formats/format';
import type { SpriteSheet } from '../rendering/SpriteSheet';
import type { SpriteFont } from '../rendering/text/SpriteFont';
import type { Texture } from '../graphics/Texture';
import { Border } from './controls/Border';
import { ScrollingText } from './controls/ScrollingText';
import { Slider } from './controls/Slider';
import { ToggleButton } from './controls/ToggleButton';
import { Button, ImageButton } from './controls/Button';
import { ContentControl, ContentDecorator, ContentPresenter } from './controls/ContentControl';
import { EditText } from './controls/EditText';
import { ImageElement } from './controls/ImageElement';
import { ModalElement } from './controls/ModalElement';
import { ScrollBar, ScrollViewer } from './controls/ScrollViewer';
import { RichTextBlock } from './controls/RichTextBlock';
import { TextBlock } from './controls/TextBlock';
import { Canvas } from './panels/Canvas';
import { Grid, StripDefinition } from './panels/Grid';
import { Panel } from './panels/Panel';
import { StackPanel } from './panels/StackPanel';
import { UniformGrid } from './panels/UniformGrid';
import { SpriteFromSheet, SpriteFromTexture } from './sprites';
import type { UIElement } from './UIElement';

export class UIPage {
  readonly name: string;
  rootElement: UIElement | null;

  constructor(name: string, rootElement: UIElement | null) {
    this.name = name;
    this.rootElement = rootElement;
  }
}

export class UILibrary {
  readonly name: string;
  readonly #file: UIFile;
  readonly #resources: UIResources;

  /** @internal 由 ContentManager.loadUILibrary 建。 */
  constructor(file: UIFile, resources: UIResources) {
    this.name = file.name;
    this.#file = file;
    this.#resources = resources;
  }

  /** 公开的元素的名字。 */
  get names(): readonly string[] {
    return Object.keys(this.#file.templates ?? {});
  }

  /** 按名字新建一个公开的元素（Stride 的 InstantiateElement）；给了 type 时检查类型。 */
  instantiateElement<T extends UIElement = UIElement>(name: string, type?: abstract new (...args: never[]) => T): T {
    const index = this.#file.templates?.[name];
    if (index === undefined) throw new Error(`UI library ${this.name} has no element named '${name}' (it has ${this.names.join(', ')})`);
    const element = buildElement(this.#file, index, this.#resources);
    if (type && !(element instanceof type)) throw new Error(`UI library ${this.name}: '${name}' is a ${element.constructor.name}, not a ${type.name}`);
    return element as T;
  }
}

/** UIFile 引用的资源，按内容路径（建元素前加载好）。 */
export interface UIResources {
  readonly spriteSheets: ReadonlyMap<string, SpriteSheet>;
  readonly fonts: ReadonlyMap<string, SpriteFont>;
  /** 按 TextureRef.texture。 */
  readonly textures: ReadonlyMap<string, Texture>;
}

const ELEMENT_TYPES: Readonly<Record<UIElementType, new () => UIElement>> = {
  Border, Button, Canvas, ContentDecorator, ContentPresenter, EditText, Grid, ImageButton, ImageElement, ModalElement, RichTextBlock, ScrollBar, ScrollingText, ScrollViewer, Slider,
  StackPanel, TextBlock, ToggleButton, UniformGrid,
};

/** 警告过的"元素类型.属性"，每种只警告一次。 */
const warned = new Set<string>();

/** 按文件里第 index 个元素建元素（连同它的子元素、内容）。 */
export function buildElement(file: UIFile, index: number, resources: UIResources): UIElement {
  const data = file.elements[index];
  if (!data) throw new Error(`UI ${file.name}: no element ${index}`);
  const create = ELEMENT_TYPES[data.type];
  if (!create) throw new Error(`UI ${file.name}: unknown element type ${data.type}`);
  const element = new create();
  applyProps(element, data, { ...data.props, ...data.attached }, resources, file.name);
  if (data.children) {
    if (!(element instanceof Panel)) throw new Error(`UI ${file.name}: ${data.type} has children but is not a panel`);
    for (const child of data.children) element.children.add(buildElement(file, child, resources));
  }
  if (data.content !== undefined) {
    if (!(element instanceof ContentControl)) throw new Error(`UI ${file.name}: ${data.type} has content but is not a content control`);
    element.content = buildElement(file, data.content, resources);
  }
  return element;
}

function applyProps(element: UIElement, data: UIElementFile, props: Readonly<Record<string, UIValue>>, resources: UIResources, where: string): void {
  const target = element as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(props).sort(([a], [b]) => Number(a === USE_ABSOLUTE) - Number(b === USE_ABSOLUTE))) {
    if ((key === 'rowDefinitions' || key === 'columnDefinitions') && element instanceof Grid) {
      for (const strip of value as readonly UIStripDefinition[]) element[key].add(stripDefinition(strip));
      continue;
    }
    if (!(key in element)) {
      const id = `${data.type}.${key}`;
      if (!warned.has(id)) console.warn(`[stride] UI ${where}: ${id} is not supported yet; ignored`);
      warned.add(id);
      continue;
    }
    target[key] = MERGED_PROPS.test(key) && Array.isArray(value)
      ? value.map((item: number | null, i: number) => item ?? (target[key] as readonly number[])[i])
      : resolveValue(value, resources, where);
  }
}

/** 文件里存的是标志本身：放到位置之后设，免得被设位置时顺带改的值盖掉。 */
const USE_ABSOLUTE = 'canvasUseAbsolutePosition';

/** 颜色、Thickness：文件里没写的成员（null）保持元素类型的默认值（Stride 反序列化时只覆盖写了的成员）。 */
const MERGED_PROPS = /^(margin|padding|color)$|Color$/;

function resolveValue(value: UIValue, resources: UIResources, where: string): unknown {
  if (value === null || typeof value !== 'object') return value;
  // 向量里的 null 是 Stride 的 NaN（没设）
  if (Array.isArray(value)) return value.map((item: unknown) => (item === null ? NaN : item));
  if ('$asset' in value) return asset(resources.fonts, value.$asset, 'font', where);
  return spriteProvider(value as UISpriteValue, resources, where);
}

function spriteProvider(value: UISpriteValue, resources: UIResources, where: string): SpriteFromSheet | SpriteFromTexture {
  if ('sheet' in value) return new SpriteFromSheet(asset(resources.spriteSheets, value.sheet, 'sprite sheet', where), value.frame);
  return new SpriteFromTexture(asset(resources.textures, value.texture.texture, 'texture', where));
}

function asset<T>(map: ReadonlyMap<string, T>, path: string, kind: string, where: string): T {
  const loaded = map.get(path);
  if (!loaded) throw new Error(`UI ${where}: ${kind} ${path} was not loaded`);
  return loaded;
}

function stripDefinition({ type = 'star', sizeValue = 1, minimumSize, maximumSize }: UIStripDefinition): StripDefinition {
  const strip = new StripDefinition(type, sizeValue);
  if (minimumSize !== undefined) strip.minimumSize = minimumSize;
  if (maximumSize !== undefined) strip.maximumSize = maximumSize;
  return strip;
}
