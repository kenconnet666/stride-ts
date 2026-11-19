/**
 * Stride 的材质（.sdmat）、贴图（.sdtex）和天空盒（.sdsky）导入成运行时内容：材质的颜色树化成"一张贴图按运算符组合一个颜色"，
 * 贴图编成 KTX2（Basis UASTC）或原样复制源图，HDR 立方体贴图导出成 .cubemap，天空盒的漫反射算成球谐。同一个资源只导入一次。
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { StrideTools } from '@stride-ts/native/tools';
import {
  EXTENSIONS,
  encodeCubemap,
  TEXTURE_EXTENSIONS,
  type ColorOperator,
  type MaterialFile,
  type NormalMapSlot,
  type SkyboxFile,
  type TextureEncoding,
  type TextureSampler,
  type TextureSlot,
  type Vec3Tuple,
} from '@stride-ts/engine/content-format';
import { readDdsCubemap, regenerateMips, toRgb9e5, type FloatCubemap } from '../hdr.ts';
import type { ResolvedImporterOptions } from './importer.ts';
import { once, sourceOf, type AssetEntry, type StrideProject } from './project.ts';
import { asNumber, asObject, linearColor, parseAssetReference, vec2, type StrideObject, type StrideValue } from './yaml.ts';

/** 材质导入用到的导入器的东西：工程、工具、选项，警告记到导入器的列表里，文件按内容路径写到输出目录。 */
export interface MaterialImportContext {
  readonly project: StrideProject;
  readonly tools: StrideTools;
  readonly options: ResolvedImporterOptions;
  readonly warnings: string[];
  write(contentPath: string, data: string | Uint8Array): Promise<void>;
}

/** 导出的贴图：内容路径、编码，svg 带上栅格化尺寸。 */
export interface ImportedTexture {
  readonly texture: string;
  readonly encoding: TextureEncoding;
  readonly size?: readonly [number, number];
  /** 按 sRGB 采样（Stride 的贴图类型决定）。 */
  readonly srgb: boolean;
}

