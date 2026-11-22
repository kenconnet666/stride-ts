/**
 * Stride 的 UI 资源（.sduipage、.sduilib）导入成 UIFile（content/formats/format.ts）：Hierarchy.Parts 里的元素平铺成数组，
 * Children、Content 的 `ref!!` 引用换成下标；属性名首字母小写，值按 UIValue 的约定换过来；精灵表、贴图、字体跟着导入。
 * 派生的元素（UI 库的实例，带 Base）在文件里已经是完整的属性（改过的键带 `*`），不需要再去合并 UI 库。
 * 布局只导入两维：深度方向的尺寸、对齐、Grid 的层（LayerDefinitions）不导入。
 */
import path from 'node:path';
import { EXTENSIONS, type TextureRef, type UIElementFile, type UIElementType, type UIFile, type UIStripDefinition, type UIValue } from '@stride-ts/engine/content-format';
import { once, type AssetEntry, type StrideProject } from './project.ts';
import { asNumber, asObject, dictionaryKey, lowerFirst, parseAssetReference, parseObjectReference, scalarSource, vec3, type StrideObject, type StrideValue } from './yaml.ts';

export interface UIImportContext {
  readonly project: StrideProject;
  readonly warnings: string[];
  write(contentPath: string, data: string | Uint8Array): Promise<void>;
  /** 导入精灵表，返回内容路径。 */
  spriteSheet(asset: AssetEntry): Promise<string>;
  texture(asset: AssetEntry): Promise<TextureRef>;
  /** 导入字体，返回内容路径。 */
  font(asset: AssetEntry): Promise<string>;
}

const ELEMENT_TYPES = new Set<string>([
  'Border', 'Button', 'Canvas', 'ContentDecorator', 'ContentPresenter', 'EditText', 'Grid', 'ImageButton',
  'ImageElement', 'ModalElement', 'ScrollBar', 'ScrollingText', 'ScrollViewer', 'Slider', 'StackPanel', 'TextBlock',
  'ToggleButton', 'UniformGrid',
] satisfies UIElementType[]);

/** 值是枚举的属性：导出成首字母小写的名字。 */
const ENUM_PROPS = new Set([
  'HorizontalAlignment', 'VerticalAlignment', 'Visibility', 'Orientation', 'StretchType', 'StretchDirection', 'ScrollMode',
  'TextAlignment', 'ClickMode', 'State', 'InputType', 'TickPlacement',
]);
/** 值是字符串的属性：YAML 里不带引号的 `Text: 000` 会读成数字，按原文取。 */
const STRING_PROPS = new Set(['Name', 'Text']);
/** 值是 Thickness 的属性：[左, 上, 右, 下]。 */
const THICKNESS_PROPS = new Set(['Margin', 'Padding', 'BorderThickness']);
/** 深度方向的属性：两维布局不用。 */
const DEPTH_PROPS = new Set(['Depth', 'MinimumDepth', 'MaximumDepth', 'DepthAlignment', 'LayerDefinitions']);
/** 不当属性导入的键：元素的 Id、附加属性和层级（另外处理）。 */
const STRUCTURE_KEYS = new Set(['$type', 'Id', 'DependencyProperties', 'Children', 'Content']);

/**
 * 附加属性的键（`GridBase.RowPropertyKey`）→ UIElementFile.attached 的名字：类名（GridBase 写成 grid）加属性名，同运行时
 * UIElement 上的属性（gridRow、panelZIndex、canvasRelativePosition）。Grid 的层不导入（两维）。
 */
function attachedName(key: string): string | null | undefined {
  const match = /^(GridBase|Panel|Canvas)\.(\w+)PropertyKey$/.exec(key);
  if (!match) return undefined;
  const [, owner, name] = match;
  if (owner === 'GridBase' && (name === 'Layer' || name === 'LayerSpan')) return null;
  return (owner === 'GridBase' ? 'grid' : owner!.toLowerCase()) + name;
}

export class UIImporter {
  readonly #context: UIImportContext;
  readonly #files = new Map<string, Promise<string>>();

