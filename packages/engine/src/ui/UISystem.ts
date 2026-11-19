/**
 * UI 系统（`game.ui`，Stride 的 UISystem 加 UIRenderFeature）：每帧画完场景之后，把启用的全屏 UIComponent 按虚拟分辨率
 * 布局（元素的 update、Measure、Arrange、世界矩阵），再画到画面上。
 *
 * 和 Stride 不同：UI 画在整个画面（包括后处理）之后。Stride 的 UI 在前向渲染器的透明阶段里画，会被泛光、色调映射处理；
 * UI 的颜色应该照原样显示，所以放到最后。还不支持不是全屏的 UI（放在 3D 场景里的，UIElementLink 那几个样例再做）。
 */
import type { Game } from '../games/Game';
import { SpriteBatch } from '../rendering/text/SpriteBatch';
import { IDENTITY } from './UIElement';
import type { UIComponent } from './UIComponent';
import { drawUI } from './UIRenderer';

export class UISystem {
  readonly #components = new Set<UIComponent>();
  #batch: SpriteBatch | undefined;
  #warnedNotFullScreen = false;

  /** @internal UIComponent 启动时登记。 */
  add(component: UIComponent): void {
    this.#components.add(component);
  }

  /** @internal UIComponent 移除时。 */
  remove(component: UIComponent): void {
    this.#components.delete(component);
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
      const virtual = UISystem.virtualResolution(component, target);
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
  }

  destroy(): void {
    this.#batch?.destroy();
    this.#batch = undefined;
    this.#components.clear();
  }
}
