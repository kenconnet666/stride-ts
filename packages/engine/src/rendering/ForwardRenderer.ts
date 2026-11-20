/**
 * 图形合成器的前向渲染器（Stride 的 GraphicsCompositor 里的 ForwardRenderer）：深度预通道、不透明阶段、透明阶段，
 * 画进 RGBA16F 的 HDR 颜色缓冲加深度缓冲（同 Stride 的 HDR 渲染模式），再经后处理（PostProcessingEffects：泛光、
 * 色调映射……）写进后备缓冲。方向光可以投阴影（ShadowMapRenderer）。
 * 主画面画槽位 cameraSlot 的相机；textureCameras 里的相机先画进各自的渲染目标贴图（Stride 的 RenderTextureSceneRenderer），
 * 主画面里的精灵、材质就能用上这一帧的结果。
 * 每帧：Collect（相机变成视图）→ Extract → 剔除所有相机的视图 → 按主视图的可见范围算出阴影级联 → 剔除级联 → Prepare
 * → 画阴影图集 → 画各个渲染目标贴图 → 深度预通道 → 画主视图（不透明、透明）→ 后处理。
 * 和 Stride 不同（暂时）：画进渲染目标贴图的相机不用阴影（级联是按主视图算的），也不做后处理（原样拷贝）。
 * 深度预通道同 Stride 默认合成器的 GBuffer 阶段（ZPrepass 效果）：先只画深度，不透明阶段用 less-equal 复用它，
 * 每个像素只做一次完整的着色（TPP 的不透明通道 3.0 → 0.9 ms 量级的差别就在这里）。
 */
import type { CompositorSettings, TextureCamera } from '../content/ContentManager';
import type { ScenePostEffects } from '../content/format';
import type { ColumnsOf } from '../engine/component';
import { system } from '../engine/system';
import { Transform, type TransformColumns } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Color4 } from '../mathematics/vectors';
import { cameraProjectionMatrix } from './cameraRays';
import { Camera, Light } from './components';
import { MAX_DIRECTIONAL_LIGHTS, MAX_LOCAL_LIGHTS, RENDER_GROUP_ALL, RenderStage, RenderView, SURFACE_FORMATS, type DirectionalShadowSettings, type RenderContext, type RenderSystem, type SkyboxLight } from './RenderSystem';
import { GpuProfiler } from '../graphics/GpuProfiler';
import { GraphTexturePool } from './graph/GraphTexturePool';
import { RenderGraph, type GraphTexture, type PassResources, type RenderGraphStats } from './graph/RenderGraph';
import { limitShadowCascades, limitShadowFilter, limitShadowSize, QUALITY_TIERS, type QualitySettings } from './Quality';
import { ShadowMapRenderer } from './shadows/ShadowMapRenderer';
import { TemporalAntialiasing } from './TemporalAntialiasing';
import { AmbientOcclusion } from './AmbientOcclusion';
import { ScreenSpaceReflections } from './ScreenSpaceReflections';
import { ContactShadows } from './ContactShadows';
import { MotionBlur } from './MotionBlur';
import { Skybox } from './Skybox';
import { EffectFrame, isGraphTexture, UniformArena, type Image } from './postfx/ImageEffect';
import { ImageScaler } from './postfx/ImageScaler';
import { PostProcessingEffects } from './postfx/PostProcessingEffects';
import { ScenePicker } from './ScenePicker';

const DEGREES = Math.PI / 180;

/**
 * 聚光的角度衰减 saturate(cos θ · scale + offset)² 的 scale、offset（Stride 的 LightSpot.UpdateLightCache）：内锥（整个锥的
 * 张角，度）里是 1，到外锥减到 0；内外锥角颠倒时按小的当内锥。
 */
export function spotAngleAttenuation(angleInner: number, angleOuter: number): [scale: number, offset: number] {
  const inner = Math.min(angleInner, angleOuter), outer = Math.max(angleInner, angleOuter);
  const cosInner = Math.cos((inner / 2) * DEGREES), cosOuter = Math.cos((outer / 2) * DEGREES);
  const scale = 1 / Math.max(0.001, cosInner - cosOuter);
  return [scale, -cosOuter * scale];
}

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
/** 运动向量：UV 的差，两个半精度。 */
const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';
/** 没画运动向量的像素（清屏的值）：比任何画面里的差都大，TAA 看到它就按深度重投影（TemporalAntialiasing.ts 里同一个数）。 */
const NO_VELOCITY = 4;
const CASCADE_COUNTS = { one: 1, two: 2, four: 4 } as const;
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** 直接画进后备缓冲用的几个阶段，和它们的颜色格式。 */
interface DirectStages {
  readonly format: GPUTextureFormat;
  readonly opaque: RenderStage;
  readonly transparent: RenderStage;
  readonly wireframe: RenderStage;
}

/** 一个视图的颜色画到哪里：目标（这一帧的临时贴图，或者后备缓冲的视图）、尺寸、格式，和这种格式的不透明、透明阶段。 */
interface ColorOutput {
  readonly target: GraphTexture | GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly opaque: RenderStage;
  readonly transparent: RenderStage;
  readonly wireframe: RenderStage;
  /** 不透明阶段另外要写的表面（屏幕空间反射开着时，SURFACE_FORMATS 的顺序）；有它时 opaque 是写表面的那个阶段。 */
  readonly surfaces?: readonly GraphTexture[];
}

