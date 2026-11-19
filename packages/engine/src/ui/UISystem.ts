/**
 * UI 系统（`game.ui`，Stride 的 UISystem 加 UIRenderFeature）：每帧把启用的 UIComponent 按虚拟分辨率布局（元素的
 * update、Measure、Arrange、世界矩阵；有 UIElementLink 时在变换更新之前，否则在画之前），画完场景之后画到画面上。全屏的 UI 铺满画面；不是全屏的放在 3D 场景里
 * （大小是 Size，按主相机画，被场景里更近的东西挡住，见 UIProjection），从远到近画，全屏的画在它们上面。
 *
 * 输入（Stride 的 UIPicking、UISystem 的 OnResolvingCapture）：每帧在脚本读输入之前，按上一帧画出来的样子把指针事件交给元素、
 * 更新悬停；鼠标在可以点的元素上（或者正拖着 UI 上按下的东西）时占着鼠标，有焦点的元素占着键盘，脚本就看不到这些输入
 * （InputManager.maskCapturedInput）。按下之前游戏里已经按着鼠标拖动的不占（拖过 UI 也不打断）。
 * 和 Stride 不同（多做的）：鼠标滚轮在 ScrollViewer 上时滚动它（Stride 桌面版的 UI 不处理滚轮）。
 *
 * 和 Stride 不同：
 * - UI 画在整个画面（包括后处理）之后。Stride 的 UI 在前向渲染器的透明阶段里画，会被泛光、色调映射处理；UI 的颜色应该照
 *   原样显示，所以放到最后。放在 3D 里的 UI 也一样（和场景的深度缓冲比较），所以它的边没有 FXAA。
 * - 放在 3D 里的 UI 不把文字对齐到像素，布局按虚拟像素（真实 / 虚拟 的比例当 1）：Stride 按投影估计这个比例，相机一动
 *   文字就重新排版；我们的字是矢量的，不随比例变，没必要。
 */
import type { Game } from '../games/Game';
import { InputCapturePriority } from '../input/capture';
import type { InputManager, PointerEvent } from '../input/InputManager';
import { Transform } from '../engine/transform';
import { Matrix, type Matrix4 } from '../mathematics/Matrix';
import { DEPTH_FORMAT } from '../rendering/ForwardRenderer';
import { SpriteBatch } from '../rendering/text/SpriteBatch';
import { EditText } from './controls/EditText';
import { ScrollViewer } from './controls/ScrollViewer';
import { IDENTITY, type UIElement } from './UIElement';
import type { UIComponent } from './UIComponent';
import { fullScreenTarget, PickingState, routePointerEvents, updateMouseOver, type PickingTarget } from './UIPicking';
import { SemanticsLayer, type SemanticsPage } from './SemanticsLayer';
import type { TextBlock } from './controls/TextBlock';
import { TextInputBridge } from './TextInputBridge';
import { routeKeyEvents } from './UIKeyboard';
import { pointerToVirtual, projectedPixelRatio, uiWorldMatrix } from './UIProjection';
import { drawUI } from './UIRenderer';

/** 滚轮一格滚多少虚拟像素。 */
const WHEEL_STEP = 50;

/** 一个 UI 上一帧画出来的样子：指针按它找元素，UIElementLink 按它算元素在世界里的位置。 */
interface DrawnUI extends PickingTarget {
  /** 放在 3D 里的 UI：虚拟坐标 → 世界坐标（见 uiWorldMatrix）；全屏的没有。 */
  readonly uiWorld?: Matrix4;
}

