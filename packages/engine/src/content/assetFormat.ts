/**
 * JSON 的资源文件（说明见 format.ts）：声音、天空盒、贴图的引用和采样、材质（含材质层、法线树、清漆）、精灵表、字体、
 * UI 页面，以及文件的扩展名表。不依赖别的模块（除了同目录的格式文件）。
 */

import type { GraphFile } from '../graph/nodeGraph';

export const EXTENSIONS = {
  model: '.model',
  material: '.material.json',
  scene: '.scene.json',
  prefab: '.prefab.json',
  spriteSheet: '.sheet.json',
  cubemap: '.cubemap',
  skybox: '.skybox.json',
  skeleton: '.skeleton',
  animation: '.anim',
  font: '.font.json',
  /** 单独引用的贴图（脚本属性、合成器的渲染器）：它的 TextureRef，贴图本身在旁边。 */
  texture: '.texture.json',
  gameSettings: '.game.json',
  /** UI 页面或 UI 库（UIFile）。 */
  ui: '.ui.json',
  /** 字体的一个码位块（码位 >> 8）：`<字体>.<块号>.glyphs`。 */
  glyphs: '.glyphs',
  /** 声音（SoundFile），音频文件在旁边。 */
  sound: '.sound.json',
  /** 时间轴（TimelineFile）。 */
  timeline: '.timeline.json',
  /** 关卡白盒（BrushFile）：笔刷的列表，编辑器后端把它烘成同名的模型（.model）。 */
  brush: '.brush.json',
  /** SDF 建模（SdfFile）：形状平滑合成的列表，编辑器后端把它烘成同名的模型（.model）。 */
  sdf: '.sdf.json',
  /** 多边形网格（PolyMeshFile）：顶点和 n 边形的面，编辑器后端把它烘成同名的模型（.model）。 */
  poly: '.poly.json',
  /**
   * 源模型的导入设置（ModelImportFile）：源文件（.glb、.gltf、.fbx、.obj）放在旁边、同名，编辑器后端照设置把它导入成同名的模型
   * （连材质、贴图、骨架、动画），设置改了重新导入。
   */
  modelImport: '.import.json',
} as const;

/** 浏览器能解的音频格式（声音的源文件原样复制，见 docs/roadmap.md 的 D9）。 */
export type SoundEncoding = 'mp3' | 'ogg' | 'wav' | 'flac' | 'aac';

/**
 * 声音（Stride 的 Sound 资源，.sdsnd）：音频文件是 `<路径>.<encoding>`。streamFromDisk 的边下边放（音乐），其余的先整个解码
 * （音效）；spatialized 的可以按 AudioEmitter 的位置空间化。
 */
export interface SoundFile {
  readonly name: string;
  readonly encoding: SoundEncoding;
  readonly streamFromDisk: boolean;
  readonly spatialized: boolean;
}

/**
 * 天空盒的光照（Stride 的 Skybox）：漫反射是球谐，资源管线算好；镜面是按粗糙度预滤波的立方体贴图，运行时第一次用到
 * 时在 GPU 上从 radiance 生成（同 Stride 的 RadiancePrefilteringGGX），不随内容下载。
 */
export interface SkyboxFile {
  /** 3 阶球谐的 9 个 RGB 系数（线性），已经乘过基函数常数，按 Stride 的 EvaluateSphericalHarmonics 求值。 */
  readonly diffuseSH: readonly number[];
  /** 源立方体贴图（内容路径，通常也是背景用的那张），带 mip。 */
  readonly radiance: string;
  /** 预滤波的镜面立方体贴图的边长（2 的幂），同 Stride 的 SkyboxAsset.SpecularCubeMapSize，默认 256。 */
  readonly specularSize: number;
}

/** 材质文件。颜色都是线性空间的。 */
/** 贴图和颜色的组合方式：结果 = 运算(贴图采样, 颜色)。对应 Stride ComputeBinaryColor 的运算符，先支持用到的两个。 */
export type ColorOperator = 'multiply' | 'add';

/**
 * 贴图文件的编码：ktx2（Basis，运行时转码成 GPU 压缩格式），svg（矢量，加载时栅格化），png、jpeg（浏览器解码）。
 * 后三种在显存里是未压缩的 RGBA8，换来的是更小的下载。
 */
export type TextureEncoding = 'ktx2' | 'svg' | 'png' | 'jpeg' | 'webp';

export const TEXTURE_EXTENSIONS: Readonly<Record<TextureEncoding, string>> = { ktx2: '.ktx2', svg: '.svg', png: '.png', jpeg: '.jpg', webp: '.webp' };

/** 一张贴图文件：内容路径和编码。 */
export interface TextureRef {
  /** 贴图的内容路径，文件是 `<路径><TEXTURE_EXTENSIONS[encoding]>`。 */
  readonly texture: string;
  /** 默认 ktx2。 */
  readonly encoding?: TextureEncoding;
  /** svg 栅格化的尺寸（像素），默认取 SVG 的 width、height。 */
  readonly size?: readonly [number, number];
  /** 按 sRGB 采样（Stride 的贴图类型决定）；没写时按用途：颜色贴图是，法线、遮蔽这些数据贴图不是。 */
  readonly srgb?: boolean;
  /**
   * 颜色树里采样时把绿色通道翻过来（g 换成 1 - g）：法线贴图的 InvertY（Stride 的 NormalMapTextureType，默认 true）。
   * Stride 在编译贴图时翻，我们的贴图照源文件，所以在采样的地方翻；固定槽的法线贴图用 NormalMapSlot.invertY。
   */
  readonly invertY?: boolean;
}