export class ForwardRenderer {
  readonly renderSystem: RenderSystem;
  /** 深度预通道（Stride 的 GBuffer 阶段）：主视图里的物体只写深度。 */
  readonly depthPrepassStage: RenderStage;
  readonly opaqueStage: RenderStage;
  /** 透明阶段（Stride 的 Transparent）：精灵，以后的透明材质。 */
  readonly transparentStage: RenderStage;
  /** 主画面画不画透明阶段。 */
  drawTransparent = true;
  /** 画不画方向光的阴影（合成器没有阴影渲染器时关掉，见 SceneCompositor.shadows）。 */
  drawShadows = true;
  /** 粒子画在 UI 上面（Game 在画完 UI 之后画），而不是在透明阶段里（见 SceneCompositor.particlesOverUI）。 */
  particlesOverUI = false;
  /**
   * 主画面的背景：清屏之后、不透明阶段之前在同一个 pass 里画（Stride 的游戏渲染器先画自己的东西再画场景的阶段，比如 JumpyJet 的
   * JumpyJetRenderer 用 SpriteBatch 画视差背景）。颜色是 HDR 格式，带深度缓冲。
   */
  background: ((pass: GPURenderPassEncoder, target: {
    readonly width: number; readonly height: number; readonly format: GPUTextureFormat; readonly depthFormat: GPUTextureFormat;
    /** 屏幕空间反射开着时这一遍另外要写的表面：管线也要带上这几个目标（写掩码 0 就行，见 RenderSystem 的 colorTargets）。 */
    readonly surfaceFormats: readonly GPUTextureFormat[];
  }) => void) | undefined;
  /** 先画进渲染目标贴图的相机（场景的合成器设置，configure 设）。 */
  textureCameras: readonly TextureCamera[] = [];
  /** 线性空间的清屏色；默认是 sRGB 的 (0.1, 0.12, 0.16)。 */
  readonly clearColor = new Color4(0.01, 0.0134, 0.022, 1);
  /** 用哪个相机槽位的相机（Camera.slot，Stride 的 SceneCameraRenderer.Camera）；默认 0。 */
  cameraSlot = 0;
  /** 这一帧用的相机实体找到了没有；没有相机时只清屏（同 Stride）。 */
  hasCamera = false;
  /** 后处理（Stride 的 ForwardRenderer.PostEffects），设置可以改，默认值同 Stride。 */
  readonly postEffects: PostProcessingEffects;
  /** 屏幕空间的环境光遮蔽（GTAO，只乘环境光；开不开照合成器的 AmbientOcclusion，见 AmbientOcclusion.ts）。 */
  readonly ambientOcclusion: AmbientOcclusion;
  /** 运动模糊（默认关，见 MotionBlur.ts）。 */
  readonly motionBlur: MotionBlur;
  /** 主画面上一帧的视图投影（不开 TAA 时运动向量用；开着时 TAA 自己记）。 */
  readonly #lastViewProjection = Matrix.identity();
  /** 接触阴影（投阴影的方向光，屏幕空间；默认关，见 ContactShadows.ts）。 */
  readonly contactShadows: ContactShadows;
  /** 屏幕空间反射（开不开照合成器的 LocalReflections，见 ScreenSpaceReflections.ts）。 */
  readonly screenSpaceReflections: ScreenSpaceReflections;
  /** 屏幕空间反射开着时的不透明阶段：颜色之外写表面（法线、粗糙度、环境镜面反射）。 */
  readonly #opaqueSurfaceStage = new RenderStage('Opaque surface', { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT, surfaceFormats: SURFACE_FORMATS }, { afterDepthPrepass: true });
  /** 这一帧开着 TAA（GTAO 的噪声跟着每帧换）。 */
  #temporal = false;
  /** 时间抗锯齿（默认关，开着时代替后处理里的 FXAA；见 TemporalAntialiasing.ts）。 */
  readonly temporalAntialiasing: TemporalAntialiasing;
  readonly shadowMapRenderer: ShadowMapRenderer;

