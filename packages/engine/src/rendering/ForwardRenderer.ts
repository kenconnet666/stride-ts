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
import type { ColumnsOf } from '../engine/component';
import { system } from '../engine/system';
import { Transform, type TransformColumns } from '../engine/transform';
import { Matrix } from '../mathematics/Matrix';
import { Color4 } from '../mathematics/vectors';
import { cameraProjectionMatrix } from './cameraRays';
import { Camera, Light } from './components';
import { MAX_DIRECTIONAL_LIGHTS, MAX_LOCAL_LIGHTS, RENDER_GROUP_ALL, RenderStage, RenderView, type DirectionalShadowSettings, type RenderContext, type RenderSystem, type SkyboxLight } from './RenderSystem';
import { ShadowMapRenderer } from './shadows/ShadowMapRenderer';
import { Skybox } from './Skybox';
import { UniformArena } from './postfx/ImageEffect';
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
const CASCADE_COUNTS = { one: 1, two: 2, four: 4 } as const;
const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

/** 一种尺寸的帧缓冲：深度，和用到时才建的 HDR 颜色。 */
interface FrameTargets {
  readonly width: number;
  readonly height: number;
  color: GPUTexture | undefined;
  readonly depth: GPUTexture;
}

/** 一个视图的颜色画到哪里：目标的视图、尺寸、格式，和这种格式的不透明、透明阶段。 */
interface ColorOutput {
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly opaque: RenderStage;
  readonly transparent: RenderStage;
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
  background: ((pass: GPURenderPassEncoder, target: { readonly width: number; readonly height: number; readonly format: GPUTextureFormat; readonly depthFormat: GPUTextureFormat }) => void) | undefined;
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
  readonly shadowMapRenderer: ShadowMapRenderer;

