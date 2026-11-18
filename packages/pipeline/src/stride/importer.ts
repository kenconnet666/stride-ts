/**
 * 把 Stride 工程的场景导入成运行时内容（格式见 @stride-ts/engine 的 content/format.ts）：场景里的实体、
 * 变换和父子关系，ModelComponent 引用的模型（源 FBX/glTF 经 stride-tools 导入）、材质和贴图（源图片解码后
 * 编成 KTX2 加 Basis），相机，光源。
 * 现在不认识的组件（物理、脚本、动画、背景）跳过并计数，后面的里程碑逐个接上。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StrideTools } from '@stride-ts/native/tools';
import { EXTENSIONS, encodeModel, VERTEX_FLOATS, type ColorOperator, type MaterialFile, type ModelMeshData, type SceneEntityFile, type SceneFile, type TextureSlot } from '@stride-ts/engine/content-format';
import type { AssetEntry, StrideProject } from './project.ts';
import { asNumber, asObject, parseAssetReference, parseObjectReference, type StrideObject, type StrideValue } from './yaml.ts';

export interface ImportResult {
  /** 场景的内容路径。 */
  readonly scene: string;
  readonly entities: number;
  readonly models: readonly string[];
  readonly materials: readonly string[];
  readonly textures: readonly string[];
  /** 跳过的组件类型和个数。 */
  readonly skipped: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}

/**
 * Stride 的天空盒光（LightSkybox）按天空盒纹理算漫反射环境光；纹理还没接上，先当一个白色的环境光，
 * 强度乘这个估计值（晴天天空的平均亮度大约是直射光的几分之一）。接上天空盒以后去掉。
 */
const SKYBOX_AMBIENT_ESTIMATE = 0.2;

const srgbToLinear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

export class StrideImporter {
  readonly #project: StrideProject;
  readonly #tools: StrideTools;
  readonly #out: string;
  readonly #models = new Map<string, Promise<string>>();
  readonly #materials = new Map<string, Promise<string>>();
  readonly #textures = new Map<string, Promise<string>>();
  readonly #skipped = new Map<string, number>();
  readonly #warnings: string[] = [];

