/**
 * UI 系统（`game.ui`，Stride 的 UISystem 加 UIRenderFeature）：每帧画完场景之后，把启用的全屏 UIComponent 按虚拟分辨率
 * 布局（元素的 update、Measure、Arrange、世界矩阵），再画到画面上。
 *
 * 输入（Stride 的 UIPicking、UISystem 的 OnResolvingCapture）：每帧在脚本读输入之前，按上一帧画出来的样子把指针事件交给元素、
 * 更新悬停；鼠标在可以点的元素上（或者正拖着 UI 上按下的东西）时占着鼠标，有焦点的元素占着键盘，脚本就看不到这些输入
 * （InputManager.maskCapturedInput）。按下之前游戏里已经按着鼠标拖动的不占（拖过 UI 也不打断）。
 * 和 Stride 不同（多做的）：鼠标滚轮在 ScrollViewer 上时滚动它（Stride 桌面版的 UI 不处理滚轮）。
 *
 * 和 Stride 不同：UI 画在整个画面（包括后处理）之后。Stride 的 UI 在前向渲染器的透明阶段里画，会被泛光、色调映射处理；
 * UI 的颜色应该照原样显示，所以放到最后。还不支持不是全屏的 UI（放在 3D 场景里的，UIElementLink 那几个样例再做）。
 */
import type { Game } from '../games/Game';
import { InputCapturePriority } from '../input/capture';
import type { InputManager, PointerEvent } from '../input/InputManager';
import { SpriteBatch } from '../rendering/text/SpriteBatch';
import { EditText } from './controls/EditText';
import { ScrollViewer } from './controls/ScrollViewer';
import { IDENTITY, type UIElement } from './UIElement';
import type { UIComponent } from './UIComponent';
import { PickingState, routePointerEvents, updateMouseOver, type PickingTarget } from './UIPicking';
import { TextInputBridge } from './TextInputBridge';
import { drawUI } from './UIRenderer';

/** 滚轮一格滚多少虚拟像素。 */
const WHEEL_STEP = 50;

export class UISystem {
  readonly #components = new Set<UIComponent>();
  #batch: SpriteBatch | undefined;
  #warnedNotFullScreen = false;
  /** 上一帧画出来的 UI（指针按它找元素）。 */
  #targets = new Map<UIComponent, PickingTarget>();
  readonly #states = new WeakMap<UIComponent, PickingState>();
  #focused: UIElement | null = null;
  /** 鼠标在 UI 上按下、还没松开：拖到 UI 外面也占着鼠标。 */
  #mouseDragOwnedByUi = false;
  #releaseMouseDrag = false;
  #pointersToRelease: number[] = [];
  #input: InputManager | undefined;
  #detachInput: (() => void) | undefined;
  /** 这一帧鼠标下面可以点的元素（Stride 的 UIElementUnderMouseCursor）。 */
  elementUnderMouseCursor: UIElement | null = null;
  /** @internal 激活的 EditText 后面的影子输入框（attach 时建）。 */
  textInput: TextInputBridge | undefined;

  /** @internal UIComponent 启动时登记。 */
  add(component: UIComponent): void {
    this.#components.add(component);
  }

  /** @internal UIComponent 移除时。 */
  remove(component: UIComponent): void {
    this.#components.delete(component);
  }

  /** @internal Game 建好输入以后调用：每帧在脚本之前处理 UI 的输入。 */
  attach(game: Game): void {
    this.#input = game.input;
    this.textInput = new TextInputBridge(game.graphicsDevice.canvas);
    this.#detachInput = game.input.onResolvingCapture(() => this.#resolveInput(game));
  }

  /** 有键盘焦点的元素（Stride 的 FocusedElement，现在是激活的 EditText）。 */
  get focusedElement(): UIElement | null {
    return this.#focused;
  }

  /** @internal EditText 激活、停用时设：有焦点的元素占着键盘。 */
  set focusedElement(element: UIElement | null) {
    this.#focused = element;
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
    if (this.#focused) input.tryCapture('keyboard', this, InputCapturePriority.focus);

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

  /** @internal 每帧画完场景之后（Game.draw）。 */
  draw(game: Game, elapsedSeconds: number): void {
    const visible = [...this.#components].filter((component) => component.enabled && component.page?.rootElement);
    this.#targets = new Map();
    if (visible.length === 0) return;
    const device = game.graphicsDevice;
    const target: [number, number] = [device.canvas.width, device.canvas.height];
    const batch = (this.#batch ??= new SpriteBatch(device.device, game.renderSystem.resources));
    for (const component of visible) {
      if (!component.isFullScreen) {
        if (!this.#warnedNotFullScreen) console.warn(`[stride] UI on entity '${component.entity.name}' is not full screen; only full-screen UI is supported yet`);
        this.#warnedNotFullScreen = true;
        continue;
      }
      const root = component.page!.rootElement!;
      root.uiSystem = this;
      const virtual = UISystem.virtualResolution(component, target);
      this.#targets.set(component, { root, virtualResolution: virtual });
      const ratio: [number, number] = [target[0] / virtual[0], target[1] / virtual[1]];
      root.layoutingContext = { virtualResolution: virtual, realResolution: target, realVirtualResolutionRatio: ratio };
      root.update(elapsedSeconds);
      root.measure(virtual);
      root.arrange(virtual, false);
      root.updateWorldMatrix(IDENTITY);
      root.updateElementState(0);
      // 每个 UI 单独提交：SpriteBatch 的数据在 end() 时写进同一个缓冲，几批放进一次提交会互相覆盖
      const encoder = device.device.createCommandEncoder({ label: 'UI' });
      const pass = encoder.beginRenderPass({
        label: `UI ${component.entity.name}`,
        colorAttachments: [{ view: device.currentBackBufferView(), loadOp: 'load', storeOp: 'store' }],
      });
      batch.virtualResolution = virtual;
      batch.begin(pass, target[0], target[1], device.backBufferViewFormat);
      drawUI(root, { batch, virtualResolution: virtual, ratio, snapText: component.snapText });
      batch.end();
      pass.end();
      device.device.queue.submit([encoder.finish()]);
    }
    // 布局之后：影子输入框跟上 EditText 的位置，选区同步回来
    this.textInput?.update();
  }

  destroy(): void {
    this.#detachInput?.();
    this.#input?.releaseAll(this);
    this.textInput?.destroy();
    this.textInput = undefined;
    this.#batch?.destroy();
    this.#batch = undefined;
    this.#components.clear();
    this.#targets.clear();
  }
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