const SOURCE_ENCODINGS: Readonly<Record<string, TextureEncoding>> = { '.svg': 'svg', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg' };

/** 补到 4 的倍数（块压缩格式的整块）。 */
const align4 = (n: number) => (n + 3) & ~3;

export class MaterialImporter {
  readonly #context: MaterialImportContext;
  readonly #materialPaths = new Map<string, Promise<string>>();
  readonly #materialFiles = new Map<string, Promise<MaterialFile>>();
  readonly #textures = new Map<string, Promise<ImportedTexture>>();
  readonly #cubemaps = new Map<string, Promise<string>>();
  readonly #skyboxes = new Map<string, Promise<string>>();
  /** 解码过的 HDR 立方体贴图源文件：天空盒光照和背景常用同一张。 */
  readonly #hdrSources = new Map<string, Promise<FloatCubemap>>();

  constructor(context: MaterialImportContext) {
    this.#context = context;
  }

  /** 导出过的材质、贴图（含立方体贴图）、天空盒的内容路径（ImportResult 用）。 */
  get imported(): { materials: string[]; textures: string[]; skyboxes: string[] } {
    return { materials: [...this.#materialPaths.keys()], textures: [...this.#textures.keys(), ...this.#cubemaps.keys()], skyboxes: [...this.#skyboxes.keys()] };
  }

  /** 导出材质（.sdmat），返回它的内容路径。 */
  material(asset: AssetEntry): Promise<string> {
    return once(this.#materialPaths, asset, async () => this.#context.write(asset.path + EXTENSIONS.material, JSON.stringify(await this.materialFile(asset), null, 1)));
  }

  /** 材质资源转成的 MaterialFile，同一个只转一次（模型导入时还要看它有没有法线贴图）。 */
  materialFile(asset: AssetEntry): Promise<MaterialFile> {
    let pending = this.#materialFiles.get(asset.path);
    if (!pending) {
      pending = this.#convert(asset);
      this.#materialFiles.set(asset.path, pending);
    }
    return pending;
  }

  async #convert(asset: AssetEntry): Promise<MaterialFile> {
    const attributes = asObject(asset.data['Attributes']) ?? {};
    const diffuse = asObject(asObject(attributes['Diffuse'])?.['DiffuseMap']);
    const uvScale = vec2(asObject(attributes['Overrides'])?.['UVScale'], 1);
    const { color, texture, operator } = diffuse ? this.#evaluateColor(diffuse, asset, uvScale) : { color: WHITE, operator: 'multiply' as const };
    const specular = asObject(attributes['Specular']);
    const workflow = specular?.$type;
    if (specular && workflow !== 'MaterialMetalnessMapFeature' && workflow !== 'MaterialSpecularMapFeature') this.#context.warnings.push(`${asset.file}: specular ${workflow ?? 'feature'} is not supported; the material has no specular`);
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
      this.#context.warnings.push(`${asset.file}: material layers are not supported yet (P2 shader system); using the base material`);
    }
    return material;
  }

  /** 镜面颜色工作流（MaterialSpecularMapFeature）：镜面颜色乘强度；镜面贴图还不支持，用它的后备颜色。 */
  #specularColor(feature: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): Vec3Tuple {
    const map = this.#evaluateColor(asObject(feature['SpecularMap']) ?? {}, asset, uvScale);
    if (map.texture) this.#context.warnings.push(`${asset.file}: specular textures are not supported; using the color`);
    const intensity = Math.min(Math.max(this.#scalar(asObject(feature['Intensity']), 1, asset), 0), 1);
    return [map.color[0] * intensity, map.color[1] * intensity, map.color[2] * intensity];
  }

  /** 透明（MaterialTransparencyBlendFeature）：alpha 限制在 0..1，tint 是常量颜色；别的透明特性记警告。 */
  #transparency(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Pick<MaterialFile, 'transparency'> {
    if (!feature) return {};
    if (feature.$type !== 'MaterialTransparencyBlendFeature') {
      this.#context.warnings.push(`${asset.file}: transparency ${feature.$type ?? 'feature'} is not supported; the material is opaque`);
      return {};
    }
    const alpha = Math.min(Math.max(this.#scalar(asObject(feature['Alpha']), 1, asset), 0), 1);
    const tint = this.#evaluateColor(asObject(feature['Tint']) ?? { $type: 'ComputeColor' }, asset, uvScale);
    if (tint.texture) this.#context.warnings.push(`${asset.file}: a textured transparency tint is not supported; using the color`);
    const [r, g, b] = tint.color;
    return { transparency: { type: 'blend', alpha, ...(r === 1 && g === 1 && b === 1 ? {} : { tint: [r, g, b] }) } };
  }

  /** 法线贴图（MaterialNormalMapFeature）：开关的默认值同 Stride；InvertY 来自贴图资源的 NormalMapTextureType（默认 true）。 */
  async #normalMap(surface: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<{ normalMap?: NormalMapSlot }> {
    if (!surface) return {};
    if (surface.$type !== 'MaterialNormalMapFeature') {
      this.#context.warnings.push(`${asset.file}: surface ${surface.$type ?? 'feature'} is not supported; using the vertex normals`);
      return {};
    }
    const node = asObject(surface['NormalMap']) ?? {};
    const reference = parseAssetReference(node['Texture']);
    if (node.$type !== 'ComputeTextureColor' || !reference) {
      this.#context.warnings.push(`${asset.file}: normal map ${node.$type ?? 'value'} without a texture is not supported; using the vertex normals`);
      return {};
    }
    const textureAsset = this.#context.project.get(reference.id, asset.file);
    const type = asObject(textureAsset.data['Type']);
    const scale = vec2(node['Scale'], 1);
    const slot = textureSlot(await this.texture(textureAsset), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(node['Offset'], 0), samplerOf(node));
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
    if (map.texture && map.operator !== 'multiply') this.#context.warnings.push(`${asset.file}: emissive texture with operator ${map.operator} is not supported; using the color`);
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
      const slot = textureSlot(await this.texture(this.#context.project.get(reference.id, asset.file)), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(map!['Offset'], 0), samplerOf(map!));
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
      if (parseAssetReference(node['Texture'])) this.#context.warnings.push(`${asset.file}: scalar textures are not supported; using the fallback value`);
      return asNumber(asObject(node['FallbackValue'])?.['Value'], fallback);
    }
    this.#context.warnings.push(`${asset.file}: scalar ${node.$type ?? 'value'} is not supported; using ${fallback}`);
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
        const texture = { texture: this.texture(this.#context.project.get(reference.id, asset.file)), scale: [scale[0] * uvScale[0], scale[1] * uvScale[1]], offset: vec2(node['Offset'], 0), sampler: samplerOf(node) } as const;
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
          this.#context.warnings.push(`${asset.file}: color operator ${name} is not supported; using the left side`);
          return left;
        }
        if (left.texture && right.texture) {
          this.#context.warnings.push(`${asset.file}: combining two textures is not supported; using the left one`);
          return left;
        }
        // 剩下的是"一边有贴图、一边是颜色"；支持的两个运算都满足交换律，不用管贴图在哪边
        const [textured, constant] = left.texture ? [left, right] : [right, left];
        const operator = TEXTURE_OPERATORS[name];
        const pureTexture = textured.operator === 'multiply' && textured.color.every((c) => c === 1);
        if (operator && pureTexture) return { color: constant.color, texture, operator };
        if (operator && fold && operator === textured.operator) return { color: combine(textured.color, constant.color, fold), texture, operator };
        this.#context.warnings.push(`${asset.file}: color operator ${name} on a texture is not supported; ignoring the color`);
        return textured;
      }
      default:
        this.#context.warnings.push(`${asset.file}: color ${node.$type ?? 'value'} is not supported; using white`);
        return { color: WHITE, operator: 'multiply' };
    }
  }

  /** 导入一个贴图资源（.sdtex），同一张只导入一次。 */
  texture(asset: AssetEntry): Promise<ImportedTexture> {
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
    const policy = this.#context.options.textureEncoding;
    const image = await this.#context.tools.decodeImage(bytes);
    // 压缩的贴图宽高补到 4 的倍数，用 Lanczos3 缩放（Stride 的 TextureHelper.FindBestTextureSize：块压缩格式要求整块）。
    // 这样的源文件不能原样复制：运行时的尺寸和 Stride 不同，按点采样的图案会错开最多一个纹素
    const width = asset.data['IsCompressed'] === false ? image.width : align4(image.width);
    const height = asset.data['IsCompressed'] === false ? image.height : align4(image.height);
    const resized = width !== image.width || height !== image.height;
    if (policy === 'source' && sourceEncoding && !resized) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
    const pixels = resized ? await this.#context.tools.resizeImage(image.pixels, image.width, image.height, width, height) : image.pixels;
    const ktx2 = await this.#context.tools.encodeBasis(pixels, width, height, { mode: 'uastc', srgb, mipmaps: asset.data['GenerateMipmaps'] !== false });
    if (policy === 'smallest' && sourceEncoding && !resized && bytes.byteLength < ktx2.byteLength) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
    await this.#context.write(asset.path + TEXTURE_EXTENSIONS.ktx2, ktx2);
    return { texture: asset.path, encoding: 'ktx2', srgb };
  }

  async #copyTexture(contentPath: string, encoding: TextureEncoding, bytes: Uint8Array, srgb: boolean): Promise<ImportedTexture> {
    await this.#context.write(contentPath + TEXTURE_EXTENSIONS[encoding], bytes);
    const size = encoding === 'svg' ? svgSize(new TextDecoder().decode(bytes)) : undefined;
    return { texture: contentPath, encoding, ...(size ? { size } : {}), srgb };
  }

  /** 覆盖目录里这个内容路径的文件（.svg 优先，然后 .png、.jpg）。 */
  async #override(contentPath: string): Promise<{ file: string; encoding: TextureEncoding } | undefined> {
    if (!this.#context.options.overrides) return undefined;
    for (const [extension, encoding] of Object.entries(SOURCE_ENCODINGS)) {
      const file = path.join(this.#context.options.overrides, contentPath + extension);
      if (await access(file).then(() => true, () => false)) return { file, encoding };
    }
    return undefined;
  }

  /** 把一个 HDR 立方体贴图资源（.sdtex，源文件是 DDS）导出成 .cubemap：RGB9E5，mip 同 #hdrSource。 */
  cubemap(asset: AssetEntry): Promise<string> {
    return once(this.#cubemaps, asset, async () => {
      const source = await this.#hdrSource(asset);
      const levels = source.levels.map((level) => new Uint8Array(toRgb9e5(level).buffer));
      await this.#context.write(asset.path + EXTENSIONS.cubemap, encodeCubemap({ size: source.size, format: 'rgb9e5ufloat', levels }));
    });
  }

  /**
   * 导入天空盒（.sdsky）：漫反射是 3 阶球谐，同 Stride 的 SkyboxGenerator，从源文件的浮点数据算；镜面的预滤波
   * 在运行时从源立方体贴图生成，这里只记下尺寸。源立方体贴图导出成 .cubemap，背景用同一张时只导出一次。
   * 返回天空盒的内容路径。
   */
  skybox(asset: AssetEntry): Promise<string> {
    return once(this.#skyboxes, asset, async () => {
      const reference = parseAssetReference(asset.data['CubeMap']);
      if (!reference) throw new Error(`${asset.file}: skybox has no CubeMap`);
      const texture = this.#context.project.get(reference.id, asset.file);
      const source = await this.#hdrSource(texture);
      const [sh, radiance] = await Promise.all([this.#context.tools.cubemapSH({ size: source.size, faces: source.levels[0]! }), this.cubemap(texture)]);
      const file: SkyboxFile = { diffuseSH: [...sh], radiance, specularSize: this.#context.options.specularCubemapSize };
      await this.#context.write(asset.path + EXTENSIONS.skybox, JSON.stringify(file, null, 1));
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
}

/** 材质里的贴图槽：ktx2 是默认，不写 encoding。 */
export function textureSlot({ texture, encoding, size, srgb }: ImportedTexture, scale: readonly [number, number], offset: readonly [number, number], sampler: TextureSampler): TextureSlot {
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