export class UISystem {
  readonly #components = new Set<UIComponent>();
  /** 每个 UI 一个：SpriteBatch 的数据在 end() 时用 writeBuffer 写，同一帧里一个缓冲只能写一份（见 GraphicsDevice.frameEncoder）。 */
  readonly #batches = new Map<UIComponent, SpriteBatch>();
  /** 上一帧画出来的 UI。 */
  #targets = new Map<UIComponent, DrawnUI>();
  readonly #states = new WeakMap<UIComponent, PickingState>();
  #focused: UIElement | null = null;
  /** 鼠标在 UI 上按下、还没松开：拖到 UI 外面也占着鼠标。 */
  #mouseDragOwnedByUi = false;
  /** 这一帧布局过了（画完清掉）。 */
  #laidOut = false;
  #releaseMouseDrag = false;
  #pointersToRelease: number[] = [];
  #input: InputManager | undefined;
  #detachInput: (() => void) | undefined;
  /** 这一帧鼠标下面可以点的元素（Stride 的 UIElementUnderMouseCursor）。 */
  elementUnderMouseCursor: UIElement | null = null;
  /** @internal 激活的 EditText 后面的影子输入框（attach 时建）。 */
  textInput: TextInputBridge | undefined;
  /**
   * 影子 DOM（attach 时建）：全屏 UI 的文字和控件在页面上的透明节点，读屏、Tab 键、查找、复制靠它。
   * `game.ui.semantics.enabled = false` 关掉。
   */
  semantics: SemanticsLayer | undefined;

  /** @internal UIComponent 启动时登记。 */
  add(component: UIComponent): void {
    this.#components.add(component);
  }

  /** @internal UIComponent 移除时。 */
  remove(component: UIComponent): void {
    this.#components.delete(component);
    this.#batches.get(component)?.destroy();
    this.#batches.delete(component);
  }

  /** @internal Game 建好输入以后调用：每帧在脚本之前处理 UI 的输入。 */
  attach(game: Game): void {
    this.#input = game.input;
    this.textInput = new TextInputBridge(game.graphicsDevice.canvas);
    this.semantics = new SemanticsLayer(game.graphicsDevice.canvas);
    this.#detachInput = game.input.onResolvingCapture(() => this.#resolveInput(game));
  }

  /**
   * 有键盘焦点的元素（Stride 的 FocusedElement）：它占着键盘（脚本读不到按键），键盘事件发给它、往上冒泡
   * （UIElement.keyPressedEvent 等）。EditText 激活时自己拿焦点；别的元素由代码给（比如用方向键选菜单项）。
   * 元素藏起来、停用或者不画了，焦点自动丢掉。
   */
  get focusedElement(): UIElement | null {
    return this.#focused;
  }