/** 采样器（Stride 的 ComputeTextureBase.Filtering、AddressModeU/V）：没写的是线性三线性过滤、重复寻址。 */
export interface TextureSampler {
  readonly filter?: 'point' | 'anisotropic';
  /** Stride 的 Clamp、Border 都是 clamp（WebGPU 没有边框色），Mirror、MirrorOnce 都是 mirror。 */
  readonly addressU?: 'clamp' | 'mirror';
  readonly addressV?: 'clamp' | 'mirror';
}

export interface TextureSlot extends TextureRef, TextureSampler {
  /** 采样坐标 = uv * scale + offset（scale 已经乘上 Stride 材质的 UVScale）。 */
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

/**
 * 法线贴图（Stride 的 MaterialNormalMapFeature）：贴图是线性的；scaleAndBias 把 0..1 映射到 -1..1，isXYNormal 只用 xy、
 * z 由单位长度算出，invertY 把 y 取反（Stride 的 NormalMapTextureType.InvertY 在导入时翻转绿色通道，这里在采样后做，
 * 结果一样）。网格要有切线。
 */
export interface NormalMapSlot extends TextureSlot {
  readonly scaleAndBias: boolean;
  readonly isXYNormal: boolean;
  readonly invertY: boolean;
}

/**
 * 一个材质层（Stride 的 MaterialBlendLayer）：子材质的各个属性按遮罩 blend（0 到 1）线性混进下面的结果（Stride 的
 * MaterialStreamLinearBlend）。子材质没有的属性不改；都是颜色树，运行时编译。
 */
export interface MaterialLayerFile {
  /** 遮罩（BlendMap，标量树）。 */
  readonly blend: ParticleModuleFile;
  readonly diffuse?: ParticleModuleFile;
  /** 镜面颜色工作流：颜色乘强度。 */
  readonly specular?: { readonly color: ParticleModuleFile; readonly intensity: ParticleModuleFile };
  /** 金属度工作流。 */
  readonly metalness?: ParticleModuleFile;
  /** 光泽度（invert 时存的是粗糙度）。 */
  readonly glossiness?: { readonly tree: ParticleModuleFile; readonly invert: boolean };
  /** 切线空间的法线（规则同 MaterialFile.normalTree）。 */
  readonly normal?: { readonly tree: ParticleModuleFile; readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  /** 自发光：颜色乘强度（下面没有自发光时是 0 往上混）。 */
  readonly emissive?: { readonly tree: ParticleModuleFile; readonly intensity: number };
  /**
   * 环境光遮蔽（Occlusion 特性的 AmbientOcclusionMap，标量树）和直射光受它影响的程度（DirectLightingFactor）；
   * 下面没有遮蔽时是从 1、0 往上混。
   */
  readonly occlusion?: { readonly tree: ParticleModuleFile; readonly directLighting: number };
}

/** 法线贴图的颜色树和它的两个开关（意思同 NormalMapSlot）。 */
export interface NormalTreeFile {
  readonly tree: ParticleModuleFile;
  readonly scaleAndBias: boolean;
  readonly isXYNormal: boolean;
}

/**
 * 清漆（Stride 的 MaterialClearCoatFeature，车漆）：两遍。底下一遍是金属碎片和底漆：漫反射色和光泽度按到相机的距离从碎片过渡到
 * 底漆（过渡量 = saturate(距离 × lodDistance)），法线是碎片的法线贴图，金属度是碎片的；上面一遍画在透明阶段、加到画面上：
 * 材质自己的漫反射色配清漆的金属度、光泽度和橘皮法线。都是颜色树；invert 时光泽度的树存的是粗糙度。
 */
export interface ClearCoatFile {
  readonly lodDistance: ParticleModuleFile;
  readonly basePaint: { readonly diffuse: ParticleModuleFile; readonly glossiness: ParticleModuleFile; readonly invert: boolean };
  readonly metalFlakes: { readonly diffuse: ParticleModuleFile; readonly glossiness: ParticleModuleFile; readonly invert: boolean; readonly metalness: ParticleModuleFile; readonly normal: NormalTreeFile };
  readonly coat: { readonly glossiness: ParticleModuleFile; readonly invert: boolean; readonly metalness: ParticleModuleFile; readonly normal: NormalTreeFile };
}

export interface MaterialFile {
  readonly name: string;
  /** 线性颜色。没有贴图时就是漫反射颜色，有贴图时按 baseColorOperator 和贴图组合。 */
  readonly baseColor: readonly [number, number, number, number];
  readonly baseColorTexture?: TextureSlot;
  /** 默认 multiply（baseColor 是白色时就是贴图本身）。 */
  readonly baseColorOperator?: ColorOperator;
  /** 金属度工作流（Stride 的 MaterialMetalnessMapFeature）；没有时材质没有镜面反射（除非有 specular）。 */
  readonly metalness?: number;
  /** 镜面工作流（Stride 的 MaterialSpecularMapFeature）：镜面颜色乘强度，线性；和 metalness 二选一。 */
  readonly specular?: Vec3Tuple;
  /** 镜面工作流不守恒能量（Stride 的 IsEnergyConservative 是 false）：漫反射不乘 1 - 镜面。默认守恒。 */
  readonly specularEnergyConservative?: false;
  /**
   * 没有镜面着色模型（Stride 的 SpecularModel 是空的，SamplesAssetPackage 的木地板 board1B）：不画镜面反射，但金属度、镜面颜色
   * 照常折进漫反射（金属没有漫反射、能量守恒时乘 1 - 镜面）。默认有。
   */
  readonly specularShading?: false;
  /** 微表面镜面模型的各项（Stride 的 MaterialSpecularMicrofacetModelFeature），只写和默认不同的。 */
  readonly microfacet?: MicrofacetModel;
  /** 卡通着色（Stride 的 MaterialDiffuseCelShadingModelFeature、MaterialSpecularCelShadingModelFeature），漫反射、镜面各自可选。 */
  readonly celShading?: CelShading;
  /** 没有漫反射着色模型（Stride 的 DiffuseModel 是空的）：不算漫反射光照，漫反射的颜色只当玻璃的颜色这类用途。默认有。 */
  readonly diffuseShading?: false;
  /**
   * 玻璃（Stride 的 MaterialSpecularThinGlassModelFeature）：画在透明阶段，先把透过去的比例乘到背景上，再把反射加上去；
   * 两个比例按折射率、视角和玻璃的颜色（漫反射的颜色）算。doubleSided 时背面和正面各画一次，能看到玻璃的里面。
   */
  readonly glass?: { readonly refractiveIndex: number };
  /** 清漆，见 ClearCoatFile。 */
  readonly clearCoat?: ClearCoatFile;
  /**
   * 次表面散射（Stride 的 MaterialSubsurfaceScatteringFeature 和皮肤散射核）：width 是散射宽度（世界单位），translucency 是
   * 透光度，strength、falloff 是散射核的强度和衰减（各通道）。意思同 rendering/mesh/Material.ts 的 MaterialSubsurfaceScattering。
   */
  readonly subsurfaceScattering?: { readonly width: number; readonly translucency: number; readonly strength: Vec3Tuple; readonly falloff: Vec3Tuple };
  /** 光泽（Stride 没有，glTF 的 KHR_materials_sheen）：颜色（线性）和粗糙度。意思同 rendering/mesh/Material.ts 的 MaterialSheen。 */
  readonly sheen?: { readonly color: Vec3Tuple; readonly roughness: number };
  /** 各向异性（Stride 没有，glTF 的 KHR_materials_anisotropy）：强度 -1..1，方向绕法线转的角度（弧度）。 */
  readonly anisotropy?: { readonly strength: number; readonly rotation?: number };
  /** 1 - 光泽度；没有时是 1（Stride 的默认光泽度 0）。有 glossinessTexture 时不看它。 */
  readonly roughness?: number;
  /**
   * 光泽度贴图（Stride 的 MaterialGlossinessMapFeature 的 ComputeTextureScalar）：光泽度 = 贴图的 channel 通道，粗糙度 =
   * 1 - 光泽度；invert 时贴图存的就是粗糙度（Stride 的 Invert）。
   */
  readonly glossinessTexture?: TextureSlot & {
    readonly channel: 'r' | 'g' | 'b' | 'a';
    readonly invert: boolean;
    /**
     * 同一张贴图的另一个通道是金属度（glTF 的金属度粗糙度贴图：G 粗糙度、B 金属度），乘到 metalness 上。Stride 是两张贴图
     * 两个槽；这里一次采样两个值，不多占片元阶段的贴图绑定。
     */
    readonly metalnessChannel?: 'r' | 'g' | 'b' | 'a';
  };
  /** 自发光：线性颜色乘强度；有 emissiveTexture 时再乘贴图（Stride 的 ComputeBinaryColor 乘法）。 */
  readonly emissive?: Vec3Tuple;
  readonly emissiveTexture?: TextureSlot;
  /**
   * 化不成"贴图乘颜色"的自发光（比如有着色器类）：整棵颜色树（格式同粒子材质的，见 ParticleModuleFile），运行时编译成 WGSL；
   * 有它时不看 emissive、emissiveTexture。useAlpha：输出的 alpha 用自发光的 alpha（Stride 的 UseAlpha）。
   */
  /**
   * 法线贴图是颜色树（MaterialNormalMapFeature 的 NormalMap 是着色器类这样的树，MaterialShader 的 ComputeColorWaveNormal）：
   * 在片元着色器里算，ScaleAndBias、IsXYNormal 同 normalMap。
   */
  readonly normalTree?: { readonly tree: ParticleModuleFile; readonly scaleAndBias: boolean; readonly isXYNormal: boolean };
  /**
   * 位移贴图（MaterialDisplacementMapFeature，Stage 是 Vertex）：顶点沿模型空间的法线移动 树的值 × intensity
   * （scaleAndBias 时值先从 0..1 换到 -1..1）。
   */
  readonly displacementTree?: { readonly tree: ParticleModuleFile; readonly intensity: number; readonly scaleAndBias: boolean };
  readonly emissiveTree?: { readonly tree: ParticleModuleFile; readonly intensity: number; readonly useAlpha: boolean };
  /**
   * 材质层（Stride 的 MaterialBlendLayer），按顺序叠在这个材质上面。材质自己的属性化不成上面那些固定的形状时（光泽度是
   * "贴图乘数"、镜面带贴图……），导入器把这些属性的树放进最底下一层、遮罩是常量 1 的层里：和材质层走同一条路径，盖住固定槽的值。
   */
  readonly layers?: readonly MaterialLayerFile[];
  /**
   * 材质节点图（Stride 没有；照 Substance Designer、Material Maker）：输出（baseColor、metalness、roughness、normal、emissive、
   * occlusion）盖过上面的值，在着色器里直接求值。节点库见 rendering/mesh/materialGraph.ts。
   */
  readonly graph?: GraphFile;
  /** 两面都画（Stride 的 CullMode 是 None）。 */
  readonly doubleSided?: boolean;
  /** 环境光遮蔽（Stride 的 Occlusion 特性的 AmbientOcclusionMap）。 */
  readonly ambientOcclusion?: AmbientOcclusionSlot;
  /** 透明（Stride 的 MaterialTransparencyBlendFeature）：预乘 alpha 混合，画在透明阶段。 */
  readonly transparency?: TransparencyFile;
  /** Alpha 裁剪（Stride 的 MaterialTransparencyCutoffFeature 的 Alpha）：基础色的 alpha 低于它的像素丢掉，材质仍是不透明的。 */
  readonly alphaCutoff?: number;
  /** Stride 的 Occlusion 特性里的 cavity：漫反射和镜面的可见部分乘上这两个系数。 */
  readonly cavity?: { readonly diffuse: number; readonly specular: number };
  readonly normalMap?: NormalMapSlot;
}

export type Vec3Tuple = readonly [number, number, number];

/**
 * 环境光遮蔽：遮蔽值 = 贴图的 channel 通道（没有贴图时是 value）。环境光（环境色、天空盒）乘遮蔽值，直射光乘
 * lerp(1, 遮蔽值, directLighting)（Stride 的 MaterialPixelStream、LightSkyboxShader）。
 */
export interface AmbientOcclusionSlot {
  readonly value: number;
  readonly texture?: TextureSlot & { readonly channel: 'r' | 'g' | 'b' | 'a' };
  readonly directLighting: number;
}

/**
 * 透明混合：可见的漫反射乘 alpha、镜面乘 specularAlpha（默认同 alpha），都乘 tint，输出的 alpha 是漫反射的 alpha 乘 alpha
 * （Stride 的预乘 alpha 和 matDiffuseSpecularAlphaBlend）。Stride 的加法透明（MaterialTransparencyAdditiveFeature）也是它：
 * alpha = max(0, 2a - 1)、specularAlpha = min(1, 2a)，a 是 0.5 时完全是加法。
 */
/**
 * 微表面镜面模型的各项，名字同 Stride 的 MaterialSpecularMicrofacet* 各类（Stride 的公式见 BRDFMicrofacet.sdsl）。默认是
 * Stride 默认的那套：菲涅耳 Schlick、分布 GGX、可见性 Smith-Schlick-GGX、环境光查 DFG 表（GGXLUT）。玻璃的菲涅耳和环境项
 * （ThinGlass）跟着 MaterialFile.glass，不在这里。
 */
export interface MicrofacetModel {
  readonly fresnel?: 'schlick' | 'none';
  readonly distribution?: 'ggx' | 'beckmann' | 'blinnPhong';
  readonly visibility?: 'smithSchlickGGX' | 'implicit' | 'neumann' | 'cookTorrance' | 'kelemen' | 'smithBeckmann' | 'smithGGXCorrelated' | 'smithSchlickBeckmann';
  /** 环境光的镜面系数：查 DFG 表，或 Stride 的多项式近似（GGXPolynomial）。 */
  readonly environment?: 'lut' | 'polynomial';
}

/**
 * 卡通着色的渐变：节点 [位置, r, g, b]（线性颜色），按位置从小到大，最多 CEL_RAMP_STOPS 个；节点之间线性插值，同一位置的两个
 * 节点是一个台阶，两头外面取端点的颜色。Stride 的默认四档、黑白两档和渐变贴图都换成这种节点（贴图在导入时化简）。
 */
export type CelRamp = readonly (readonly [number, number, number, number])[];

/** 一个渐变最多几个节点（材质常量里留的位置）。 */
export const CEL_RAMP_STOPS = 8;
/** Stride 卡通着色的默认渐变（MaterialCelShadingLightDefault）：0.2、0.5、0.8 处分成 0、0.3、0.8、1 四档。 */
export const CEL_DEFAULT_RAMP: CelRamp = [[0, 0, 0, 0], [0.2, 0, 0, 0], [0.2, 0.3, 0.3, 0.3], [0.5, 0.3, 0.3, 0.3], [0.5, 0.8, 0.8, 0.8], [0.8, 0.8, 0.8, 0.8], [0.8, 1, 1, 1], [1, 1, 1, 1]];
/** Stride 卡通着色的黑白两档（MaterialCelShadingLightDefault 的 IsBlackAndWhite）：0.2 以下黑，以上白。 */
export const CEL_BLACK_AND_WHITE_RAMP: CelRamp = [[0.2, 0, 0, 0], [0.2, 1, 1, 1]];

/**
 * 卡通着色。漫反射：N·L 乘光的衰减过 diffuse 渐变，阴影和遮蔽另乘；fakeNDotL 大于 0 时 N·L 先乘它（Stride 的 FakeNDotL）。镜面：
 * 微表面的结果按亮度过 specular 渐变。环境光的漫反射也按亮度过 diffuse 渐变。
 */
export interface CelShading {
  readonly diffuse?: { readonly ramp: CelRamp; readonly fakeNDotL?: number };
  readonly specular?: { readonly ramp: CelRamp };
}

export interface TransparencyFile {
  readonly type: 'blend';
  readonly alpha: number;
  readonly specularAlpha?: number;
  /** 线性颜色，默认白色。 */
  readonly tint?: Vec3Tuple;
  /** 阴影按 alpha 抖动（Stride 的 DitheredShadows），默认 true。 */
  readonly ditheredShadows?: boolean;
}

/**
 * 粒子模块里的值：数字、布尔、字符串（枚举，首字母小写；名字原样）、数组（向量、四元数、颜色）、贴图、对实体（或它的组件）
 * 的引用、嵌套的模块、模块的列表。
 */
export type ParticleValue =
  | number | boolean | string | null | readonly number[] | TextureRef | { readonly $entity: string } | ParticleModuleFile | readonly ParticleModuleFile[];

/**
 * 粒子系统里的一个对象（Stride 的 ParticleSystemComponent、ParticleSystem、发射器、生成器、初始化器、更新器、形状、材质……）：
 * $type 是 Stride 的类名首字母小写（发射器这种不带类型标签的没有），其余是属性，名字首字母小写，没写的用 Stride 的默认值。
 * 向量、四元数、颜色是数组（颜色原样，不换色彩空间），贴图是 TextureRef，Spawners、Initializers、Updaters、Emitters 是数组。
 * 导入器只留下运行时认识的模块类型（见 pipeline 的 particles.ts），其余的警告后去掉。
 */
export interface ParticleModuleFile {
  readonly $type?: string;
  readonly [key: string]: ParticleValue | undefined;
}

/** 精灵的混合方式（Stride 的 SpriteBlend；auto 是贴图透明时 alphaBlend，不透明时 none）。 */
export type SpriteBlend = 'auto' | 'none' | 'alphaBlend' | 'additiveBlend' | 'noColor';

/** 精灵表（Stride 的 SpriteSheet，.sdsheet）：按 Stride 里的顺序列出精灵。 */
export interface SpriteSheetFile {
  readonly name: string;
  readonly sprites: readonly {
    readonly name: string;
    /** 精灵所在的贴图（按 sRGB 采样）。同一张源图的精灵共用一张贴图。 */
    readonly texture: TextureRef;
    /** 贴图上的区域，像素：x、y（左上角）、宽、高。 */
    readonly region: readonly [number, number, number, number];
    readonly pixelsPerUnit: number;
    /** 原点在区域里的像素位置：centerFromMiddle 时从区域中心算，否则从左上角算。 */
    readonly center: readonly [number, number];
    readonly centerFromMiddle: boolean;
    /** 九宫格的边框（Stride 的 Sprite.Borders），像素：左、上、右、下；没有时是 0（整张拉伸）。 */
    readonly borders?: readonly [number, number, number, number];
  }[];
}

/**
 * 字体（Stride 的 SpriteFont，.sdfnt）：字形是轮廓（矢量文字，见 rendering/text），按码位分块存在旁边的 .glyphs 文件里，
 * 用到哪块才下载哪块。长度单位都是 em（字号是 1 像素时的像素数），y 向上。
 */
export interface FontFile {
  readonly name: string;
  /**
   * Stride 的字体类型：static 是编译期栅格化的（OfflineRasterized，只有导入时列出的字符，画的时候按 size，不能换字号），
   * dynamic 是运行时栅格化的（RuntimeRasterized，字体里的所有字符，字号可变），sdf 是有向距离场的（字号可变）。
   * 我们都按轮廓画，区别只在字符集和能不能换字号。
   */
  readonly kind: 'static' | 'dynamic' | 'sdf';
  /** 默认字号（像素，Stride 的 Size）。 */
  readonly size: number;
  /** aliased 时覆盖率按 0.5 取舍（没有抗锯齿）；clearType 在 Stride 里已经升级成灰度，和 default 一样。 */
  readonly antiAlias: 'default' | 'aliased' | 'clearType';
  /**
   * 字体要求栅格化时把 ppem（每 em 的像素数）取整（head 表 flags 的第 3 位，Arial 这些 TrueType 字体都有）：Stride 用的 FreeType
   * 开着 hinting，照做，字号 33.33 的字按 33 画、按 33 排，见 rendering/text/layout.ts 的 glyphScale。
   */
  readonly integerPpem: boolean;
  /** 字体的上升、下降（都是正数）和行间距（hhea）。 */
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  /** Stride 的 Spacing（字符之间额外的距离）和 LineSpacing（行之间额外的距离），像素，按 size 定的。 */
  readonly spacing: number;
  readonly lineSpacing: number;
  /** Stride 的 LineGapFactor、LineGapBaseLineFactor。 */
  readonly lineGapFactor: number;
  readonly lineGapBaseLineFactor: number;
  /** 找不到字形时用的字符（Stride 的 DefaultCharacter）。 */
  readonly defaultCharacter: number;
  /** 有字形的码位块（码位 >> 8），升序。 */
  readonly blocks: readonly number[];
  /** kern 表的字距，每三个一组：左边的码位、右边的码位、调整量（em）；按左、右码位排序。 */
  readonly kerning: readonly number[];
}

/**
 * UI 页面或 UI 库（Stride 的 UIPageAsset、UILibraryAsset，.sduipage、.sduilib）：元素平铺成数组，互相用下标引用。
 * 布局只有两维（和 Stride 不同：Stride 的布局是三维的，深度方向的尺寸、对齐、Grid 的层都不导入，见 docs/decisions.md）。
 */
export interface UIFile {
  readonly name: string;
  /** 设计时的分辨率（Stride 的 Design.Resolution），宽、高。 */
  readonly designResolution: readonly [number, number];
  /** 页面的根元素；UI 库没有。 */
  readonly root?: number;
  /** UI 库公开的元素（Stride 的 UILibrary.UIElements）：名字 → 元素。 */
  readonly templates?: Readonly<Record<string, number>>;
  readonly elements: readonly UIElementFile[];
}

/**
 * UI 元素的类型（Stride 的类名，能写在 .sduipage 里的都在；ContentControl 这类抽象类不算）。RichTextBlock 是我们加的
 * （Markdown 的富文本，Stride 没有）。
 */
export type UIElementType =
  | 'Border' | 'Button' | 'Canvas' | 'ContentDecorator' | 'ContentPresenter' | 'EditText' | 'Grid'
  | 'ImageButton' | 'ImageElement' | 'ModalElement' | 'RichTextBlock' | 'ScrollBar' | 'ScrollingText' | 'ScrollViewer' | 'Slider' | 'StackPanel'
  | 'TextBlock' | 'ToggleButton' | 'UniformGrid';

export interface UIElementFile {
  readonly type: UIElementType;
  /** 元素的属性：Stride 的属性名首字母小写，值见 UIValue。没写的是 Stride 的默认值。 */
  readonly props: Readonly<Record<string, UIValue>>;
  /**
   * 附加属性（Stride 的 DependencyProperties 里别的类定义的），名字同运行时 UIElement 上的属性：`gridRow`、`gridColumn`、
   * `gridRowSpan`、`gridColumnSpan`、`panelZIndex`、`canvasAbsolutePosition`、`canvasRelativePosition`、`canvasRelativeSize`、
   * `canvasPinOrigin`、`canvasUseAbsolutePosition`。
   */
  readonly attached?: Readonly<Record<string, UIValue>>;
  /** 面板的子元素（Stride 的 Panel.Children），按顺序。 */
  readonly children?: readonly number[];
  /** 内容控件的内容（Stride 的 ContentControl.Content）。 */
  readonly content?: number;
}

/**
 * UI 元素的属性值：标量原样，枚举是首字母小写的名字（'center'、'collapsed'）；颜色是 sRGB 的 [r, g, b, a]（0 到 1）；
 * Thickness（Margin、Padding）是 [左, 上, 右, 下]；颜色、Thickness 里的 null 是文件里没写的成员（保持元素类型的默认值）；
 * 向量是数组，Stride 里的 NaN（没设）是 null；Grid 的行列定义是对象的数组；图片是 UISpriteValue；字体是 { $asset, kind: 'font' }。
 */
export type UIValue =
  | null
  | boolean
  | number
  | string
  | readonly (number | null)[]
  | UISpriteValue
  | readonly UIStripDefinition[]
  | { readonly $asset: string; readonly kind: 'font' };

/** UI 的图片（Stride 的 ISpriteProvider）：精灵表的一帧，或者一整张贴图。 */
export type UISpriteValue =
  | { readonly sheet: string; readonly frame: number }
  | { readonly texture: TextureRef };

/** Grid 的一行或一列（Stride 的 StripDefinition）；没写的同 Stride 的默认值（star、1、0、无穷大）。 */
export interface UIStripDefinition {
  readonly type?: 'fixed' | 'auto' | 'star';
  readonly sizeValue?: number;
  readonly minimumSize?: number;
  readonly maximumSize?: number;
}

/**
 * 关卡白盒（Stride 没有；照虚幻 Modeling Mode 的 CubeGrid、Godot 的 CSG 节点、Unity 的 ProBuilder）：一串笔刷——方块、挤出的
 * 多边形、圆柱、球——按顺序加上、减掉或求交，编辑器后端（Manifold，原生工具模块的 st_brush_csg）烘成同名的模型：平直的法线，
 * 按朝向投影的世界坐标 UV（uvScale 米一个周期，贴网格图时各个面接得上），每个笔刷的面用它的材质槽。场景引用的是烘出的模型，
 * 运行时不做布尔运算；这个文件是源头，随时能回来改参数（和直接改网格的建模不同）。
 */
export interface BrushFile {
  readonly name: string;
  /** 材质槽（内容路径；null 是默认材质）；笔刷的 material 是这里的下标。 */
  readonly materials: readonly (string | null)[];
  /** 自动 UV：多少米一个贴图周期（默认 1）。 */
  readonly uvScale?: number;
  /** 按顺序合成（第一个应该是 add）。 */
  readonly brushes: readonly BrushShapeFile[];
}

/** 一个笔刷：形状、运算、放在哪（相对模型的原点）、用哪个材质槽。 */
export type BrushShapeFile = {
  /** 编辑器里显示的名字。 */
  readonly name?: string;
  readonly operation: 'add' | 'subtract' | 'intersect';
  readonly position: Vec3Tuple;
  /** 四元数 xyzw；没写是不转。 */
  readonly rotation?: readonly [number, number, number, number];
  /** 材质槽的下标，没写是 0。 */
  readonly material?: number;
} & (
  /** 方块：中心在 position。 */
  | { readonly kind: 'box'; readonly size: Vec3Tuple }
  /** 挤出的多边形：XZ 平面上的简单多边形（可以是凹的，点是 [x, z]），从 position 往上挤出 height。 */
  | { readonly kind: 'prism'; readonly points: readonly (readonly [number, number])[]; readonly height: number }
  /** 圆柱（顶面半径不同时是圆台、为 0 是圆锥）：轴是 Y，中心在 position。 */
  | { readonly kind: 'cylinder'; readonly height: number; readonly radius: number; readonly topRadius?: number; readonly segments?: number }
  | { readonly kind: 'sphere'; readonly radius: number; readonly segments?: number }
);

/**
 * SDF 建模（Stride 没有；照 Womp、Adobe Substance Modeler 的"液态"建模）：一串形状——球、圆角方块、胶囊、圆柱、圆环、椭球——
 * 按顺序平滑地并上、减掉或求交（smoothness 是融合带的宽度，0 是硬接），编辑器后端（原生工具模块的 st_sdf_mesh，Manifold 的等值面）
 * 烘成同名的模型：光滑的法线（距离场的梯度，融合的地方也是圆的），按朝向投影的世界坐标 UV，每个三角形用离它最近的形状的材质槽。
 * 圆润的道具、角色的粗形、石头这类用它很快；场景引用烘出的模型，这个文件是源头，随时回来改参数。
 */
export interface SdfFile {
  readonly name: string;
  /** 材质槽（内容路径；null 是默认材质）；形状的 material 是这里的下标。 */
  readonly materials: readonly (string | null)[];
  /** 网格的边长（米，默认 0.05）：越小越细、烘得越慢。 */
  readonly resolution?: number;
  /** 自动 UV：多少米一个贴图周期（默认 1）。 */
  readonly uvScale?: number;
  /** 按顺序合成（第一个应该是 add）。 */
  readonly shapes: readonly SdfShapeFile[];
}

/** SDF 建模的一个形状：形状、运算、和前面融合的宽度、放在哪（中心，相对模型的原点）、用哪个材质槽。 */
export type SdfShapeFile = {
  /** 编辑器里显示的名字。 */
  readonly name?: string;
  readonly operation: 'add' | 'subtract' | 'intersect';
  /** 和前面的形状融合的宽度（米）；没写是 0（硬接）。 */
  readonly smoothness?: number;
  readonly position: Vec3Tuple;
  /** 四元数 xyzw；没写是不转。 */
  readonly rotation?: readonly [number, number, number, number];
  /** 材质槽的下标，没写是 0。 */
  readonly material?: number;
} & (
  | { readonly kind: 'sphere'; readonly radius: number }
  /** 方块：size 是整个的边长，圆角在尺寸以内。 */
  | { readonly kind: 'box'; readonly size: Vec3Tuple; readonly cornerRadius?: number }
  /** 胶囊：轴是 Y，height 是两个半球中心之间的距离。 */
  | { readonly kind: 'capsule'; readonly height: number; readonly radius: number }
  /** 圆柱：轴是 Y，边上的圆角在尺寸以内。 */
  | { readonly kind: 'cylinder'; readonly height: number; readonly radius: number; readonly edgeRadius?: number }
  /** 圆环：环在 XZ 平面上。 */
  | { readonly kind: 'torus'; readonly ringRadius: number; readonly tubeRadius: number }
  | { readonly kind: 'ellipsoid'; readonly radii: Vec3Tuple }
);

/** 能导入的源模型的格式：源文件是 `<内容路径>.<格式>`。 */
export type ModelSourceFormat = 'glb' | 'gltf' | 'fbx' | 'obj';

/**
 * 源模型的导入设置（`.import.json`，和导入出的模型同名；Stride 的 ModelAsset、Unity 的 ModelImporter、Godot 的 .import 那一类）。
 * 编辑器把 glTF、FBX、OBJ 拖进来时写一份默认的，源文件留在旁边；改了设置后端重新导入：模型、骨架、动画、贴图照新的设置重写，
 * 已经有的材质文件不动（导入以后可能改过）。
 */
export interface ModelImportFile {
  /** 源文件的格式：源文件是 `<内容路径>.<source>`。 */
  readonly source: ModelSourceFormat;
  /** 整体缩放（Stride 的 ScaleImport、Unity 的 Scale Factor）：顶点、骨架和动画的平移、形变的位移都乘它；厘米做的 FBX 写 0.01。 */
  readonly scale: number;
  /** 导入材质（和它们的贴图）；关着时网格用默认材质。 */
  readonly materials: boolean;
  /** 导入动画（每个动画一个剪辑）；关着时只在有蒙皮时导骨架。 */
  readonly animations: boolean;
  /** 动画烘焙的采样率（每秒关键帧数）。 */
  readonly sampleRate: number;
}

/** 新导入的源模型的设置（同 Stride 导入 FBX、glTF 的默认）。 */
export const DEFAULT_MODEL_IMPORT: Omit<ModelImportFile, 'source'> = { scale: 1, materials: true, animations: true, sampleRate: 30 };

/**
 * 多边形网格（Stride 没有；照 Unity 的 ProBuilder、Blender 的网格编辑）：顶点加 n 边形的面，编辑器里点线面地改（挤出、内插、倒角、
 * 合并、切割，modeling/polyEdit.ts），编辑器后端烘成同名的模型：面三角化，相邻面的夹角小于 smoothAngle 时法线光滑过渡（其余是硬边），
 * 按朝向投影的世界坐标 UV，每个面用它的材质槽；mirror 给了时按那个平面镜像一份（像 Blender 的镜像修改器：文件里只存一半，
 * 改一边两边一起变）。场景引用烘出的模型。
 */
export interface PolyMeshFile {
  readonly name: string;
  /** 材质槽（内容路径；null 是默认材质）；面的 material 是这里的下标。 */
  readonly materials: readonly (string | null)[];
  /** 顶点的位置（相对模型的原点）。 */
  readonly vertices: readonly Vec3Tuple[];
  readonly faces: readonly PolyFaceFile[];
  /** 相邻面的夹角（度）小于它时法线光滑过渡，默认 30；0 是全部硬边（平直的面）。 */
  readonly smoothAngle?: number;
  /** 自动 UV：多少米一个贴图周期（默认 1）。 */
  readonly uvScale?: number;
  /** 按 x = 0、y = 0 或 z = 0 的平面镜像一份，落在平面上的顶点两边共用；没写是不镜像。 */
  readonly mirror?: 'x' | 'y' | 'z';
}

/** 一个面：顶点下标按从外面看逆时针排（至少 3 个，大致在一个平面上，可以是凹的）。 */
export interface PolyFaceFile {
  readonly vertices: readonly number[];
  /** 材质槽的下标，没写是 0。 */
  readonly material?: number;
}

/**
 * 时间轴（Stride 没有；照虚幻的 Sequencer、Unity 的 Timeline）：一段时间里各条轨道上的东西。游戏里当过场放（TimelinePlayer
 * 脚本），编辑器里拖时间预览，成片导出按它出帧。轨道里的实体写场景文件里的实体 id（时间轴配着一个场景用），时刻都是秒。
 */
export interface TimelineFile {
  readonly name: string;
  /** 长度（秒）。 */
  readonly duration: number;
  /** 编辑器里吸附、显示用的帧率；没写是 30。 */
  readonly frameRate?: number;
  readonly tracks: readonly TimelineTrackFile[];
}

/** 关键帧之间怎么插值：constant 取前一个关键帧的值，linear 线性（四元数走球面），cubic 过四个点的 Catmull-Rom。 */
export type TimelineInterpolation = 'constant' | 'linear' | 'cubic';

export type TimelineTrackFile =
  /**
   * 属性：实体上一个组件（运行时的组件名，比如 Transform、Light、游戏的 `gameplay/health#Health`）的一个属性按关键帧走。
   * 值是数，或者按分量的数组（向量 xyz、四元数 xyzw、颜色 rgba）。
   */
  | {
    readonly type: 'property'; readonly entity: string; readonly component: string; readonly property: string;
    readonly interpolation?: TimelineInterpolation;
    /** in、out：cubic 时关键帧两侧的切线（每秒变多少，分量同 value）；不写是自动的平滑切线。 */
    readonly keys: readonly { readonly time: number; readonly value: number | readonly number[]; readonly in?: number | readonly number[]; readonly out?: number | readonly number[] }[];
  }
  /** 相机切换：每个切点以后主画面用哪台相机（场景里带 Camera 的实体）。 */
  | { readonly type: 'camera'; readonly cuts: readonly { readonly time: number; readonly camera: string }[] }
  /**
   * 动画剪辑：实体的 AnimationComponent 从 start 起放这个剪辑（剪辑在组件的 animations 里的名字），放到下一个片段开始；第一个片段
   * 之前停在它的第一帧。speed 没写是 1；blend 是从前一个片段过渡过来的秒数（交叉淡化），没写是直接切。
   */
  | { readonly type: 'animation'; readonly entity: string; readonly clips: readonly { readonly start: number; readonly clip: string; readonly speed?: number; readonly blend?: number }[] }
  /** 声音：从 start 起放（声音资源的内容路径），volume 没写是 1。 */
  | { readonly type: 'sound'; readonly clips: readonly { readonly start: number; readonly sound: string; readonly volume?: number }[] }
  /** 字幕：start 到 end 之间显示 text。 */
  | { readonly type: 'subtitle'; readonly cues: readonly { readonly start: number; readonly end: number; readonly text: string }[] }
  /** 事件：播放经过 time 时通知（TimelinePlayer 的 events），游戏的脚本按名字接。 */
  | { readonly type: 'event'; readonly events: readonly { readonly time: number; readonly name: string }[] };
