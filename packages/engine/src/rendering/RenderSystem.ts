/**
 * 渲染系统的骨架，名字和阶段照 Stride（Rendering/RenderSystem.cs）：合成器先收集视图（Collect），
 * 然后各个根渲染特性从实体里提取这一帧要画的东西（Extract）、上传数据（Prepare），最后按视图和阶段绘制（Draw）。
 * 和 Stride 不同的地方：没有通用的 RenderObject / RenderNode 列表，每个特性直接按列遍历实体（数据导向），
 * 也还没有剔除和排列组合（效果系统等内容管线）。
 */
import type { Game } from '../games/Game';
import type { GameTime } from '../games/GameTime';
import type { GraphicsDevice } from '../graphics/GraphicsDevice';
import { Matrix } from '../mathematics/Matrix';
import { Color4, Vector3 } from '../mathematics/vectors';

/** 一帧渲染里各阶段都要用的东西。 */
export interface RenderContext {
  readonly game: Game;
  readonly time: GameTime;
}

/** 一个阶段画进去的目标格式（Stride 的 RenderOutputDescription）。 */
export interface RenderOutput {
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
}

/** 渲染阶段（Opaque、Transparent、ShadowMapCaster……）：决定用哪套管线、画进什么格式。 */
export class RenderStage {
  readonly name: string;
  readonly output: RenderOutput;

  constructor(name: string, output: RenderOutput) {
    this.name = name;
    this.output = output;
  }
}

/** 一个视角：相机、阴影级联等。矩阵的布局见 mathematics/Matrix.ts。 */
export class RenderView {
  readonly view = Matrix.identity();
  readonly projection = Matrix.identity();
  readonly viewProjection = Matrix.identity();
  nearClipPlane = 0.1;
  farClipPlane = 1000;
  /** 在 RenderSystem.views 里的下标；特性按它给每个视图的常量分块。 */
  index = -1;

  /** 由 view 和 projection 算出 viewProjection。 */
  update(): void {
    Matrix.multiply(this.viewProjection, this.projection, this.view);
  }
}

/** 根渲染特性（Stride 的 RootRenderFeature）：负责一类可画的东西，比如网格。 */
export abstract class RootRenderFeature {
  #system: RenderSystem | undefined;

  /** 加入渲染系统后可用。 */
  get system(): RenderSystem {
    if (!this.#system) throw new Error(`${this.constructor.name} has not been added to a RenderSystem`);
    return this.#system;
  }

  /** @internal 由 RenderSystem.addFeature 调用。 */
  attach(system: RenderSystem): void {
    this.#system = system;
  }

  /** 从实体里取出这一帧要画的东西，只在 CPU 上做。 */
  abstract extract(context: RenderContext): void;
  /** 上传这一帧的数据；这时视图都已收集好。 */
  abstract prepare(context: RenderContext): void;
  /** 把这个特性的东西画进一个视图的一个阶段。 */
  abstract draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void;
  destroy(): void {}
}

/** 这一帧的光照：一个方向光加环境光（多个方向光、点光源、阴影以后加）。 */
export interface Lighting {
  /** 光线前进的方向（世界空间，不必归一化）。 */
  readonly direction: Vector3;
  /** 方向光：线性空间的颜色乘强度。 */
  readonly color: Color4;
  /** 环境光：线性空间的颜色乘强度。 */
  readonly ambient: Color4;
}

export class RenderSystem {
  readonly graphicsDevice: GraphicsDevice;
  readonly features: RootRenderFeature[] = [];
  /** 这一帧的视图，由合成器在 Collect 时填。 */
  readonly views: RenderView[] = [];
  /** 这一帧的光照，由合成器在 Collect 时从 Light 组件收集。 */
  readonly lighting: Lighting = {
    direction: new Vector3(),
    color: new Color4(),
    ambient: new Color4(),
  };
  /** 场景里没有 Light 组件时用的光照（直射光的漫反射要除以 π，所以强度 3 大约是满亮度）。 */
  readonly defaultLighting: Lighting = {
    direction: new Vector3(-0.4, -1, -0.6),
    color: new Color4(3, 3, 3, 1),
    ambient: new Color4(0.15, 0.15, 0.18, 1),
  };

  constructor(graphicsDevice: GraphicsDevice) {
    this.graphicsDevice = graphicsDevice;
  }

  get device(): GPUDevice {
    return this.graphicsDevice.device;
  }

  addFeature<F extends RootRenderFeature>(feature: F): F {
    feature.attach(this);
    this.features.push(feature);
    return feature;
  }

  /** Collect：这一帧要画的视图。 */
  collect(views: readonly RenderView[]): void {
    this.views.length = 0;
    views.forEach((view, index) => {
      view.index = index;
      this.views.push(view);
    });
  }

  extract(context: RenderContext): void {
    for (const feature of this.features) feature.extract(context);
  }

  prepare(context: RenderContext): void {
    for (const feature of this.features) feature.prepare(context);
  }

  draw(context: RenderContext, pass: GPURenderPassEncoder, view: RenderView, stage: RenderStage): void {
    for (const feature of this.features) feature.draw(context, pass, view, stage);
  }

  destroy(): void {
    for (const feature of this.features) feature.destroy();
  }
}