  constructor(context: UIImportContext) {
    this.#context = context;
  }

  /** 导入 UI 页面或 UI 库，返回它的内容路径。 */
  ui(asset: AssetEntry): Promise<string> {
    if (asset.type !== 'UIPageAsset' && asset.type !== 'UILibraryAsset') throw new Error(`${asset.file} is a ${asset.type}, not a UI page or library`);
    return once(this.#files, asset, () => this.#import(asset));
  }

  async #import(asset: AssetEntry): Promise<void> {
    const hierarchy = asObject(asset.data['Hierarchy']);
    const parts = hierarchy?.['Parts'];
    if (!Array.isArray(parts)) throw new Error(`${asset.file}: no Hierarchy.Parts`);
    const objects = parts.map((part) => asObject(asObject(part)?.['UIElement'])).filter((e): e is StrideObject => e !== undefined);
    const indices = new Map(objects.map((object, index) => [String(object['Id']), index]));
    const indexOf = (value: StrideValue | undefined, where: string): number | undefined => {
      // 带类型标签的引用（`!ImageElement ref!! Id`）解析出来是 { $type, value: 'ref!! Id' }
      const id = parseObjectReference(asObject(value)?.['value'] ?? value);
      const index = id === undefined ? undefined : indices.get(id);
      if (index === undefined) this.#context.warnings.push(`${where}: reference ${String(id)} is not in this file; skipped`);
      return index;
    };

    const elements = await Promise.all(objects.map((object) => this.#element(object, asset, indexOf)));
    const design = vec3(asObject(asset.data['Design'])?.['Resolution'], 0);
    const file: { -readonly [K in keyof UIFile]: UIFile[K] } = {
      name: path.basename(asset.path),
      designResolution: [design[0], design[1]],
      elements,
    };
    if (asset.type === 'UIPageAsset') {
      const roots = hierarchy?.['RootParts'];
      const root = Array.isArray(roots) && roots.length > 0 ? indexOf(roots[0], asset.file) : undefined;
      if (Array.isArray(roots) && roots.length > 1) this.#context.warnings.push(`${asset.file}: a page has one root element; using the first of ${roots.length}`);
      if (root !== undefined) file.root = root;
    } else {
      const templates: Record<string, number> = {};
      for (const [id, name] of Object.entries(asObject(asset.data['PublicUIElements']) ?? {})) {
        const index = indices.get(id);
        if (index !== undefined && typeof name === 'string') templates[name] = index;
      }
      file.templates = templates;
    }
    await this.#context.write(asset.path + EXTENSIONS.ui, JSON.stringify(file, null, 1));
  }

  async #element(object: StrideObject, asset: AssetEntry, indexOf: (value: StrideValue | undefined, where: string) => number | undefined): Promise<UIElementFile> {
    const type = object.$type ?? 'unknown';
    const where = `${asset.file}: ${type} '${String(object['Name'] ?? object['Id'])}'`;
    if (!ELEMENT_TYPES.has(type)) throw new Error(`${where}: UI element type ${type} is not supported`);

    const props: Record<string, UIValue> = {};
    for (const [key, value] of Object.entries(object)) {
      if (STRUCTURE_KEYS.has(key) || DEPTH_PROPS.has(key) || value === undefined) continue;
      if (STRING_PROPS.has(key) && value !== null && typeof value !== 'string') {
        props[lowerFirst(key)] = scalarSource(object, key) ?? String(value);
        continue;
      }
      const converted = await this.#value(key, value, `${where}.${key}`);
      if (converted !== undefined) props[lowerFirst(key)] = converted;
    }

    const attached: Record<string, UIValue> = {};
    for (const [key, value] of Object.entries(asObject(object['DependencyProperties']) ?? {})) {
      const name = attachedName(dictionaryKey(key));
      if (name === null) continue;
      if (name === undefined) {
        this.#context.warnings.push(`${where}: dependency property ${dictionaryKey(key)} is not supported; ignored`);
        continue;
      }
      const converted = await this.#value(name, value ?? null, `${where}.${name}`);
      if (converted !== undefined) attached[name] = converted;
    }

    const element: { -readonly [K in keyof UIElementFile]: UIElementFile[K] } = { type: type as UIElementType, props };
    if (Object.keys(attached).length > 0) element.attached = attached;
    if (object['Children'] !== undefined) {
      element.children = Object.values(asObject(object['Children']) ?? {})
        .map((child) => indexOf(child, where))
        .filter((index): index is number => index !== undefined);
    }
    if (object['Content'] !== undefined && object['Content'] !== null) {
      const content = indexOf(object['Content'], where);
      if (content !== undefined) element.content = content;
    }
    return element;
  }

  /** 一个属性值换成 UIValue；不支持的记警告、返回 undefined（用 Stride 的默认值）。 */
  async #value(key: string, value: StrideValue, where: string): Promise<UIValue | undefined> {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') {
      if (ENUM_PROPS.has(key)) return lowerFirst(value);
      if (key === 'Font') {
        const reference = parseAssetReference(value);
        return reference ? { $asset: await this.#context.font(this.#context.project.get(reference.id, where)), kind: 'font' } : null;
      }
      // YAML 里的 NaN、无穷大（没设的尺寸）：用默认值
      if (/^[-+]?(NaN|Infinity|∞)$/.test(value)) return undefined;
      return value;
    }
    if (Array.isArray(value)) {
      this.#context.warnings.push(`${where}: list values are not supported; ignored`);
      return undefined;
    }
    if (value.$type === 'SpriteFromSheet') {
      const reference = parseAssetReference(value['Sheet']);
      if (!reference) return null;
      return { sheet: await this.#context.spriteSheet(this.#context.project.get(reference.id, where)), frame: asNumber(value['CurrentFrame'], 0) };
    }
    if (value.$type === 'SpriteFromTexture') {
      const reference = parseAssetReference(value['Texture']);
      if (!reference) return null;
      return { texture: await this.#context.texture(this.#context.project.get(reference.id, where)) };
    }
    if (value.$type !== undefined) {
      this.#context.warnings.push(`${where}: ${value.$type} is not supported; ignored`);
      return undefined;
    }
    // Thickness、颜色没写的成员是 null：Stride 反序列化时只覆盖写了的成员，没写的保持元素类型的默认值（Button 的
    // `Padding: {Left: 45.0, Top: 20.0, Bottom: 25.0}` 右边还是默认的 10）
    if (THICKNESS_PROPS.has(key)) return ['Left', 'Top', 'Right', 'Bottom'].map((side) => (typeof value[side] === 'number' ? value[side] : null));
    if (key.endsWith('Color')) return ['R', 'G', 'B', 'A'].map((channel) => (typeof value[channel] === 'number' ? value[channel] / 255 : null));
    if (key === 'RowDefinitions' || key === 'ColumnDefinitions') return Object.values(value).map((strip) => stripDefinition(asObject(strip) ?? {}));
    const keys = Object.keys(value).join(',');
    // Vector2、Vector3（Canvas 的位置和大小）：只要 X、Y，NaN（没设）是 null
    if (keys === 'X,Y' || keys === 'X,Y,Z') return [value['X'], value['Y']].map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    this.#context.warnings.push(`${where}: value ${JSON.stringify(value)} is not supported; ignored`);
    return undefined;
  }
}

function stripDefinition(strip: StrideObject): UIStripDefinition {
  const definition: { -readonly [K in keyof UIStripDefinition]: UIStripDefinition[K] } = {};
  if (typeof strip['Type'] === 'string' && strip['Type'] !== 'Star') definition.type = lowerFirst(strip['Type']) as 'fixed' | 'auto';
  for (const [key, name] of [['SizeValue', 'sizeValue'], ['MinimumSize', 'minimumSize'], ['MaximumSize', 'maximumSize']] as const) {
    const value = strip[key];
    if (typeof value === 'number' && Number.isFinite(value)) definition[name] = value;
  }
  return definition;
}