  set focusedElement(element: UIElement | null) {
    const previous = this.#focused;
    if (previous === element) return;
    this.#focused = element;
    // 焦点从正在编辑的输入框挪走：结束编辑
    if (previous instanceof EditText) previous.isSelectionActive = false;
    if (!this.#input) return;
    if (element) this.#input.tryCapture('keyboard', this, InputCapturePriority.focus);
    else this.#input.release('keyboard', this);
  }

  #resolveInput(game: Game): void {
    const input = game.input;
    // 藏起来、停用的元素，或者这一帧没画的 UI 里的元素，失去焦点
    const focused = this.#focused;
    if (focused && (!canKeepFocus(focused) || !this.#isDrawn(focused))) {
      if (focused instanceof EditText) focused.isSelectionActive = false;
      this.focusedElement = null;
    }
    if (this.#focused) {
      input.tryCapture('keyboard', this, InputCapturePriority.focus);
      routeKeyEvents(this.#focused, input.rawKeys, input.rawTextInput);
    }

    if (this.#releaseMouseDrag) {
      this.#mouseDragOwnedByUi = false;
      this.#releaseMouseDrag = false;
    }
    for (const pointerId of this.#pointersToRelease) input.releasePointer(pointerId, this);
    this.#pointersToRelease = [];

    const mouse = input.isMousePositionLocked ? undefined : input.mousePosition;
    let underMouse: UIElement | null = null;
    for (const [component, target] of this.#targets) {
      let state = this.#states.get(component);
      if (!state) this.#states.set(component, (state = new PickingState()));
      underMouse = updateMouseOver(target, state, mouse) ?? underMouse;
      routePointerEvents(target, state, input.rawPointerEvents, game.updateTime.total, (event) => this.#captureOnPress(input, event));
    }
    this.elementUnderMouseCursor = underMouse;
    for (const event of input.rawPointerEvents) {
      if (event.eventType !== 'released' && event.eventType !== 'canceled') continue;
      if (event.device === 'mouse') this.#releaseMouseDrag ||= this.#mouseDragOwnedByUi;
      else this.#pointersToRelease.push(event.pointerId);
    }

    // 悬停占鼠标；游戏里按着鼠标拖过 UI 时不占，锁定的鼠标（视角）不占
    const gameDrag = !this.#mouseDragOwnedByUi && input.captureOwner('mouse') !== this && input.rawMouseButtonsActive;
    const wantsMouse = (underMouse !== null && !gameDrag) || this.#mouseDragOwnedByUi;
    if (wantsMouse && !input.isMousePositionLocked) input.tryCapture('mouse', this, InputCapturePriority.hover);
    else input.release('mouse', this);

    if (underMouse && input.rawMouseWheelDelta !== 0) scrollWithWheel(underMouse, input.rawMouseWheelDelta);
  }

  #captureOnPress(input: InputManager, event: PointerEvent): void {
    if (event.device === 'mouse') this.#mouseDragOwnedByUi = true;
    else input.capturePointer(event.pointerId, this);
  }

  #isDrawn(element: UIElement): boolean {
    let root = element;
    while (root.visualParent) root = root.visualParent;
    return [...this.#targets.values()].some((target) => target.root === root);
  }

  /** 这一帧有没有要放在 3D 场景里画的 UI（前向渲染器按它决定留不留深度缓冲）。 */
  get drawsInScene(): boolean {
    return this.#visible().some((component) => !component.isFullScreen);
  }

  /** 登记的 UI 组件，按启动的顺序。 */
  get components(): readonly UIComponent[] {
    return [...this.#components];
  }

  /** 全屏 UI 在画面大小 target 下的虚拟分辨率（按 ResolutionStretch 调整宽或高）。 */
  static virtualResolution(component: UIComponent, target: readonly [number, number]): [number, number] {
    const resolution: [number, number] = [component.resolution.x, component.resolution.y];
    if (component.resolutionStretch === 'fixedWidthAdaptableHeight') resolution[1] = (resolution[0] * target[1]) / target[0];
    if (component.resolutionStretch === 'fixedHeightAdaptableWidth') resolution[0] = (resolution[1] * target[0]) / target[1];
    return resolution;
  }

  /**
   * @internal 这一帧还没布局时，把要画的 UI 都布局好（元素的 update、Measure、Arrange、世界矩阵）。UIElementLink 在变换更新
   * 之前调用，跟着走的实体用的就是这一帧的布局；没有 UIElementLink 时在画之前调用。
   */
  layout(game: Game): void {
    if (this.#laidOut) return;
    this.#laidOut = true;
    const { width, height } = game.graphicsDevice.canvas;
    const target: [number, number] = [width, height];
    for (const component of this.#visible()) {
      // 放在 3D 里的 UI 按虚拟像素布局（见文件开头）
      const virtual: [number, number] = component.isFullScreen ? UISystem.virtualResolution(component, target) : [component.resolution.x, component.resolution.y];
      const ratio: [number, number] = component.isFullScreen ? [width / virtual[0], height / virtual[1]] : [1, 1];
      const root = component.page!.rootElement!;
      root.uiSystem = this;
      root.layoutingContext = { virtualResolution: virtual, realResolution: target, realVirtualResolutionRatio: ratio };
      root.update(game.updateTime.elapsed);
      root.measure(virtual);
      root.arrange(virtual, false);
      root.updateWorldMatrix(IDENTITY);
      root.updateElementState(0);
    }
  }

  #visible(): UIComponent[] {
    return [...this.#components].filter((component) => component.enabled && component.page?.rootElement);
  }

  /** @internal 每帧画完场景之后（Game.draw）。 */
  draw(game: Game): void {
    this.layout(game);
    this.#laidOut = false;
    const visible = this.#visible();
    this.#targets = new Map();
    const pages: SemanticsPage[] = [];
    if (visible.length === 0) {
      this.semantics?.update(pages);
      return;
    }
    const selectionOf = this.semantics ? (text: TextBlock) => this.semantics?.selectionOf(text) : undefined;
    const device = game.graphicsDevice;
    const target: [number, number] = [device.canvas.width, device.canvas.height];
    const inScene = visible.filter((component) => !component.isFullScreen);
    if (inScene.length > 0) this.#drawInScene(game, inScene, target);
    for (const component of visible) {
      if (!component.isFullScreen) continue;
      const root = component.page!.rootElement!;
      const virtual = UISystem.virtualResolution(component, target);
      pages.push({ root, virtualResolution: virtual });
      this.#targets.set(component, fullScreenTarget(root, virtual));
      const ratio: [number, number] = [target[0] / virtual[0], target[1] / virtual[1]];
      const batch = this.#batch(game, component);
      const pass = device.frameEncoder.beginRenderPass({
        label: `UI ${component.entity.name}`,
        colorAttachments: [{ view: device.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }],
      });
      batch.virtualResolution = virtual;
      batch.transform = undefined;
      batch.pixelRatio = undefined;
      batch.begin(pass, target[0], target[1], device.backBufferViewFormat);
      drawUI(root, { batch, virtualResolution: virtual, ratio, snapText: component.snapText, selectionOf });
      batch.end();
      pass.end();
    }
    // 布局之后：影子输入框跟上 EditText 的位置，选区同步回来；影子 DOM 照这一帧的 UI 树同步
    this.textInput?.update();
    this.semantics?.update(pages);
  }

  /** 放在 3D 里的 UI：按主相机从远到近画进一个通道，和场景的深度比较。没有相机时不画。 */
  #drawInScene(game: Game, components: readonly UIComponent[], target: [number, number]): void {
    const compositor = game.graphicsCompositor;
    const view = compositor.mainView, depth = compositor.mainDepth;
    const cameraWorld = new Float32Array(16);
    if (!view || !depth || !Matrix.invert(cameraWorld, view.view)) return;
    // 指针在下一帧开头按这一帧画出来的样子找元素，那时相机的矩阵可能已经变了，所以拷一份
    const inverseViewProjection = new Float32Array(view.inverseViewProjection);
    const placed = components.map((component) => {
      const virtual: [number, number] = [component.resolution.x, component.resolution.y];
      const uiWorld = uiWorldMatrix(new Float32Array(16), component, virtual, component.entity.require(Transform).world, cameraWorld, view.projection);
      const transform = Matrix.multiply(new Float32Array(16), view.viewProjection, uiWorld);
      // UI 中心在裁剪空间的 w：透视投影下就是到相机的距离
      const distance = transform[3]! * (virtual[0] / 2) + transform[7]! * (virtual[1] / 2) + transform[15]!;
      return { component, virtual, uiWorld, transform, distance };
    });
    placed.sort((a, b) => b.distance - a.distance);
    const device = game.graphicsDevice;
    const pass = device.frameEncoder.beginRenderPass({
      label: 'UI in scene',
      colorAttachments: [{ view: device.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
    });
    for (const { component, virtual, uiWorld, transform } of placed) {
      const root = component.page!.rootElement!;
      this.#targets.set(component, { root, virtualResolution: virtual, uiWorld, toVirtual: (position) => pointerToVirtual(position, uiWorld, inverseViewProjection) });
      const pixelRatio = projectedPixelRatio(transform, virtual, target) ?? [1, 1];
      const batch = this.#batch(game, component);
      batch.virtualResolution = virtual;
      batch.transform = transform;
      batch.pixelRatio = pixelRatio;
      batch.begin(pass, target[0], target[1], device.backBufferViewFormat, DEPTH_FORMAT);
      drawUI(root, { batch, virtualResolution: virtual, ratio: pixelRatio, snapText: false });
      batch.end();
    }
    pass.end();
  }

  /**
   * 元素在世界里的矩阵（Stride 的 UIElementTransformLink），按元素现在的布局和 UI 上一帧画的摆法写进 out；这个 UI 上一帧没画、或者元素不在
   * 它里面时返回 false。放在 3D 里的 UI：UI 实际的摆法（包括面向相机）乘上元素的变换，元素的位移换成世界单位（旋转、缩放
   * 不变）。全屏的 UI：元素的变换按虚拟像素放在世界原点（UI 的中心在原点，y 向上），不看 UI 实体的变换。
   */
  elementWorldMatrix(out: Matrix4, component: UIComponent, element: UIElement): boolean {
    const drawn = this.#targets.get(component);
    if (!drawn || !isInside(element, drawn.root)) return false;
    const [vx, vy] = drawn.virtualResolution;
    // UI 的摆法 W 和 虚拟像素 → 世界单位 的缩放 k（y 翻过来），uiWorld = W · k · 平移(-v/2)
    const placement = new Float32Array(16);
    let kx = 1, ky = -1;
    if (drawn.uiWorld) {
      const u = drawn.uiWorld;
      kx = component.size.x / vx;
      ky = -component.size.y / vy;
      for (let i = 0; i < 3; i++) {
        placement[i] = u[i]! / kx;
        placement[4 + i] = u[4 + i]! / ky;
        placement[8 + i] = -u[8 + i]!;
        placement[12 + i] = u[12 + i]! + (u[i]! * vx) / 2 + (u[4 + i]! * vy) / 2;
      }
      placement[15] = 1;
    } else {
      Matrix.setIdentity(placement);
    }
    // 元素的变换（中心在 UI 中心的虚拟坐标）换到世界单位：k · 元素 · k⁻¹
    const [a, b, c, d, e, f] = element.worldMatrix;
    const local = new Float32Array([a, (b * ky) / kx, 0, 0, (c * kx) / ky, d, 0, 0, 0, 0, 1, 0, kx * (e - vx / 2), ky * (f - vy / 2), 0, 1]);
    Matrix.multiply(out, placement, local);
    return true;
  }

  #batch(game: Game, component: UIComponent): SpriteBatch {
    let batch = this.#batches.get(component);
    if (!batch) this.#batches.set(component, (batch = new SpriteBatch(game.graphicsDevice.device, game.renderSystem.resources)));
    return batch;
  }

  destroy(): void {
    this.#detachInput?.();
    this.#input?.releaseAll(this);
    this.textInput?.destroy();
    this.textInput = undefined;
    this.semantics?.destroy();
    this.semantics = undefined;
    for (const batch of this.#batches.values()) batch.destroy();
    this.#batches.clear();
    this.#components.clear();
    this.#targets.clear();
  }
}

/** element 是不是 root 或它的后代。 */
function isInside(element: UIElement, root: UIElement): boolean {
  for (let current: UIElement | null = element; current; current = current.visualParent) if (current === root) return true;
  return false;
}

/** 元素和所有父元素都看得见、启用着。 */
function canKeepFocus(element: UIElement): boolean {
  for (let current: UIElement | null = element; current; current = current.visualParent) {
    if (!current.isVisible || !current.isEnabled) return false;
  }
  return true;
}

/** 滚轮滚动鼠标下面最近的能竖着（不能时横着）滚的 ScrollViewer。 */
function scrollWithWheel(element: UIElement, notches: number): void {
  for (let current: UIElement | null = element; current; current = current.visualParent) {
    if (!(current instanceof ScrollViewer) || !current.isHierarchyEnabled) continue;
    const direction = current.canScroll(1) ? 1 : current.canScroll(0) ? 0 : undefined;
    if (direction === undefined) continue;
    const step: [number, number] = [0, 0];
    step[direction] = -notches * WHEEL_STEP;
    current.scrollOf(step);
    return;
  }
}