  /** out：内容根目录，导出的文件按内容路径放在下面。 */
  constructor(project: StrideProject, tools: StrideTools, out: string) {
    this.#project = project;
    this.#tools = tools;
    this.#out = out;
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

    const files = await Promise.all(entities.map((entity) => this.#entity(entity, parentOf.get(entity['Id'] as string) ?? null, asset)));
    const scene: SceneFile = { name: path.basename(asset.path), entities: parentsFirst(files) };
    await this.#write(asset.path + EXTENSIONS.scene, JSON.stringify(scene, null, 1));
    return {
      scene: asset.path,
      entities: scene.entities.length,
      models: [...this.#models.keys()],
      materials: [...this.#materials.keys()],
      textures: [...this.#textures.keys()],
      skipped: this.#skipped,
      warnings: this.#warnings,
    };
  }

  async #entity(entity: StrideObject, parent: string | null, scene: AssetEntry): Promise<SceneEntityFile> {
    const where = `${scene.file}: entity '${String(entity['Name'])}'`;
    const transform = componentOf(entity, 'TransformComponent') ?? {};
    const components: { -readonly [K in keyof SceneEntityFile['components']]: SceneEntityFile['components'][K] } = {};
    for (const component of Object.values(asObject(entity['Components']) ?? {})) {
      const object = asObject(component);
      const type = object?.$type ?? 'unknown';
      if (!object || type === 'TransformComponent') continue;
      if (type === 'ModelComponent') components.model = await this.#modelComponent(object, where);
      else if (type === 'CameraComponent') components.camera = cameraOf(object);
      else if (type === 'LightComponent' && lightOf(object)) components.light = lightOf(object)!;
      else this.#skipped.set(type, (this.#skipped.get(type) ?? 0) + 1);
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

  async #modelComponent(component: StrideObject, where: string): Promise<NonNullable<SceneEntityFile['components']['model']>> {
    const reference = parseAssetReference(component['Model']);
    if (!reference) throw new Error(`${where}: ModelComponent has no model`);
    const model = await this.#model(this.#project.get(reference.id, where));
    // 按槽覆盖材质：键是 "<hash>~<槽号>"
    const materials: (string | null)[] = [];
    for (const [key, value] of Object.entries(asObject(component['Materials']) ?? {})) {
      const slot = Number(key.slice(key.lastIndexOf('~') + 1));
      const material = parseAssetReference(value);
      if (!Number.isInteger(slot) || !material) continue;
      while (materials.length < slot) materials.push(null);
      materials[slot] = await this.#material(this.#project.get(material.id, where));
    }
    return { model, materials };
  }

  /** 导入一个模型资源（.sdm3d），返回它的内容路径；同一个模型只导入一次。 */
  #model(asset: AssetEntry): Promise<string> {
    let pending = this.#models.get(asset.path);
    if (!pending) {
      pending = this.#importModel(asset).then(() => asset.path);
      this.#models.set(asset.path, pending);
    }
    return pending;
  }

  async #importModel(asset: AssetEntry): Promise<void> {
    const source = asset.data['Source'];
    if (typeof source !== 'string') throw new Error(`${asset.file}: model has no Source`);
    // 材质槽按 .sdm3d 里的顺序；源文件里的网格按材质名对上槽
    const slots = Object.values(asObject(asset.data['Materials']) ?? {}).map((slot) => asObject(slot) ?? {});
    const slotNames = slots.map((slot) => String(slot['Name'] ?? ''));
    const materials = await Promise.all(slots.map(async (slot) => {
      const reference = parseAssetReference(asObject(slot['MaterialInstance'])?.['Material']);
      return reference ? this.#material(this.#project.get(reference.id, asset.file)) : null;
    }));

    const pivot = vec3(asset.data['PivotPosition'], 0);
    const scale = asNumber(asset.data['ScaleImport'], 1);
    const scene = await this.#tools.loadScene(await readFile(path.resolve(path.dirname(asset.file), source)));
    try {
      const meshes: ModelMeshData[] = [];
      for (let m = 0; m < scene.meshCount; m++) {
        const data = scene.mesh(m);
        const materialName = data.material === null ? undefined : scene.materials[data.material];
        let slot = materialName === undefined ? -1 : slotNames.indexOf(materialName);
        if (slot < 0 && materialName !== undefined) {
          this.#warnings.push(`${asset.file}: mesh material '${materialName}' has no slot in the model; using slot 0`);
          slot = slots.length > 0 ? 0 : -1;
        }
        meshes.push({ name: `mesh${m}`, material: slot < 0 ? null : slot, ...interleave(data, pivot, scale) });
      }
      await this.#write(asset.path + EXTENSIONS.model, encodeModel({ meshes, materials }));
    } finally {
      scene.destroy();
    }
  }

  /** 导入一个材质资源（.sdmat），返回它的内容路径；同一个材质只导入一次。 */
  #material(asset: AssetEntry): Promise<string> {
    let pending = this.#materials.get(asset.path);
    if (!pending) {
      pending = this.#materialFile(asset).then((file) => this.#write(asset.path + EXTENSIONS.material, JSON.stringify(file, null, 1))).then(() => asset.path);
      this.#materials.set(asset.path, pending);
    }
    return pending;
  }

  async #materialFile(asset: AssetEntry): Promise<MaterialFile> {
    const attributes = asObject(asset.data['Attributes']) ?? {};
    const diffuse = asObject(asObject(attributes['Diffuse'])?.['DiffuseMap']);
    const uvScale = vec2(asObject(attributes['Overrides'])?.['UVScale'], 1);
    const { color, texture, operator } = diffuse ? this.#evaluateColor(diffuse, asset, uvScale) : { color: WHITE, operator: 'multiply' as const };
    const metalness = asObject(asObject(attributes['Specular'])?.['MetalnessMap'])?.['Value'];
    const glossiness = asObject(asObject(attributes['MicroSurface'])?.['GlossinessMap'])?.['Value'];
    return {
      name: path.basename(asset.path),
      baseColor: color,
      ...(texture ? { baseColorTexture: { ...texture, texture: await texture.texture } } : {}),
      ...(texture && operator !== 'multiply' ? { baseColorOperator: operator } : {}),
      ...(typeof metalness === 'number' ? { metalness } : {}),
      ...(typeof glossiness === 'number' ? { roughness: 1 - glossiness } : {}),
    };
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
      case 'ComputeTextureColor': {
        const reference = parseAssetReference(node['Texture']);
        if (!reference) return { color: linearColor(asObject(node['FallbackValue'])?.['Value']), operator: 'multiply' };
        const scale = vec2(node['Scale'], 1);
        const texture = { texture: this.#texture(this.#project.get(reference.id, asset.file)), scale: [scale[0] * uvScale[0], scale[1] * uvScale[1]], offset: vec2(node['Offset'], 0) } as const;
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

  /** 导入一个贴图资源（.sdtex）：解码源图片，编成 KTX2（UASTC 加 mipmap），返回内容路径；同一张贴图只导入一次。 */
  #texture(asset: AssetEntry): Promise<string> {
    let pending = this.#textures.get(asset.path);
    if (!pending) {
      pending = this.#importTexture(asset).then(() => asset.path);
      this.#textures.set(asset.path, pending);
    }
    return pending;
  }

  async #importTexture(asset: AssetEntry): Promise<void> {
    const source = asset.data['Source'];
    if (typeof source !== 'string') throw new Error(`${asset.file}: texture has no Source`);
    const type = asObject(asset.data['Type']);
    // 颜色贴图默认按 sRGB 采样（Stride 的 ColorTextureType.UseSRgbSampling），法线、灰度贴图是线性的
    const srgb = type?.$type === 'ColorTextureType' && type['UseSRgbSampling'] !== false;
    const image = await this.#tools.decodeImage(await readFile(path.resolve(path.dirname(asset.file), source)));
    const ktx2 = await this.#tools.encodeBasis(image.pixels, image.width, image.height, { mode: 'uastc', srgb, mipmaps: true });
    await this.#write(asset.path + EXTENSIONS.texture, ktx2);
  }

  async #write(contentPath: string, data: string | Uint8Array): Promise<void> {
    const file = path.join(this.#out, contentPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
}

type Color4Tuple = readonly [number, number, number, number];

const WHITE: Color4Tuple = [1, 1, 1, 1];

/** 颜色树化简后的形状：有贴图时结果 = operator(贴图采样, color)，没有贴图时就是 color。 */
interface ColorExpression {
  readonly color: Color4Tuple;
  /** texture 是导入中的贴图的内容路径。 */
  readonly texture?: Omit<TextureSlot, 'texture'> & { readonly texture: Promise<string> };
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

function vec3(value: StrideValue | undefined, fallback: number): [number, number, number] {
  const v = asObject(value) ?? {};
  return [asNumber(v['X'], fallback), asNumber(v['Y'], fallback), asNumber(v['Z'], fallback)];
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

function cameraOf(component: StrideObject): NonNullable<SceneEntityFile['components']['camera']> {
  return {
    verticalFieldOfView: asNumber(component['VerticalFieldOfView'], 45),
    nearClipPlane: asNumber(component['NearClipPlane'], 0.1),
    farClipPlane: asNumber(component['FarClipPlane'], 1000),
  };
}

function lightOf(component: StrideObject): SceneEntityFile['components']['light'] | undefined {
  const type = asObject(component['Type']);
  const intensity = asNumber(component['Intensity'], 1);
  if (type?.$type === 'LightDirectional') {
    const color = asObject(asObject(type['Color'])?.['Value']) ?? {};
    return { type: 'directional', color: [asNumber(color['R'], 1), asNumber(color['G'], 1), asNumber(color['B'], 1)], intensity };
  }
  if (type?.$type === 'LightSkybox') return { type: 'ambient', color: [1, 1, 1], intensity: intensity * SKYBOX_AMBIENT_ESTIMATE };
  return undefined;
}

/** 导入的网格变成交错顶点（位置减去轴心再乘缩放，同 Stride 的 PivotPosition、ScaleImport），没有的属性填 0。 */
function interleave(
  mesh: { positions: Float32Array; normals: Float32Array | null; uvs: Float32Array | null; indices: Uint32Array },
  pivot: readonly [number, number, number],
  scale: number,
): { vertices: Float32Array; indices: Uint16Array | Uint32Array } {
  const count = mesh.positions.length / 3;
  const vertices = new Float32Array(count * VERTEX_FLOATS);
  for (let v = 0; v < count; v++) {
    const o = v * VERTEX_FLOATS;
    for (let k = 0; k < 3; k++) vertices[o + k] = (mesh.positions[v * 3 + k]! - pivot[k]!) * scale;
    if (mesh.normals) vertices.set(mesh.normals.subarray(v * 3, v * 3 + 3), o + 3);
    if (mesh.uvs) vertices.set(mesh.uvs.subarray(v * 2, v * 2 + 2), o + 6);
  }
  return { vertices, indices: count <= 0xffff ? Uint16Array.from(mesh.indices) : mesh.indices };
}
