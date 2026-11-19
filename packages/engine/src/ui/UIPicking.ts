/**
 * UI 的指针（Stride 的 UIPicking 和 UIRenderFeature.Picking）：按上一帧画出来的样子，把这一帧的指针事件交给指针下面的元素
 * （按下、移动、松开，换了元素时发移入、移出），更新鼠标悬停的状态。
 *
 * 指针位置（画布里 0..1）先换到 UI 的虚拟坐标（全屏的乘上虚拟分辨率，放在 3D 里的用相机的射线和 UI 平面求交）。找元素：
 * 可以点的（canBeHitByUser）元素里画得最靠前的（Stride 按深度，再按 DepthBias；一个 UI 的元素都在一个平面上，深度一样）；
 * ClipToBounds 的元素外面不找它的子元素。
 */
import type { PointerEvent } from '../input/InputManager';
import { TouchEventArgs, type TouchAction } from './events';
import type { UIElement } from './UIElement';

/** 一个 UI 上一帧画出来的样子。 */
export interface PickingTarget {
  readonly root: UIElement;
  readonly virtualResolution: readonly [number, number];
  /** 画布里 0..1 的位置换到 UI 的虚拟坐标；对不到 UI 上时是 undefined。 */
  readonly toVirtual: (position: readonly [number, number]) => [number, number] | undefined;
}

/** 全屏 UI 的 PickingTarget：画布里 0..1 的位置乘上虚拟分辨率。 */
export function fullScreenTarget(root: UIElement, virtualResolution: readonly [number, number]): PickingTarget {
  const [vx, vy] = virtualResolution;
  return { root, virtualResolution, toVirtual: ([x, y]) => (x < 0 || x > 1 || y < 0 || y > 1 ? undefined : [x * vx, y * vy]) };
}

/** 一个 UI 的指针状态（Stride 的 RenderUIElement 上的 LastTouchedElement 这些）。 */
export class PickingState {
  lastTouchedElement: UIElement | null = null;
  lastMouseOverElement: UIElement | null = null;
  lastWorldPosition: readonly [number, number] = [0, 0];
}

/** 虚拟坐标里 point 下面可以点的、最靠前的元素。 */
export function hitTest(root: UIElement, point: readonly [number, number]): UIElement | null {
  let hit: UIElement | null = null;
  let highestBias = -1;
  const visit = (element: UIElement): void => {
    if (!element.isVisible) return;
    if (element.canBeHitByUser || element.clipToBounds) {
      const inside = element.intersects(point);
      if (element.clipToBounds && !inside) return;
      if (element.canBeHitByUser && inside && element.depthBias > highestBias) {
        highestBias = element.depthBias;
        hit = element;
      }
    }
    for (const child of element.visualChildren) visit(child);
  };
  visit(root);
  return hit;
}

/** 连着的移动合成一个（位移加起来），同 Stride 的 CompactPointerEvents。 */
function compact(events: readonly PointerEvent[]): PointerEvent[] {
  const result: PointerEvent[] = [];
  let dx = 0, dy = 0;
  events.forEach((event, index) => {
    if (event.eventType !== 'moved') {
      dx = dy = 0;
      result.push(event);
      return;
    }
    dx += event.deltaPosition[0];
    dy += event.deltaPosition[1];
    if (events[index + 1]?.eventType !== 'moved') result.push({ ...event, deltaPosition: [dx, dy] });
  });
  return result;
}

const ACTIONS: Readonly<Record<PointerEvent['eventType'], TouchAction>> = { pressed: 'down', moved: 'move', released: 'up', canceled: 'move' };

/**
 * 把这一帧的指针事件交给元素（Stride 的 UpdateTouchEvents）。onPress：有元素被按下时（UI 占用这个指针、鼠标的拖动）。
 * 没有元素被按着时，只处理按下（鼠标在 UI 外面移动不发事件）。
 */
export function routePointerEvents(target: PickingTarget, state: PickingState, events: readonly PointerEvent[], time: number, onPress: (event: PointerEvent) => void): void {
  for (const event of compact(events)) {
    const last = state.lastTouchedElement;
    if (!last && event.eventType !== 'pressed') continue;
    const position = target.toVirtual(event.position);
    if (!position) continue;
    const current = hitTest(target.root, position);
    const args = new TouchEventArgs();
    args.action = ACTIONS[event.eventType];
    args.timestamp = time;
    args.screenPosition = event.position;
    args.screenTranslation = event.deltaPosition;
    args.worldPosition = position;
    args.worldTranslation = [position[0] - state.lastWorldPosition[0], position[1] - state.lastWorldPosition[1]];
    switch (event.eventType) {
      case 'pressed':
        if (current) onPress(event);
        current?.raiseTouchDown(args);
        break;
      case 'released':
        if (current !== last) enterAndLeave(current, last, args);
        current?.raiseTouchUp(args);
        break;
      case 'moved':
        current?.raiseTouchMove(args);
        if (current !== last) enterAndLeave(current, last, args);
        break;
      case 'canceled':
        if (current !== last) enterAndLeave(current, last, args);
        for (let element = current; element; element = element.visualParent) {
          if (element.isTouched) element.raiseTouchLeave(args);
        }
        break;
    }
    state.lastTouchedElement = current;
    state.lastWorldPosition = position;
  }
}

/** 更新鼠标悬停：鼠标下面的元素是 element，它的父元素是 child，之前悬停、现在不悬停的是 none。返回鼠标下面的元素。 */
export function updateMouseOver(target: PickingTarget, state: PickingState, mousePosition: readonly [number, number] | undefined): UIElement | null {
  const position = mousePosition && target.toVirtual(mousePosition);
  const element = position ? hitTest(target.root, position) : null;
  const common = commonParent(element, state.lastMouseOverElement);
  for (let parent = state.lastMouseOverElement; parent && parent !== common; parent = parent.visualParent) parent.mouseOverState = 'none';
  if (element) {
    element.mouseOverState = 'element';
    for (let parent = element.visualParent; parent; parent = parent.visualParent) {
      if (parent.isHierarchyEnabled) parent.mouseOverState = 'child';
    }
  }
  state.lastMouseOverElement = element;
  return element;
}

/** 两个元素最近的共同祖先（包括它们自己）。 */
function commonParent(a: UIElement | null, b: UIElement | null): UIElement | null {
  const parents = new Set<UIElement>();
  for (let element = a; element; element = element.visualParent) parents.add(element);
  let common = b;
  while (common && !parents.has(common)) common = common.visualParent;
  return common;
}

/** 从 previous 到共同祖先发移出，从 current 到共同祖先发移入（Stride 的 ThrowEnterAndLeaveTouchEvents）。 */
function enterAndLeave(current: UIElement | null, previous: UIElement | null, args: TouchEventArgs): void {
  const common = commonParent(current, previous);
  for (let element = previous; element && element !== common; element = element.visualParent) {
    if (element.isHierarchyEnabled && element.isTouched) {
      args.handled = false;
      element.raiseTouchLeave(args);
    }
  }
  for (let element = current; element && element !== common; element = element.visualParent) {
    if (element.isHierarchyEnabled && !element.isTouched) {
      args.handled = false;
      element.raiseTouchEnter(args);
    }
  }
}