  readonly #mainView = new RenderView();
  #mainDepth: GPUTexture | undefined;
  /** 每个画进渲染目标贴图的相机一个视图（按 textureCameras 的顺序）。 */
  readonly #textureViews: RenderView[] = [];
  /** HDR 颜色缓冲和深度缓冲，按尺寸缓存（主画面一套，每个渲染目标贴图的尺寸一套）。 */
  /** 主画面的深度缓冲：后处理之后画的东西（场景里的 UI、调试线、粒子）还要和它比，所以不是这一帧的临时贴图。 */
  #depth: GPUTexture | undefined;
  /**
   * 这一帧的渲染图（见 graph/RenderGraph）：阴影、画进渲染目标贴图的相机、主画面的各遍、后处理都是它的通道，HDR 颜色缓冲、
   * 渲染目标贴图的相机用的缓冲、后处理的中间结果都是它的临时贴图（用到才占、用完就让给后面的）。draw 里录完当场执行。
   */
  readonly #graph: RenderGraph;
  readonly #backBufferViewFormat: GPUTextureFormat;
  readonly #pool: GraphTexturePool;
  /** 点选（Game.pick 用它）：问主画面上某个像素最前面的是哪个实例。 */
  readonly picker: ScenePicker;
  /** 没有后处理时主画面直接画进后备缓冲（省掉 HDR 缓冲和一遍拷贝）；关掉是先画进 HDR 缓冲再拷过去，对比、排查时用。 */
  directOutput = true;
  /** 调试视图：在主画面上叠画网格的线框（三角形的边）。 */
  wireframe = false;
  /** 画质档位：内容要的阴影、后处理不超过它给的上限（见 Quality.ts）；默认极高，就是照内容写的画。 */
  quality: QualitySettings = QUALITY_TIERS.ultra;
  readonly #wireframeStage = new RenderStage('Wireframe', { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT }, { wireframe: true });
  /** 运动向量（TAA 用）：不透明的画完以后再画一遍，深度相等的像素写上一帧的位置减这一帧的。 */
  readonly #velocityStage = new RenderStage('Velocity', { colorFormat: VELOCITY_FORMAT, depthFormat: DEPTH_FORMAT }, { afterDepthPrepass: true, velocity: true });
  /** 没有后处理时主画面直接画进后备缓冲用的两个阶段（颜色格式是后备缓冲的）。 */
  #directStages: DirectStages | undefined;
  /** 渲染目标贴图的原样拷贝（自己的参数区：主画面的后处理每帧会重置它的参数区）。 */
  readonly #textureCopy: { scaler: ImageScaler; arena: UniformArena };
  // 找相机：每个要的槽位取第一个带 Camera 和 Transform 的实体；找到的视图记在 #found 里
  readonly #wanted = new Map<number, RenderView>();
  readonly #found = new Set<RenderView>();
  readonly #findCameras = system('ForwardRenderer.cameras', {
    with: { camera: Camera, transform: Transform },
    update: ({ camera, transform, count }) => {
      for (let row = 0; row < count; row++) {
        const view = this.#wanted.get(camera.slot[row]!);
        if (!view || this.#found.has(view)) continue;
        this.#found.add(view);
        const slot = transform.slot[row]!;
        if (!Matrix.invert(view.view, transform.world.subarray(slot * 16, slot * 16 + 16))) Matrix.setIdentity(view.view);
        view.nearClipPlane = camera.nearClipPlane[row]!;
        view.farClipPlane = camera.farClipPlane[row]!;
        cameraProjectionMatrix(view.projection, {
          projection: camera.projection[row]!,
          verticalFieldOfView: camera.verticalFieldOfView[row]!,
          orthographicSize: camera.orthographicSize[row]!,
          nearClipPlane: view.nearClipPlane,
          farClipPlane: view.farClipPlane,
        }, view.width / view.height);
        view.update();
      }
    },
  });

  // 光源：前 MAX_DIRECTIONAL_LIGHTS 个方向光、第一个天空盒光，加上所有环境光
  #lightFound = false;
  #skyboxLight: SkyboxLight | undefined;
  readonly #shadowSettings: DirectionalShadowSettings = {
    size: 'medium', filter: 'none', cascadeCount: 4, depthBias: 0, normalOffsetScale: 0, stabilization: 'projectionSnapping',
    pssmFactor: 0.5, depthRange: 'automatic', minDistance: 0, maxDistance: 50, blendCascades: true,
  };
  readonly #lightColor = new Color4();
  readonly #collectLights = system('ForwardRenderer.lights', {
    with: { light: Light, transform: Transform },
    update: ({ light, transform, count }) => {
      const lighting = this.renderSystem.lighting;
      if (count > 0) this.#lightFound = true;
      for (let i = 0; i < count; i++) {
        const color = this.#lightColor.set(light.color[i * 4]!, light.color[i * 4 + 1]!, light.color[i * 4 + 2]!, 1).toLinear();
        const intensity = light.intensity[i]!;
        if (light.type[i] === 'skybox') {
          const skybox = Skybox.byId(light.skybox[i]!);
          if (!skybox || lighting.skybox) continue;
          const sky = (this.#skyboxLight ??= { skybox, intensity, rotation: new Float32Array(16) });
          sky.skybox = skybox;
          sky.intensity = intensity;
          Matrix.rotationOf(sky.rotation, transform.world, transform.slot[i]! * 16);
          lighting.skybox = sky;
        } else if (light.type[i] === 'point' || light.type[i] === 'spot') {
          this.#collectLocal(light, transform, i, color, intensity);
        } else if (light.type[i] === 'ambient') {
          lighting.ambient.set(lighting.ambient.r + color.r * intensity, lighting.ambient.g + color.g * intensity, lighting.ambient.b + color.b * intensity, 1);
        } else if (lighting.directionalCount < MAX_DIRECTIONAL_LIGHTS) {
          const directional = lighting.directionals[lighting.directionalCount]!;
          // 照向本地 -Z：世界矩阵第三列（Z 轴）取反
          const w = transform.slot[i]! * 16;
          directional.direction.set(-transform.world[w + 8]!, -transform.world[w + 9]!, -transform.world[w + 10]!);
          directional.color.set(color.r * intensity, color.g * intensity, color.b * intensity, 1);
          if (this.drawShadows && this.quality.shadows && light.shadow[i] && lighting.shadowLight < 0) {
            lighting.shadowLight = lighting.directionalCount;
            const s = this.#shadowSettings;
            // 大小、滤波、级联数不超过画质档位给的
            s.size = limitShadowSize(light.shadowSize[i]!, this.quality);
            s.filter = limitShadowFilter(light.shadowFilter[i]!, this.quality);
            s.cascadeCount = limitShadowCascades(CASCADE_COUNTS[light.shadowCascadeCount[i]!], this.quality);
            s.depthBias = light.shadowDepthBias[i]!;
            s.normalOffsetScale = light.shadowNormalOffsetScale[i]!;
            s.stabilization = light.shadowStabilization[i]!;
            s.pssmFactor = light.shadowPssmFactor[i]!;
            s.depthRange = light.shadowDepthRange[i]!;
            s.minDistance = light.shadowMinDistance[i]!;
            s.maxDistance = light.shadowMaxDistance[i]!;
            s.blendCascades = light.shadowBlendCascades[i] !== 0;
            lighting.directionalShadow = s;
          }
          lighting.directionalCount++;
        }
      }
    },
  });

  constructor(renderSystem: RenderSystem) {
    this.renderSystem = renderSystem;
    this.depthPrepassStage = new RenderStage('DepthPrepass', { depthFormat: DEPTH_FORMAT });
    this.opaqueStage = new RenderStage('Opaque', { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT }, { afterDepthPrepass: true });
    this.transparentStage = new RenderStage('Transparent', { colorFormat: HDR_FORMAT, depthFormat: DEPTH_FORMAT }, { transparent: true });
    this.#textureCopy = { scaler: new ImageScaler(renderSystem.device, renderSystem.resources.linearClamp), arena: new UniformArena(renderSystem.device, 4096) };
    this.postEffects = new PostProcessingEffects(renderSystem.device, renderSystem.resources.linearClamp);
    this.temporalAntialiasing = new TemporalAntialiasing(renderSystem.device);
    this.ambientOcclusion = new AmbientOcclusion(renderSystem.device);
    this.screenSpaceReflections = new ScreenSpaceReflections(renderSystem.device, renderSystem.resources.linearClamp);
    this.contactShadows = new ContactShadows(renderSystem.device);
    this.motionBlur = new MotionBlur(renderSystem.device);
    this.#pool = new GraphTexturePool(renderSystem.device);
    this.#graph = new RenderGraph(this.#pool);
    this.picker = new ScenePicker(renderSystem);
    this.shadowMapRenderer = new ShadowMapRenderer(renderSystem.graphicsDevice);
    this.#backBufferViewFormat = renderSystem.graphicsDevice.backBufferViewFormat;
  }

  /** 这一帧画的主视图（找到相机时）：放在 3D 里的 UI 按它画、按它求指针的射线。 */
  get mainView(): RenderView | undefined {
    return this.hasCamera ? this.#mainView : undefined;
  }

  /** 主画面画哪些渲染组（合成器里相机渲染器的 RenderMask）；没有相机时也有。 */
  get renderMask(): number {
    return this.#mainView.cullingMask;
  }

  /** 这一帧主画面的深度缓冲（画布大小，格式 DEPTH_FORMAT）：放在 3D 里的 UI 和它比深度。 */
  get mainDepth(): GPUTexture | undefined {
    return this.hasCamera ? this.#mainDepth : undefined;
  }

  /** 按场景的合成器设置：主画面的清屏色、后处理开关、画不画阴影，和先画的渲染目标贴图。 */
  configure({ clearColor: [r, g, b, a], postEffects, transparent, textureCameras, shadows, particlesOverUI, renderMask }: CompositorSettings): void {
    this.particlesOverUI = particlesOverUI === true;
    this.#mainView.cullingMask = renderMask ?? RENDER_GROUP_ALL;
    this.clearColor.set(r, g, b, a);
    this.postEffects.configure(postEffects);
    this.ambientOcclusion.enabled = postEffects?.ambientOcclusion !== undefined;
    this.ambientOcclusion.radius = postEffects?.ambientOcclusion?.radius ?? 1;
    const reflections = postEffects?.localReflections;
    this.screenSpaceReflections.enabled = reflections !== undefined;
    if (reflections) Object.assign(this.screenSpaceReflections, { maxRoughness: reflections.maxRoughness, edgeFade: reflections.edgeFade });
    this.screenSpaceReflections.reset();
    this.drawTransparent = transparent;
    this.drawShadows = shadows !== false;
    this.textureCameras = textureCameras;
  }

  draw(context: RenderContext): void {
    const { renderSystem } = this;
    const graphicsDevice = renderSystem.graphicsDevice;
    const { canvas } = graphicsDevice;

    // 每个相机的视图：主画面按画布的尺寸，渲染目标贴图按贴图的尺寸
    const textureCameras = this.textureCameras;
    while (this.#textureViews.length < textureCameras.length) this.#textureViews.push(Object.assign(new RenderView(), { receivesShadows: false }));
    this.#wanted.clear();
    this.#found.clear();
    textureCameras.forEach(({ cameraSlot, texture, renderMask }, i) => {
      const view = this.#textureViews[i]!;
      view.cullingMask = renderMask ?? RENDER_GROUP_ALL;
      view.width = texture.data.width;
      view.height = texture.data.height;
      if (!this.#wanted.has(cameraSlot)) this.#wanted.set(cameraSlot, view);
    });
    this.#mainView.width = canvas.width;
    this.#mainView.height = canvas.height;
    this.#wanted.set(this.cameraSlot, this.#mainView);
    context.game.entities.run(this.#findCameras, context.time);
    this.hasCamera = this.#found.has(this.#mainView);
    // 有后处理（画进 HDR 缓冲）、合成器和画质档位都要抗锯齿时才用 TAA：投影在剔除之前挪
    const post = this.postEffects.enabled || !this.directOutput;
    const temporal = this.hasCamera && post && this.temporalAntialiasing.enabled && this.postEffects.antialiasing.enabled && this.quality.antialiasing;
    const blur = this.hasCamera && post && this.motionBlur.enabled && this.quality.motionBlur;
    if (temporal) this.temporalAntialiasing.jitter(this.#mainView);
    else {
      this.temporalAntialiasing.reset();
      // 运动模糊的运动向量要这一帧（不抖动）和上一帧的视图投影；TAA 开着时由它设
      if (blur) {
        this.#mainView.unjitteredViewProjection.set(this.#mainView.viewProjection);
        this.#mainView.previousViewProjection.set(this.#lastViewProjection);
      }
    }
    this.#lastViewProjection.set(temporal ? this.#mainView.unjitteredViewProjection : this.#mainView.viewProjection);
    this.#temporal = temporal;
    this.#mainView.screenOcclusion = undefined;
    this.#mainView.screenShadow = undefined;
    const views = [...(this.hasCamera ? [this.#mainView] : []), ...this.#textureViews.slice(0, textureCameras.length).filter((view) => this.#found.has(view))];

    renderSystem.collect(views);
    this.#gatherLighting(context);
    renderSystem.lighting.shadow = undefined;
    renderSystem.lighting.shadowAtlas = undefined;
    let shadowViews: readonly RenderView[] = [];
    if (views.length > 0) {
      renderSystem.extract(context);
      renderSystem.cull(context, views);
      if (this.hasCamera) shadowViews = this.shadowMapRenderer.collect(this.#mainView, renderSystem.lighting);
      renderSystem.addViews(shadowViews);
      renderSystem.cull(context, shadowViews);
      renderSystem.prepare(context);
    }

    const encoder = graphicsDevice.frameEncoder;
    const graph = this.#graph;
    graph.beginFrame();
    const frame = new EffectFrame(encoder, graph, GpuProfiler.of(renderSystem.device) ?? undefined);
    if (shadowViews.length > 0) {
      // 阴影图集在图外面（着色时经光照的绑定组读它）：算副作用
      frame.pass('ShadowMapRenderer', (pass) => pass.sideEffect(), () => this.shadowMapRenderer.draw(context, encoder, renderSystem, shadowViews));
    }
    // 渲染目标贴图：画完原样拷进贴图
    const copy = this.#textureCopy;
    copy.arena.reset();
    textureCameras.forEach(({ texture, clearColor, transparent }, i) => {
      const view = this.#textureViews[i]!;
      if (!this.#found.has(view)) return;
      const { width, height } = texture.data;
      const color = graph.texture({ label: `${texture.name} color`, width, height, format: HDR_FORMAT });
      const depth = graph.texture({ label: `${texture.name} depth`, width, height, format: DEPTH_FORMAT });
      this.#viewPasses(context, frame, view, this.#hdrOutput(color), depth, clearColor, transparent, `ForwardRenderer ${texture.name}`);
      frame.pass(`ForwardRenderer ${texture.name} copy`, (pass) => {
        pass.read(color);
        pass.sideEffect();
      }, (real) => copy.scaler.copy(encoder, copy.arena, real.texture(color), renderSystem.resources.texture(texture).createView(), texture.data.format));
    });
    const depth = this.#mainDepthFor(canvas.width, canvas.height);
    this.#mainDepth = depth;
    const { r, g, b, a } = this.clearColor;
    // 场景里有 UI、或者粒子画在 UI 上面时留着深度缓冲（它们在后处理之后和它比深度），否则丢掉（分块渲染的 GPU 上省带宽）
    const particles = context.game.particles;
    const reflect = this.hasCamera && post && this.screenSpaceReflections.enabled && this.quality.screenSpaceReflections;
    const keepDepth = temporal || reflect || blur || blur || context.game.ui.drawsInScene || (this.particlesOverUI && particles.components.length > 0) || context.game.debugDraw.tested.count > 0;
    const drawParticles = !this.particlesOverUI && particles.components.length > 0;
    const mainView = this.hasCamera ? this.#mainView : undefined;
    // 点选：有人问的时候才画（用的是这一帧剔除好的实例）
    if (this.picker.pending) frame.pass('ScenePicker', (pass) => pass.sideEffect(), () => this.picker.draw(context, encoder, mainView, canvas.width, canvas.height));
    if (post) {
      const color = graph.texture({ label: 'ForwardRenderer HDR color', width: canvas.width, height: canvas.height, format: HDR_FORMAT });
      const surfaces = reflect ? SURFACE_FORMATS.map((format, i) => graph.texture({ label: `ForwardRenderer surface ${i}`, width: canvas.width, height: canvas.height, format })) : undefined;
      this.#viewPasses(context, frame, mainView, this.#hdrOutput(color, surfaces), depth, [r, g, b, a], this.drawTransparent, 'ForwardRenderer', keepDepth, drawParticles);
      const velocity = temporal || blur ? this.#velocityPass(context, frame, depth) : undefined;
      // 反射在后处理之前合成进画面（同 Stride 的 LocalReflections 排在后处理的最前面）
      const reflected = surfaces ? this.screenSpaceReflections.record(frame, color, depth, surfaces, this.#mainView, velocity) : color;
      // TAA 做了抗锯齿，后处理里就不再做 FXAA
      const antialiased = temporal ? this.temporalAntialiasing.record(frame, reflected, depth, this.#mainView, velocity!) : reflected;
      // 运动模糊在抗锯齿之后、泛光这些之前（亮的东西糊开以后再泛光）
      const input = blur ? this.motionBlur.record(frame, antialiased, depth, velocity!, this.#mainView) : antialiased;
      this.postEffects.record(frame, input, graphicsDevice.currentBackBufferView(), graphicsDevice.backBufferViewFormat, context.time.elapsed, temporal ? { ...this.quality, antialiasing: false } : this.quality);
    } else {
      this.#viewPasses(context, frame, mainView, this.#backBufferOutput(canvas.width, canvas.height), depth, [r, g, b, a], this.drawTransparent, 'ForwardRenderer', keepDepth, drawParticles);
    }
    // 都录好了：跑。uniform 的参数在提交之前一次写进 GPU
    graph.execute();
    this.#pool.endFrame();
    copy.arena.flush();
    if (post) this.postEffects.flush();
    if (this.#mainView.screenOcclusion) this.ambientOcclusion.flush();
    if (reflect) this.screenSpaceReflections.flush();
    if (this.#mainView.screenShadow) this.contactShadows.flush();
    if (blur) this.motionBlur.flush();
    if (temporal) {
      this.temporalAntialiasing.flush();
      this.temporalAntialiasing.unjitter(this.#mainView);
    }
  }

  destroy(): void {
    this.#depth?.destroy();
    this.#depth = undefined;
    this.#pool.destroy();
    this.#textureCopy.arena.destroy();
    this.postEffects.destroy();
    this.temporalAntialiasing.destroy();
    this.ambientOcclusion.destroy();
    this.screenSpaceReflections.destroy();
    this.contactShadows.destroy();
    this.motionBlur.destroy();
    this.picker.destroy();
    this.shadowMapRenderer.destroy();
  }

  /**
   * 一个视图的通道：深度预通道，然后不透明、（transparent 时）透明阶段画进 output。没有视图时只清屏。depth 是这个视图的
   * 深度缓冲：这一帧的临时贴图（渲染目标贴图的相机），或者一张留着的贴图（主画面）。
   */
  #viewPasses(
    context: RenderContext, frame: EffectFrame, view: RenderView | undefined, output: ColorOutput, depth: Image,
    clearColor: readonly number[], transparent: boolean, label: string, keepDepth = false, drawParticles = false,
  ): void {
    const { renderSystem } = this;
    const profiler = renderSystem.graphicsDevice.profiler;
    const { encoder } = frame;
    const { target } = output;
    const depthView = (real: PassResources) => (isGraphTexture(depth) ? real.view(depth) : depth.createView());
    // 没有网格的画面（纯 2D：精灵、UI）深度预通道是空的，不开这一遍，深度在下面那一遍开头清
    const prepassNeeded = view !== undefined && renderSystem.drawsDepth;
    if (prepassNeeded) {
      frame.pass(`${label} depth prepass`, (pass) => (isGraphTexture(depth) ? pass.write(depth) : pass.sideEffect()), (real) => {
        const prepassTimestamps = profiler.passTimestamps(`${label} depth prepass`);
        const prepass = encoder.beginRenderPass({
          label: `${label} depth prepass`,
          ...(prepassTimestamps ? { timestampWrites: prepassTimestamps } : {}),
          colorAttachments: [],
          depthStencilAttachment: { view: depthView(real), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });
        renderSystem.draw(context, prepass, view, this.depthPrepassStage);
        prepass.end();
      });
      // 主画面：深度有了，算屏幕空间的环境光遮蔽，着色时乘环境光
      if (view === this.#mainView && !isGraphTexture(depth) && this.ambientOcclusion.enabled && this.quality.ambientOcclusion) {
        view.screenOcclusion = this.ambientOcclusion.record(frame, depth, view, this.#temporal);
      }
      // 接触阴影：投阴影的那盏方向光（没有就不算）
      const { lighting } = renderSystem;
      if (view === this.#mainView && !isGraphTexture(depth) && this.contactShadows.enabled && this.quality.contactShadows && lighting.shadowLight >= 0) {
        const { direction } = lighting.directionals[lighting.shadowLight]!;
        const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
        view.screenShadow = this.contactShadows.record(frame, depth, view, [-direction.x / length, -direction.y / length, -direction.z / length]);
      }
    }
    const surfaces = output.surfaces ?? [];
    // 透明的、粒子、线框：没有表面时和不透明的在同一遍里画；有表面时（只有不透明的网格写表面）接着另开一遍
    const drawRest = (pass: GPURenderPassEncoder) => {
      if (!view) return;
      if (transparent) renderSystem.draw(context, pass, view, output.transparent);
      // 粒子在透明阶段的最后（Stride 的粒子在透明阶段里，和其他透明物体一起按远近排）
      if (transparent && drawParticles) context.game.particles.draw(context.game, pass, view, output.format, DEPTH_FORMAT);
      if (this.wireframe && view === this.#mainView) renderSystem.draw(context, pass, view, output.wireframe);
    };
    frame.pass(`${label} opaque`, (pass) => {
      if (isGraphTexture(target)) pass.write(target);
      else pass.sideEffect();
      for (const surface of surfaces) pass.write(surface);
      if (!isGraphTexture(depth)) return;
      if (prepassNeeded) pass.readWrite(depth);
      else pass.write(depth);
    }, (real) => {
      const timestampWrites = profiler.passTimestamps(`${label} opaque`);
      const pass = encoder.beginRenderPass({
        label: `${label} opaque`,
        ...(timestampWrites ? { timestampWrites } : {}),
        colorAttachments: [
          { view: isGraphTexture(target) ? real.view(target) : target, clearValue: [...clearColor], loadOp: 'clear', storeOp: 'store' },
          ...surfaces.map((surface) => ({ view: real.view(surface), clearValue: [0, 0, 0, 0], loadOp: 'clear' as const, storeOp: 'store' as const })),
        ],
        depthStencilAttachment: { view: depthView(real), depthClearValue: 1, depthLoadOp: prepassNeeded ? 'load' : 'clear', depthStoreOp: keepDepth || surfaces.length > 0 ? 'store' : 'discard' },
      });
      if (view === this.#mainView) this.background?.(pass, { width: output.width, height: output.height, format: output.format, depthFormat: DEPTH_FORMAT, surfaceFormats: output.opaque.output.surfaceFormats ?? [] });
      if (view) renderSystem.draw(context, pass, view, output.opaque);
      if (surfaces.length === 0) drawRest(pass);
      pass.end();
    });
    if (surfaces.length === 0 || !view) return;
    frame.pass(`${label} transparent`, (pass) => {
      if (isGraphTexture(target)) pass.readWrite(target);
      else pass.sideEffect();
      if (isGraphTexture(depth)) pass.readWrite(depth);
    }, (real) => {
      const pass = encoder.beginRenderPass({
        label: `${label} transparent`,
        colorAttachments: [{ view: isGraphTexture(target) ? real.view(target) : target, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: depthView(real), depthLoadOp: 'load', depthStoreOp: keepDepth ? 'store' : 'discard' },
      });
      drawRest(pass);
      pass.end();
    });
  }

  /** 点光、聚光的常量（Stride 的 LightPoint、LightSpot.UpdateLightCache 算的那些）；超过 MAX_LOCAL_LIGHTS 个的不画。 */
  #collectLocal(light: ColumnsOf<typeof Light>, transform: TransformColumns, i: number, color: Color4, intensity: number): void {
    const lighting = this.renderSystem.lighting;
    if (lighting.localCount >= MAX_LOCAL_LIGHTS) return;
    const local = lighting.locals[lighting.localCount++]!;
    const w = transform.slot[i]! * 16, world = transform.world;
    local.spot = light.type[i] === 'spot';
    local.position.set(world[w + 12]!, world[w + 13]!, world[w + 14]!);
    // 聚光照向本地 -Z
    local.direction.set(-world[w + 8]!, -world[w + 9]!, -world[w + 10]!).normalize();
    local.color.set(color.r * intensity, color.g * intensity, color.b * intensity, 1);
    const radius = Math.max(0.001, local.spot ? light.range[i]! : light.radius[i]!);
    local.radius = radius;
    local.invSquareRadius = 1 / (radius * radius);
    local.shadowIndex = -1;
    local.castsShadow = this.drawShadows && this.quality.shadows && light.shadow[i] !== 0;
    if (local.castsShadow) {
      local.shadow.size = limitShadowSize(light.shadowSize[i]!, this.quality);
      local.shadow.filter = limitShadowFilter(light.shadowFilter[i]!, this.quality);
      local.shadow.depthBias = light.shadowDepthBias[i]!;
      local.shadow.normalOffsetScale = light.shadowNormalOffsetScale[i]!;
      local.world.set(world.subarray(w, w + 16));
    }
    if (!local.spot) return;
    local.angleOuter = light.angleOuter[i]!;
    [local.angleScale, local.angleOffset] = spotAngleAttenuation(light.angleInner[i]!, light.angleOuter[i]!);
  }

  /** 从 Light 组件收集这一帧的光照；一个都没有时用默认光照。 */
  #gatherLighting(context: RenderContext): void {
    const { lighting, defaultLighting } = this.renderSystem;
    lighting.ambient.set(0, 0, 0, 1);
    lighting.directionalCount = 0;
    lighting.localCount = 0;
    lighting.localShadowCount = 0;
    lighting.shadowLight = -1;
    lighting.directionalShadow = undefined;
    lighting.skybox = undefined;
    this.#lightFound = false;
    context.game.entities.run(this.#collectLights, context.time);
    if (this.#lightFound) return;
    defaultLighting.directionals.forEach((light, i) => {
      lighting.directionals[i]!.direction.copy(light.direction);
      lighting.directionals[i]!.color.copy(light.color);
    });
    lighting.directionalCount = defaultLighting.directionalCount;
    lighting.ambient.copy(defaultLighting.ambient);
  }

  /** 上一帧的渲染图：跑了哪些通道、裁掉哪些、临时贴图声明了几张、实际占了几张（调试的 perf 命令和统计量读）。 */
  get graphStats(): RenderGraphStats {
    return this.#graph.stats;
  }

  /**
   * 主画面的运动向量：会画运动向量的特性（网格）按深度相等再画一遍不透明的；没画到的像素（天空、精灵、粒子）是
   * NO_VELOCITY，TAA 在那里按深度重投影。
   */
  #velocityPass(context: RenderContext, frame: EffectFrame, depth: GPUTexture): GraphTexture {
    const velocity = frame.graph.texture({ label: 'ForwardRenderer velocity', width: depth.width, height: depth.height, format: VELOCITY_FORMAT });
    frame.pass('ForwardRenderer velocity', (pass) => pass.write(velocity), (real) => {
      const timestampWrites = this.renderSystem.graphicsDevice.profiler.passTimestamps('ForwardRenderer velocity');
      const pass = frame.encoder.beginRenderPass({
        label: 'ForwardRenderer velocity',
        ...(timestampWrites ? { timestampWrites } : {}),
        colorAttachments: [{ view: real.view(velocity), clearValue: { r: NO_VELOCITY, g: NO_VELOCITY, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
      });
      this.renderSystem.draw(context, pass, this.#mainView, this.#velocityStage);
      pass.end();
    });
    return velocity;
  }

  /** 主画面的深度缓冲；画布改了尺寸时重建。 */
  #mainDepthFor(width: number, height: number): GPUTexture {
    if (this.#depth?.width !== width || this.#depth.height !== height) {
      this.#depth?.destroy();
      this.#depth = this.renderSystem.graphicsDevice.device.createTexture({
        // TAA 读它重投影
        label: `ForwardRenderer depth ${width}x${height}`, size: [width, height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    return this.#depth;
  }

  /** 画进一张 HDR 颜色缓冲（后面接后处理，或者拷进渲染目标贴图）；surfaces 是不透明阶段另外要写的表面（屏幕空间反射用）。 */
  #hdrOutput(color: GraphTexture, surfaces?: readonly GraphTexture[]): ColorOutput {
    return {
      target: color, width: color.width, height: color.height, format: HDR_FORMAT,
      opaque: surfaces ? this.#opaqueSurfaceStage : this.opaqueStage, transparent: this.transparentStage, wireframe: this.#wireframeStage,
      ...(surfaces ? { surfaces } : {}),
    };
  }

  /**
   * 没有后处理时主画面直接画进后备缓冲（同 Stride：合成器的 PostEffects 是 null 时前向渲染器直接画到输出上）：省掉 HDR 缓冲
   * 和把它拷到后备缓冲的那一遍。超过 1 的颜色在写进去时截断。
   */
  #backBufferOutput(width: number, height: number): ColorOutput {
    const graphicsDevice = this.renderSystem.graphicsDevice;
    const { format, opaque, transparent, wireframe } = this.#direct();
    return { target: graphicsDevice.currentBackBufferView(), width, height, format, opaque, transparent, wireframe };
  }

  /** 直接画进后备缓冲用的几个阶段（颜色格式是后备缓冲的）。 */
  #direct(): DirectStages {
    const format = this.renderSystem.graphicsDevice.backBufferViewFormat;
    if (this.#directStages?.format !== format) {
      this.#directStages = {
        format,
        opaque: new RenderStage('Opaque', { colorFormat: format, depthFormat: DEPTH_FORMAT }, { afterDepthPrepass: true }),
        transparent: new RenderStage('Transparent', { colorFormat: format, depthFormat: DEPTH_FORMAT }, { transparent: true }),
        wireframe: new RenderStage('Wireframe', { colorFormat: format, depthFormat: DEPTH_FORMAT }, { wireframe: true }),
      };
    }
    return this.#directStages;
  }

  /**
   * 预热后处理的管线（PostProcessingEffects.warm）、场景开着的 GTAO 和屏幕空间反射的，以及画质档位允许的 TAA、接触阴影、
   * 运动模糊的：这三个是运行中打开的（画质设置里一开），不先编好的话打开的那一帧要当场编译。都在后台编，不挡加载。
   * settings 是要加载的场景的后处理设置；没给（不知道）、不做后处理又直接画进后备缓冲时不用预热。
   */
  warmPostEffects(settings: ScenePostEffects | null | undefined): Promise<void> | undefined {
    if (settings === undefined || (settings === null && this.directOutput)) return undefined;
    const ambientOcclusion = settings?.ambientOcclusion !== undefined && this.quality.ambientOcclusion ? this.ambientOcclusion.warm() : undefined;
    const reflections = settings?.localReflections !== undefined && this.quality.screenSpaceReflections ? this.screenSpaceReflections.warm() : undefined;
    const temporal = this.quality.antialiasing ? this.temporalAntialiasing.warm() : undefined;
    const contact = this.quality.contactShadows ? this.contactShadows.warm() : undefined;
    const blur = this.quality.motionBlur ? this.motionBlur.warm() : undefined;
    return Promise.all([this.postEffects.warm(settings, HDR_FORMAT, this.#backBufferViewFormat, this.quality), ambientOcclusion, reflections, temporal, contact, blur]).then(() => undefined);
  }

  /**
   * 主画面会用到的阶段（阴影投射、深度预通道、不透明、透明）：预热管线时按它们编。主画面直接画进后备缓冲还是先画进
   * HDR 缓冲（有后处理时），两边的颜色格式不同、管线也不同：postEffects 说要加载的场景开不开后处理，没给就按现在的。
   * reflections：开屏幕空间反射时不透明阶段换成写表面的那个。有后处理、画质档位允许 TAA 或运动模糊时，加上画运动向量的阶段
   * （它们是运行中打开的，见 warmPostEffects）。
   */
  warmStages(postEffects = this.postEffects.enabled, reflections = this.screenSpaceReflections.enabled): RenderStage[] {
    const { casterStage, cubeMapCasterStage } = this.shadowMapRenderer;
    const direct = !postEffects && this.directOutput ? this.#direct() : undefined;
    const opaque = direct?.opaque ?? (reflections && this.quality.screenSpaceReflections ? this.#opaqueSurfaceStage : this.opaqueStage);
    const velocity = !direct && (this.quality.antialiasing || this.quality.motionBlur) ? [this.#velocityStage] : [];
    return [casterStage, cubeMapCasterStage, this.depthPrepassStage, opaque, direct?.transparent ?? this.transparentStage, ...velocity];
  }
}