  readonly #mainView = new RenderView();
  #mainDepth: GPUTexture | undefined;
  /** 每个画进渲染目标贴图的相机一个视图（按 textureCameras 的顺序）。 */
  readonly #textureViews: RenderView[] = [];
  /** HDR 颜色缓冲和深度缓冲，按尺寸缓存（主画面一套，每个渲染目标贴图的尺寸一套）。 */
  readonly #targets = new Map<string, FrameTargets>();
  /** 点选（Game.pick 用它）：问主画面上某个像素最前面的是哪个实例。 */
  readonly picker: ScenePicker;
  /** 没有后处理时主画面直接画进后备缓冲（省掉 HDR 缓冲和一遍拷贝）；关掉是先画进 HDR 缓冲再拷过去，对比、排查时用。 */
  directOutput = true;
  /** 没有后处理时主画面直接画进后备缓冲用的两个阶段（颜色格式是后备缓冲的）。 */
  #directStages: { format: GPUTextureFormat; opaque: RenderStage; transparent: RenderStage } | undefined;
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
          if (this.drawShadows && light.shadow[i] && lighting.shadowLight < 0) {
            lighting.shadowLight = lighting.directionalCount;
            const s = this.#shadowSettings;
            s.size = light.shadowSize[i]!;
            s.filter = light.shadowFilter[i]!;
            s.cascadeCount = CASCADE_COUNTS[light.shadowCascadeCount[i]!];
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
    this.picker = new ScenePicker(renderSystem);
    this.shadowMapRenderer = new ShadowMapRenderer(renderSystem.graphicsDevice);
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
    this.shadowMapRenderer.draw(context, encoder, renderSystem, shadowViews);
    // 渲染目标贴图：画完原样拷进贴图
    const copy = this.#textureCopy;
    copy.arena.reset();
    textureCameras.forEach(({ texture, clearColor, transparent }, i) => {
      const view = this.#textureViews[i]!;
      if (!this.#found.has(view)) return;
      const targets = this.#targetsFor(texture.data.width, texture.data.height);
      const output = this.#hdrOutput(targets);
      this.#drawView(context, encoder, view, output, targets.depth, clearColor, transparent, `ForwardRenderer ${texture.name}`);
      copy.scaler.copy(encoder, copy.arena, output.texture, renderSystem.resources.texture(texture).createView(), texture.data.format);
    });
    copy.arena.flush();
    const targets = this.#targetsFor(canvas.width, canvas.height);
    this.#mainDepth = targets.depth;
    const { r, g, b, a } = this.clearColor;
    // 场景里有 UI、或者粒子画在 UI 上面时留着深度缓冲（它们在后处理之后和它比深度），否则丢掉（分块渲染的 GPU 上省带宽）
    const particles = context.game.particles;
    const keepDepth = context.game.ui.drawsInScene || (this.particlesOverUI && particles.components.length > 0) || context.game.debugDraw.tested.count > 0;
    const drawParticles = !this.particlesOverUI && particles.components.length > 0;
    const mainView = this.hasCamera ? this.#mainView : undefined;
    // 点选：有人问的时候才画（用的是这一帧剔除好的实例）
    if (this.picker.pending) this.picker.draw(context, encoder, mainView, canvas.width, canvas.height);
    if (!this.postEffects.enabled && this.directOutput) {
      this.#drawView(context, encoder, mainView, this.#backBufferOutput(canvas.width, canvas.height), targets.depth, [r, g, b, a], this.drawTransparent, 'ForwardRenderer', keepDepth, drawParticles);
      return;
    }
    const output = this.#hdrOutput(targets);
    this.#drawView(context, encoder, mainView, output, targets.depth, [r, g, b, a], this.drawTransparent, 'ForwardRenderer', keepDepth, drawParticles);
    this.postEffects.draw(encoder, output.texture, graphicsDevice.currentBackBufferView(), graphicsDevice.backBufferViewFormat, context.time.elapsed);
  }

  destroy(): void {
    for (const { color, depth } of this.#targets.values()) {
      color?.destroy();
      depth.destroy();
    }
    this.#targets.clear();
    this.#textureCopy.arena.destroy();
    this.postEffects.destroy();
    this.picker.destroy();
    this.shadowMapRenderer.destroy();
  }

  /** 一个视图：深度预通道，然后不透明、（transparent 时）透明阶段画进 output。没有视图时只清屏。 */
  #drawView(
    context: RenderContext, encoder: GPUCommandEncoder, view: RenderView | undefined, output: ColorOutput, depthTexture: GPUTexture,
    clearColor: readonly number[], transparent: boolean, label: string, keepDepth = false, drawParticles = false,
  ): void {
    const { renderSystem } = this;
    const profiler = renderSystem.graphicsDevice.profiler;
    const depth = depthTexture.createView();
    // 没有网格的画面（纯 2D：精灵、UI）深度预通道是空的，不开这一遍，深度在下面那一遍开头清
    const prepassNeeded = view !== undefined && renderSystem.drawsDepth;
    if (prepassNeeded) {
      const prepassTimestamps = profiler.passTimestamps(`${label} depth prepass`);
      const prepass = encoder.beginRenderPass({
        label: `${label} depth prepass`,
        ...(prepassTimestamps ? { timestampWrites: prepassTimestamps } : {}),
        colorAttachments: [],
        depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      renderSystem.draw(context, prepass, view, this.depthPrepassStage);
      prepass.end();
    }
    const timestampWrites = profiler.passTimestamps(`${label} opaque`);
    const pass = encoder.beginRenderPass({
      label: `${label} opaque`,
      ...(timestampWrites ? { timestampWrites } : {}),
      colorAttachments: [{ view: output.view, clearValue: [...clearColor], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: prepassNeeded ? 'load' : 'clear', depthStoreOp: keepDepth ? 'store' : 'discard' },
    });
    if (view === this.#mainView) this.background?.(pass, { width: output.width, height: output.height, format: output.format, depthFormat: DEPTH_FORMAT });
    if (view) {
      renderSystem.draw(context, pass, view, output.opaque);
      if (transparent) renderSystem.draw(context, pass, view, output.transparent);
      // 粒子在透明阶段的最后（Stride 的粒子在透明阶段里，和其他透明物体一起按远近排）
      if (transparent && drawParticles) context.game.particles.draw(context.game, pass, view, output.format, DEPTH_FORMAT);
    }
    pass.end();
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
    local.castsShadow = this.drawShadows && light.shadow[i] !== 0;
    if (local.castsShadow) {
      local.shadow.size = light.shadowSize[i]!;
      local.shadow.filter = light.shadowFilter[i]!;
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

  /**
   * width x height 的 HDR 颜色缓冲和深度缓冲。画布改了尺寸时旧的那套释放掉（渲染目标贴图的尺寸不变，它们的一直留着）。
   */
  #targetsFor(width: number, height: number): FrameTargets {
    const key = `${width}x${height}`;
    let targets = this.#targets.get(key);
    if (targets) return targets;
    const kept = new Set(this.textureCameras.map(({ texture }) => `${texture.data.width}x${texture.data.height}`));
    for (const [oldKey, old] of this.#targets) {
      if (kept.has(oldKey)) continue;
      old.color?.destroy();
      old.depth.destroy();
      this.#targets.delete(oldKey);
    }
    const { device } = this.renderSystem.graphicsDevice;
    targets = {
      width, height, color: undefined,
      depth: device.createTexture({ label: `ForwardRenderer depth ${key}`, size: [width, height], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT }),
    };
    this.#targets.set(key, targets);
    return targets;
  }

  /** 画进 HDR 颜色缓冲（后面接后处理，或者拷进渲染目标贴图）；缓冲第一次用到时才建。 */
  #hdrOutput(targets: FrameTargets): ColorOutput & { texture: GPUTexture } {
    const { width, height } = targets;
    targets.color ??= this.renderSystem.graphicsDevice.device.createTexture({
      label: `ForwardRenderer HDR color ${width}x${height}`, size: [width, height], format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    return { texture: targets.color, view: targets.color.createView(), width, height, format: HDR_FORMAT, opaque: this.opaqueStage, transparent: this.transparentStage };
  }

  /**
   * 没有后处理时主画面直接画进后备缓冲（同 Stride：合成器的 PostEffects 是 null 时前向渲染器直接画到输出上）：省掉 HDR 缓冲
   * 和把它拷到后备缓冲的那一遍。超过 1 的颜色在写进去时截断。
   */
  #backBufferOutput(width: number, height: number): ColorOutput {
    const graphicsDevice = this.renderSystem.graphicsDevice;
    const format = graphicsDevice.backBufferViewFormat;
    if (this.#directStages?.format !== format) {
      this.#directStages = {
        format,
        opaque: new RenderStage('Opaque', { colorFormat: format, depthFormat: DEPTH_FORMAT }, { afterDepthPrepass: true }),
        transparent: new RenderStage('Transparent', { colorFormat: format, depthFormat: DEPTH_FORMAT }, { transparent: true }),
      };
    }
    return { view: graphicsDevice.currentBackBufferView(), width, height, format, opaque: this.#directStages.opaque, transparent: this.#directStages.transparent };
  }
}

