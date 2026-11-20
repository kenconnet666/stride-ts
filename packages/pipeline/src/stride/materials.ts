/**
 * Stride 的材质（.sdmat）、贴图（.sdtex）和天空盒（.sdsky）导入成运行时内容：材质的颜色树化成"一张贴图按运算符组合一个颜色"
 * 这样固定的形状（运行时不用按材质编着色器）；化不成的（有着色器类、光泽度是运算、镜面带贴图……）整棵树导出，运行时编译，
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
  type MaterialLayerFile,
  type ParticleModuleFile,
  type SkyboxFile,
  type TextureEncoding,
  type TextureSampler,
  type TextureSlot,
  type Vec3Tuple,
} from '@stride-ts/engine/content-format';
import { readDdsCubemap, regenerateMips, toRgb9e5, type FloatCubemap } from '../hdr.ts';
import type { DerivedDataCache } from '../cache.ts';
import { applyColorKey, bleedTransparentColors, encodePng, maskAlpha } from '../image.ts';
import type { ResolvedImporterOptions } from './importer.ts';
import { once, sourceOf, type AssetEntry, type StrideProject } from './project.ts';
import { importColorTree } from './particles.ts';
import { asNumber, asObject, color3, color4, linearColor, parseAssetReference, vec2, type StrideObject, type StrideValue } from './yaml.ts';

/** 材质导入用到的导入器的东西：工程、工具、选项，警告记到导入器的列表里，文件按内容路径写到输出目录。 */
export interface MaterialImportContext {
  readonly project: StrideProject;
  readonly tools: StrideTools;
  readonly options: ResolvedImporterOptions;
  readonly warnings: string[];
  write(contentPath: string, data: string | Uint8Array): Promise<void>;
  /** 贵的结果的缓存；没有时每次都现算。 */
  readonly cache?: DerivedDataCache;
}

/** 导出的贴图：内容路径、编码，svg 带上栅格化尺寸。 */
export interface ImportedTexture {
  readonly texture: string;
  readonly encoding: TextureEncoding;
  readonly size?: readonly [number, number];
  /** 按 sRGB 采样（Stride 的贴图类型决定）。 */
  readonly srgb: boolean;
}

/** 贴图编成 KTX2 这个做法在缓存里的名字；换了编码器的版本或者参数的含义就改后面的数。 */
const BASIS_RECIPE = 'basis-ktx2/1';

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
    const attributes = materialAttributes(asset);
    const diffuse = asObject(asObject(attributes['Diffuse'])?.['DiffuseMap']);
    const uvScale = vec2(asObject(attributes['Overrides'])?.['UVScale'], 1);
    const { color, texture, operator } = diffuse ? this.#evaluateColor(diffuse, asset, uvScale) : { color: WHITE, operator: 'multiply' as const };
    const specular = asObject(attributes['Specular']);
    const workflow = specular?.$type;
    if (specular && workflow !== 'MaterialMetalnessMapFeature' && workflow !== 'MaterialSpecularMapFeature') this.#context.warnings.push(`${asset.file}: specular ${workflow ?? 'feature'} is not supported; the material has no specular`);
    // 镜面的颜色（Specular）和着色模型（SpecularModel）是分开的两个特性：没有模型就不画镜面反射
    const specularModel = asObject(attributes['SpecularModel']);
    // 玻璃（MaterialSpecularThinGlassModelFeature）是微表面模型的一种，菲涅耳项换成按折射率算的反射比例，另外多画一遍透射
    const glass = specularModel?.$type === 'MaterialSpecularThinGlassModelFeature';
    if (specularModel && !glass && specularModel.$type !== 'MaterialSpecularMicrofacetModelFeature') {
      this.#context.warnings.push(`${asset.file}: specular model ${specularModel.$type} is not supported yet; using the microfacet model`);
    }
    // 还没做的特性要说出来，不能悄悄忽略
    if (attributes['Tessellation']) this.#context.warnings.push(`${asset.file}: material feature Tessellation is not supported yet; ignored`);
    // 漫反射同理：颜色（Diffuse）和着色模型（DiffuseModel）缺一个就不算漫反射光照（只有自发光的激光、玻璃）
    const diffuseShading = attributes['Diffuse'] !== undefined && attributes['DiffuseModel'] !== undefined;
    // 化不成固定槽的属性整棵树放进 trees（最底下一层盖满的材质层）；固定槽里留个占位的值，只用来定工作流
    const trees = await this.#surfaceTrees(attributes, asset, uvScale);
    const metalness = workflow !== 'MaterialMetalnessMapFeature' ? undefined : trees?.metalness ? 0 : this.#scalar(asObject(specular!['MetalnessMap']), 0, asset);
    const microSurface = asObject(attributes['MicroSurface']);
    const glossinessMap = asObject(microSurface?.['GlossinessMap']);
    // Invert 为真时这张图存的是粗糙度（MaterialGlossinessMapFeature.Invert）
    const invert = microSurface?.['Invert'] === true;
    const glossinessTexture = glossinessMap?.$type === 'ComputeTextureScalar' ? await this.#scalarTexture(glossinessMap, asset, uvScale) : undefined;
    const glossiness = glossinessTexture || trees?.glossiness ? 0 : this.#scalar(glossinessMap, 0, asset);
    const roughness = invert ? glossiness : 1 - glossiness;
    const material: MaterialFile = {
      name: path.basename(asset.path),
      baseColor: color,
      ...(texture ? { baseColorTexture: textureSlot(await texture.load(), texture.scale, texture.offset, texture.sampler) } : {}),
      ...(texture && operator !== 'multiply' ? { baseColorOperator: operator } : {}),
      ...(metalness === undefined ? {} : { metalness }),
      ...(workflow === 'MaterialSpecularMapFeature' ? { specular: trees?.specular ? ([0, 0, 0] as const) : this.#specularColor(specular!, asset, uvScale) } : {}),
      ...(workflow === 'MaterialSpecularMapFeature' && specular!['IsEnergyConservative'] === false ? { specularEnergyConservative: false as const } : {}),
      ...(specular && !specularModel ? { specularShading: false as const } : {}),
      ...(diffuseShading ? {} : { diffuseShading: false as const }),
      ...(glass ? { glass: { refractiveIndex: asNumber(specularModel['RefractiveIndex'], 1.52) } } : {}),
      roughness,
      ...(glossinessTexture ? { glossinessTexture: { ...glossinessTexture, invert } } : {}),
      ...await this.#emissive(asObject(attributes['Emissive']), asset, uvScale),
      ...await this.#occlusion(asObject(attributes['Occlusion']), asset, uvScale),
      ...await this.#normalMap(asObject(attributes['Surface']), asset, uvScale),
      ...await this.#displacement(asObject(attributes['Displacement']), asset),
      ...this.#transparency(asObject(attributes['Transparency']), asset, uvScale),
      ...this.#cullMode(attributes['CullMode'], asset),
      ...await this.#clearCoat(asObject(attributes['ClearCoat']), asset, uvScale),
      ...this.#subsurfaceScattering(asObject(attributes['SubsurfaceScattering']), asset),
    };
    if (material.clearCoat && material.transparency) this.#context.warnings.push(`${asset.file}: clear coat on a transparent material is not supported yet; the base pass is drawn opaque`);
    const layers = [...(trees ? [trees] : []), ...await this.#layers(asset)];
    return layers.length > 0 ? { ...material, layers } : material;
  }

  /**
   * 材质自己的金属度、镜面、光泽度里化不成固定槽的（不是常量，也不是固定槽认的那一张贴图）：整棵树放进一个遮罩是常量 1 的材质层，
   * 运行时和材质层走同一条路径、盖住固定槽的值。SamplesAssetPackage 的木地板（board1B）是这样的：光泽度是"贴图 × 0.3"，镜面带贴图。
   * 都化得成时是 undefined。
   */
  async #surfaceTrees(attributes: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): Promise<MaterialLayerFile | undefined> {
    const tree = (node: StrideValue | undefined, what: string) => this.#colorTree(asObject(node) ?? {}, asset, what);
    const specular = asObject(attributes['Specular']);
    const microSurface = asObject(attributes['MicroSurface']);
    const glossinessMap = asObject(microSurface?.['GlossinessMap']);
    const intensity = specular?.['Intensity'] ?? { $type: 'ComputeFloat', Value: 1 };
    const surface: Omit<MaterialLayerFile, 'blend'> = {
      ...(specular?.$type === 'MaterialSpecularMapFeature' && !(isConstant(specular['SpecularMap']) && isConstant(intensity))
        ? { specular: { color: await tree(specular['SpecularMap'], 'specular'), intensity: await tree(intensity, 'specular intensity') } } : {}),
      ...(specular?.$type === 'MaterialMetalnessMapFeature' && !isConstant(specular['MetalnessMap']) ? { metalness: await tree(specular['MetalnessMap'], 'metalness') } : {}),
      // 单独一张贴图的光泽度有固定槽（glossinessTexture）
      ...(glossinessMap && glossinessMap.$type !== 'ComputeTextureScalar' && !isConstant(glossinessMap)
        ? { glossiness: { tree: await tree(glossinessMap, 'glossiness'), invert: microSurface!['Invert'] === true } } : {}),
    };
    if (Object.keys(surface).length === 0) return undefined;
    if (uvScale[0] !== 1 || uvScale[1] !== 1) this.#context.warnings.push(`${asset.file}: UVScale is not applied to the specular, metalness and glossiness color trees`);
    return { blend: await tree({ $type: 'ComputeFloat', Value: 1 }, 'surface'), ...surface };
  }

  /**
   * 材质层（Stride 的 MaterialBlendLayer）：子材质的漫反射、镜面、金属度、光泽度、法线各导出成颜色树，遮罩是 BlendMap。
   * 停用的、没有子材质或遮罩的层跳过（同 Stride）；子材质自己的层、别的属性（自发光、遮蔽、透明）还不支持，记警告。
   */
  async #layers(asset: AssetEntry): Promise<MaterialLayerFile[]> {
    const layers: MaterialLayerFile[] = [];
    for (const value of Object.values(asObject(asset.data['Layers']) ?? {})) {
      const layer = asObject(value);
      const reference = parseAssetReference(layer?.['Material']);
      // 没写 BlendMap 是 Stride 的默认值 new ComputeTextureScalar()（没有贴图，后备值 1：整层盖上），写成 null 才是没有
      const blendMap = layer?.['BlendMap'] === null ? undefined : (asObject(layer?.['BlendMap']) ?? { $type: 'ComputeTextureScalar' });
      if (!layer || layer['Enabled'] === false || !reference || !blendMap) continue;
      const where = `${asset.file}: layer ${String(layer['Name'] ?? reference.url)}`;
      const uvScale = vec2(asObject(layer['Overrides'])?.['UVScale'], 1);
      if (uvScale[0] !== 1 || uvScale[1] !== 1) this.#context.warnings.push(`${where}: UVScale overrides are not supported yet`);
      const sub = this.#context.project.get(reference.id, asset.file);
      const attributes = materialAttributes(sub);
      const tree = (node: StrideValue | undefined, what: string) => this.#colorTree(asObject(node) ?? {}, sub, what);
      const diffuse = asObject(asObject(attributes['Diffuse'])?.['DiffuseMap']);
      const specular = asObject(attributes['Specular']);
      const microSurface = asObject(attributes['MicroSurface']);
      const surface = asObject(attributes['Surface']);
      const emissive = asObject(attributes['Emissive']);
      const occlusion = asObject(attributes['Occlusion']);
      // 层的 cavity 还没做：没有贴图、后备值是 1 的 cavity 本来就不起作用，别的才报
      const cavityMap = asObject(occlusion?.['CavityMap']);
      if (cavityMap && (parseAssetReference(cavityMap['Texture']) || this.#scalar(cavityMap, 1, sub) !== 1)) this.#context.warnings.push(`${where}: the layer's cavity is not supported yet; ignored`);
      if (emissive && emissive.$type !== 'MaterialEmissiveMapFeature') this.#context.warnings.push(`${where}: the layer's emissive ${emissive.$type ?? 'feature'} is not supported; ignored`);
      for (const key of ['Transparency', 'Displacement']) if (attributes[key]) this.#context.warnings.push(`${where}: the layer's ${key} is not supported yet; ignored`);
      if (Object.keys(asObject(sub.data['Layers']) ?? {}).length > 0) this.#context.warnings.push(`${where}: nested layers are not supported yet; ignored`);
      layers.push({
        blend: await this.#colorTree(blendMap, asset, 'layer blend map'),
        ...(diffuse ? { diffuse: await tree(diffuse, 'layer diffuse') } : {}),
        ...(specular?.$type === 'MaterialSpecularMapFeature' ? { specular: { color: await tree(specular['SpecularMap'], 'layer specular'), intensity: await tree(specular['Intensity'] ?? { $type: 'ComputeFloat', Value: 1 }, 'layer specular intensity') } } : {}),
        ...(specular?.$type === 'MaterialMetalnessMapFeature' ? { metalness: await tree(specular['MetalnessMap'], 'layer metalness') } : {}),
        ...(microSurface?.['GlossinessMap'] ? { glossiness: { tree: await tree(microSurface['GlossinessMap'], 'layer glossiness'), invert: microSurface['Invert'] === true } } : {}),
        ...(emissive?.$type === 'MaterialEmissiveMapFeature' ? { emissive: { tree: await tree(emissive['EmissiveMap'], 'layer emissive'), intensity: this.#scalar(asObject(emissive['Intensity']), 1, sub) } } : {}),
        ...(surface?.$type === 'MaterialNormalMapFeature' ? { normal: { tree: await tree(surface['NormalMap'], 'layer normal map'), scaleAndBias: surface['ScaleAndBias'] !== false, isXYNormal: surface['IsXYNormal'] !== false } } : {}),
        ...(occlusion?.$type === 'MaterialOcclusionMapFeature' ? {
          occlusion: {
            tree: await tree(occlusion['AmbientOcclusionMap'] ?? { $type: 'ComputeFloat', Value: 1 }, 'layer occlusion'),
            directLighting: this.#scalar(asObject(occlusion['DirectLightingFactor']), 0, sub),
          },
        } : {}),
      });
    }
    return layers;
  }

  /**
   * 清漆（MaterialClearCoatFeature，CSharpIntermediate 的蓝箱子是这种车漆）：各个输入整棵树导出。没写的输入用 Stride 构造函数里的
   * 默认值（颜色是黑、数是 0，过渡距离 1）；两张法线贴图的开关默认 ScaleAndBias 开、IsXYNormal 关。
   */
  async #clearCoat(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<Pick<MaterialFile, 'clearCoat'>> {
    if (!feature) return {};
    if (uvScale[0] !== 1 || uvScale[1] !== 1) this.#context.warnings.push(`${asset.file}: UVScale is not applied to the clear coat color trees`);
    const color = (key: string) => this.#colorTree(asObject(feature[key]) ?? { $type: 'ComputeColor', Value: { R: 0, G: 0, B: 0, A: 1 } }, asset, `clear coat ${key}`);
    const scalar = (key: string, fallback = 0) => this.#colorTree(asObject(feature[key]) ?? { $type: 'ComputeFloat', Value: fallback }, asset, `clear coat ${key}`);
    return {
      clearCoat: {
        lodDistance: await scalar('LODDistance', 1),
        basePaint: { diffuse: await color('BasePaintDiffuseMap'), glossiness: await scalar('BasePaintGlossinessMap'), invert: feature['BasePaintGlossinessInvert'] === true },
        metalFlakes: {
          diffuse: await color('MetalFlakesDiffuseMap'),
          glossiness: await scalar('MetalFlakesGlossinessMap'),
          invert: feature['MetalFlakesGlossinessInvert'] === true,
          metalness: await scalar('MetalFlakesMetalnessMap'),
          // Stride 的属性名就拼成 MetalFlakeslIsXYNormal
          normal: { tree: await color('MetalFlakesNormalMap'), scaleAndBias: feature['MetalFlakesScaleAndBias'] !== false, isXYNormal: feature['MetalFlakeslIsXYNormal'] === true },
        },
        coat: {
          glossiness: await scalar('ClearCoatGlossinessMap'),
          invert: feature['ClearCoatGlossinessInvert'] === true,
          metalness: await scalar('ClearCoatMetalnessMap'),
          normal: { tree: await color('OrangePeelNormalMap'), scaleAndBias: feature['OrangePeelScaleAndBias'] !== false, isXYNormal: feature['OrangePeelIsXYNormal'] === true },
        },
      },
    };
  }

  /**
   * 次表面散射（MaterialSubsurfaceScatteringFeature）：散射宽度、透光度和皮肤散射核的强度、衰减，没写的用 Stride 的默认值。
   * 透光度贴图（TranslucencyMap）还不支持：没有贴图、后备值是 1 的（Stride 的默认）不起作用，别的才报。
   */
  #subsurfaceScattering(feature: StrideObject | undefined, asset: AssetEntry): Pick<MaterialFile, 'subsurfaceScattering'> {
    if (!feature) return {};
    const map = asObject(feature['TranslucencyMap']);
    if (map && (parseAssetReference(map['Texture']) || this.#scalar(map, 1, asset) !== 1)) this.#context.warnings.push(`${asset.file}: subsurface scattering TranslucencyMap is not supported yet; using Translucency`);
    const profile = asObject(feature['ProfileFunction']);
    if (profile && profile.$type !== 'MaterialSubsurfaceScatteringScatteringProfileSkin') this.#context.warnings.push(`${asset.file}: subsurface scattering profile ${profile.$type} is not supported yet; using the skin profile`);
    const kernel = asObject(feature['KernelFunction']);
    return {
      subsurfaceScattering: {
        width: asNumber(feature['ScatteringWidth'], 0.015),
        translucency: asNumber(feature['Translucency'], 0.83),
        strength: color3(kernel?.['Strength'], [0.48, 0.41, 0.28]),
        falloff: color3(kernel?.['Falloff'], [1, 0.37, 0.3]),
      },
    };
  }

  /** 镜面颜色工作流（MaterialSpecularMapFeature）：镜面颜色乘强度；镜面贴图还不支持，用它的后备颜色。 */
  #specularColor(feature: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): Vec3Tuple {
    const map = this.#evaluateColor(asObject(feature['SpecularMap']) ?? {}, asset, uvScale);
    if (map.texture) this.#context.warnings.push(`${asset.file}: specular textures are not supported; using the color`);
    const intensity = Math.min(Math.max(this.#scalar(asObject(feature['Intensity']), 1, asset), 0), 1);
    return [map.color[0] * intensity, map.color[1] * intensity, map.color[2] * intensity];
  }

  /**
   * 透明：MaterialTransparencyBlendFeature 的 alpha（限制在 0..1）同时乘漫反射和镜面；MaterialTransparencyAdditiveFeature 照
   * Stride 的 ComputeColorMaterialAlphaBlend 换成两个系数：漫反射（和输出的 alpha）乘 max(0, 2a - 1)，镜面乘 min(1, 2a)，
   * a 是 0.5 时完全是加法。tint 是常量颜色；MaterialTransparencyCutoffFeature 是 Alpha 裁剪（alphaCutoff）；别的透明特性记警告。
   */
  #transparency(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Pick<MaterialFile, 'transparency' | 'alphaCutoff'> {
    if (!feature) return {};
    // Alpha 裁剪不混合，材质仍画在不透明阶段（Stride 的 MaterialTransparencyCutoffFeature，Alpha 默认 0.5）
    if (feature.$type === 'MaterialTransparencyCutoffFeature') return { alphaCutoff: this.#scalar(asObject(feature['Alpha']), 0.5, asset) };
    const additive = feature.$type === 'MaterialTransparencyAdditiveFeature';
    if (feature.$type !== 'MaterialTransparencyBlendFeature' && !additive) {
      this.#context.warnings.push(`${asset.file}: transparency ${feature.$type ?? 'feature'} is not supported; the material is opaque`);
      return {};
    }
    const alpha = Math.min(Math.max(this.#scalar(asObject(feature['Alpha']), additive ? 0.5 : 1, asset), 0), 1);
    const tint = this.#evaluateColor(asObject(feature['Tint']) ?? { $type: 'ComputeColor' }, asset, uvScale);
    if (tint.texture) this.#context.warnings.push(`${asset.file}: a textured transparency tint is not supported; using the color`);
    const [r, g, b] = tint.color;
    const factors = additive ? { alpha: Math.max(0, 2 * alpha - 1), specularAlpha: Math.min(1, 2 * alpha) } : { alpha };
    return { transparency: { type: 'blend', ...factors, ...(r === 1 && g === 1 && b === 1 ? {} : { tint: [r, g, b] }) } };
  }

  /** CullMode：None 是两面都画；Front（只画背面）还不支持。 */
  #cullMode(mode: StrideValue | undefined, asset: AssetEntry): Pick<MaterialFile, 'doubleSided'> {
    if (mode === 'None') return { doubleSided: true };
    if (mode === 'Front') this.#context.warnings.push(`${asset.file}: front-face culling is not supported; culling back faces`);
    return {};
  }

  /** 法线贴图（MaterialNormalMapFeature）：开关的默认值同 Stride；InvertY 来自贴图资源的 NormalMapTextureType（默认 true）。 */
  async #normalMap(surface: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<Pick<MaterialFile, 'normalMap' | 'normalTree'>> {
    if (!surface) return {};
    if (surface.$type !== 'MaterialNormalMapFeature') {
      this.#context.warnings.push(`${asset.file}: surface ${surface.$type ?? 'feature'} is not supported; using the vertex normals`);
      return {};
    }
    const node = asObject(surface['NormalMap']) ?? {};
    const reference = parseAssetReference(node['Texture']);
    const rules = { scaleAndBias: surface['ScaleAndBias'] !== false, isXYNormal: surface['IsXYNormal'] !== false };
    // 不是单独一张贴图的（着色器类、贴图乘一个数……）整棵树导出
    if (node.$type !== undefined && node.$type !== 'ComputeTextureColor') return { normalTree: { tree: await this.#colorTree(node, asset, 'normal map'), ...rules } };
    // 没写法线贴图，或者贴图节点里没有贴图：照顶点的法线
    if (!reference) return {};
    const textureAsset = this.#context.project.get(reference.id, asset.file);
    const scale = vec2(node['Scale'], 1);
    const slot = textureSlot(await this.texture(textureAsset), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(node['Offset'], 0), samplerOf(node));
    return {
      normalMap: {
        ...slot,
        ...rules,
        invertY: invertsY(textureAsset),
      },
    };
  }

  /**
   * 位移贴图（MaterialDisplacementMapFeature）：整棵树导出，运行时在顶点着色器里算（MaterialShader 的 ComputeColorWave）。只支持
   * Stage 是 Vertex 的（细分阶段的要曲面细分，WebGPU 没有）；Intensity、ScaleAndBias 的默认值同 Stride。
   */
  async #displacement(feature: StrideObject | undefined, asset: AssetEntry): Promise<Pick<MaterialFile, 'displacementTree'>> {
    if (!feature) return {};
    const stage = String(feature['Stage'] ?? 'Vertex');
    if (feature.$type !== 'MaterialDisplacementMapFeature' || stage !== 'Vertex') {
      this.#context.warnings.push(`${asset.file}: displacement ${feature.$type ?? 'feature'} in stage ${stage} is not supported; no displacement`);
      return {};
    }
    const tree = await this.#colorTree(asObject(feature['DisplacementMap']) ?? {}, asset, 'displacement');
    return { displacementTree: { tree, intensity: this.#scalar(asObject(feature['Intensity']), 1, asset), scaleAndBias: feature['ScaleAndBias'] !== false } };
  }

  /** 颜色树原样导出（运行时编译），树里的贴图导出成 TextureRef。 */
  #colorTree(node: StrideObject, asset: AssetEntry, what: string): Promise<ParticleModuleFile> {
    return importColorTree(node, `${asset.file}: ${what}`, {
      texture: async (id) => {
        const textureAsset = this.#context.project.get(id, asset.file);
        const { texture, encoding, size, srgb } = await this.texture(textureAsset);
        return { texture, ...(encoding === 'ktx2' ? {} : { encoding }), ...(size ? { size } : {}), srgb, ...(invertsY(textureAsset) ? { invertY: true } : {}) };
      },
      entity: () => undefined,
      warn: (message) => this.#context.warnings.push(message),
    });
  }

  /**
   * 自发光（MaterialEmissiveMapFeature）：颜色乘强度，同 Stride 的 MaterialSurfaceEmissiveShading；颜色树化简成"贴图乘颜色"
   * （比如 PhysicsSample 的 ComputeBinaryColor：贴图乘 ComputeFloat4），贴图加颜色的记警告、只用颜色。
   */
  async #emissive(feature: StrideObject | undefined, asset: AssetEntry, uvScale: readonly [number, number]): Promise<Pick<MaterialFile, 'emissive' | 'emissiveTexture' | 'emissiveTree'>> {
    if (!feature) return {};
    const intensity = this.#scalar(asObject(feature['Intensity']), 1, asset);
    const emissiveMap = asObject(feature['EmissiveMap']) ?? {};
    // 有着色器类的树化不成"贴图乘颜色"：整棵导出，运行时编译（UV 缩放还不乘进树里的贴图）
    if (hasShaderClass(emissiveMap)) {
      if (uvScale[0] !== 1 || uvScale[1] !== 1) this.#context.warnings.push(`${asset.file}: UVScale is not applied to an emissive color tree`);
      return { emissiveTree: { tree: await this.#colorTree(emissiveMap, asset, 'emissive'), intensity, useAlpha: feature['UseAlpha'] === true } };
    }
    const map = this.#evaluateColor(emissiveMap, asset, uvScale);
    const emissive: Vec3Tuple = [map.color[0] * intensity, map.color[1] * intensity, map.color[2] * intensity];
    if (map.texture && map.operator !== 'multiply') this.#context.warnings.push(`${asset.file}: emissive texture with operator ${map.operator} is not supported; using the color`);
    const texture = map.texture && map.operator === 'multiply' ? map.texture : undefined;
    return { emissive, ...(texture ? { emissiveTexture: textureSlot(await texture.load(), texture.scale, texture.offset, texture.sampler) } : {}) };
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

  /** ComputeTextureScalar 的贴图和通道（Channel，默认 R）；没有贴图时是 undefined（用 #scalar 取后备值）。 */
  async #scalarTexture(node: StrideObject, asset: AssetEntry, uvScale: readonly [number, number]): Promise<(TextureSlot & { channel: 'r' | 'g' | 'b' | 'a' }) | undefined> {
    const reference = parseAssetReference(node['Texture']);
    if (!reference) return undefined;
    const scale = vec2(node['Scale'], 1);
    const slot = textureSlot(await this.texture(this.#context.project.get(reference.id, asset.file)), [scale[0] * uvScale[0], scale[1] * uvScale[1]], vec2(node['Offset'], 0), samplerOf(node));
    return { ...slot, channel: String(node['Channel'] ?? 'R').toLowerCase() as 'r' | 'g' | 'b' | 'a' };
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
        const textureAsset = this.#context.project.get(reference.id, asset.file);
        const texture = { load: () => this.texture(textureAsset), scale: [scale[0] * uvScale[0], scale[1] * uvScale[1]], offset: vec2(node['Offset'], 0), sampler: samplerOf(node) } as const;
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

  /**
   * 有覆盖文件就原样导出它；否则按 textureEncoding：编成 KTX2（UASTC 加 mipmap），或者留着 PNG/JPEG（'source'：运行时不用带
   * KTX2 的解码器）。'source' 时像素没动过的原样复制源文件，导入时改过像素的（缩放、颜色键、1 位 alpha）写成 PNG。
   */
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
    const sized = resized ? await this.#context.tools.resizeImage(image.pixels, image.width, image.height, width, height) : image.pixels;
    // 颜色键（ColorTextureType 的 ColorKeyEnabled，默认品红）：等于这个颜色的像素变透明，在缩放之后做（同 Stride 的 TextureHelper）
    const colorKey = type?.$type === 'ColorTextureType' && type['ColorKeyEnabled'] === true ? color4(type['ColorKeyColor'] ?? { R: 255, G: 0, B: 255, A: 255 }) : undefined;
    const keyed = colorKey ? applyColorKey(sized, colorKey) : sized;
    // Alpha: Mask 的压缩贴图在桌面上是 BC1，alpha 只有 1 位：材质按它做的（硬边的遮罩），照着做，不然半透明的边缘会多出一圈
    const alphaMask = type?.['Alpha'] === 'Mask' && asset.data['IsCompressed'] !== false;
    const masked = alphaMask ? maskAlpha(keyed, type['PremultiplyAlpha'] !== false) : keyed;
    // 像素没动过的源文件才能原样用
    const unchanged = masked === image.pixels;
    if (policy === 'source' && sourceEncoding && unchanged) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
    // 1 位 alpha 的贴图不渗色，透明的地方就是黑的（同 BC1）：渗进去的颜色会被压缩误差漏出来的一点 alpha 带出来，
    // 材质再乘上很大的系数（箱子标志的自发光是遮罩乘 50）就看得见了
    const pixels = alphaMask ? masked : bleedTransparentColors(masked, width, height);
    if (policy === 'source' && sourceEncoding) return this.#copyTexture(asset.path, 'png', encodePng(pixels, width, height), srgb);
    // 编 KTX2 是导入里最慢的一步（一张 2048 的法线贴图要两分钟），结果只取决于像素、尺寸和选项：按它们缓存
    const basis = { mode: 'uastc', srgb, mipmaps: asset.data['GenerateMipmaps'] !== false } as const;
    const encode = () => this.#context.tools.encodeBasis(pixels, width, height, basis);
    const ktx2 = await (this.#context.cache ? this.#context.cache.get(BASIS_RECIPE, [pixels, `${width}x${height}`, JSON.stringify(basis)], encode) : encode());
    if (policy === 'smallest' && sourceEncoding && unchanged && bytes.byteLength < ktx2.byteLength) return this.#copyTexture(asset.path, sourceEncoding, bytes, srgb);
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
  /**
   * texture.load 导入贴图。用到时才调：调用方可能丢掉这张贴图（不支持的镜面贴图、两张贴图里的一张），提前开始的导入没人等，
   * 命令行导完就关掉原生模块，编码任务还在跑会出错（CSharpBeginner 的 board1）。
   */
  readonly texture?: { readonly load: () => Promise<ImportedTexture>; readonly scale: readonly [number, number]; readonly offset: readonly [number, number]; readonly sampler: TextureSampler };
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

/** 颜色树里有没有着色器类（ComputeShaderClassColor）。 */
/**
 * 材质的 Attributes，去掉停用的东西（同 Stride 生成着色器时的做法）：停用的特性（MaterialFeature.Enabled 是 false）整个不要；
 * 停用的贴图节点（ComputeTextureBase.Enabled 是 false）不用贴图，用它的后备值。
 */
function materialAttributes(asset: AssetEntry): StrideObject {
  const features = Object.entries(asObject(asset.data['Attributes']) ?? {}).filter(([, feature]) => asObject(feature)?.['Enabled'] !== false);
  return Object.fromEntries(features.map(([name, feature]) => [name, withoutDisabledTextures(feature)]));
}

function withoutDisabledTextures(value: StrideValue | undefined): StrideValue | undefined {
  const node = asObject(value);
  if (!node) return value;
  const entries = Object.entries(node).filter(([key]) => !(key === 'Texture' && node['Enabled'] === false));
  return Object.fromEntries(entries.map(([key, child]) => [key, withoutDisabledTextures(child)])) as StrideObject;
}

/** 法线贴图的绿色通道要不要翻转（NormalMapTextureType 的 InvertY，默认 true）。 */
function invertsY(texture: AssetEntry): boolean {
  const type = asObject(texture.data['Type']);
  return type?.$type === 'NormalMapTextureType' && type['InvertY'] !== false;
}

/** 颜色树或标量树导入时就能算成常量：没有贴图、着色器类，二元运算是导入器会算的那几个。 */
function isConstant(value: StrideValue | undefined): boolean {
  const node = asObject(value);
  switch (node?.$type) {
    case undefined:
    case 'ComputeColor':
    case 'ComputeFloat4':
    case 'ComputeFloat':
      return true;
    case 'ComputeTextureColor':
    case 'ComputeTextureScalar':
      return parseAssetReference(node['Texture']) === undefined;
    case 'ComputeBinaryColor':
    case 'ComputeBinaryScalar':
      return String(node['Operator']) in BINARY_OPERATORS && isConstant(node['LeftChild']) && isConstant(node['RightChild']);
    default:
      return false;
  }
}

function hasShaderClass(node: StrideValue | undefined): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasShaderClass);
  if ((node as StrideObject).$type === 'ComputeShaderClassColor') return true;
  return Object.values(node as StrideObject).some(hasShaderClass);
}
